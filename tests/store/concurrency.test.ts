// 用真实子进程验证竞争写入、锁超时及强制终止后的恢复。
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaimSchema, InboxMessageSchema } from '../../src/protocol/index.js';
import { ClaimEditStore, ClaimStore, cleanupAtomicTemps, InboxStore, UploadStore, withFileLock, withFileLocks } from '../../src/store/index.js';
import { context, fixture, logger } from '../helpers.js';

let root: string;
let children: ChildProcess[];
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'acn-process-')); children = []; });
afterEach(async () => {
  await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => { child.kill('SIGKILL'); await once(child, 'exit'); }));
  await fs.rm(root, { recursive: true, force: true });
});

function worker(mode: string, number = 0) {
  const child = fork(new URL('./fixtures/worker.mjs', import.meta.url), [root, mode, String(number)], { silent: true });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  let message: unknown;
  const ready = new Promise<unknown>((resolve, reject) => {
    child.once('message', (value: unknown) => { message = value; resolve(value); });
    child.once('error', reject);
    child.once('exit', (code) => { if (message === undefined) reject(new Error(`Worker exited before readiness: ${code}: ${stderr}`)); });
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 || signal === 'SIGKILL' ? resolve() : reject(new Error(`Worker failed: ${code}: ${stderr}`)));
  });
  // 失败在调用方 await 时报告，避免退出事件先于 ready 消费时产生未处理拒绝。
  void done.catch(() => {});
  return { child, ready, done };
}

