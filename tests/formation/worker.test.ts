// 调度验收覆盖固定优先级、同级 FIFO、跨实例互斥和持久重试上限。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DurableWorker } from '../../src/worker/worker.js';
import { JobError } from '../../src/worker/types.js';
import { JobSchema } from '../../src/worker/types.js';
import { writeYamlAtomic } from '../../src/store/yaml.js';
import { context } from '../helpers.js';
import { waitJob } from './helpers.js';

describe('persistent worker', () => {
  it('ignores retired private-review jobs without changing them or blocking knowledge work', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-jobs-')); const worker = new DurableWorker(context(root), { pollMs: 10 });
    try {
      await fs.mkdir(worker.context.paths.jobs, { recursive: true });
      for (const state of ['queued', 'running', 'succeeded', 'failed']) await fs.writeFile(worker.context.paths.job(`retired-${state}`), JSON.stringify({ schemaVersion: 1, id: `retired-${state}`, kind: 'memory_review', state, payload: {}, attempts: 0, createdAt: 0, updatedAt: 0 }));
      const before = await fs.readFile(worker.context.paths.job('retired-running'), 'utf8');
      worker.register('dream', () => Promise.resolve({ done: true })); const job = await worker.enqueue('dream', {}); await worker.start();
      await waitJob(worker.queue, job.id); expect((await worker.queue.list()).map((item) => item.kind)).toEqual(['dream']);
      expect(await fs.readFile(worker.context.paths.job('retired-running'), 'utf8')).toBe(before);
      expect(await worker.queue.read('retired-running')).toBeNull();
    } finally { await worker.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(['enqueue', 'monitor'])('does not abort a running Dream for an unregistered higher-priority task via %s', async (mode) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-jobs-')); const worker = new DurableWorker(context(root), { pollMs: 10 }); let release = () => {}; const waiting = new Promise<void>((resolve) => { release = resolve; }); let signal: AbortSignal | undefined; let calls = 0;
    worker.register('dream', async (_job, control) => { calls += 1; signal = control.signal; await waiting; control.signal.throwIfAborted(); return { done: true }; });
    const inspections = vi.spyOn(worker.queue, 'list');
    try {
      const job = await worker.enqueue('dream', {}); await worker.start(); await vi.waitFor(() => { expect(signal).toBeDefined(); });
      const higher = mode === 'enqueue' ? await worker.enqueue('inbox', {}, 'session-a') : await worker.queue.enqueue('inbox', {}, 'session-a'); const count = inspections.mock.calls.length;
      await vi.waitFor(() => { expect(inspections.mock.calls.length).toBeGreaterThan(count + 1); }); expect(signal?.aborted).toBe(false); expect(calls).toBe(1);
      release(); expect(await waitJob(worker.queue, job.id)).toMatchObject({ attempts: 1 }); expect(await worker.queue.read(higher.id)).toMatchObject({ state: 'queued', attempts: 0 });
    } finally { release(); await worker.close(); inspections.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('returns a claimed job to queued if its handler unloads during queue I/O', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-jobs-')); const worker = new DurableWorker(context(root), { pollMs: 10 }); let calls = 0;
    const unregister = worker.register('inbox', () => { calls += 1; return Promise.resolve({ done: true }); }); const claim = worker.queue.claim.bind(worker.queue);
    const intercepted = vi.spyOn(worker.queue, 'claim').mockImplementation(async (kinds) => { const job = await claim(kinds); if (job !== null) unregister(); return job; });
    try {
      const job = await worker.enqueue('inbox', { request_id: 'request-a' }, 'session-a'); await worker.start();
      await vi.waitFor(async () => { expect(await worker.queue.read(job.id)).toMatchObject({ state: 'queued', attempts: 1 }); }); expect(calls).toBe(0); intercepted.mockRestore();
      worker.register('inbox', () => { calls += 1; return Promise.resolve({ done: true }); }); await waitJob(worker.queue, job.id); expect(calls).toBe(1);
    } finally { intercepted.mockRestore(); await worker.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('refuses a durable job whose ID differs from its filename', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-jobs-')); const worker = new DurableWorker(context(root));
    try {
      const job = await worker.enqueue('finalize', {});
      await writeYamlAtomic(worker.context.paths.job(job.id), { ...job, id: 'another-job' }, JobSchema, worker.context.logger);
      await expect(worker.queue.read(job.id)).rejects.toMatchObject({ kind: 'decode' });
    } finally { await worker.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('orders all kinds by priority, uses FIFO and supersedes only matching queued Recaps', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-jobs-')); const worker = new DurableWorker(context(root), { pollMs: 10 }); const order: string[] = [];
    try {
      for (const kind of ['dream', 'inbox', 'recap', 'finalize'] as const) worker.register(kind, (job) => { order.push(typeof job.payload['label'] === 'string' ? job.payload['label'] : ''); return Promise.resolve({ done: true }); });
      await worker.enqueue('dream', { label: 'dream' }); await worker.enqueue('inbox', { label: 'inbox' });
      await worker.enqueue('recap', { label: 'recap-a' }, 'session-a');
      const obsolete = await worker.enqueue('recap', { label: 'obsolete' }, 'session-b');
      const first = await worker.enqueue('finalize', { label: 'finalize-1' }, 'session-b'); const second = await worker.enqueue('finalize', { label: 'finalize-2' }, 'session-c');
      await worker.start(); await waitJob(worker.queue, second.id); await vi.waitFor(() => { expect(order).toHaveLength(5); });
      expect(order).toEqual(['finalize-1', 'finalize-2', 'recap-a', 'inbox', 'dream']);
      expect(await worker.queue.read(obsolete.id)).toMatchObject({ result: { skipped: 'superseded' } }); expect((await worker.queue.read(first.id))?.attempts).toBe(1);
    } finally { await worker.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('two workers share one lease, consume other-instance enqueue and take over after graceful close', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-jobs-')); const a = new DurableWorker(context(root), { pollMs: 10, takeoverMs: 20 }); const b = new DurableWorker(context(root), { pollMs: 10, takeoverMs: 20 });
    let count = 0; let concurrent = 0; let peak = 0;
    const run = async () => { count += 1; concurrent += 1; peak = Math.max(peak, concurrent); await new Promise((resolve) => setTimeout(resolve, 10)); concurrent -= 1; return { done: true }; };
    a.register('finalize', run); b.register('finalize', run);
    try {
      await a.start(); await b.start();
      const jobs = await Promise.all(Array.from({ length: 8 }, (_, index) => b.enqueue('finalize', { index }, `session-${index}`)));
      await Promise.all(jobs.map((job) => waitJob(a.queue, job.id))); expect(count).toBe(8); expect(peak).toBe(1);
      await a.close(); const next = await b.enqueue('finalize', { index: 9 }, 'session-9'); await waitJob(b.queue, next.id); expect(count).toBe(9);
    } finally { await a.close(); await b.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('bounds retryable failures at five attempts, persists failure and resets attempts on manual retry', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-jobs-')); const worker = new DurableWorker(context(root), { pollMs: 5, retryBaseMs: 1 }); let failed = true;
    worker.register('finalize', () => { if (failed) return Promise.reject(new JobError('transport', 'Retryable service failure.', true)); return Promise.resolve({ done: true }); });
    try {
      const job = await worker.enqueue('finalize', {}); await worker.start();
      expect(await waitJob(worker.queue, job.id, 'failed')).toMatchObject({ attempts: 5, lastError: 'Retryable service failure. 已达到自动重试上限，请修正原因后手动重试任务。' });
      failed = false; await worker.retry(job.id); expect(await waitJob(worker.queue, job.id)).toMatchObject({ attempts: 1 });
    } finally { await worker.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
