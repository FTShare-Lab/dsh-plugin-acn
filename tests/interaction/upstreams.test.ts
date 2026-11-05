// 真实宿主覆盖多份单人配置、默认预选、旧目录迁移与运行中客户端的生效边界。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { flowHarness, turn, callTool } from '../flow/harness.js';
import { ScriptAdapter, textResponse } from '../flow/adapter.js';
import { KnowledgeSessions } from '../../src/knowledge/sessions.js';
import { InboxStore } from '../../src/store/inbox.js';
import { inboxMessage, emptyInternalize, teamServer } from '../team/helpers.js';
import { resolveConfig, UpstreamSchema, upstreamsOf } from '../../src/config.js';
import { resolveUpstream } from '../../src/upstreams.js';
import { ClaimStore } from '../../src/store/claims.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { UploadStore } from '../../src/store/uploads.js';
import { readKnowledge } from '../../src/dsh-adapter/interaction-service.js';
import Knowledge from '../../src/plugins/knowledge.js';
import { mergeConfiguration, configurationValues } from '../../src/configuration.js';

const solo = (name: string, agentId = 'agent-a') => UpstreamSchema.parse({ name, agentId });
const configuration = () => ({ upstream: 'coding', upstreams: { coding: solo('开发'), review: solo('审查') }, llm: { provider: 'mock', model: 'mock' }, formation: { idleRecap: false }, dream: { enabled: false } });
const response = (path: string) => path === '/inbox/pull' ? { body: [] } : path.endsWith('/overview') ? { body: { scopes: [] } } : { body: { status: 'ok', team_auth_enabled: false } };
describe('upstream selection and ownership', () => {
  it('starts with the real default, separates equal Agent IDs, and shares a store across sessions', async () => {
    const adapter = new ScriptAdapter([textResponse('Task completed.'), textResponse('Review completed.')]);
    const flow = await flowHarness(adapter, { formation: true, inbox: true, config: configuration() });
    try {
      const first = await flow.create(); const pool = flow.ctx.acnRuntime;
      expect(pool.view(first.session.header)).toMatchObject({ key: 'coding', available: true, locked: false });
      const knowledge = await pool.knowledge(first.session.header);
      expect(knowledge.context().paths.root).toBe(join(flow.root, 'knowledge', 'coding', 'data', 'agents', 'agent-a'));
      await new ClaimStore(knowledge.context()).write(sampleClaim({ name: 'CODING_ONLY_KNOWLEDGE' }));
      const next = await flow.create('another-project-session');
      expect((await pool.knowledge(next.session.header)).context().paths.root).toBe(knowledge.context().paths.root);
      expect((await callTool(flow.ctx, next, { action: 'list' })).value).toMatchObject({ items: [expect.objectContaining({ name: { text: 'CODING_ONLY_KNOWLEDGE', truncated: false } })] });
      expect((await pool.select(next.session.header, 'review')).available).toBe(true);
      expect((await callTool(flow.ctx, next, { action: 'list' })).value).toMatchObject({ items: [] });
      expect((await pool.knowledge(next.session.header)).context().paths.root).not.toBe(knowledge.context().paths.root);
      const prompt = JSON.stringify(await flow.ctx.systemPrompt.assemble(assembleContextFor(next)));
      expect(prompt).not.toContain('CODING_ONLY_KNOWLEDGE');
      await turn(first); await turn(next); expect(adapter.requests).toHaveLength(2);
      await expect(pool.select(first.session.header, 'review')).rejects.toMatchObject({ kind: 'bound' });
      const child = await flow.ctx.agents.create({ sessionId: SessionId('upstream-child'), parentAgent: first, meta: { parentSession: first.session.id, origin: 'subagent', delegationDepth: 1 }, agentOptions: { provider: 'mock', model: 'mock' } });
      try { expect(pool.view(child.agent.session.header)).toMatchObject({ key: 'coding', available: true, locked: true }); } finally { await child.dispose(); }
    } finally { await flow.close(); }
  });
  it('requires an explicit choice when no default exists and keeps selection without a team', async () => {
    const flow = await flowHarness(new ScriptAdapter([textResponse('Explicit task.')]), { config: { ...configuration(), upstream: '' } });
    try {
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime;
      expect(pool.view(agent.session.header).available).toBe(false);
      expect((await pool.select(agent.session.header, 'review')).key).toBe('review');
      await turn(agent); expect(pool.view(agent.session.header).locked).toBe(true);
    } finally { await flow.close(); }
  });
  it('allows first replies after team failure, then synchronizes using the same identity', async () => {
    let failed = true; const server = await teamServer((request) => failed ? { status: 503 } : response(request.path));
    const adapter = new ScriptAdapter([textResponse('Local work while offline.'), textResponse('Network restored.')]);
    const flow = await flowHarness(adapter, { inbox: true, config: { ...configuration(), upstreams: { coding: { ...solo('开发'), routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, timeoutMs: 200 } }, team: { retryCount: 0 } } });
    try {
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime;
      expect(pool.view(agent.session.header)).toMatchObject({ key: 'coding', phase: 'failed', available: true, needsPreparation: false });
      await turn(agent); expect(adapter.requests).toHaveLength(1);
      failed = false; await pool.sync(agent.session.header);
      expect(pool.view(agent.session.header)).toMatchObject({ phase: 'ready', key: 'coding' });
      await turn(agent); expect(adapter.requests).toHaveLength(2);
    } finally { await flow.close(); await server.close(); }
  });
  it('retains solo knowledge when connecting the same upstream and never backfills it', async () => {
    const server = await teamServer((request) => response(request.path));
    const flow = await flowHarness(new ScriptAdapter([]), { inbox: true, config: configuration() });
    try {
      const agent = await flow.create(); const old = await flow.ctx.acnRuntime.knowledge(agent.session.header);
      await new ClaimStore(old.context()).write(sampleClaim());
      const config = flow.knowledge.config;
      const next = resolveConfig({ ...config, upstreams: { ...config.upstreams, coding: { ...config.upstreams?.['coding'], routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } } });
      await flow.fibers.knowledge.dispose(); await flow.ctx.plugin(Knowledge, next);
      const existing = await flow.ctx.acnRuntime.knowledge(agent.session.header);
      expect(existing.mode).toBe('solo');
      expect(flow.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ activeMode: 'solo', configurationChanged: true });
      const newAgent = await flow.create('connected-after-save');
      const connected = await flow.ctx.acnRuntime.knowledge(newAgent.session.header);
      expect(connected.mode).toBe('team'); expect(connected.context().paths.root).toBe(old.context().paths.root);
      expect((await new ClaimStore(connected.context()).list()).map((claim) => claim.id)).toEqual([sampleClaim().id]);
      expect(await new UploadStore(connected.context()).read()).toMatchObject({ claims: [], disputes: [] });
      expect(server.requests.some((request) => request.path.includes('upload'))).toBe(false);
    } finally { await flow.close(); await server.close(); }
  });
  it('freezes upstream instructions and resumes the snapshot after edits', async () => {
    const flow = await flowHarness(new ScriptAdapter([textResponse('Using instructions.')]), { persistence: true, config: configuration() });
    try {
      await fs.mkdir(join(flow.root, 'knowledge', 'coding'), { recursive: true });
      await fs.writeFile(join(flow.root, 'knowledge', 'coding', 'ACN.md'), 'UPSTREAM_INSTRUCTION_BEFORE');
      const handle = await flow.ctx.agents.create({ sessionId: SessionId('instructions'), agentOptions: { provider: 'mock', model: 'mock' } });
      expect(JSON.stringify(await flow.ctx.systemPrompt.assemble(assembleContextFor(handle.agent)))).toContain('UPSTREAM_INSTRUCTION_BEFORE');
      await turn(handle.agent); await handle.dispose();
      await fs.writeFile(join(flow.root, 'knowledge', 'coding', 'ACN.md'), 'UPSTREAM_INSTRUCTION_AFTER');
      const resumed = await flow.ctx.agents.resume({ resumeSessionId: SessionId('instructions'), agentOptions: { provider: 'mock', model: 'mock' } });
      try { const prompt = JSON.stringify(await flow.ctx.systemPrompt.assemble(assembleContextFor(resumed.agent))); expect(prompt).toContain('UPSTREAM_INSTRUCTION_BEFORE'); expect(prompt).not.toContain('UPSTREAM_INSTRUCTION_AFTER'); } finally { await resumed.dispose(); }
    } finally { await flow.close(); }
  });
  it('uses the current upstream connection on a cold resume while keeping the persisted identity', async () => {
    const reply = (path: string) => path.endsWith('/query') ? { body: { candidate_claims: [], disputes: [] } } : response(path);
    const first = await teamServer((request) => reply(request.path));const second = await teamServer((request) => reply(request.path));
    const oldKey = crypto.randomUUID();const newKey = crypto.randomUUID();
    const flow = await flowHarness(new ScriptAdapter([textResponse('Original connection task.')]), { persistence: true, config: { ...configuration(), upstreams: { coding: { ...solo('开发'), routerEndpoint: first.endpoint, maintainerEndpoint: first.endpoint, keyEnv: 'FIRST_TEAM_REFERENCE' } } } });
    flow.ctx.provide('credentials', { resolve: (reference: string) => Promise.resolve({ value: reference === 'FIRST_TEAM_REFERENCE' ? oldKey : newKey, source: 'file' }) } as unknown as CredentialProvider);
    try {
      const handle = await flow.ctx.agents.create({ sessionId: SessionId('cold-connection'), agentOptions: { provider: 'mock', model: 'mock' } });
      await turn(handle.agent);await handle.dispose();
      const before = first.requests.length;const config = flow.knowledge.config;
      await flow.fibers.knowledge.dispose();await flow.ctx.plugin(Knowledge, resolveConfig({ ...config, upstreams: { coding: { ...config.upstreams?.['coding'], routerEndpoint: second.endpoint, maintainerEndpoint: second.endpoint, keyEnv: 'SECOND_TEAM_REFERENCE' } } }));
      const resumed = await flow.ctx.agents.resume({ resumeSessionId: SessionId('cold-connection'), agentOptions: { provider: 'mock', model: 'mock' } });
      try {
        const current = await flow.ctx.acnRuntime.knowledge(resumed.agent.session.header);
        expect(flow.ctx.acnRuntime.view(resumed.agent.session.header)).toMatchObject({ key: 'coding', available: true });expect(current.config.agentId).toBe('agent-a');
        expect(current.config.team.keyEnv).toBe('SECOND_TEAM_REFERENCE');
        await current.team?.router.query({ scope: 'shopping', semantic_query: null });
        expect(first.requests).toHaveLength(before);
        expect(second.requests.at(-1)?.body).toMatchObject({ auth: { agent_id: 'agent-a', acn_key: newKey } });
      } finally { await resumed.dispose(); }
    } finally { await flow.close();await first.close();await second.close(); }
  });
  it('keeps the old live client after an address edit and delivers pending records with the newly started configuration', async () => {
    let failUploads = true;
    const first = await teamServer((request) => request.path.includes('/claims') && failUploads ? { status: 503 } : response(request.path));
    const second = await teamServer((request) => response(request.path));
    const flow = await flowHarness(new ScriptAdapter([]), { inbox: true, config: { ...configuration(), upstreams: { coding: { ...solo('开发'), routerEndpoint: first.endpoint, maintainerEndpoint: first.endpoint } }, team: { retryCount: 0 } } });
    try {
      const agent = await flow.create(); const knowledge = await flow.ctx.acnRuntime.knowledge(agent.session.header);
      const claim = sampleClaim(); await new ClaimStore(knowledge.context()).write(claim); await new UploadStore(knowledge.context()).enqueue([claim], []);
      await knowledge.jobs?.close();
      const oldConfig = flow.knowledge.config; const requestsBeforeReload = first.requests.filter((request) => request.path === '/inbox/pull').length;
      await flow.fibers.knowledge.dispose();
      const updated = resolveConfig({ ...oldConfig, upstreams: { coding: { ...oldConfig.upstreams?.['coding'], routerEndpoint: second.endpoint, maintainerEndpoint: second.endpoint } } });
      await flow.ctx.plugin(Knowledge, updated);
      expect((await flow.ctx.acnRuntime.knowledge(agent.session.header)).config.team.routerEndpoint).toBe(first.endpoint);
      expect(first.requests.filter((request) => request.path === '/inbox/pull')).toHaveLength(requestsBeforeReload);
      const next = await flow.create('new-address'); const current = await flow.ctx.acnRuntime.knowledge(next.session.header);
      expect(current.config.team.routerEndpoint).toBe(second.endpoint); expect(current.context().paths.root).toBe(knowledge.context().paths.root);
      await flow.ctx.acnRuntime.sync(next.session.header);
      failUploads = false;
      await vi.waitFor(async () => { expect(second.requests.some((request) => request.path === '/claims/upload')).toBe(true); expect((await new UploadStore(current.context()).read()).claims).toHaveLength(0); });
    } finally { await flow.close(); await first.close(); await second.close(); }
  });
  it('waits for local pending Inbox processing despite a remote pull warning', async () => {
    const server = await teamServer(() => ({ status: 503 }));
    let release: (() => void) | undefined; const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = new ScriptAdapter([async () => { await gate; return textResponse(JSON.stringify(emptyInternalize())); }]);
    const flow = await flowHarness(adapter, { inbox: true, config: { ...configuration(), upstreams: { coding: solo('开发'), review: { ...solo('审查'), routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } }, team: { retryCount: 0 } } });
    try {
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime; const target = await pool.activate('review');
      await new InboxStore(target.context()).acceptPulled(inboxMessage());
      let finished = false; const selecting = pool.select(agent.session.header, 'review').then((result) => { finished = true; return result; });
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1); }); expect(finished).toBe(false); expect(pool.view(agent.session.header).phase).toBe('syncing');
      release?.(); expect((await selecting).phase).toBe('failed'); expect(await new InboxStore(target.context()).listPending()).toHaveLength(0);
    } finally { release?.(); await flow.close(); await server.close(); }
  });
  it('attaches the selected offline upstream instructions and disposes its own lifecycle', async () => {
    const server = await teamServer(() => ({ status: 503 })); const adapter = new ScriptAdapter([textResponse('Offline task.')]);
    const flow = await flowHarness(adapter, { formation: true, inbox: true, config: { ...configuration(), upstreams: { coding: solo('开发'), review: { ...solo('审查'), routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } }, team: { retryCount: 0 } } });
    try {
      await fs.mkdir(join(flow.root, 'knowledge', 'coding'), { recursive: true }); await fs.mkdir(join(flow.root, 'knowledge', 'review'), { recursive: true });
      await fs.writeFile(join(flow.root, 'knowledge', 'coding', 'ACN.md'), 'DEFAULT_INSTRUCTIONS_PRIVATE'); await fs.writeFile(join(flow.root, 'knowledge', 'review', 'ACN.md'), 'TARGET_OFFLINE_INSTRUCTIONS');
      const handle = await flow.ctx.agents.create({ sessionId: SessionId('offline-ownership'), agentOptions: { provider: 'mock', model: 'mock' } });
      await flow.ctx.acnRuntime.select(handle.agent.session.header, 'review');
      const selected = await flow.ctx.acnRuntime.service(handle.agent.session.header); if (selected.formation === undefined) throw new Error('Missing formation.');
      const disposed = vi.spyOn(selected.formation, 'disposed');
      await turn(handle.agent); const text = JSON.stringify(adapter.requests[0]); expect(text).toContain('TARGET_OFFLINE_INSTRUCTIONS'); expect(text).not.toContain('DEFAULT_INSTRUCTIONS_PRIVATE');
      await handle.dispose(); expect(disposed).toHaveBeenCalledWith('offline-ownership');
    } finally { await flow.close(); await server.close(); }
  });
  it('retains the Router tool for a live team session when the saved profile becomes solo', async () => {
    const server = await teamServer((request) => response(request.path));
    const flow = await flowHarness(new ScriptAdapter([]), { config: { ...configuration(), upstreams: { coding: { ...solo('开发'), routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } } } });
    try {
      const agent = await flow.create(); const config = flow.knowledge.config; await flow.fibers.knowledge.dispose();
      await flow.ctx.plugin(Knowledge, resolveConfig({ ...config, upstreams: { coding: solo('开发') } }));
      const result = await flow.ctx.tools.execute({ name: 'consult_router', agent, callId: ToolCallId('live-team-router'), arguments: { mode: 'overview' }, signal: new AbortController().signal });
      expect(result.isError).toBe(false); expect(result.value).toMatchObject({ available: true });
      expect(flow.ctx.acnRuntime.view(agent.session.header).activeMode).toBe('team');
      const local = await flow.create('new-solo-instance'); const before = server.requests.length;
      const localResult = await flow.ctx.tools.execute({ name: 'consult_router', agent: local, callId: ToolCallId('solo-router'), arguments: { mode: 'overview' }, signal: new AbortController().signal });
      expect(localResult.value).toMatchObject({ error: { kind: 'unconfigured' } }); expect(server.requests).toHaveLength(before);
    } finally { await flow.close(); await server.close(); }
  });
  it('restores the most recently activated background owner before older surviving clients', async () => {
    let allowUploads = false; const serve = (path: string) => path === '/claims/upload' && !allowUploads ? { status: 503 } : response(path);
    const first = await teamServer((request) => serve(request.path)); const second = await teamServer((request) => serve(request.path));
    const flow = await flowHarness(new ScriptAdapter([]), { inbox: true, config: { ...configuration(), upstreams: { coding: { ...solo('开发'), routerEndpoint: first.endpoint, maintainerEndpoint: first.endpoint } }, team: { retryCount: 0 } } });
    try {
      const old = await flow.create(); const original = flow.knowledge.config; await flow.fibers.knowledge.dispose();
      const updated = resolveConfig({ ...original, upstreams: { coding: { ...solo('开发'), routerEndpoint: second.endpoint, maintainerEndpoint: second.endpoint } } });
      const fiber = await flow.ctx.plugin(Knowledge, updated); const next = await flow.create('new-worker-owner'); const target = await flow.ctx.acnRuntime.knowledge(next.session.header);
      await new ClaimStore(target.context()).write(sampleClaim()); await new UploadStore(target.context()).enqueue([sampleClaim()], []);
      await fiber.dispose(); const before = first.requests.filter((request) => request.path === '/claims/upload').length; allowUploads = true;
      await flow.ctx.plugin(Knowledge, updated);
      await vi.waitFor(async () => { expect((await new UploadStore(target.context()).read()).claims).toHaveLength(0); });
      expect(first.requests.filter((request) => request.path === '/claims/upload')).toHaveLength(before);
      expect(second.requests.some((request) => request.path === '/claims/upload')).toBe(true);
      expect((await flow.ctx.acnRuntime.knowledge(old.session.header)).config.team.routerEndpoint).toBe(first.endpoint);
    } finally { await flow.close(); await first.close(); await second.close(); }
  });
  it('finishes cancelled selection attachment before admitting an immediate user turn', async () => {
    const server = await teamServer((request) => request.path === '/inbox/pull' ? { delayMs: 1000, body: [] } : response(request.path));
    const adapter = new ScriptAdapter([textResponse('Continued after cancellation.')]);
    const flow = await flowHarness(adapter, { inbox: true, formation: true, config: { ...configuration(), upstreams: { coding: solo('开发'), review: { ...solo('审查'), routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } } } });
    try {
      await fs.mkdir(join(flow.root, 'knowledge', 'review'), { recursive: true }); await fs.writeFile(join(flow.root, 'knowledge', 'review', 'ACN.md'), 'CANCELLED_SELECTION_INSTRUCTIONS');
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime; const selecting = pool.select(agent.session.header, 'review');
      await vi.waitFor(() => { expect(pool.view(agent.session.header).phase).toBe('syncing'); });
      const cancelling = pool.cancel(agent.session.header); const running = turn(agent);
      expect(adapter.requests).toHaveLength(0);
      await Promise.all([selecting, cancelling, running]);
      expect(adapter.requests).toHaveLength(1); expect(JSON.stringify(adapter.requests[0])).toContain('CANCELLED_SELECTION_INSTRUCTIONS');
      expect(pool.view(agent.session.header)).toMatchObject({ key: 'review', needsPreparation: false, phase: 'failed' });
    } finally { await flow.close(); await server.close(); }
  });
  it('refreshes the legacy base assembly after cancellation without starting a new Router overview', async () => {
    const server = await teamServer((request) => request.path === '/inbox/pull' ? { delayMs: 1000, body: [] } : response(request.path));
    const adapter = new ScriptAdapter([textResponse('Legacy cancellation continued.')]);
    const flow = await flowHarness(adapter, { inbox: true, config: { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint }, inbox: { pullOnSessionStart: false }, dream: { enabled: false } } });
    let release: (() => void) | undefined; const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: (() => void) | undefined; const refreshing = new Promise<void>((resolve) => { started = resolve; });
    // 仅通过 apply(this, args) 调用原方法，保留竞态中的真实实例。
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const freeze = KnowledgeSessions.prototype.freeze; let restore: (() => void) | undefined;
    try {
      const agent = await flow.create(); await new ClaimStore(flow.knowledge.context()).write(sampleClaim({ name: 'LEGACY_REFRESHED_CLAIM' }));
      const spy = vi.spyOn(KnowledgeSessions.prototype, 'freeze').mockImplementation(async function (this: KnowledgeSessions, ...args) { if (args[1] === 'clear') { started?.(); await gate; } return freeze.apply(this, args); });
      restore = () => { spy.mockRestore(); };
      const pool = flow.ctx.acnRuntime; const syncing = pool.sync(agent.session.header);
      await vi.waitFor(() => { expect(server.requests.some((request) => request.path === '/inbox/pull')).toBe(true); });
      const before = server.requests.filter((request) => request.path === '/claims/scopes/overview').length;
      const cancelling = pool.cancel(agent.session.header); const running = turn(agent);
      await refreshing; expect(adapter.requests).toHaveLength(0); release?.();
      await Promise.all([syncing, cancelling, running]);
      const first = JSON.stringify(adapter.requests[0]); expect(first).toContain('LEGACY_REFRESHED_CLAIM');
      expect(server.requests.filter((request) => request.path === '/claims/scopes/overview')).toHaveLength(before);
    } finally { release?.(); restore?.(); await flow.close(); await server.close(); }
  });
  it('maps legacy stores without copying or merging and forbids changing the stored mapping', () => {
    const raw = resolveConfig({ agentId: 'agent-a', home: '/tmp/example-knowledge', team: { routerEndpoint: 'http://127.0.0.1:8101', maintainerEndpoint: 'http://127.0.0.1:8102' }, connections: [{ id: 'TEAM-A', name: '旧连接', agentId: 'agent-a', routerEndpoint: 'http://127.0.0.1:8101', maintainerEndpoint: 'http://127.0.0.1:8102' }] });
    const profiles = upstreamsOf(raw);
    expect(profiles['team-a']?.legacyKey).toBe('TEAM-A');
    const migrated = resolveConfig(mergeConfiguration(raw, { ...configurationValues(raw), upstreams: profiles, upstream: 'personal' }));
    expect(resolveUpstream(migrated, 'personal')?.home).toBe(join('/tmp/example-knowledge', 'personal'));
    expect(resolveUpstream(migrated, 'legacy')?.home).toBe('/tmp/example-knowledge');
    expect(resolveUpstream(migrated, 'team-a')?.home).toBe(join('/tmp/example-knowledge', 'connections', 'TEAM-A'));
    expect(() => mergeConfiguration(migrated, { ...configurationValues(migrated), upstreams: { ...profiles, 'team-a': { ...profiles['team-a'] as NonNullable<typeof profiles['team-a']>, legacyKey: 'another' } } })).toThrow();
  });
  it('browses an unused upstream without initializing a worker or team request', async () => {
    const server = await teamServer((request) => response(request.path));
    const adapter = new ScriptAdapter([]); const flow = await flowHarness(adapter, { inbox: true, config: { ...configuration(), upstreams: { coding: solo('开发'), team: { ...solo('团队', 'agent-b'), routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } } } });
    try { expect((await readKnowledge(flow.ctx.acnRuntime, 'team', 'claim', '', 0)).items).toEqual([]); expect(server.requests).toEqual([]); expect(adapter.requests).toEqual([]); } finally { await flow.close(); await server.close(); }
  });
});

it('explains an unexpected Inbox sync failure using visible settings and preserves local work', async () => {
  const server = await teamServer((request) => response(request.path));
  const { AcnInbox } = await import('../../src/inbox/service.js');
  const request = vi.spyOn(AcnInbox.prototype, 'request').mockRejectedValue(new Error('PRIVATE_SYNC_ERROR'));
  const flow = await flowHarness(new ScriptAdapter([]), { inbox: true, config: { ...configuration(), upstreams: { coding: { ...solo('Example'), routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } }, team: { retryCount: 0 } } });
  try {
    const agent = await flow.create();await flow.ctx.acnRuntime.sync(agent.session.header);const state = flow.ctx.acnRuntime.view(agent.session.header);
    expect(state).toMatchObject({ phase: 'failed', available: true });expect(state.message).toContain('团队鉴权密钥');expect(state.message).toContain('本地存储');expect(state.message).toContain('可继续使用本地知识');
    expect(state.message).not.toContain('环境变量');expect(state.message).not.toContain('PRIVATE_SYNC_ERROR');
  } finally { request.mockRestore();await flow.close();await server.close(); }
});
