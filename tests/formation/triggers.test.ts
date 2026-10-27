// 用持久投影验证阈值、归档边界与恢复，不把查看历史或内部消息当作人类交互。
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.js';
import { FormationStateSchema } from '../../src/formation/transcript.js';
import { idleTrigger } from '../../src/formation/triggers.js';
import { AcnFormation } from '../../src/formation/service.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import { emptyOutput, formationFixture, waitJob } from './helpers.js';

const at = 1_700_000_000_000;
const config = resolveConfig({}).formation;
const state = (turns: number) => FormationStateSchema.parse({ lastSeenSeq: 40, activityAt: at, completedTurns: Array.from({ length: turns }, (_, index) => index + 1) });
const entries = [{ seq: 40, type: 'assistant' as const, text: 'Verified a reusable boundary.' }];
function turn(service: AcnFormation, offset: number, time: number, text = 'Verified the retry contract.', human = true, completed = true): void {
  service.running('session-a');
  service.capture('session-a', { activity: { seq: offset, at: time, turn: 'start' } });
  service.capture('session-a', { route: { provider: 'mock', model: 'mock' }, entry: { seq: offset + 1, type: 'user', text }, activity: { seq: offset + 1, at: time, human } });
  service.capture('session-a', { entry: { seq: offset + 2, type: 'assistant', text: 'Checked the project contract.' }, activity: { seq: offset + 2, at: time } });
  service.capture('session-a', { activity: { seq: offset + 3, at: time, turn: completed ? 'completed' : 'ended' } });
  service.idle('session-a');
}

describe('incremental idle Recap thresholds', () => {
  it('uses ten completed human turns and five full idle minutes, or a one-hour tail', () => {
    expect(idleTrigger(config, state(10), entries, at + 299_999)).toBeUndefined();
    expect(idleTrigger(config, state(9), entries, at + 300_000)).toBeUndefined();
    expect(idleTrigger(config, state(10), entries, at + 300_000)).toBe('batch-idle');
    expect(idleTrigger(config, state(1), entries, at + 3_599_999)).toBeUndefined();
    expect(idleTrigger(config, state(1), entries, at + 3_600_000)).toBe('tail-idle');
  });
  it('admits the token threshold independently of turn count and counts only the pending range', () => {
    const large = [{ seq: 40, type: 'tool_result' as const, text: 'x'.repeat(400_000) }];
    expect(idleTrigger(config, state(1), [{ ...large[0], seq: 40, type: 'tool_result', text: 'x'.repeat(399_996) }], at + 300_000)).toBeUndefined();
    expect(idleTrigger(config, state(1), large, at + 300_000)).toBe('batch-idle');
    expect(idleTrigger(config, { ...state(10), recappedThroughSeq: 40 }, large, at + 3_600_000)).toBeUndefined();
    expect(idleTrigger(config, { ...state(10), recappedThroughSeq: 10 }, entries, at + 300_000)).toBeUndefined();
  });
  it('never admits empty, paused, archiving or explicitly disabled idle work', () => {
    for (const patch of [{ autoPaused: true }, { archiveIntent: 40 }]) expect(idleTrigger(config, { ...state(10), ...patch }, entries, at + 3_600_000)).toBeUndefined();
    expect(idleTrigger(config, state(10), [], at + 3_600_000)).toBeUndefined();
    expect(idleTrigger({ ...config, idleRecap: false }, state(10), entries, at + 3_600_000)).toBeUndefined();
  });
});

