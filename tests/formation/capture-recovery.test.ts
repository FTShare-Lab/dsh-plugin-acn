// 真实临时盘上的投影故障不能永久毒化形成队列，也不能越过丢失事件调用模型。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AcnFormation } from '../../src/formation/service.js';
import { TranscriptStore } from '../../src/formation/transcript.js';
import type { Projection } from '../../src/formation/transcript.js';
import { FormationCapture, formationFault, projectionError } from '../../src/formation/capture.js';
import { StoreError } from '../../src/store/errors.js';
import { JobError } from '../../src/worker/types.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import { displayMessage, messageInfo } from '../../src/interaction-messages.js';
import { emptyOutput, formationFixture, waitJob } from './helpers.js';

const entry = (seq: number): Projection => ({ route: { provider: 'example', model: 'example' }, entry: { seq, type: 'user', text: `Public event ${seq}` } });
const occupied = () => Object.assign(new Error('PRIVATE_PAYLOAD_MUST_NOT_LEAK'), { code: 'EPERM' });

describe('formation projection recovery', () => {
  it('continues closing past one failed session and coalesces concurrent shutdown calls', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }), { formation: { finalizeOnDispose: true } });
    const record = f.formation.transcript.record.bind(f.formation.transcript);
    vi.spyOn(f.formation.transcript, 'record').mockImplementation((id, projection) => id === 'session-a' && projection.entry !== undefined ? Promise.reject(occupied()) : record(id, projection));
    try {
      await f.formation.start(); f.formation.attach('session-a'); f.formation.attach('session-b');
      f.formation.capture('session-a', entry(0)); f.formation.capture('session-b', entry(1));
      await expect(f.formation.flush('session-a')).rejects.toMatchObject({ kind: 'transcript_occupied' });
      const first = f.formation.close(); const second = f.formation.close(); expect(first).toBe(second);
      await expect(first).resolves.toBeUndefined();
      const jobs = await f.formation.worker.queue.list(); expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ kind: 'finalize', sessionId: 'session-b' });
      expect(f.warnings.some((message) => message.includes('stage=enqueue') && message.includes('session=session-a'))).toBe(true);
    } finally { await f.close(); }
  });
  it('retries one occupied-file error and forms from both original events in order', async () => {
    const calls: string[] = []; const f = await formationFixture((_r, _s, input) => { calls.push(input); return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); });
    const record = f.formation.transcript.record.bind(f.formation.transcript); let failed = false;
    vi.spyOn(f.formation.transcript, 'record').mockImplementation(async (id, projection) => {
      if (!failed && projection.entry?.seq === 0) { failed = true; throw occupied(); }
      await record(id, projection);
    });
    try {
      await f.formation.start(); f.formation.capture('session-a', entry(0)); f.formation.capture('session-a', entry(2));
      const job = await f.formation.recap('session-a'); expect(job).not.toBeNull();
      if (job !== null) await waitJob(f.formation.worker.queue, job.id);
      expect(calls).toHaveLength(1); expect(calls[0]).toContain('Public event 0'); expect(calls[0]).toContain('Public event 2');
      expect((await f.formation.transcript.state('session-a')).recappedThroughSeq).toBe(2);
    } finally { await f.close(); }
  });
  it('retains the failed head and later events; another session remains usable and retry repairs the same job', async () => {
    let broken = true; const calls: string[] = []; const f = await formationFixture((_r, _s, input) => { calls.push(input); return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); });
    const record = f.formation.transcript.record.bind(f.formation.transcript); let attempts = 0;
    vi.spyOn(f.formation.transcript, 'record').mockImplementation(async (id, projection) => {
      if (id === 'session-a' && projection.entry?.seq === 0 && broken) { attempts += 1; throw occupied(); }
      await record(id, projection);
    });
    try {
      await f.formation.start(); f.formation.capture('session-a', entry(0)); f.formation.capture('session-a', entry(4));
      await expect(f.formation.flush('session-a')).rejects.toMatchObject({ kind: 'transcript_occupied' });
      expect(attempts).toBe(6); expect((await f.formation.transcript.state('session-a')).lastSeenSeq).toBe(-1);
      const failed = await f.formation.worker.enqueue('recap', { untilSeq: 4 }, 'session-a');
      const result = await waitJob(f.formation.worker.queue, failed.id, 'failed');
      expect(result.lastErrorKind).toBe('transcript_occupied'); expect(result.lastError).toContain('seq=0'); expect(result.lastError).not.toContain('PRIVATE_PAYLOAD');
      expect(calls).toEqual([]);
      f.formation.capture('session-b', entry(1)); const healthy = await f.formation.recap('session-b');
      if (healthy === null) throw new Error('Expected healthy recap'); await waitJob(f.formation.worker.queue, healthy.id);
      expect(calls).toHaveLength(1);
      broken = false; await f.formation.worker.retry(failed.id); await waitJob(f.formation.worker.queue, failed.id);
      expect(calls).toHaveLength(2); expect(calls[1]).toContain('Public event 0'); expect(calls[1]).toContain('Public event 4');
      expect((await f.formation.transcript.state('session-a')).recappedThroughSeq).toBe(4);
    } finally { await f.close(); }
  });
  it('recovers after an atomic state rename failed after the transcript append', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    const rename = fs.rename.bind(fs); let failed = false;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === f.knowledge.context().paths.sessionState('session-a') && !failed) { failed = true; throw occupied(); }
      await rename(from, to);
    });
    try {
      await f.formation.start(); f.formation.capture('session-a', entry(0)); await f.formation.flush('session-a');
      expect(failed).toBe(true); expect(await f.formation.transcript.read('session-a')).toEqual([entry(0).entry]);
      expect((await f.formation.transcript.state('session-a')).lastSeenSeq).toBe(0);
    } finally { spy.mockRestore(); await f.close(); }
  });
  it('does not turn idle scans, route writes or enqueue failures into transcript poison', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    const read = f.formation.transcript.read.bind(f.formation.transcript);
    const spy = vi.spyOn(f.formation.transcript, 'read');
    try {
      await f.formation.start(); f.formation.capture('session-a', entry(0)); await f.formation.flush();
      spy.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_SCAN'), { code: 'EIO' }));
      await f.formation.scan(Date.now() + 7_200_000); spy.mockImplementation(read);
      await expect(f.formation.flush('session-a')).resolves.toBeUndefined();
      const enqueue = vi.spyOn(f.formation.worker, 'enqueue').mockRejectedValueOnce(Object.assign(new Error('PRIVATE_QUEUE'), { code: 'EIO' }));
      f.formation.capture('session-a', {}, 0); await f.formation.flush('session-a');
      expect(enqueue).toHaveBeenCalled(); expect(f.warnings.join('\n')).toContain('stage=enqueue'); expect(f.warnings.join('\n')).not.toContain('PRIVATE_');
      const rename = fs.rename.bind(fs);
      const route = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (String(to) === f.knowledge.context().paths.lastRoute) throw occupied(); await rename(from, to); });
      f.formation.capture('session-b', entry(3)); await f.formation.flush('session-b'); route.mockRestore();
      expect(f.warnings.join('\n')).toContain('stage=route');
      const job = await f.formation.recap('session-b'); if (job !== null) await waitJob(f.formation.worker.queue, job.id);
    } finally { spy.mockRestore(); await f.close(); }
  });
  it('isolates a scan failure and still scans another eligible session', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    const state = f.formation.transcript.state.bind(f.formation.transcript);
    try {
      await f.formation.start(); f.formation.capture('session-a', entry(0)); f.formation.capture('session-b', entry(1)); await f.formation.flush();
      vi.spyOn(f.formation.transcript, 'state').mockImplementation(async (id) => { if (id === 'session-a') throw occupied(); return state(id); });
      await f.formation.scan(Date.now() + 7_200_000);
      expect((await f.formation.worker.queue.list()).some((job) => job.sessionId === 'session-b')).toBe(true);
      await expect(f.formation.flush('session-b')).resolves.toBeUndefined();
    } finally { await f.close(); }
  });
  it('uses retained original logs after restart to backfill old skipped seqs without replaying processed input', async () => {
    const inputs: string[] = []; const backend = (_r: object, _s: string, input: string) => { inputs.push(input); return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); };
    const f = await formationFixture(backend); let resumed: AcnFormation | undefined;
    try {
      const source = join(f.root, 'source-log.json'); await fs.writeFile(source, JSON.stringify([entry(0), entry(3), entry(9)]));
      await f.formation.transcript.record('session-a', entry(0)); await f.formation.transcript.advance('session-a', 'finalize', 0);
      // 模拟旧版一次失败后后继事件仍推进 lastSeenSeq，原事件 3 不在投影中。
      await f.formation.transcript.record('session-a', entry(9)); await f.formation.close();
      resumed = new AcnFormation(f.knowledge, backend, await loadPromptRenderer(), { pollMs: 10 }, undefined, undefined, async () => JSON.parse(await fs.readFile(source, 'utf8')) as Projection[]);
      await resumed.start(); const job = await resumed.recap('session-a'); if (job === null) throw new Error('Expected repaired recap');
      await waitJob(resumed.worker.queue, job.id);
      expect(inputs).toHaveLength(1); expect(inputs[0]).toContain('Public event 3'); expect(inputs[0]).toContain('Public event 9'); expect(inputs[0]).not.toContain('Public event 0');
      expect((await resumed.transcript.state('session-a')).finalizedThroughSeq).toBe(0);
    } finally { await resumed?.close(); await f.close(); }
  });
  it('refuses model calls when original logs cannot be replayed, then retries once the source returns', async () => {
    let available = false; const backend = vi.fn(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    const f = await formationFixture(backend); let resumed: AcnFormation | undefined;
    try {
      await f.formation.transcript.record('session-a', entry(9)); await f.formation.close();
      resumed = new AcnFormation(f.knowledge, backend, await loadPromptRenderer(), { pollMs: 10 }, undefined, undefined, () => available ? Promise.resolve([entry(3), entry(9)]) : Promise.reject(new JobError('transcript_source', 'PRIVATE_SOURCE')));
      await resumed.start(); const job = await resumed.worker.enqueue('recap', { untilSeq: 9 }, 'session-a');
      expect((await waitJob(resumed.worker.queue, job.id, 'failed')).lastErrorKind).toBe('transcript_source'); expect(backend).not.toHaveBeenCalled();
      available = true; await resumed.worker.retry(job.id); await waitJob(resumed.worker.queue, job.id); expect(backend).toHaveBeenCalledOnce();
    } finally { await resumed?.close(); await f.close(); }
  });
  it('keeps private results out of replay, preserves archive pause and refuses conflicting bodies', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    try {
      const transcript = f.formation.transcript;
      await transcript.record('session-a', { ...entry(5), activity: { seq: 5, at: 50, human: true } });
      await transcript.lifecycle('session-a', (state) => { state.autoPaused = true; state.archivedThroughSeq = 5; });
      const replay = [entry(1), { privateCallId: 'private-call' }, { entry: { seq: 3, type: 'tool_result' as const, text: 'PRIVATE_MEMORY' }, resultCallId: 'private-call', seenSourceIds: ['claim_deadbeef'] }, { ...entry(5), activity: { seq: 5, at: 50, human: true } }];
      await Promise.all([transcript.replay('session-a', replay), transcript.replay('session-a', replay)]);
      expect((await transcript.read('session-a')).map((row) => row.seq)).toEqual([1, 5]);
      expect(await transcript.state('session-a')).toMatchObject({ autoPaused: true, activityAt: 50, seenSourceIds: [] });
      await expect(transcript.replay('session-a', [{ entry: { seq: 5, type: 'user', text: 'Changed' } }])).rejects.toMatchObject({ kind: 'transcript' });
    } finally { await f.close(); }
  });
  it.each([
    { archived: true, human: true, afterBoundary: true },
    { archived: undefined, human: true, afterBoundary: true },
    { archived: false, human: false, afterBoundary: true },
    { archived: false, human: true, afterBoundary: false },
  ])('does not unpause for an archived, unverified or non-continuation replay: %j', async ({ archived, human, afterBoundary }) => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    try {
      const transcript = f.formation.transcript;
      await transcript.record('session-a', { ...entry(1), activity: { seq: 1, at: 10, human: true } });
      await transcript.lifecycle('session-a', (state) => { state.autoPaused = true; state.archivedThroughSeq = 1; });
      const seq = afterBoundary ? 3 : 1;
      await transcript.replay('session-a', [
        { ...entry(seq), activity: { seq, at: 30, ...(human ? { human: true } : {}) } },
        { sourceSeq: 4, ...(archived === undefined ? {} : { sourceArchived: archived }) },
      ]);
      expect(await transcript.state('session-a')).toMatchObject({ autoPaused: true, activityAt: 10 });
    } finally { await f.close(); }
  });
  it('restores a missed unpause even when a later activity cursor was already saved', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    try {
      const transcript = f.formation.transcript;
      await transcript.record('session-a', entry(1)); await transcript.advance('session-a', 'finalize', 1);
      await transcript.lifecycle('session-a', (state) => { state.autoPaused = true; state.archivedThroughSeq = 1; state.activitySeq = 5; state.activityAt = 10; });
      await transcript.replay('session-a', [
        { ...entry(3), activity: { seq: 3, at: 30, human: true } },
        { entry: { seq: 4, type: 'assistant', text: 'Verified continuation.' }, activity: { seq: 4, at: 40 } },
        { activity: { seq: 5, at: 50, turn: 'completed' } }, { sourceSeq: 6, sourceArchived: false },
      ]);
      expect(await transcript.state('session-a')).toMatchObject({ autoPaused: false, activityAt: 50, activitySeq: 5 });
      expect((await transcript.read('session-a')).map((row) => row.seq)).toEqual([3, 4]);
    } finally { await f.close(); }
  });
  it('removes private results already mispersisted after an earlier private-call marker failure', async () => {
    const inputs: string[] = []; const backend = (_r: object, _s: string, input: string) => { inputs.push(input); return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); };
    const f = await formationFixture(backend); let resumed: AcnFormation | undefined;
    try {
      await f.formation.transcript.record('session-a', entry(0));
      const leaked: Projection = { entry: { seq: 3, type: 'tool_result', text: 'PRIVATE_RESULT_MUST_BE_REMOVED' }, resultCallId: 'private-call' };
      await f.formation.transcript.record('session-a', leaked); await f.formation.close();
      resumed = new AcnFormation(f.knowledge, backend, await loadPromptRenderer(), { pollMs: 10 }, undefined, undefined, () => Promise.resolve([entry(0), { privateCallId: 'private-call' }, leaked]));
      await resumed.start(); expect((await resumed.transcript.read('session-a')).map((row) => row.seq)).toEqual([0]);
      const job = await resumed.recap('session-a'); if (job === null) throw new Error('Expected public Recap'); await waitJob(resumed.worker.queue, job.id);
      expect(inputs).toHaveLength(1); expect(inputs[0]).not.toContain('PRIVATE_RESULT'); expect(inputs[0]).toContain('Public event 0');
    } finally { await resumed?.close(); await f.close(); }
  });
  it('keeps archive recovery isolated and later scans dispatch its frozen Finalize exactly once', async () => {
    let available = false; const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) })); let resumed: AcnFormation | undefined;
    try {
      await f.formation.transcript.record('session-a', entry(2)); await f.formation.transcript.lifecycle('session-a', (state) => { state.archiveIntent = 2; });
      await f.formation.transcript.record('session-b', entry(4)); await f.formation.close();
      resumed = new AcnFormation(f.knowledge, () => Promise.resolve({ text: JSON.stringify(emptyOutput()) }), await loadPromptRenderer(), { pollMs: 10 }, undefined, undefined, (id) => {
        if (id === 'session-a' && !available) return Promise.reject(new JobError('transcript_source', 'Source unavailable'));
        return Promise.resolve([id === 'session-a' ? entry(2) : entry(4)]);
      });
      await expect(resumed.reconcileArchives(new Set(['session-a']))).resolves.toBeUndefined(); await resumed.start();
      expect(await resumed.transcript.state('session-a')).toMatchObject({ autoPaused: true, archivePending: true, archivedThroughSeq: 2 });
      const healthy = await resumed.recap('session-b'); if (healthy === null) throw new Error('Expected healthy Recap'); await waitJob(resumed.worker.queue, healthy.id);
      available = true; await resumed.scan(); await resumed.scan();
      const archived = (await resumed.worker.queue.list()).filter((job) => job.sessionId === 'session-a'); expect(archived).toHaveLength(1);
      const archive = archived[0]; if (archive === undefined) throw new Error('Expected archived Finalize');
      expect(archive).toMatchObject({ kind: 'finalize', payload: { untilSeq: 2, trigger: 'archive' } }); await waitJob(resumed.worker.queue, archive.id);
      expect(await resumed.transcript.state('session-a')).toMatchObject({ archivePending: false, autoPaused: true, finalizedThroughSeq: 2 });
    } finally { await resumed?.close(); await f.close(); }
  });
  it('refuses a shorter source log before accepting an unverifiable old private result', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    try {
      await f.formation.transcript.record('session-a', entry(0));
      await f.formation.transcript.record('session-a', { entry: { seq: 9, type: 'tool_result', text: 'UNVERIFIABLE_PRIVATE_RESULT' } });
      await expect(f.formation.transcript.replay('session-a', [entry(0), { sourceSeq: 4 }])).rejects.toMatchObject({ kind: 'transcript_source' });
      expect((await f.formation.transcript.state('session-a')).recappedThroughSeq).toBe(-1);
    } finally { await f.close(); }
  });
  it.each([true, false])('retries archive reconciliation after an early state read or cancellation failure, archived=%s', async (archived) => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    try {
      await f.formation.transcript.record('session-a', entry(2)); await f.formation.transcript.lifecycle('session-a', (state) => { state.archiveIntent = 2; });
      const state = f.formation.transcript.state.bind(f.formation.transcript); let broken = true;
      const read = vi.spyOn(f.formation.transcript, 'state').mockImplementation((id) => broken ? Promise.reject(occupied()) : state(id));
      await expect(f.formation.reconcileArchives(new Set(archived ? ['session-a'] : []))).resolves.toBeUndefined();
      broken = false; read.mockRestore();
      if (!archived) vi.spyOn(f.formation.transcript, 'lifecycle').mockRejectedValueOnce(occupied());
      await f.formation.start(); await f.formation.scan();
      const after = await state('session-a'); expect(after.archiveIntent).toBeNull(); expect(after.autoPaused).toBe(archived);
      if (archived) {
        const jobs = await f.formation.worker.queue.list(); expect(jobs).toHaveLength(1);
        const job = jobs[0]; if (job === undefined) throw new Error('Expected archive job'); await waitJob(f.formation.worker.queue, job.id);
      } else expect((await f.formation.recap('session-a'))?.kind).toBe('recap');
    } finally { await f.close(); }
  });
  it.each([['ENOSPC', 'transcript_space'], ['EDQUOT', 'transcript_space'], ['EPERM', 'transcript_occupied'], ['EBUSY', 'transcript_occupied'], ['EIO', 'transcript_io']])('classifies nested %s without revealing exception text', (code, kind) => {
    const error = new StoreError('io', 'PRIVATE_PATH', { cause: Object.assign(new Error('PRIVATE_BODY'), { code }) });
    expect(formationFault(error)).toBe(code); const result = projectionError(error, 'projection', 41);
    expect(result.kind).toBe(kind); expect(result.message).toContain('seq=41'); expect(result.message).not.toContain('PRIVATE');
    expect(displayMessage(result.message, (_zh, en) => en, messageInfo(result.message, result.kind))).toContain('retry');
  });
  it('does not keep retrying invalid oversized input or silently discard the gap', async () => {
    const f = await formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
    try {
      const small = new TranscriptStore(f.knowledge.context(), 100); const capture = new FormationCapture(small);
      const record = vi.spyOn(small, 'record'); capture.add('session-a', { entry: { seq: 0, type: 'user', text: 'x'.repeat(200) } }); capture.add('session-a', entry(1));
      await expect(capture.prepare('session-a')).rejects.toMatchObject({ kind: 'transcript_limit' }); expect(record).toHaveBeenCalledOnce();
      expect((await small.state('session-a')).lastSeenSeq).toBe(-1);
    } finally { await f.close(); }
  });
});
