// 真实宿主验证会话路由、首次同步、冻结快照和失败恢复，测试服务仅监听回环地址。
import { describe, expect, it, vi } from 'vitest';
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { AgentIdSchema } from '../../src/protocol/ids.js';
import { flowHarness, turn, callTool } from '../flow/harness.js';
import { ScriptAdapter, textResponse } from '../flow/adapter.js';
import { teamServer } from '../team/helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { ClaimStore } from '../../src/store/claims.js';
import { readYaml } from '../../src/store/yaml.js';
import { RouteSchema } from '../../src/formation/transcript.js';
import { UploadStore } from '../../src/store/uploads.js';
import { identityOf, sessionSelection } from '../../src/dsh-adapter/session-binding.js';
import { finishDream } from '../dream/autonomous-helpers.js';
import { waitJob } from '../formation/helpers.js';
import { readKnowledge } from '../../src/dsh-adapter/interaction-service.js';
import type { ConfigInput } from '../../src/config.js';
import Knowledge from '../../src/plugins/knowledge.js';
import { executeInteraction } from '../../src/dsh-adapter/interaction-service.js';
import type { Context } from '@deepseek-ai/cordis';

const config = (endpoint: string): ConfigInput => ({
  connections: [{ id: 'team-a', name: 'Example team', agentId: 'member-a', routerEndpoint: endpoint, maintainerEndpoint: endpoint, timeoutMs: 1000 }],
  llm: { provider: 'mock', model: 'mock' }, inbox: { pullOnSessionStart: false },
  dream: { enabled: false }, memory: { review: { enabled: false } }, formation: { idleRecap: false },
});
const reply = (path: string) => path === '/inbox/pull' ? { body: [] } : path.endsWith('/overview') ? { body: { scopes: [] } } : { body: { status: 'ok', team_auth_enabled: false } };
describe('session team interaction', () => {
  it('keeps a new session solo and browses an unused connection without network or model work', async () => {
    const server = await teamServer((request) => reply(request.path));
    const adapter = new ScriptAdapter([textResponse('Local task completed.')]); const flow = await flowHarness(adapter, { formation: true, inbox: true, memory: true, config: config(server.endpoint) });
    try {
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime;
      expect(pool.view(agent.session.header)).toMatchObject({ key: 'personal', phase: 'ready', locked: false });
      const denied = await executeInteraction(flow.ctx, { action: 'sync', sessionId: agent.session.id }, pool);
      expect(denied).toMatchObject({ ok: false, message: '单人模式没有团队收件箱。' });
      await pool.cancel(agent.session.header); expect(pool.view(agent.session.header).phase).toBe('ready');
      expect(await flow.knowledge.jobs?.queue.list()).toEqual([]);
      expect((await readKnowledge(pool, 'team-a', 'claim', '', 0)).items).toEqual([]);
      expect(server.requests).toEqual([]); expect(adapter.requests).toEqual([]);
      await turn(agent); expect(server.requests).toEqual([]); expect(pool.view(agent.session.header).locked).toBe(true);
      expect(await new UploadStore(flow.knowledge.context()).read()).toMatchObject({ claims: [], disputes: [] });
    } finally { await flow.close(); await server.close(); }
  });
  it('finishes initial Inbox before admitting a team prompt and isolates tools and private Memory', async () => {
    const server = await teamServer((request) => reply(request.path));
    const adapter = new ScriptAdapter([textResponse('Team work completed.')]); const flow = await flowHarness(adapter, { formation: true, inbox: true, memory: true, config: config(server.endpoint) });
    try {
      await flow.ctx.acnMemory.apply({ ops: [{ op: 'add', target: 'memory', entry: 'PERSONAL_ONLY_MARKER' }] });
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime;
      const view = await pool.select(agent.session.header, 'team-a'); expect(view.phase).toBe('ready');
      const knowledge = await pool.knowledge(agent.session.header); expect(knowledge.agentId).toBe('member-a'); expect(knowledge.context().paths.root).not.toBe(flow.knowledge.context().paths.root);
      const claim = sampleClaim({ holder: AgentIdSchema.parse('member-a'), name: 'team_only_marker' }); await new ClaimStore(knowledge.context()).write(claim);
      expect((await callTool(flow.ctx, agent, { action: 'list' })).value).toMatchObject({ items: [expect.objectContaining({ name: { text: 'team_only_marker', truncated: false } })] });
      const memory = await flow.ctx.tools.execute({ name: 'memory', agent, callId: ToolCallId('team-memory'), arguments: { ops: [{ op: 'add', target: 'memory', entry: 'TEAM_ONLY_PRIVATE_MARKER' }] }, signal: new AbortController().signal });
      expect(memory.isError).toBe(false); expect(JSON.stringify(await flow.ctx.acnMemory.snapshot())).not.toContain('TEAM_ONLY_PRIVATE_MARKER');
      const sections = await flow.ctx.systemPrompt.assemble(assembleContextFor(agent)); expect(JSON.stringify(sections)).not.toContain('PERSONAL_ONLY_MARKER');
      await turn(agent); expect(JSON.stringify(adapter.requests)).toContain('member-a'); expect(JSON.stringify(adapter.requests)).not.toContain('PERSONAL_ONLY_MARKER');
      expect(sessionSelection(flow.ctx, agent.session.header)?.prepared).toBe(true);
      await expect(pool.select(agent.session.header, 'personal')).rejects.toMatchObject({ kind: 'bound' });
      const jobs = await knowledge.jobs?.queue.list(); expect(jobs?.find((job) => job.kind === 'inbox')).toMatchObject({ state: 'succeeded', sessionId: agent.session.id });
      const activity = (await readKnowledge(pool, 'team-a', 'claim', '', 0, false)).activities.find((item) => item.kind === 'inbox');
      expect(activity).toMatchObject({ state: 'succeeded', sessionId: agent.session.id, unseen: false });
    } finally { await flow.close(); await server.close(); }
  });
  it('prepares the selected chat route for first Inbox work when no background model is configured', async () => {
    const server = await teamServer((request) => reply(request.path)); const flow = await flowHarness(new ScriptAdapter([]), { inbox: true, config: { ...config(server.endpoint), llm: {} } });
    try {
      const agent = await flow.create(); agent.session.append('model/selection', { provider: 'mock', model: 'selected-model' }); const pool = flow.ctx.acnRuntime; expect((await pool.select(agent.session.header, 'team-a')).phase).toBe('ready');
      const knowledge = await pool.knowledge(agent.session.header); expect(await readYaml(knowledge.context().paths.lastRoute, RouteSchema)).toEqual({ provider: 'mock', model: 'selected-model' });
    } finally { await flow.close(); await server.close(); }
  });
  it('allows local first send after a real connection failure, then repairs the same selection', async () => {
    let fail = true; const server = await teamServer((request) => fail ? { status: 503 } : reply(request.path));
    const adapter = new ScriptAdapter([textResponse('Local team task.'), textResponse('Recovered team task.')]); const flow = await flowHarness(adapter, { inbox: true, config: config(server.endpoint) });
    try {
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime;
      expect((await pool.select(agent.session.header, 'team-a')).phase).toBe('failed');
      expect(sessionSelection(flow.ctx, agent.session.header)?.prepared).toBe(true);
      await turn(agent); expect(adapter.requests).toHaveLength(1);
      fail = false; await pool.sync(agent.session.header); expect(pool.view(agent.session.header).phase).toBe('ready');
      await turn(agent); expect(adapter.requests).toHaveLength(2);
    } finally { await flow.close(); await server.close(); }
  });
  it('cancels waiting without losing the selected ownership and lets a blank session return to solo', async () => {
    let hold = false; const server = await teamServer((request) => hold && request.path === '/inbox/pull' ? { delayMs: 1000, body: [] } : reply(request.path));
    const flow = await flowHarness(new ScriptAdapter([]), { inbox: true, config: config(server.endpoint) });
    try {
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime; hold = true;
      const selecting = pool.select(agent.session.header, 'team-a');
      await vi.waitFor(() => { expect(pool.view(agent.session.header).phase).toBe('syncing'); }); await pool.cancel(agent.session.header); await selecting;
      expect(pool.view(agent.session.header)).toMatchObject({ phase: 'failed', key: 'team-a' });
      expect((await pool.select(agent.session.header, 'personal')).phase).toBe('ready');
      expect(await pool.knowledge(agent.session.header)).toBe(flow.knowledge);
    } finally { await flow.close(); await server.close(); }
  });
  it('does not admit personal Claim changes after selecting a team and inherits that team in fresh children', async () => {
    const server = await teamServer((request) => reply(request.path)); const adapter = new ScriptAdapter([textResponse('Team task.'), textResponse('Child inspection.')]);
    const flow = await flowHarness(adapter, { inbox: true, memory: true, config: config(server.endpoint) });
    try {
      const parent = await flow.create(); const pool = flow.ctx.acnRuntime; await pool.select(parent.session.header, 'team-a');
      await new ClaimStore(flow.knowledge.context()).write(sampleClaim({ name: 'PERSONAL_CHANGED_CLAIM_MARKER', statement: 'PERSONAL_CHANGED_BODY_MARKER' }));
      await turn(parent); expect(JSON.stringify(adapter.requests[0])).not.toContain('PERSONAL_CHANGED_');
      const child = await flow.ctx.agents.create({ sessionId: SessionId('team-child'), parentAgent: parent, meta: { parentSession: parent.session.id, origin: 'subagent', delegationDepth: 1 }, agentOptions: { provider: 'mock', model: 'mock' } });
      try {
        expect(pool.view(child.agent.session.header)).toMatchObject({ key: 'team-a', locked: true, available: true });
        await turn(child.agent); expect(adapter.requests).toHaveLength(2); expect(JSON.stringify(adapter.requests[1])).toContain('member-a'); expect(JSON.stringify(adapter.requests[1])).not.toContain('PERSONAL_CHANGED_');
        expect((await callTool(flow.ctx, child.agent, { action: 'list' })).isError).toBe(false);
        expect((await flow.ctx.tools.execute({ name: 'memory', agent: child.agent, callId: ToolCallId('child-private'), arguments: { ops: [] }, signal: new AbortController().signal })).isError).toBe(true);
      } finally { await child.dispose(); }
    } finally { await flow.close(); await server.close(); }
  });
  it('retains an unfinished first-sync record without blocking local work in the actual session journal across disposal and resume', async () => {
    const server = await teamServer(() => ({ status: 503 }));
    const adapter = new ScriptAdapter([textResponse('Local work after resume.')]); const flow = await flowHarness(adapter, { persistence: true, inbox: true, config: config(server.endpoint) });
    try {
      const handle = await flow.ctx.agents.create({ sessionId: SessionId('unfinished-team'), agentOptions: { provider: 'mock', model: 'mock' } });
      await flow.ctx.acnRuntime.select(handle.agent.session.header, 'team-a'); await handle.dispose();
      const resumed = await flow.ctx.agents.resume({ resumeSessionId: SessionId('unfinished-team'), agentOptions: { provider: 'mock', model: 'mock' } });
      expect(sessionSelection(flow.ctx, resumed.agent.session.header)).toMatchObject({ key: 'team-a', prepared: true });
      await turn(resumed.agent); expect(adapter.requests).toHaveLength(1); await resumed.dispose();
    } finally { await flow.close(); await server.close(); }
  });
  it('rejects changed identities instead of falling back to personal data', async () => {
    const server = await teamServer((request) => reply(request.path)); const flow = await flowHarness(new ScriptAdapter([]), { inbox: true, config: config(server.endpoint) });
    try {
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime;
      const target = pool.config('team-a'); if (target === undefined) throw new Error('Missing team.');
      appendPluginRecord(agent.session, 'plugin:acn/team-selection', { schemaVersion: 1, key: 'team-a', identity: identityOf({ ...target, agentId: AgentIdSchema.parse('another-member') }), prepared: true });
      expect(pool.allowed(agent.session.header)).toBe(false); expect(pool.view(agent.session.header).phase).toBe('blocked');
      await expect(pool.knowledge(agent.session.header)).rejects.toMatchObject({ kind: 'identity' });
    } finally { await flow.close(); await server.close(); }
  });
  it('restores the frozen team catalog and private snapshot when configuration reload keeps the agent alive', async () => {
    const server = await teamServer((request) => reply(request.path)); const adapter = new ScriptAdapter([textResponse('Before reload.'), textResponse('After reload.')]);
    const flow = await flowHarness(adapter, { formation: true, inbox: true, memory: true, config: config(server.endpoint) });
    try {
      const agent = await flow.create(); await flow.ctx.acnRuntime.select(agent.session.header, 'team-a');
      const services = await flow.ctx.acnRuntime.service(agent.session.header); if (services.memory === undefined) throw new Error('Missing Memory.');
      await services.memory.apply({ ops: [{ op: 'add', target: 'memory', entry: 'LATER_TEAM_PRIVATE_MARKER' }] });
      const before = (await flow.ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.filter((section) => section.name.startsWith('acn:connection-'));
      await turn(agent); const previous = flow.ctx.acnRuntime; const configuration = flow.knowledge.config;
      await flow.fibers.knowledge.dispose(); await flow.ctx.plugin(Knowledge, configuration);
      await vi.waitFor(() => { expect(flow.ctx.acnRuntime).not.toBe(previous); });
      expect(flow.ctx.agents.list().map((item) => item.session.id)).toContain(agent.session.id);
      await turn(agent);
      const after = (await flow.ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.filter((section) => section.name.startsWith('acn:connection-'));
      expect(after).toEqual(before); expect(JSON.stringify(adapter.requests.at(-1))).not.toContain('LATER_TEAM_PRIVATE_MARKER');
      expect(adapter.requests).toHaveLength(2);
    } finally { await flow.close(); await server.close(); }
  });
  it('releases a disabled Inbox component for an existing connection without blocking later ordinary turns', async () => {
    const server = await teamServer((request) => reply(request.path)); const adapter = new ScriptAdapter([textResponse('First turn.'), textResponse('Continue with frozen knowledge.')]);
    const flow = await flowHarness(adapter, { formation: true, inbox: true, memory: true, config: config(server.endpoint) });
    try {
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime; await pool.select(agent.session.header, 'team-a'); await turn(agent);
      await flow.fibers.inbox?.dispose(); expect((await pool.service(agent.session.header)).inbox).toBeUndefined();
      await pool.sync(agent.session.header); expect(pool.view(agent.session.header).phase).toBe('failed'); expect(pool.view(agent.session.header).needsPreparation).toBe(false);
      await turn(agent); expect(adapter.requests).toHaveLength(2);
    } finally { await flow.close(); await server.close(); }
  });
  it.each(['personal', 'team-a'])('runs %s Dream in its own identity when the legacy connection is disabled', async (key) => {
    const server = await teamServer((request) => reply(request.path)); const adapter = new ScriptAdapter([finishDream(), finishDream()]);
    const flow = await flowHarness(adapter, { inbox: true, dream: true, memory: true, config: { ...config(server.endpoint), team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint }, legacyEnabled: false, dream: { enabled: true, minChangedClaims: 1000 } } });
    try {
      const agent = await flow.create(); const pool = flow.ctx.acnRuntime; await pool.select(agent.session.header, key);
      const services = await pool.service(agent.session.header); const knowledge = services.knowledge;
      await new ClaimStore(knowledge.context()).write(sampleClaim({ holder: AgentIdSchema.parse(key === 'personal' ? 'agent-a' : 'member-a') }));
      if (services.dream === undefined || knowledge.jobs === null) throw new Error('Missing Dream.');
      const job = await services.dream.request(); expect((await waitJob(knowledge.jobs.queue, job.id)).state).toBe('succeeded');
      expect(adapter.requests).toHaveLength(2); expect(JSON.stringify(adapter.requests)).not.toContain('PRIVATE');
    } finally { await flow.close(); await server.close(); }
  });
  it('reads a cold persisted session without activating its agent, then activates only for explicit work', async () => {
    const server = await teamServer((request) => reply(request.path)); const flow = await flowHarness(new ScriptAdapter([textResponse('A completed task.'), textResponse('Continued after resume.')]), { persistence: true, inbox: true, config: { ...config(server.endpoint), inbox: { pullOnSessionStart: true } } });
    try {
      const handle = await flow.ctx.agents.create({ sessionId: SessionId('cold-team'), agentOptions: { provider: 'mock', model: 'mock' } });
      const pool = flow.ctx.acnRuntime; await pool.select(handle.agent.session.header, 'team-a'); await turn(handle.agent);
      const inspection = { meta: handle.agent.session.header, events: handle.agent.session.snapshotEvents(), inheritedEventCount: handle.agent.session.inheritedEventCount }; await handle.dispose();
      const observed = vi.fn(() => Promise.resolve(inspection));
      const activate = vi.fn(async () => ({ agent: (await flow.ctx.agents.resume({ resumeSessionId: SessionId('cold-team'), agentOptions: { provider: 'mock', model: 'mock' } })).agent }));
      flow.ctx.provide('sessionController', { inspect: observed, resolveAgent: activate } as unknown as Context['sessionController']);
      const count = server.requests.length;
      expect(await executeInteraction(flow.ctx, { action: 'session', sessionId: 'cold-team' }, pool)).toMatchObject({ ok: true, session: { key: 'team-a', locked: true, available: true } });
      expect(observed).toHaveBeenCalledOnce(); expect(activate).not.toHaveBeenCalled(); expect(server.requests).toHaveLength(count);
      expect((await executeInteraction(flow.ctx, { action: 'sync', sessionId: 'cold-team' }, pool)).ok).toBe(true); expect(activate).toHaveBeenCalledOnce();
      const live = flow.ctx.agents.get(SessionId('cold-team')); if (live === undefined) throw new Error('Missing resumed agent.'); await turn(live);
      const knowledge = await pool.knowledge(live.session.header);
      await vi.waitFor(async () => { expect((await knowledge.jobs?.queue.list())?.some((job) => job.kind === 'inbox' && job.payload['synchronize'] === true && job.sessionId === 'cold-team')).toBe(true); });
    } finally { await flow.close(); await server.close(); }
  });
});
