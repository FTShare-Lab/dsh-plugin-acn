// 真实宿主中拒绝继承能力与改写参数，并给模型可操作而不含正文的字段反馈。
import { describe, expect, it, vi } from 'vitest';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { dreamToolGuard } from '../../src/dsh-adapter/dream-agent.js';
import { DreamTools } from '../../src/dream/autonomous.js';
import { flowHarness } from './harness.js';
import { ScriptAdapter, textResponse, toolResponse } from './adapter.js';
import { applyValidated, finishDream } from '../dream/autonomous-helpers.js';
import { qualityDraft, until } from '../dream/helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { waitJob } from '../formation/helpers.js';
import { acquireFileLease } from '../../src/store/lock.js';
import { ClaimStore } from '../../src/store/claims.js';

describe('autonomous Dream host boundaries', () => {
  it('identifies missing and extra draft fields without including Claim contents', () => {
    const group = { ...qualityDraft([sampleClaim()]), reason: undefined, private_test_field: 'PRIVATE_BODY_MARKER' };
    const feedback = dreamToolGuard('dream_stage_group', { group_id: 'a', group });
    expect(feedback).toContain('group.reason: invalid_type'); expect(feedback).toContain('private_test_field'); expect(feedback).not.toContain('PRIVATE_BODY_MARKER');
    expect(dreamToolGuard('bash', {})).toContain('只能调用');
  });
  it.each([1, 2])('counts same-step host retries against a %i-request budget', async (limit) => {
    const adapter = new ScriptAdapter([[{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', status: 429, message: 'Transient test limit.' } } }], finishDream()]);
    const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'mock', model: 'mock' }, dream: { maxModelSteps: limit } } });
    try {
      f.ctx.on('agent/request-error', () => Promise.resolve({ kind: 'retry' }));
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      await waitJob(worker.queue, job.id);
      expect(adapter.requests).toHaveLength(2); expect((await f.knowledge.dreamStore().progress(job.id))?.autonomy?.steps).toBe(limit);
      if (limit === 1) expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('现在进行本次 Dream 的有限收尾');
    } finally { await f.close(); }
  });
  it('hard caps closing requests, drops pending drafts, and starts the next task from fresh Claims', async () => {
    const adapter = new ScriptAdapter([
      toolResponse('stage', 'dream_stage_group', { group_id: 'a', group: qualityDraft([sampleClaim()]) }),
      toolResponse('inspect-1', 'dream_read_draft', {}), toolResponse('inspect-2', 'dream_read_draft', {}), finishDream(),
    ]);
    const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'mock', model: 'mock' }, dream: { maxModelSteps: 1, maxWrapUpSteps: 2 } } });
    try {
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      expect((await waitJob(worker.queue, job.id)).result).toMatchObject({ budgetLimited: true, modelSteps: 1, wrapUpSteps: 2 });
      expect(adapter.requests).toHaveLength(3); expect((await f.knowledge.dreamStore().progress(job.id))?.entries[0]).toMatchObject({ status: 'skipped', draft: null });
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
      const changed = { ...f.claim, statement: 'NEW_CLAIM_VERSION_FOR_NEXT_DREAM' }; await new ClaimStore(f.knowledge.context()).write(changed);
      const next = await f.ctx.acnDream.request(); expect(next.id).not.toBe(job.id); await waitJob(worker.queue, next.id);
      expect((await f.knowledge.dreamStore().origin(next.id))?.claims).toEqual([changed]);
      expect(JSON.stringify(adapter.requests[3]?.messages)).toContain(changed.statement);
      expect((await f.knowledge.dreamStore().progress(next.id))?.entries).toEqual([]);
    } finally { await f.close(); }
  });
  it('allows a final validated commit and model summary within three closing requests', async () => {
    const adapter = new ScriptAdapter([
      toolResponse('stage', 'dream_stage_group', { group_id: 'a', group: qualityDraft([sampleClaim()]) }),
      toolResponse('validate', 'dream_validate', { group_id: 'a' }), applyValidated, finishDream(),
    ]);
    const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'mock', model: 'mock' }, dream: { maxModelSteps: 1 } } });
    try {
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      expect((await waitJob(worker.queue, job.id)).result).toMatchObject({ modelSteps: 1, wrapUpSteps: 3 });
      expect(adapter.requests).toHaveLength(4); expect((await f.knowledge.dreamStore().progress(job.id))?.entries[0]?.status).toBe('executed');
    } finally { await f.close(); }
  });
  it('requests final closure after a text-only last exploration response and terminates a text-only closure', async () => {
    const adapter = new ScriptAdapter([textResponse('Exploration notes.'), textResponse('No further changes.')]);
    const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'mock', model: 'mock' }, dream: { maxModelSteps: 1 } } });
    try {
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.'); await waitJob(worker.queue, job.id);
      expect(adapter.requests).toHaveLength(2); expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('有限收尾');
      expect((await f.knowledge.dreamStore().progress(job.id))?.discovery.review.quality).toContain('模型未提交收尾总结');
    } finally { await f.close(); }
  });
  it.each(['exploration', 'wrap-up'] as const)('does not restart or finalize after direct child cancellation during %s', async (phase) => {
    let child: Agent | undefined; const endings: string[] = [];
    const adapter = new ScriptAdapter([
      toolResponse('stage', 'dream_stage_group', { group_id: 'a', group: qualityDraft([sampleClaim()]) }),
      (request) => { if (!child || !request.signal) throw new Error('Missing running child.'); child.cancel({ kind: 'user' }); request.signal.throwIfAborted(); return textResponse('Cancelled request must not finish.'); },
      finishDream(),
    ]);
    const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'mock', model: 'mock' }, dream: { maxModelSteps: phase === 'exploration' ? 2 : 1 } } });
    try {
      f.ctx.on('agent/created', ({ agent }) => { if (agent.session.header.agentPreset === 'acn-dream') child = agent; });
      f.ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') endings.push(event.data.reason.kind); });
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      await until(async () => { const current = await worker.queue.read(job.id); return current?.state === 'failed' || current?.state === 'succeeded'; });
      expect(endings).toContain('aborted'); expect(adapter.requests).toHaveLength(2);
      expect((await worker.queue.read(job.id))?.state).toBe('failed');
      const progress = await f.knowledge.dreamStore().progress(job.id);
      expect(progress?.finished).toBe(false); expect(progress?.entries[0]?.status).toBe('pending'); expect(progress?.entries[0]?.draft).not.toBeNull();
      expect(await f.knowledge.dreamStore().final(job.id)).toBeNull(); expect(await f.knowledge.dreamStore().records(job.id)).toEqual([]);
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
    } finally { await f.close(); }
  });
  it.each(['cancel', 'timeout'] as const)('propagates child %s while apply waits for the knowledge lock', async (mode) => {
    let lease: Awaited<ReturnType<typeof acquireFileLease>> | undefined; let child: Agent | undefined;
    const timeoutMs = 10_001; const deadline = new AbortController(); const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const adapter = new ScriptAdapter([
      toolResponse('stage', 'dream_stage_group', { group_id: 'a', group: qualityDraft([sampleClaim()]) }),
      toolResponse('validate', 'dream_validate', { group_id: 'a' }),
      async (request) => {
        lease = await acquireFileLease(f.knowledge.context().paths.knowledgeLock);
        setTimeout(() => { if (mode === 'cancel') child?.cancel({ kind: 'parent' }); else deadline.abort(new DOMException('Test deadline elapsed.', 'TimeoutError')); }, 100);
        return applyValidated(request);
      },
    ]);
    const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'mock', model: 'mock', timeoutMs: mode === 'timeout' ? timeoutMs : 5000 } } });
    // 到达持锁场景后才触发期限，避免机器负载使测试提前在准备阶段超时。
    const timeoutSpy = mode === 'timeout' ? vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === timeoutMs ? deadline.signal : nativeTimeout(ms)) : undefined;
    try {
      f.ctx.on('agent/created', ({ agent }) => { if (agent.session.header.agentPreset === 'acn-dream') child = agent; });
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      await until(async () => { const current = await worker.queue.read(job.id); return current?.state === 'failed' || current?.state === 'queued' && current.lastError !== undefined; });
      expect(lease).toBeDefined(); expect(await f.knowledge.dreamStore().records(job.id)).toEqual([]);
      if (mode === 'timeout') { expect(timeoutSpy).toHaveBeenCalledWith(timeoutMs); expect((await worker.queue.read(job.id))?.lastError).toContain('Dream 超时'); }
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
      await f.ctx.acnDream.stop();
    } finally { await lease?.release(); await f.close(); timeoutSpy?.mockRestore(); }
  });
  it.each(['native', 'ptc'] as const)('isolates tools and required private context in %s mode', async (toolMode) => {
    const adapter = new ScriptAdapter([finishDream()]);
    const f = await flowHarness(adapter, { dream: true, memory: true, toolMode, config: { llm: { provider: 'mock', model: 'mock' } } });
    let unsafeCalls = 0; const checks: Promise<unknown>[] = [];
    try {
      f.ctx.systemPrompt.section({ name: 'private-system', order: 0, text: 'PRIVATE_CONTEXT_MARKER' });
      f.ctx.systemPrompt.context({ name: 'private-required', order: 0, text: 'PRIVATE_CONTEXT_MARKER', required: true });
      f.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }));
      for (const name of ['bash', 'edit', 'upload']) f.ctx.tools.register(defineTool({ name, description: 'Forbidden capability.', parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, execute: () => { unsafeCalls += 1; return Promise.resolve({}); } }));
      f.ctx.on('agent/created', ({ agent }) => {
        if (agent.session.header.agentPreset !== 'acn-dream') return;
        agent.ctx.tools.register(defineTool({ name: 'late_write', description: 'Forbidden late capability.', parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, execute: () => { unsafeCalls += 1; return Promise.resolve({}); } }));
        for (const name of ['bash', 'edit', 'memory', 'upload', 'run_code', 'late_write']) checks.push(f.ctx.tools.execute({ name, arguments: {}, agent, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal }));
      });
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.'); await waitJob(worker.queue, job.id);
      for (const result of await Promise.all(checks)) expect(result).toMatchObject({ isError: true }); expect(unsafeCalls).toBe(0);
      expect(JSON.stringify(adapter.requests)).not.toContain('PRIVATE_CONTEXT_MARKER'); expect(JSON.stringify(adapter.requests)).not.toContain('late_write');
      expect(adapter.requests[0]?.tools?.map((tool) => tool.name).sort()).toEqual(Object.keys(DreamTools).sort());
    } finally { await f.close(); }
  });
  it('lets a real host model correct invalid arguments from precise tool feedback', async () => {
    const adapter = new ScriptAdapter([
      toolResponse('bad', 'dream_stage_group', { group_id: 'a', group: { kind: 'quality', operations: [{ id: 'claim_00000001', action: 'deprecate', reason: 'One-time record.' }] } }),
      (request) => { expect(JSON.stringify(request.messages)).toContain('group.reason: invalid_type'); return finishDream(); },
    ]);
    const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'mock', model: 'mock' } } });
    try { const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.'); await waitJob(worker.queue, job.id); expect(adapter.requests).toHaveLength(2); }
    finally { await f.close(); }
  });
});
