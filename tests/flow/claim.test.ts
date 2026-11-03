// 用生产循环执行工具，核对领域结果、子代理门禁和真实持久会话恢复。
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';
import { TraceStore } from '../../src/store/traces.js';
import { ClaimStore } from '../../src/store/claims.js';
import { SessionStateStore } from '../../src/store/session-state.js';
import { TraceSchema } from '../../src/protocol/trace.js';
import { ClaimSchema } from '../../src/protocol/claim.js';
import { writeYamlAtomic } from '../../src/store/yaml.js';
import { ScriptAdapter, textResponse, toolResponse } from './adapter.js';
import { callTool, flowHarness, turn } from './harness.js';

describe('Claim tool in the production loop', () => {
  it('executes list/read/update, conflict and Trace lookup as canonical tool results', async () => {
    const adapter = new ScriptAdapter([
      toolResponse('list-call', 'claim', { action: 'list' }),
      toolResponse('read-call', 'claim', { action: 'read', id: 'claim_00000001' }),
      (request) => {
        const body = JSON.stringify(request.messages);
        const revision = /sha256-v1:[a-f0-9]{64}/.exec(body)?.[0];
        if (revision === undefined) throw new Error('Read must expose a revision to the model.');
        return toolResponse('update-call', 'claim', { action: 'update', id: 'claim_00000001', expected_revision: revision, name: 'updated_from_tool' });
      },
      toolResponse('stale-call', 'claim', { action: 'update', id: 'claim_00000001', expected_revision: 'stale', status: 'deprecated' }),
      toolResponse('traces-call', 'claim', { action: 'traces', claim_id: 'claim_00000001' }),
      toolResponse('trace-call', 'claim', { action: 'read_trace', id: 'trace_00000001', task_offset: 1, task_limit: 2 }),
      textResponse('done'),
    ]);
    const flow = await flowHarness(adapter);
    try {
      const trace = TraceSchema.parse({ id: 'trace_00000001', name: 'original task', task: '甲😀乙丙', agent: 'agent-a', created_at: flow.claim.created_at, input_claims: [], output_claims: [flow.claim.id] });
      await new TraceStore(flow.knowledge.context()).write(trace);
      const results: unknown[] = [];
      flow.ctx.on('tools/result', (_exec, result) => { results.push(result); });
      await turn(await flow.create());
      expect(adapter.requests).toHaveLength(7);
      expect(results).toHaveLength(6);
      expect(results).toMatchObject([{ isError: false }, { isError: false }, { isError: false }, { isError: false }, { isError: false }, { isError: false }]);
      const last = JSON.stringify(adapter.requests.at(-1));
      expect(last).toContain('current_revision'); expect(last).toContain('😀乙');
      expect((await flow.knowledge.readClaim(flow.claim.id)).claim.name).toBe('updated_from_tool');
      expect((await flow.knowledge.readClaim(flow.claim.id)).claim.status).toBe('active');
      await expect(fs.access(flow.knowledge.context().paths.uploads)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await flow.close(); }
  });

  it.each([{ origin: 'subagent' as const }, { delegationDepth: 1 }])('subagent_cannot_write but can read: %j', async (meta) => {
    const flow = await flowHarness(new ScriptAdapter([]));
    try {
      const { agent } = await flow.ctx.agents.create({ sessionId: SessionId('child'), meta, agentOptions: { provider: 'mock', model: 'mock' } });
      // 一个外层策略即使跳过普通 gate，最终 guard 仍必须拒绝子代理写入。
      if ('delegationDepth' in meta) flow.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true });
      expect(await callTool(flow.ctx, agent, { action: 'read', id: flow.claim.id })).toMatchObject({ isError: false });
      const { revision } = await flow.knowledge.readClaim(flow.claim.id);
      const denied = await callTool(flow.ctx, agent, { action: 'update', id: flow.claim.id, expected_revision: revision, name: 'denied' });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('Subagents cannot modify');
      expect((await flow.knowledge.readClaim(flow.claim.id)).revision).toBe(revision);
    } finally { await flow.close(); }
  });

  it('rejects unrelated fields and keeps infrastructure failures as tool errors', async () => {
    const flow = await flowHarness(new ScriptAdapter([]));
    try {
      const agent = await flow.create();
      const invalid = await callTool(flow.ctx, agent, { action: 'read', id: flow.claim.id, limit: 1 });
      expect(JSON.stringify(invalid)).toContain('validation');
      await fs.writeFile(flow.knowledge.context().paths.claim(flow.claim.id), 'broken: [');
      expect(await callTool(flow.ctx, agent, { action: 'read', id: flow.claim.id })).toMatchObject({ isError: true });
    } finally { await flow.close(); }
  });
  it('rejects a foreign-holder model update and retains its stored revision', async () => {
    const flow = await flowHarness(new ScriptAdapter([]));
    try {
      const agent = await flow.create();
      const path = flow.knowledge.context().paths.claim(flow.claim.id);
      await writeYamlAtomic(path, { ...flow.claim, holder: 'agent-b' }, ClaimSchema, flow.knowledge.logger);
      const original = await fs.readFile(path, 'utf8');
      const result = await callTool(flow.ctx, agent, { action: 'update', id: flow.claim.id, expected_revision: 'old', name: 'denied' });
      expect(result.isError).toBe(false); expect(JSON.stringify(result)).toContain('ownership');
      expect(await fs.readFile(path, 'utf8')).toBe(original);
    } finally { await flow.close(); }
  });

  it('unconfigured bundle exposes only status and writes no knowledge directory', async () => {
    const flow = await flowHarness(new ScriptAdapter([]), { configured: false });
    try {
      const agent = await flow.create();
      expect(flow.ctx.commands.list(agent).map((command) => command.name)).toEqual(['acn-status']);
      expect(flow.ctx.tools.schemas().map((tool) => tool.name)).not.toContain('claim');
      expect((await flow.ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.map((section) => section.name)).not.toContain('acn:knowledge');
      const result = await flow.ctx.commands.execute(agent, '/acn-status', [], new AbortController().signal);
      expect(result?.result.kind).toBe('success');
      expect(result?.result.text).toContain('Agent ID');
      await expect(fs.access(join(flow.root, 'knowledge'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await flow.close(); }
  });

  it('commands revise locally without model requests; disposal unregisters all contributions', async () => {
    const adapter = new ScriptAdapter([]); const flow = await flowHarness(adapter);
    try {
      const agent = await flow.create();
      const edited = await flow.ctx.commands.execute(agent, `/claim set ${flow.claim.id} name="from command"`, [], new AbortController().signal);
      expect(edited?.result.kind).toBe('success');
      expect((await flow.knowledge.readClaim(flow.claim.id)).claim.name).toBe('from command');
      expect(adapter.requests).toHaveLength(0);
      await flow.fibers.tools.dispose();
      expect(flow.ctx.tools.schemas().map((tool) => tool.name)).not.toContain('claim');
      await flow.fibers.prompt.dispose();
      expect((await flow.ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.map((section) => section.name)).not.toContain('acn:knowledge');
      await flow.fibers.commands.dispose();
      expect(flow.ctx.commands.list(agent)).toHaveLength(0);
    } finally { await flow.close(); }
  });
});

describe('session context projection', () => {
  it('preserves literal template-like data without prompt interpolation', async () => {
    const flow = await flowHarness(new ScriptAdapter([]));
    try {
      await new ClaimStore(flow.knowledge.context()).write({ ...flow.claim, name: 'literal {{unknown_variable}}', scope: 'example\nsecond line' });
      const agent = await flow.create();
      const catalog = (await flow.ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.find((section) => section.name === 'acn:claim-catalog');
      expect(catalog?.text).toContain('{{unknown_variable}}'); expect(catalog?.text).toContain('example\\nsecond line');
    } finally { await flow.close(); }
  });
  it('catalog_frozen_per_session; another process triggers a same-request notice once', async () => {
    const adapter = new ScriptAdapter([textResponse('first'), textResponse('second'), textResponse('third')]);
    const flow = await flowHarness(adapter);
    try {
      const agent = await flow.create();
      const catalog = async () => (await flow.ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.find((section) => section.name === 'acn:claim-catalog')?.text;
      const original = await catalog();
      await turn(agent);
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/edit.mjs', import.meta.url)), flow.knowledge.context().paths.root, flow.claim.id, 'changed_by_process']);
      const notices: string[] = [];
      flow.ctx.on('session/event', (_session, event) => { if (event.type === 'user/message' && event.data.source.kind === 'acn-claim-changes') notices.push(JSON.stringify(event.data)); });
      await turn(agent);
      expect(JSON.stringify(adapter.requests[1])).toContain('changed_by_process');
      await turn(agent);
      expect(notices).toHaveLength(1);
      expect(await catalog()).toBe(original);
      expect(JSON.stringify(adapter.requests[0])).not.toContain('changed_by_process');
    } finally { await flow.close(); }
  });

  it('a rejected decision does not consume a pending Claim notice', async () => {
    const adapter = new ScriptAdapter([textResponse('done')]); const flow = await flowHarness(adapter);
    try {
      const agent = await flow.create();
      await new ClaimStore(flow.knowledge.context()).write({ ...flow.claim, name: 'retry_notice' });
      const reject = flow.ctx.on('agent/pre-step', async (_payload, next) => { await next(); return { kind: 'reject' }; }, { prepend: true });
      await turn(agent); expect(adapter.requests).toHaveLength(0);
      reject(); await turn(agent);
      expect(JSON.stringify(adapter.requests[0])).toContain('retry_notice');
    } finally { await flow.close(); }
  });

  it('cancellation during request preparation does not advance the notice cursor', async () => {
    const adapter = new ScriptAdapter([textResponse('done')]); const flow = await flowHarness(adapter);
    try {
      const agent = await flow.create();
      await new ClaimStore(flow.knowledge.context()).write({ ...flow.claim, name: 'after_cancel' });
      const cancel = flow.ctx.on('agent/request', ({ agent: subject }, next) => { subject.cancel({ kind: 'user' }); return next(); });
      await turn(agent); expect(adapter.requests).toHaveLength(0);
      cancel(); await turn(agent);
      expect(JSON.stringify(adapter.requests[0])).toContain('after_cancel');
    } finally { await flow.close(); }
  });

  it('resumes a real persisted session with the same catalog and no duplicate notices', async () => {
    const adapter = new ScriptAdapter([textResponse('first'), textResponse('changed'), textResponse('resumed')]);
    const flow = await flowHarness(adapter, { persistence: true });
    try {
      const handle = await flow.ctx.agents.create({ sessionId: SessionId('resume-a'), agentOptions: { provider: 'mock', model: 'mock' } });
      const original = (await flow.ctx.systemPrompt.assemble(assembleContextFor(handle.agent))).sections.find((section) => section.name === 'acn:claim-catalog')?.text;
      await turn(handle.agent);
      await new ClaimStore(flow.knowledge.context()).write({ ...flow.claim, name: 'changed_before_resume' });
      await turn(handle.agent); await handle.dispose();
      const resumed = await flow.ctx.agents.resume({ resumeSessionId: SessionId('resume-a'), agentOptions: { provider: 'mock', model: 'mock' } });
      expect((await flow.ctx.systemPrompt.assemble(assembleContextFor(resumed.agent))).sections.find((section) => section.name === 'acn:claim-catalog')?.text).toBe(original);
      let noticeCount = 0;
      flow.ctx.on('session/event', (_session, event) => { if (event.type === 'user/message' && event.data.source.kind === 'acn-claim-changes') noticeCount += 1; });
      await turn(resumed.agent);
      expect(noticeCount).toBe(0);
      expect((await new SessionStateStore(flow.knowledge.context()).read('resume-a'))?.catalog).toBeDefined();
    } finally { await flow.close(); }
  });
});
