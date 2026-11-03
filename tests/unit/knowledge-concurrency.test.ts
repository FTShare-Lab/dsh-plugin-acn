// 用真实磁盘和可控读取屏障核对整批快照、写后通知和冻结游标的并发边界。
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeBusy } from '../../src/knowledge/alignment.js';
import { KnowledgeSessions } from '../../src/knowledge/sessions.js';
import { ClaimStore } from '../../src/store/claims.js';
import { LockTimeoutError, StoreError } from '../../src/store/errors.js';
import { acquireFileLease, withFileLock } from '../../src/store/lock.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { ClaimIdSchema } from '../../src/protocol/ids.js';
import { formationFixture, emptyOutput } from '../formation/helpers.js';
import { executeClaim } from '../../src/tools/claim.js';
import { TranscriptStore } from '../../src/formation/transcript.js';
import { InboxStore } from '../../src/store/inbox.js';
import { inboxMessage } from '../team/helpers.js';
import { prepared } from '../dream/helpers.js';
import { nowSeconds } from '../../src/protocol/time.js';

const fixture = () => formationFixture(() => Promise.resolve({ text: JSON.stringify(emptyOutput()) }));
function gate() { let open = () => {}; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; }

describe('knowledge read and publication conflicts', () => {
  it.each(['list', 'read', 'traces', 'read_trace', 'update'])('reports %s lock contention as a retryable tool result without exposing paths', async (action) => {
    const f = await fixture(); const context = f.knowledge.context(); const claim = await new ClaimStore(context).write(sampleClaim());
    const { revision } = await f.knowledge.readClaim(claim.id); context.lockTimeoutMs = 0;
    const lease = await acquireFileLease(context.paths.knowledgeLock);
    try {
      const args = action === 'list' || action === 'traces' ? { action } : action === 'update' ? { action, id: claim.id, expected_revision: revision, name: 'not-written' } : { action, id: action === 'read_trace' ? 'trace_00000001' : claim.id };
      const result = await executeClaim(f.knowledge, args);
      expect(result).toMatchObject({ error: { kind: 'knowledge_busy', retryable: true } }); expect(JSON.stringify(result)).not.toContain(context.paths.root);
      expect(await new ClaimStore(context).read(claim.id)).toEqual(claim);
    } finally { await lease.release(); await f.close(); }
  });
  it('cancels a contended CAS update without writing or converting cancellation into a busy result', async () => {
    const f = await fixture(); const context = f.knowledge.context(); const claim = await new ClaimStore(context).write(sampleClaim());
    const { revision } = await f.knowledge.readClaim(claim.id); const lease = await acquireFileLease(context.paths.knowledgeLock);
    const controller = new AbortController(); const reason = new Error('Cancelled knowledge operation.');
    try {
      const updating = executeClaim(f.knowledge, { action: 'update', id: claim.id, expected_revision: revision, name: 'not-written' }, controller.signal);
      controller.abort(reason); await expect(updating).rejects.toBe(reason); expect(await new ClaimStore(context).read(claim.id)).toEqual(claim);
    } finally { await lease.release(); await f.close(); }
  });
  it('returns one complete snapshot while a cooperative multi-Claim writer waits', async () => {
    const f = await fixture(); const context = f.knowledge.context(); const store = new ClaimStore(context);
    const before = [sampleClaim(), sampleClaim({ id: ClaimIdSchema.parse('claim_00000002') })];
    for (const claim of before) await store.write(claim);
    const firstRead = gate(); const releaseRead = gate(); const nativeRead = fs.readFile.bind(fs); let intercepted = false;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const value = await nativeRead(...args);
      if (!intercepted && typeof args[0] === 'string' && args[0] === context.paths.claim(before[0]?.id ?? 'claim_00000001')) { intercepted = true; firstRead.open(); await releaseRead.promise; }
      return value;
    });
    let reader: ReturnType<typeof f.knowledge.snapshot> | undefined; let writer: Promise<void> | undefined; let written = false;
    try {
      reader = f.knowledge.snapshot(); await firstRead.promise;
      writer = withFileLock(context.paths.knowledgeLock, async () => { for (const claim of before) await store.write({ ...claim, name: 'committed-new-name' }); written = true; });
      await Promise.race([writer, delay(100)]);
      expect(written).toBe(false); releaseRead.open();
      expect((await reader).claims.map((claim) => claim.name)).toEqual(before.map((claim) => claim.name));
      await writer; expect((await f.knowledge.snapshot()).claims.every((claim) => claim.name === 'committed-new-name')).toBe(true);
    } finally { releaseRead.open(); await Promise.allSettled([reader, writer]); spy.mockRestore(); await f.close(); }
  });
  it.each(['busy', 'timeout', 'storage'] as const)('does not report an already committed CAS update as failed when its notice refresh encounters %s', async (mode) => {
    const f = await fixture(); const claim = await new ClaimStore(f.knowledge.context()).write(sampleClaim());
    const { revision } = await f.knowledge.readClaim(claim.id); const listener = vi.fn(); f.knowledge.onClaimsChanged(listener);
    const failure = mode === 'busy' ? new KnowledgeBusy() : mode === 'timeout' ? new LockTimeoutError('neutral-lock') : new StoreError('decode', 'PRIVATE_STORAGE_ERROR');
    const spy = vi.spyOn(f.knowledge, 'knowledgeVersion').mockRejectedValueOnce(failure);
    try {
      await expect(f.knowledge.updateClaim({ id: claim.id, expected_revision: revision, name: 'successfully-committed' })).resolves.toMatchObject({ claim: { name: 'successfully-committed' } });
      expect((await new ClaimStore(f.knowledge.context()).read(claim.id)).name).toBe('successfully-committed');
      expect(listener).not.toHaveBeenCalled(); expect(f.warnings.join('')).not.toContain('PRIVATE_');
    } finally { spy.mockRestore(); await f.close(); }
  });
  it('never creates an empty initial catalog by swallowing a busy baseline', async () => {
    const f = await fixture(); const sessions = new KnowledgeSessions(f.knowledge); const spy = vi.spyOn(f.knowledge, 'snapshot').mockRejectedValueOnce(new KnowledgeBusy());
    try { await expect(sessions.freeze('first-session', 'startup')).rejects.toBeInstanceOf(KnowledgeBusy); expect(sessions.catalog('first-session')).toBe(''); }
    finally { spy.mockRestore(); await f.close(); }
  });
  it('cancels first baseline creation while the knowledge lock is held', async () => {
    const f = await fixture(); const sessions = new KnowledgeSessions(f.knowledge); const context = f.knowledge.context();
    const lease = await acquireFileLease(context.paths.knowledgeLock); const controller = new AbortController(); const reason = new Error('Cancelled baseline.');
    const entered = gate(); const nativeSnapshot = f.knowledge.snapshot.bind(f.knowledge);
    const spy = vi.spyOn(f.knowledge, 'snapshot').mockImplementation((...args) => { entered.open(); return nativeSnapshot(...args); });
    try {
      const freezing = sessions.freeze('new-session', 'startup', undefined, false, controller.signal);
      await entered.promise; controller.abort(reason); await expect(freezing).rejects.toBe(reason); expect(sessions.catalog('new-session')).toBe('');
      await expect(fs.access(context.paths.sessionState('new-session'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { spy.mockRestore(); await lease.release(); await f.close(); }
  });
  it.each(['formation', 'inbox'] as const)('cancels %s before acquiring the submission lock without preparing a journal', async (kind) => {
    const f = await fixture(); const context = f.knowledge.context(); const claim = await new ClaimStore(context).write(sampleClaim());
    const message = inboxMessage(); await new InboxStore(context).acceptPulled(message);
    const lease = await acquireFileLease(context.paths.knowledgeLock); const controller = new AbortController(); const reason = new Error('Cancelled before prepared.');
    const control = { signal: controller.signal, prepared: vi.fn() }; const plan = { claims: [{ ...claim, name: 'not-written' }], disputes: [], usedClaimIds: [], warnings: [] };
    try {
      const writing = kind === 'formation' ? f.knowledge.applyFormation({ sessionId: 'session-a', jobId: 'job-a', kind: 'finalize', fromSeq: -1, untilSeq: 0, analysisClaims: [claim], prepared: plan, task: 'Review.' }, control) : f.knowledge.applyInboxEffect([message], [claim], plan, control);
      controller.abort(reason); await expect(writing).rejects.toBe(reason); expect(control.prepared).not.toHaveBeenCalled();
      expect(await new ClaimStore(context).read(claim.id)).toEqual(claim);
      await expect(fs.access(kind === 'formation' ? context.paths.finalizeCheckpoint('session-a') : context.paths.inboxEffect(message.id))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await lease.release(); await f.close(); }
  });
  it('cancels post-commit notification waiting without undoing or misreporting the saved Claim', async () => {
    const f = await fixture(); const context = f.knowledge.context(); const store = new ClaimStore(context); const claim = await store.write(sampleClaim());
    const { revision } = await f.knowledge.readClaim(claim.id); const controller = new AbortController(); const reason = new Error('Cancelled after commit.');
    const waiting = gate(); let release = async () => {}; const nativeVersion = f.knowledge.knowledgeVersion.bind(f.knowledge);
    const spy = vi.spyOn(f.knowledge, 'knowledgeVersion').mockImplementation(async (...args) => {
      const lease = await acquireFileLease(context.paths.knowledgeLock); release = () => lease.release(); waiting.open(); return nativeVersion(...args);
    });
    try {
      const writing = f.knowledge.updateClaim({ id: claim.id, expected_revision: revision, name: 'already-saved' }, controller.signal);
      await waiting.promise; controller.abort(reason); await expect(writing).resolves.toMatchObject({ claim: { name: 'already-saved' } });
      expect((await store.read(claim.id)).name).toBe('already-saved');
    } finally { await release(); spy.mockRestore(); await f.close(); }
  });
  it('does not swallow cancellation during an incremental refresh', async () => {
    const f = await fixture(); const sessions = new KnowledgeSessions(f.knowledge); await sessions.freeze('session-a', 'startup');
    const controller = new AbortController(); const reason = new Error('Cancelled refresh.');
    const spy = vi.spyOn(f.knowledge, 'snapshot').mockImplementation(() => { controller.abort(reason); return Promise.reject(new LockTimeoutError('neutral-lock')); });
    try { await expect(sessions.prepare('session-a', controller.signal)).rejects.toBe(reason); }
    finally { spy.mockRestore(); await f.close(); }
  });
  it.each(['formation', 'inbox', 'dream'] as const)('keeps readers behind a partially written %s batch and tolerates a post-commit notice conflict', async (kind) => {
    const f = await fixture(); const context = f.knowledge.context(); const store = new ClaimStore(context);
    const before = [sampleClaim(), sampleClaim({ id: ClaimIdSchema.parse('claim_00000002') })]; for (const claim of before) await store.write(claim);
    const plan = { claims: before.map((claim) => ({ ...claim, name: 'committed-batch' })), disputes: [], usedClaimIds: [], warnings: [] };
    const control = { signal: new AbortController().signal, prepared() {}, committed() {} };
    await new TranscriptStore(context).record('session-a', { entry: { seq: 0, type: 'user', text: 'Review the example rule.' } });
    const message = inboxMessage(); await new InboxStore(context).acceptPulled(message);
    await f.knowledge.dreamStore().saveOrigin('job-dream', { snapshot_at: nowSeconds(), claims: before, coverage: {} });
    const dreamPlan = prepared(before); const landed = gate(); const release = gate(); const nativeRename = fs.rename.bind(fs); let stopped = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      await nativeRename(source, target);
      if (!stopped && typeof target === 'string' && target === context.paths.claim(before[0]?.id ?? 'claim_00000001')) { stopped = true; landed.open(); await release.promise; }
    });
    const notify = vi.spyOn(f.knowledge, 'knowledgeVersion').mockRejectedValueOnce(new KnowledgeBusy());
    let writing: Promise<unknown> | undefined; let reading: ReturnType<typeof f.knowledge.snapshot> | undefined;
    try {
      writing = kind === 'formation' ? f.knowledge.applyFormation({ sessionId: 'session-a', jobId: 'job-formation', kind: 'finalize', fromSeq: -1, untilSeq: 0, analysisClaims: before, prepared: plan, task: 'Review the example rule.' }, control)
        : kind === 'inbox' ? f.knowledge.applyInboxEffect([message], before, plan, control)
          : f.knowledge.applyDreamGroup('job-dream', 'group-a', dreamPlan.group, dreamPlan.validation, dreamPlan.semantic, dreamPlan.self_review, control);
      await landed.promise; let returned = false; reading = f.knowledge.snapshot().then((value) => { returned = true; return value; });
      await delay(25); expect(returned).toBe(false); release.open(); await writing;
      const current = (await reading).claims; expect(current).toHaveLength(2);
      if (kind === 'dream') expect(current.every((claim) => claim.status === 'deprecated')).toBe(true);
      else expect(current.every((claim) => claim.name === 'committed-batch')).toBe(true);
    } finally { release.open(); await Promise.allSettled([writing, reading]); rename.mockRestore(); notify.mockRestore(); await f.close(); }
  });
});