describe('interprocess persistence', () => {
  it('ten processes overwrite one Claim with a complete, parseable version', async () => {
    const claim = await fixture('claim-seconds', ClaimSchema);
    const store = new ClaimStore(context(root)); await store.write(claim);
    const writers = Array.from({ length: 10 }, (_, index) => worker('claim-write', index));
    let finished = false;
    const completion = Promise.all(writers.map(async (item) => { await item.ready; await item.done; })).finally(() => { finished = true; });
    void completion.catch(() => {});
    while (!finished) {
      const current = await store.read(claim.id);
      if (current.statement !== claim.statement) expect(current.statement).toBe(current.evidence_summary);
      await delay(1);
    }
    await completion;
    const current = await store.read(claim.id);
    const allowed = Array.from({ length: 10 }, (_, index) => `writer-${index}:` + String(index).repeat(5000));
    expect(allowed).toContain(current.statement);
    expect(current.statement).toBe(current.evidence_summary);
  });
  it('serializes ten process queue updates without losing any Claim', async () => {
    const writers = Array.from({ length: 10 }, (_, index) => worker('upload', index));
    await Promise.all(writers.map(async (item) => { await item.ready; await item.done; }));
    expect((await new UploadStore(context(root, 'team')).read()).claims).toHaveLength(10);
  });
  it('allows only one of ten processes to claim the same pending message', async () => {
    const inbox = new InboxStore(context(root));
    await inbox.acceptPulled(await fixture('inbox-policy', InboxMessageSchema));
    const workers = Array.from({ length: 10 }, () => worker('inbox-claim'));
    const results = await Promise.all(workers.map(async (item) => {
      const value = z.object({ claimed: z.array(z.unknown()) }).parse(await item.ready);
      await item.done; return value.claimed.length;
    }));
    expect(results.reduce((total, count) => total + count, 0)).toBe(1);
  });
  it('preserves the old Claim after SIGKILL before rename, then cleans stale temporary data', async () => {
    const store = new ClaimStore(context(root)); const claim = await fixture('claim-seconds', ClaimSchema); await store.write(claim);
    const task = worker('before-rename');
    const { temporary } = z.object({ kind: z.literal('prepared'), temporary: z.string() }).parse(await task.ready);
    task.child.kill('SIGKILL'); await task.done;
    expect(await store.read(claim.id)).toEqual(claim);
    await fs.access(temporary);
    expect(await cleanupAtomicTemps(root, logger)).toBe(0);
    const old = new Date(Date.now() - 7_200_000); await fs.utimes(temporary, old, old);
    expect(await cleanupAtomicTemps(root, logger)).toBe(1);
    expect(await store.list()).toEqual([claim]);
    await store.write({ ...claim, statement: 'new successful write' });
    expect((await store.read(claim.id)).statement).toBe('new successful write');
  });
  it('recovers a processing lease left by a killed process', async () => {
    const ctx = context(root); const inbox = new InboxStore(ctx);
    const message = await fixture('inbox-policy', InboxMessageSchema); await inbox.acceptPulled(message);
    const task = worker('inbox-crash');
    const { claimed } = z.object({ claimed: z.array(z.object({ leaseId: z.string() })) }).parse(await task.ready);
    const lease = claimed[0]; if (lease === undefined) throw new Error('Expected a lease.');
    task.child.kill('SIGKILL'); await task.done;
    const old = new Date(Date.now() - 700_000); await fs.utimes(join(ctx.paths.inbox, lease.leaseId), old, old);
    expect(await new InboxStore(ctx).recoverStale()).toBe(1);
    expect(await inbox.listPending()).toEqual([message]);
  });
  it('takes over a stale lock directory left by SIGKILL', async () => {
    const ctx = context(root); const task = worker('hold-lock'); await task.ready;
    task.child.kill('SIGKILL'); await task.done;
    const old = new Date(Date.now() - 60_000); await fs.utimes(ctx.paths.knowledgeLock, old, old);
    expect(await withFileLock(ctx.paths.knowledgeLock, () => Promise.resolve('recovered'))).toBe('recovered');
  });
  it.each(['journal', 'claim', 'queue'])('recovers a killed edit after the %s stage without duplication', async (stage) => {
    const ctx = context(root, 'team'); const claims = new ClaimStore(ctx);
    const original = await fixture('claim-seconds', ClaimSchema); await claims.write(original);
    const task = worker(`edit-${stage}`); await task.ready;
    task.child.kill('SIGKILL'); await task.done;
    const old = new Date(Date.now() - 60_000); await fs.utimes(ctx.paths.knowledgeLock, old, old);
    expect(await new ClaimEditStore(ctx).recover()).toBe(stage === 'journal' ? 'discarded' : 'queued');
    expect(await new ClaimEditStore(ctx).recover()).toBe('none');
    const current = await claims.read(original.id);
    expect(current.statement).toBe(stage === 'journal' ? original.statement : 'landed edit');
    expect((await new UploadStore(ctx).read()).claims).toEqual(stage === 'journal' ? [] : [current]);
  });
});

describe('lock discipline', () => {
  it('times out under contention and releases after a failed action', async () => {
    const path = context(root).paths.knowledgeLock;
    let releaseHold: () => void = () => {};
    let announceReady: () => void = () => {};
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    const ready = new Promise<void>((resolve) => { announceReady = resolve; });
    const owner = withFileLock(path, async () => { announceReady(); await hold; });
    await ready;
    try { await expect(withFileLock(path, () => Promise.resolve(), { timeoutMs: 30 })).rejects.toMatchObject({ kind: 'lock_timeout' }); }
    finally { releaseHold(); await owner; }
    await expect(withFileLock(path, () => Promise.reject(new Error('action failed')))).rejects.toThrow('action failed');
    expect(await withFileLock(path, () => Promise.resolve(true))).toBe(true);
  });
  it('rejects inverted order and sorts multi-file locks', async () => {
    const paths = context(root).paths;
    await expect(withFileLock(paths.pendingUploadsLock, () => withFileLock(paths.knowledgeLock, () => Promise.resolve()))).rejects.toMatchObject({ kind: 'lock_order' });
    expect(await withFileLocks([paths.pendingUploadsLock, paths.knowledgeLock], () => Promise.resolve('ordered'))).toBe('ordered');
  });
});
