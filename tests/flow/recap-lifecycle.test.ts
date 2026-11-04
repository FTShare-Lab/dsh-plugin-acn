// 使用宿主真实归档注册表及生产循环验证触发、暂停与命令，边界时间由扫描参数控制。
import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import Formation from '../../src/plugins/formation.js';
import { TranscriptStore } from '../../src/formation/transcript.js';
import { emptyOutput, waitJob } from '../formation/helpers.js';
import { flowHarness, turn } from './harness.js';
import { ScriptAdapter, textResponse } from './adapter.js';

const formed = () => textResponse(JSON.stringify(emptyOutput()));
describe('host Recap lifecycle', () => {
  it.each(['agent-a', 'agent-b'])('ignores the old draft configuration when archiving after reload, selected Agent ID=%s', async (agentId) => {
    const adapter = new ScriptAdapter([textResponse('Selected work is complete.'), formed()]);
    const f = await flowHarness(adapter, { formation: true, workspace: true, config: {
      upstream: 'alpha', upstreams: { alpha: { agentId: 'agent-a' }, beta: { agentId } },
      llm: { provider: 'mock', model: 'mock' }, dream: { enabled: false }, memory: { review: { enabled: false } },
      formation: { idleRecap: false, finalizeIdleMinutes: 0, finalizeOnDispose: false },
    } });
    try {
      const agent = await f.create(); const old = await f.ctx.acnRuntime.service(agent.session.header);
      if (old.formation === undefined) throw new Error('Missing original formation');
      await old.formation.flush(agent.session.id);
      await f.ctx.acnRuntime.select(agent.session.header, 'beta'); await turn(agent, 'SELECTED_TASK');
      await f.fibers.formation?.dispose(); await f.ctx.plugin(Formation);
      // 组件重新启用是异步的，等待服务就绪后再检查真实归档入口。
      const selected = await f.ctx.acnRuntime.service(agent.session.header);
      if (selected.formation === undefined) throw new Error('Missing selected formation');
      await f.ctx.workspaceRegistry.archiveSession(agent.session.id);
      expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(agent.session.id);
      const jobs = await selected.formation.worker.queue.list(); expect(jobs).toHaveLength(1);
      const job = jobs[0]; if (job === undefined) throw new Error('Missing selected Finalize');
      await waitJob(selected.formation.worker.queue, job.id);
      expect(await old.formation.worker.queue.list()).toEqual([]);
      expect(await old.formation.transcript.state(agent.session.id)).toMatchObject({ archiveIntent: null, autoPaused: false });
      expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('SELECTED_TASK');
    } finally { await f.close(); }
  });
  it.each(['recap', 'finalize'] as const)('recovers unarchived real continuation after a projection failure and permits %s', async (kind) => {
    const adapter = new ScriptAdapter([textResponse('Archived answer.'), formed(), textResponse('Recovered continuation answer.'), formed()]);
    const f = await flowHarness(adapter, { formation: true, workspace: true, config: { formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false } } });
    try {
      const agent = await f.create(); const original = f.ctx.acnFormation; const registry = f.ctx.workspaceRegistry;
      await turn(agent, 'ARCHIVED_TASK'); await original.flush(); await registry.archiveSession(agent.session.id);
      const archivedJob = (await original.worker.queue.list())[0]; if (archivedJob === undefined) throw new Error('Missing initial Finalize');
      await waitJob(original.worker.queue, archivedJob.id); await registry.unarchiveSession(agent.session.id);
      const record = original.transcript.record.bind(original.transcript);
      vi.spyOn(original.transcript, 'record').mockImplementation((id, projection) => projection.activity?.human
        ? Promise.reject(Object.assign(new Error('Private fault detail'), { code: 'EACCES' })) : record(id, projection));
      await turn(agent, 'RESUMED_TASK'); await f.ctx.sessionPersistence.flush();
      await expect(original.flush(agent.session.id)).rejects.toMatchObject({ kind: 'transcript_occupied' });
      expect((await original.transcript.state(agent.session.id)).autoPaused).toBe(true);
      await f.fibers.formation?.dispose(); await f.ctx.plugin(Formation);
      const restored = f.ctx.acnFormation;
      expect((await restored.transcript.state(agent.session.id)).autoPaused).toBe(false);
      const job = await restored[kind](agent.session.id); if (job === null) throw new Error('Recovered continuation was not queued');
      expect(Number(job.payload['untilSeq'])).toBeGreaterThan(Number(archivedJob.payload['untilSeq']));
      await waitJob(restored.worker.queue, job.id);
      const input = JSON.stringify(adapter.requests[3]?.messages);
      expect(input).toContain('RESUMED_TASK'); expect(input).toContain('Recovered continuation answer.'); expect(input).not.toContain('ARCHIVED_TASK');
      expect(adapter.requests).toHaveLength(4);
    } finally { await f.close(); }
  });
  it('reconciles existing host archives before scanning an overdue migrated transcript', async () => {
    const adapter = new ScriptAdapter([textResponse('Verified old contract.'), formed()]);
    const f = await flowHarness(adapter, { workspace: true });
    try {
      const agent = await f.create(); await turn(agent); await f.ctx.workspaceRegistry.archiveSession(agent.session.id);
      const transcript = new TranscriptStore(f.knowledge.context());
      await transcript.record(agent.session.id, { entry: { seq: 2, type: 'user', text: 'Existing archived increment.' }, route: { provider: 'mock', model: 'mock' }, activity: { seq: 2, at: Date.now() - 7_200_000, human: true } });
      await f.ctx.plugin(Formation);
      const jobs = await f.ctx.acnFormation.worker.queue.list(); expect(jobs).toHaveLength(1);
      const job = jobs[0]; if (!job) throw new Error('Missing archive recovery');
      expect(job).toMatchObject({ kind: 'finalize', payload: { trigger: 'archive' } }); await waitJob(f.ctx.acnFormation.worker.queue, job.id);
      expect((await transcript.state(agent.session.id)).autoPaused).toBe(true);
    } finally { await f.close(); }
  });
  it('registers /recap, excludes empty and repeated work, and counts real completed human turns', async () => {
    const adapter = new ScriptAdapter([textResponse('Verified contract.'), formed(), textResponse('Continued.')]);
    const f = await flowHarness(adapter, { formation: true, workspace: true });
    try {
      const agent = await f.create(); const formation = f.ctx.acnFormation;
      const run = () => f.ctx.commands.execute(agent, '/recap', [], new AbortController().signal);
      expect(JSON.stringify(await run())).toContain('未创建任务');
      await turn(agent); await formation.flush();
      expect((await formation.transcript.state(agent.session.id)).completedTurns).toHaveLength(1);
      await run(); const job = (await formation.worker.queue.list())[0]; if (!job) throw new Error('Missing manual Recap');
      await waitJob(formation.worker.queue, job.id);
      expect(JSON.stringify(await run())).toContain('未创建任务'); expect(adapter.requests).toHaveLength(2);
      await turn(agent); await formation.flush(); expect((await formation.transcript.state(agent.session.id)).completedTurns).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('normal archive freezes Finalize, reload retains pause, and unarchive alone cannot resume', async () => {
    const adapter = new ScriptAdapter([textResponse('First contract.'), formed(), textResponse('Second contract.'), formed()]);
    const f = await flowHarness(adapter, { formation: true, workspace: true });
    try {
      const agent = await f.create(); let formation = f.ctx.acnFormation; const registry = f.ctx.workspaceRegistry;
      await turn(agent, 'FIRST_RANGE'); await formation.flush();
      await registry.archiveSession(agent.session.id);
      const job = (await formation.worker.queue.list())[0]; if (!job) throw new Error('Missing archive Finalize');
      expect(job).toMatchObject({ kind: 'finalize', payload: { trigger: 'archive' } }); await waitJob(formation.worker.queue, job.id);
      expect((await formation.transcript.state(agent.session.id)).autoPaused).toBe(true);
      await f.fibers.formation?.dispose(); expect(Object.hasOwn(registry, 'archiveSession')).toBe(false);
      await f.ctx.plugin(Formation); formation = f.ctx.acnFormation;
      await registry.unarchiveSession(agent.session.id); formation.attach(agent.session.id); await formation.scan(Date.now() + 7_200_000);
      expect((await formation.transcript.state(agent.session.id)).autoPaused).toBe(true); expect(adapter.requests).toHaveLength(2);
      await turn(agent, 'SECOND_RANGE'); await formation.flush();
      expect((await formation.transcript.state(agent.session.id)).autoPaused).toBe(false);
      await registry.archiveSession(agent.session.id);
      const next = (await formation.worker.queue.list()).find(x => x.id !== job.id); if (!next) throw new Error('Missing second archive'); await waitJob(formation.worker.queue, next.id);
      expect(JSON.stringify(adapter.requests[3]?.messages)).toContain('SECOND_RANGE'); expect(JSON.stringify(adapter.requests[3]?.messages)).not.toContain('FIRST_RANGE');
    } finally { await f.close(); }
  });
  it('refuses ordinary archive while running, rolls back the intent, and supports archive with stop', async () => {
    let ready: (() => void) | undefined;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const adapter = new ScriptAdapter([async request => {
      ready?.();
      await new Promise<void>(resolve => { request.signal?.addEventListener('abort', () => { resolve(); }, { once: true }); });
      return textResponse('LATE_ANSWER');
    }, formed()]);
    const f = await flowHarness(adapter, { formation: true, workspace: true });
    try {
      const agent = await f.create(); const formation = f.ctx.acnFormation;
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'RUNNING_TASK' }], source: { kind: 'user' } })); await started; await formation.flush();
      await expect(f.ctx.workspaceRegistry.archiveSession(agent.session.id)).rejects.toMatchObject({ name: 'WorkspaceActiveSessionError' });
      expect((await formation.transcript.state(agent.session.id)).archiveIntent).toBeNull(); expect(await formation.worker.queue.list()).toEqual([]);
      // 故障注入：模拟归档请求后到达的内部通知，保持宿主日志的合法消息结构。
      f.ctx.on('workspace/session-stop', () => {
        agent.session.append('user/message', createUserMessage({ source: { kind: 'acn-formation' }, content: [{ type: 'text', text: 'LATE_NOTICE' }] }), { surfaceOp: 'append' });
      });
      await f.ctx.workspaceRegistry.archiveSession(agent.session.id, { stopActivity: true }); await agent.whenIdle();
      const job = (await formation.worker.queue.list())[0]; if (!job) throw new Error('Missing cancelled archive Finalize'); await waitJob(formation.worker.queue, job.id);
      expect((await formation.transcript.state(agent.session.id)).autoPaused).toBe(true);
      expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('RUNNING_TASK'); expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('LATE_ANSWER');
      expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('LATE_NOTICE');
      expect((await formation.transcript.state(agent.session.id)).lastSeenSeq).toBeGreaterThan(Number(job.payload['untilSeq']));
    } finally { await f.close(); }
  });
  it('archives an empty attached session without a job, rejects unknown sessions, and ignores child /recap', async () => {
    const f = await flowHarness(new ScriptAdapter([]), { formation: true, workspace: true });
    try {
      const agent = await f.create(); await f.ctx.workspaceRegistry.archiveSession(agent.session.id);
      expect((await f.ctx.acnFormation.transcript.state(agent.session.id)).autoPaused).toBe(true);
      await expect(f.ctx.workspaceRegistry.archiveSession(SessionId('missing'))).rejects.toMatchObject({ name: 'WorkspaceUnknownSessionError' });
      const child = await f.ctx.agents.create({ sessionId: SessionId('child'), meta: { origin: 'subagent' }, agentOptions: { provider: 'mock', model: 'mock' } });
      const result = await f.ctx.commands.execute(child.agent, '/recap', [], new AbortController().signal); expect(result?.result.kind).toBe('error');
      expect(await f.ctx.acnFormation.worker.queue.list()).toEqual([]);
    } finally { await f.close(); }
  });
});
