// 并发提交、取消和恢复屏障使用真实锁与 I/O；模型和网络均在知识锁之外。
import fs from 'node:fs/promises';
import { sep, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { UploadStore } from '../../src/store/uploads.js';
import { acquireFileLease, withFileLock } from '../../src/store/lock.js';
import { DreamStopped } from '../../src/worker/types.js';
import { ValidationSchema } from '../../src/dream/schema.js';
import { nowSeconds } from '../../src/protocol/time.js';
import { waitJob } from '../formation/helpers.js';
import { claims, candidate, dreamFixture, phaseBackend, prepared, qualityDraft, reviews, reviewSummary, until, deferred } from './helpers.js';

const control = () => ({ signal: new AbortController().signal, prepared() {} });
describe('Dream concurrency and stop boundaries', () => {
  it('rechecks automatic eligibility shortly after a contended commit finishes', async () => {
    const input = claims(); const f = await dreamFixture(phaseBackend(input), { dream: { minChangedClaims: 1 } });
    const lease = await acquireFileLease(f.knowledge.context().paths.knowledgeLock); let released = false;
    try {
      await f.start(); expect(await f.worker.queue.list()).toEqual([]); await lease.release(); released = true;
      await until(async () => (await f.worker.queue.list()).some((job) => job.kind === 'dream'));
      const job = (await f.worker.queue.list()).find((item) => item.kind === 'dream'); if (!job) throw new Error('Missing automatic Dream.');
      await waitJob(f.worker.queue, job.id);
    } finally { if (!released) await lease.release(); await f.close(); }
  });
  it.each(['stop', 'close'] as const)('cancels a pending eligibility retry on %s', async (action) => {
    const f = await dreamFixture(phaseBackend(claims()), { dream: { minChangedClaims: 1 } });
    const lease = await acquireFileLease(f.knowledge.context().paths.knowledgeLock); let released = false;
    try {
      await f.start(); if (action === 'stop') await f.dream.stop(); else await f.dream.close();
      await lease.release(); released = true; await new Promise<void>((resolve) => { setTimeout(resolve, 1100); });
      expect(await f.worker.queue.list()).toEqual([]);
    } finally { if (!released) await lease.release(); await f.close(); }
  });
  it.each(['provider', 'prepared'])('honors an independent process pause during %s and resumes the same job', async (mode) => {
    const input = claims(); const backend = phaseBackend(input); const ready = deferred(); const release = deferred(); let paused = false; let calls = 0;
    const f = await dreamFixture((...args) => { calls += 1; if (mode === 'provider' && !paused && (JSON.parse(args[2]) as { phase: string }).phase === 'review') { paused = true; ready.resolve(); return new Promise(() => {}); } return backend(...args); });
    const rename = fs.rename.bind(fs); const spy = mode === 'prepared' ? vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => { await rename(source, target); if (!paused && String(target).includes(`${sep}executions${sep}`) && String(target).endsWith('.yaml')) { paused = true; ready.resolve(); await release.promise; } }) : undefined;
    try {
      await f.start(); const job = await f.dream.request(); await ready.promise;
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/pause.mjs', import.meta.url)), f.knowledge.context().paths.root], { timeout: 5000 }); release.resolve();
      await until(async () => (await f.worker.queue.read(job.id))?.state === 'queued'); expect(await f.worker.queue.read(job.id)).toMatchObject({ attempts: 0, payload: { paused: true } }); expect((await f.knowledge.dreamStore().state()).last_success_at).toBeNull(); expect(await f.knowledge.dreamStore().records(job.id)).toHaveLength(mode === 'prepared' ? 1 : 0);
      expect((await f.dream.request()).id).toBe(job.id); await waitJob(f.worker.queue, job.id); expect(calls).toBe(mode === 'prepared' ? 3 : 4);
    } finally { release.resolve(); spy?.mockRestore(); await f.close(); }
  });
  it('serializes duplicate commits into one exact receipt, Trace and upload set', async () => {
    const input = claims(); const f = await dreamFixture(phaseBackend(input), { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1', retryCount: 0 } });
    try { const store = f.knowledge.dreamStore(); await store.saveOrigin('job-a', { snapshot_at: nowSeconds(), claims: input, coverage: {} }); const p = prepared(input, 'consolidation'); const results = await Promise.all(Array.from({ length: 5 }, () => store.commitGroup('job-a', 'group-a', p.group, p.validation, p.semantic, p.self_review, control()))); expect(results.every((result) => result.applied)).toBe(true); expect(await store.records('job-a')).toHaveLength(1); expect(await new TraceStore(f.knowledge.context()).list()).toHaveLength(1); expect((await new UploadStore(f.knowledge.context()).read()).claims).toHaveLength(2); }
    finally { await f.close(); }
  });
  it('allows only the first of two stale writers and records the second skipped group', async () => {
    const input = claims(); const f = await dreamFixture(phaseBackend(input));
    try { const store = f.knowledge.dreamStore(); for (const job of ['job-a', 'job-b']) await store.saveOrigin(job, { snapshot_at: nowSeconds(), claims: input, coverage: {} }); const a = prepared(input); const b = prepared(input, 'consolidation'); const result = await Promise.all([store.commitGroup('job-a', 'group-a', a.group, a.validation, a.semantic, a.self_review, control()), store.commitGroup('job-b', 'group-a', b.group, b.validation, b.semantic, b.self_review, control())]); expect(result.flatMap((cp) => cp.groups).filter((group) => group.skipped)).toHaveLength(1); const local = await new ClaimStore(f.knowledge.context()).list(); expect(local.every((claim) => claim.status === 'deprecated') || local.filter((claim) => claim.status === 'deprecated').length === 1).toBe(true); }
    finally { await f.close(); }
  });
  it('rechecks newly introduced source cycles against the complete current graph', async () => {
    const input = claims(3); const [a, b, c] = input; if (!a || !b || !c) throw new Error('Missing input.'); b.source_claim_ids = [c.id]; const f = await dreamFixture(phaseBackend(input), {}, input); const selected = [a, b];
    try { const store = f.knowledge.dreamStore(); await store.saveOrigin('job-a', { snapshot_at: nowSeconds(), claims: input, coverage: {} }); const p = prepared(selected, 'consolidation'); await new ClaimStore(f.knowledge.context()).write({ ...c, source_claim_ids: [a.id], updated_at: nowSeconds() }); const result = await store.commitGroup('job-a', 'group-a', p.group, p.validation, p.semantic, p.self_review, control()); expect(result.groups[0]?.skipped).toBe(true); expect((await new ClaimStore(f.knowledge.context()).read(b.id)).status).toBe('active'); }
    finally { await f.close(); }
  });
  it('cancels the initial snapshot lock wait promptly and does not prepare a group', async () => {
    const f = await dreamFixture(phaseBackend(claims())); const held = deferred(); const release = deferred();
    const lock = withFileLock(f.knowledge.context().paths.knowledgeLock, async () => { held.resolve(); await release.promise; });
    try { await held.promise; await f.start(); const job = await f.dream.request(); await until(async () => (await f.worker.queue.read(job.id))?.state === 'running'); const started = performance.now(); await f.dream.stop(); await until(async () => (await f.worker.queue.read(job.id))?.state === 'queued'); expect(performance.now() - started).toBeLessThan(500); expect(await f.knowledge.dreamStore().records(job.id)).toEqual([]); expect((await f.worker.queue.read(job.id))?.attempts).toBe(0); }
    finally { release.resolve(); await lock; await f.close(); }
  });
  it('rejects cancellation before prepared and finishes a prepared group despite stop', async () => {
    const input = claims(); const f = await dreamFixture(phaseBackend(input));
    try { const store = f.knowledge.dreamStore(); await store.saveOrigin('job-a', { snapshot_at: nowSeconds(), claims: input, coverage: {} }); const p = prepared(input); const before = new AbortController(); before.abort(new DreamStopped()); await expect(store.commitGroup('job-a', 'group-a', p.group, p.validation, p.semantic, p.self_review, { signal: before.signal, prepared() {} })).rejects.toThrow(); expect(await store.records('job-a')).toEqual([]); const during = new AbortController(); const result = await store.commitGroup('job-a', 'group-a', p.group, p.validation, p.semantic, p.self_review, { signal: during.signal, prepared() { during.abort(new DreamStopped()); } }); expect(result.applied).toBe(true); expect((await store.state()).last_success_at).toBeNull(); expect((await new ClaimStore(f.knowledge.context()).list()).every((claim) => claim.status === 'deprecated')).toBe(true); }
    finally { await f.close(); }
  });
  it('yields the provider to higher-priority Inbox without spending the Dream attempt', async () => {
    const input = claims(); const backend = phaseBackend(input); const ready = deferred(); let reviewed = 0; const order: string[] = [];
    const f = await dreamFixture((...args) => { if ((JSON.parse(args[2]) as { phase: string }).phase === 'review') { reviewed += 1; if (reviewed === 1) { ready.resolve(); return new Promise(() => {}); } order.push('dream'); } return backend(...args); });
    const unregister = f.worker.register('inbox', () => { order.push('inbox'); return Promise.resolve({ done: true }); });
    try { await f.start(); const job = await f.dream.request(); await ready.promise; const inbox = await f.worker.enqueue('inbox', {}); await waitJob(f.worker.queue, inbox.id); const done = await waitJob(f.worker.queue, job.id); expect(order).toEqual(['inbox', 'dream']); expect(done.attempts).toBe(1); }
    finally { unregister(); await f.close(); }
  });
  it('recovery failure blocks all other knowledge work before attempts are spent', async () => {
    const f = await dreamFixture(phaseBackend(claims())); let calls = 0; const unregister = f.worker.register('finalize', () => { calls += 1; return Promise.resolve({ done: true }); });
    try { const pending = f.knowledge.context().paths.dreamPending; await fs.mkdir(dirname(pending), { recursive: true }); await fs.writeFile(pending, 'invalid: pointer\n'); const job = await f.worker.queue.enqueue('finalize', {}, 'session-a'); await f.worker.start(); await until(() => Promise.resolve(f.warnings.length > 0)); await expect(f.knowledge.snapshot()).rejects.toThrow(); expect(await f.worker.queue.read(job.id)).toMatchObject({ state: 'queued', attempts: 0 }); expect(calls).toBe(0); await fs.rm(pending); f.worker.wake(true); await waitJob(f.worker.queue, job.id); expect(calls).toBe(1); }
    finally { unregister(); await f.close(); }
  });
  it('bounds its own context, archives history and resumes a failed compaction without replaying committed groups', async () => {
    const input = claims(); let compactions = 0; let firstDrafts = 0; const f = await dreamFixture((_route, _system, text) => {
      const r = JSON.parse(text) as { phase: string; candidate?: { group_id: string; claim_ids: string[] }; validation?: unknown; history?: unknown; prior_summary?: unknown };
      if (r.phase === 'candidates') return Promise.resolve({ text: JSON.stringify({ review: reviewSummary, candidates: input.map((claim, index) => candidate([claim], 'quality', `group-${index}`)), sync_candidates: [] }) });
      if (r.phase === 'compaction') { compactions += 1; expect(text.length).toBeLessThan(3000); if (compactions === 1) return Promise.reject(Object.assign(new Error('Context unavailable.'), { code: 'CONTEXT_WINDOW_EXCEEDED' })); return Promise.resolve({ text: JSON.stringify({ checked: 'The first group is already durable.', findings: 'Only episodic material retired.', uncertainties: 'No independent evidence.', next_steps: 'Review the remaining group.' }) }); }
      if (r.phase === 'draft') { if (r.candidate?.group_id === 'group-0') firstDrafts += 1; if (r.candidate?.group_id === 'group-1') expect(r.prior_summary).toMatchObject({ checked: 'The first group is already durable.' }); return Promise.resolve({ text: JSON.stringify({ action: 'stage', group: qualityDraft(input.filter((claim) => r.candidate?.claim_ids.includes(claim.id))) }) }); }
      return Promise.resolve({ text: JSON.stringify({ decision: 'apply', reason: r.candidate?.group_id === 'group-0' ? '审'.repeat(12_000) : 'Reviewed remaining group.', reason_kind: 'useful_knowledge', ...reviews(ValidationSchema.parse(r.validation)) }) });
    });
    try { await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id, 'failed'); expect((await f.knowledge.dreamStore().progress(job.id))?.entries[0]?.status).toBe('executed'); await f.worker.retry(job.id); await waitJob(f.worker.queue, job.id); expect(firstDrafts).toBe(1); expect(compactions).toBe(2); expect((await f.knowledge.dreamStore().progress(job.id))?.summary?.checked).toContain('already durable'); expect(await fs.readdir(join(f.knowledge.context().paths.dreamJob(job.id), 'history'))).toContain('context-1.json'); }
    finally { await f.close(); }
  });
  it('coalesces concurrent manual requests into a single durable job', async () => {
    const f = await dreamFixture(phaseBackend(claims())); try { const jobs = await Promise.all(Array.from({ length: 6 }, () => f.dream.request())); expect(new Set(jobs.map((job) => job.id)).size).toBe(1); expect(await f.worker.queue.list()).toHaveLength(1); } finally { await f.close(); }
  });
});