describe('durable Recap lifecycle', () => {
  it('manual Recap during a foreground turn only processes earlier completed turns', async () => {
    const inputs: string[] = [];
    const f = await formationFixture((_route, _system, input) => { inputs.push(input); return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); });
    try {
      await f.formation.start(); f.formation.running('session-a');
      f.formation.capture('session-a', { entry: { seq: 0, type: 'user', text: 'FIRST_PENDING' }, activity: { seq: 0, at: Date.now(), human: true }, route: { provider: 'mock', model: 'mock' } });
      expect(await f.formation.recap('session-a')).toBeNull();
      f.formation.capture('session-a', { activity: { seq: 1, at: Date.now(), turn: 'completed' } });
      f.formation.capture('session-a', { activity: { seq: 2, at: Date.now(), turn: 'start' } });
      f.formation.capture('session-a', { entry: { seq: 3, type: 'user', text: 'SECOND_PENDING' }, activity: { seq: 3, at: Date.now(), human: true } });
      const job = await f.formation.recap('session-a'); if (!job) throw new Error('Missing completed range');
      expect(job.payload['untilSeq']).toBe(0); await waitJob(f.formation.worker.queue, job.id);
      expect(inputs[0]).toContain('FIRST_PENDING'); expect(inputs[0]).not.toContain('SECOND_PENDING');
    } finally { await f.close(); }
  });
  it('manual Recap works below all thresholds, does not duplicate queued work, and creates no empty task', async () => {
    let calls = 0;
    const f = await formationFixture(() => { calls += 1; return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); });
    try {
      expect(await f.formation.recap('session-a')).toBeNull();
      turn(f.formation, 0, Date.now()); await f.formation.flush();
      const first = await f.formation.recap('session-a'); if (!first) throw new Error('Missing Recap');
      expect((await f.formation.recap('session-a'))?.id).toBe(first.id);
      await f.formation.start(); await waitJob(f.formation.worker.queue, first.id);
      expect(await f.formation.recap('session-a')).toBeNull(); expect(calls).toBe(1);
      expect(await f.formation.worker.queue.list()).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('counts successful human turns, excludes internal and aborted turns, and never resets idle time on attach', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    try {
      const now = Date.now(); await f.formation.start();
      for (let i = 0; i < 9; i++) turn(f.formation, i * 4, now);
      turn(f.formation, 36, now, 'Internal notification.', false);
      turn(f.formation, 40, now, 'Interrupted user request.', true, false);
      await f.formation.flush(); f.formation.attach('session-a'); await f.formation.flush();
      const before = await f.formation.transcript.state('session-a'); expect(before.activityAt).toBe(now); expect(before.completedTurns).toHaveLength(9);
      await f.formation.scan(now + 300_000); expect(await f.formation.worker.queue.list()).toEqual([]);
      turn(f.formation, 44, now); await f.formation.flush();
      f.formation.running('session-a'); await f.formation.scan(now + 300_000); expect(await f.formation.worker.queue.list()).toEqual([]);
      f.formation.idle('session-a'); await f.formation.scan(now + 300_000);
      const job = (await f.formation.worker.queue.list())[0]; if (!job) throw new Error('Missing batch Recap');
      expect(job).toMatchObject({ kind: 'recap', payload: { trigger: 'batch-idle', untilSeq: 46 } });
      await waitJob(f.formation.worker.queue, job.id);
      expect((await f.formation.transcript.state('session-a')).completedTurns).toEqual([]);
    } finally { await f.close(); }
  });
  it('queues a small tail only at one hour and does not silently retry a failed range every scan', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: 'invalid' }), { llm: { structuredRetries: 1 } });
    try {
      const now = Date.now(); await f.formation.start(); turn(f.formation, 0, now); await f.formation.flush();
      await f.formation.scan(now + 3_599_999); expect(await f.formation.worker.queue.list()).toEqual([]);
      await f.formation.scan(now + 3_600_000); const job = (await f.formation.worker.queue.list())[0]; if (!job) throw new Error('Missing tail Recap');
      expect(job.payload['trigger']).toBe('tail-idle'); await waitJob(f.formation.worker.queue, job.id, 'failed');
      await f.formation.scan(now + 7_200_000); expect(await f.formation.worker.queue.list()).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('does not enqueue automatic work without a model route', async () => {
    const f = await formationFixture(() => Promise.reject(new Error('No model call expected')));
    try {
      await f.formation.start(); const now = Date.now();
      f.formation.capture('session-a', { entry: { seq: 0, type: 'user', text: 'Pending task.' }, activity: { seq: 0, at: now, human: true } });
      await f.formation.scan(now + 3_600_000); expect(await f.formation.worker.queue.list()).toEqual([]);
    } finally { await f.close(); }
  });
  it('freezes archive Finalize before late results and resumes only on a real user message', async () => {
    const inputs: string[] = [];
    const f = await formationFixture((_route, _system, input) => { inputs.push(input); return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); });
    try {
      const now = Date.now(); await f.formation.start(); turn(f.formation, 0, now, 'ORIGINAL_TASK'); await f.formation.flush();
      const frozen = await f.formation.beginArchive('session-a', 3); if (frozen === null) throw new Error('Missing archive range');
      f.formation.capture('session-a', { entry: { seq: 4, type: 'tool_result', text: 'LATE_RESULT' }, activity: { seq: 4, at: now + 1 } });
      await f.formation.archived('session-a', frozen);
      const job = (await f.formation.worker.queue.list())[0]; if (!job) throw new Error('Missing archive Finalize'); await waitJob(f.formation.worker.queue, job.id);
      expect(job).toMatchObject({ kind: 'finalize', payload: { untilSeq: 2, trigger: 'archive' } });
      expect(inputs[0]).toContain('ORIGINAL_TASK'); expect(inputs[0]).not.toContain('LATE_RESULT');
      f.formation.attach('session-a'); await f.formation.reconcileArchives(new Set());
      turn(f.formation, 5, now + 2, 'INTERNAL_NOTICE', false); await f.formation.scan(now + 7_200_000);
      expect((await f.formation.transcript.state('session-a')).autoPaused).toBe(true); expect(await f.formation.recap('session-a')).toBeNull();
      expect(inputs).toHaveLength(1);
      turn(f.formation, 9, now + 3, 'USER_CONTINUES'); await f.formation.scan(now + 7_200_000);
      const next = (await f.formation.worker.queue.list()).find(j => j.id !== job.id); if (!next) throw new Error('Missing resumed Recap'); await waitJob(f.formation.worker.queue, next.id);
      expect(inputs).toHaveLength(2); expect(inputs[1]).toContain('USER_CONTINUES'); expect(inputs[1]).not.toContain('ORIGINAL_TASK');
    } finally { await f.close(); }
  });
  it.each([false, true])('reconciles a crash between archive intent and host completion (committed=%s)', async (committed) => {
    const inputs: string[] = []; const backend = (_route: object, _system: string, input: string) => { inputs.push(input); return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); };
    const f = await formationFixture(backend); let resumed: AcnFormation | undefined;
    try {
      const now = Date.now(); turn(f.formation, 0, now, 'ARCHIVE_RANGE'); await f.formation.flush();
      await f.formation.beginArchive('session-a', 3);
      f.formation.capture('session-a', { entry: { seq: 4, type: 'tool_result', text: 'LATE_RANGE' } }); await f.formation.flush(); await f.formation.close();
      resumed = new AcnFormation(f.knowledge, backend, await loadPromptRenderer(), { pollMs: 10 }); await resumed.start();
      expect(await resumed.worker.queue.list()).toEqual([]);
      await resumed.reconcileArchives(new Set(committed ? ['session-a'] : []));
      const current = await resumed.transcript.state('session-a'); expect(current.archiveIntent).toBeNull(); expect(current.autoPaused).toBe(committed);
      if (committed) { const job = (await resumed.worker.queue.list())[0]; if (!job) throw new Error('Missing recovered Finalize'); await waitJob(resumed.worker.queue, job.id); expect(inputs[0]).not.toContain('LATE_RANGE'); }
      else expect(inputs).toEqual([]);
    } finally { await resumed?.close(); await f.close(); }
  });
});
