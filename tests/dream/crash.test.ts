// 强杀持锁进程，验证逐组日志、最终记录和依赖重绑均可在新实例中恢复。
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { UploadStore } from '../../src/store/uploads.js';
import { DreamStore } from '../../src/dream/checkpoint.js';
import { DreamSync } from '../../src/dream/sync.js';
import { DreamSession } from '../../src/dream/autonomous.js';
import { waitJob } from '../formation/helpers.js';
import { dreamFixture } from './helpers.js';

async function expireOrphans(root: string): Promise<void> { const old = new Date(Date.now() - 60_000); for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory()) { const path = join(root, entry.name); if (entry.name.endsWith('.lock')) await fs.utimes(path, old, old); else await expireOrphans(path); } }
function kill(child: ChildProcess) { const exit = once(child, 'exit'); child.kill('SIGKILL'); return exit; }
async function crash(root: string, job: string, stage: string, reviewMode = 'legacy', mode = 'team') {
  const child = fork(new URL('./fixtures/worker.mjs', import.meta.url), [root, job, stage, reviewMode, mode], { silent: true }); let stderr = ''; child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  try { await new Promise<void>((resolve, reject) => { child.once('message', () => { resolve(); }); child.once('error', reject); child.once('exit', (code) => { reject(new Error(`Crash worker exited ${code}: ${stderr}`)); }); }); }
  catch (error) { if (child.exitCode === null && child.signalCode === null) await kill(child); throw error; }
  await kill(child); await expireOrphans(root);
}
describe('Dream real process crash recovery', () => {
  it('keeps a solo prepared Dream local when restarted with team configuration', async () => {
    const f = await dreamFixture(() => { throw new Error('Recovery cannot use a model.'); });
    try {
      const ctx = f.knowledge.context(); await crash(ctx.paths.root, 'solo-recovery', 'prepared', 'semantic', 'solo');
      const team = { ...ctx, mode: 'team' as const }; const store = new DreamStore(team);
      await store.recover(); await store.recover();
      expect((await store.records('solo-recovery'))[0]?.checkpoint).toMatchObject({ applied: true, team_authorized: false });
      expect((await new ClaimStore(team).list()).filter((claim) => claim.status === 'deprecated')).toHaveLength(1);
      expect((await new UploadStore(team).read()).claims).toEqual([]);
      await expect(fs.access(ctx.paths.uploads)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.close(); }
  });

  it.each(['final-prepared', 'final-state', 'final-applied'])('terminates an exhausted Dream after SIGKILL at %s without a new model allowance', async (stage) => {
    const f = await dreamFixture(() => { throw new Error('Budget recovery cannot call a model.'); });
    try {
      const job = await f.worker.queue.enqueue('dream', { manual: true }); await crash(f.knowledge.context().paths.root, job.id, stage, 'budget');
      await f.knowledge.dreamStore().recover();
      const session = await DreamSession.create(f.knowledge, job, { signal: new AbortController().signal, prepared() {} }, () => Promise.resolve());
      expect(session.finished).toBe(true); expect(session.progress.autonomy).toMatchObject({ steps: 1, limit: 1, wrap_up: { steps: 3, limit: 3 } });
      await expect(session.admitStep()).rejects.toThrow('已结束'); expect(await f.knowledge.dreamStore().records(job.id)).toHaveLength(1);
    } finally { await f.close(); }
  });
  it.each(['prepared', 'carrier', 'retired', 'applied', 'final-prepared'])('semantic-only checkpoint survives SIGKILL at %s', async (stage) => {
    const f = await dreamFixture(() => { throw new Error('Recovery cannot use a model.'); }, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1', retryCount: 0 } });
    try {
      const job = await f.worker.queue.enqueue('dream', { manual: true }); await crash(f.knowledge.context().paths.root, job.id, stage, 'semantic');
      await f.knowledge.dreamStore().recover(); await f.knowledge.dreamStore().recover();
      const record = (await f.knowledge.dreamStore().records(job.id))[0]?.checkpoint;
      expect(record).toMatchObject({ applied: true, self_reviews: [], operation: { hard_validation_passed: true }, groups: [{ completed: true, skipped: false }] });
      expect(record?.operation?.review.claims).toHaveLength(2);
      expect((await new ClaimStore(f.knowledge.context()).list()).filter((claim) => claim.status === 'deprecated')).toHaveLength(1);
      expect((await new UploadStore(f.knowledge.context()).read()).consolidations).toHaveLength(1);
    } finally { await f.close(); }
  });
  it.each(['carrier', 'retired'])('preserves a foreground third version after SIGKILL at %s and abandons remaining stale effects', async (stage) => {
    const f = await dreamFixture(() => { throw new Error('Stale recovery cannot call the model.'); }, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1', retryCount: 0 } });
    try {
      const ctx = f.knowledge.context(); const job = await f.worker.queue.enqueue('dream', { manual: true }); await crash(ctx.paths.root, job.id, stage);
      const current = await new ClaimStore(ctx).list(); const target = current.find((claim) => stage === 'carrier' ? claim.status !== 'deprecated' && claim.id.endsWith('2') : claim.status !== 'deprecated'); if (!target) throw new Error('Missing concurrently edited target.');
      const revised = { ...target, statement: 'A newer user-reviewed condition must remain.', updated_at: '2027-01-01T00:00:00Z' }; await new ClaimStore(ctx).write(revised);
      await f.knowledge.dreamStore().recover(); expect((await f.knowledge.dreamStore().records(job.id))[0]?.checkpoint.groups[0]).toMatchObject({ completed: true, skipped: true }); expect(await new ClaimStore(ctx).read(target.id)).toEqual(revised);
      await f.start(); await waitJob(f.worker.queue, job.id); expect((await f.knowledge.dreamStore().progress(job.id))?.entries[0]).toMatchObject({ status: 'skipped' });
      if (stage === 'carrier') expect((await new ClaimStore(ctx).list()).every((claim) => claim.status !== 'deprecated')).toBe(true);
      else { const pending = await new UploadStore(ctx).read(); expect(pending.consolidations).toHaveLength(1); expect(pending.claims.filter((claim) => claim.status === 'deprecated')).toHaveLength(1); }
    } finally { await f.close(); }
  });
  it.each(['prepared', 'pending', 'carrier', 'retired', 'upload', 'group-completed', 'trace', 'applied', 'state', 'pointer-removed', 'final-prepared', 'final-trace', 'final-applied', 'final-state', 'final-pointer-removed'])('SIGKILL at %s recovers fixed versions and finishes without replaying the model', async (stage) => {
    let calls = 0; const f = await dreamFixture(() => { calls += 1; throw new Error('A durable execution must not replay the model.'); }, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1', retryCount: 0 } });
    try { const ctx = f.knowledge.context(); const job = await f.worker.queue.enqueue('dream', { manual: true }); await crash(ctx.paths.root, job.id, stage); await f.knowledge.dreamStore().recover(); await f.knowledge.dreamStore().recover(); const saved = (await f.knowledge.dreamStore().records(job.id))[0]?.checkpoint; expect(saved).toMatchObject({ applied: true, groups: [{ completed: true, skipped: false }] }); const local = await new ClaimStore(ctx).list(); expect(local.filter((claim) => claim.status === 'deprecated')).toHaveLength(1); expect(saved?.groups[0]?.after).toEqual(local); const queue = await new UploadStore(ctx).read(); expect(queue.claims).toHaveLength(2); expect(queue.consolidations).toHaveLength(1); expect(await fs.readFile(join(ctx.paths.root, 'model-calls'), 'utf8')).toBe('one');
      await f.start(); await waitJob(f.worker.queue, job.id); expect(calls).toBe(0); expect((await f.knowledge.dreamStore().state()).last_success_at).not.toBeNull(); const traces = await new TraceStore(ctx).list(); expect(traces).toHaveLength(2); expect(new Set(traces.map((trace) => trace.id)).size).toBe(2); expect(await new ClaimStore(ctx).list()).toEqual(local);
    } finally { await f.close(); }
  });
  it.each(['sync-prepared', 'sync-upload', 'sync-applied'])('SIGKILL at %s rebinds once without modifying current knowledge', async (stage) => {
    const f = await dreamFixture(() => { throw new Error('Sync recovery does not call a model.'); }, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1', retryCount: 0 } });
    try { const ctx = f.knowledge.context(); await crash(ctx.paths.root, 'sync-job', stage); const before = await new ClaimStore(ctx).list(); const source = before.find((claim) => claim.status === 'deprecated'); const carrier = before.find((claim) => claim.status !== 'deprecated'); if (!source || !carrier) throw new Error('Missing consolidated inputs.'); const sync = new DreamSync(ctx); expect(await sync.resume('sync-job', source.id, new AbortController().signal)).toBe(true); expect(await sync.resume('sync-job', source.id, new AbortController().signal)).toBe(true); expect((await new UploadStore(ctx).read()).consolidations?.[0]?.carriers).toEqual([carrier]); expect(await new ClaimStore(ctx).list()).toEqual(before); }
    finally { await f.close(); }
  });
});
