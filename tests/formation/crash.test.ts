// 实际终止持锁进程，覆盖 prepared 至游标提交各阶段，以及多个进程的 worker 接管。
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaimStore, TraceStore, UploadStore, DisputeStore } from '../../src/store/index.js';
import { FormationStore } from '../../src/formation/checkpoint.js';
import { TranscriptStore, processedThrough } from '../../src/formation/transcript.js';
import { DurableWorker } from '../../src/worker/worker.js';
import { JobQueue } from '../../src/worker/queue.js';
import { context } from '../helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { waitJob } from './helpers.js';
import { emptyOutput } from './helpers.js';
import { AcnFormation } from '../../src/formation/service.js';
import { AcnKnowledge } from '../../src/knowledge/service.js';
import { resolveConfig } from '../../src/config.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import { logger } from '../helpers.js';

let root: string; let children: ChildProcess[];
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'acn-formation-crash-')); children = []; });
afterEach(async () => {
  await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }));
  await fs.rm(root, { recursive: true, force: true });
});
function spawn(mode: string, fixture = 'worker.mjs') {
  const child = fork(new URL(`./fixtures/${fixture}`, import.meta.url), [root, mode], { silent: true }); children.push(child);
  let stderr = ''; child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  const ready = new Promise<void>((resolve, reject) => { child.once('message', () => { resolve(); }); child.once('error', reject); child.once('exit', (code) => { if (code !== null) reject(new Error(`Worker exited: ${code}: ${stderr}`)); }); });
  return { child, ready, kill: async () => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } };
}
async function expireOrphanLocks(directory: string): Promise<void> {
  const expired = new Date(Date.now() - 60_000);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) {
    const path = join(directory, entry.name);
    if (entry.name.endsWith('.lock')) await fs.utimes(path, expired, expired);
    else await expireOrphanLocks(path);
  }
}

describe('process crash recovery', () => {
  it.each(['intent', 'archive-pending', 'archive-queued'])('SIGKILL at %s resumes exactly one frozen archive range', async (stage) => {
    const first = spawn(stage, 'archive.mjs'); await first.ready; await first.kill(); await expireOrphanLocks(root);
    const knowledge = new AcnKnowledge(resolveConfig({ agentId: 'agent-a', home: root }), logger); await knowledge.initialize();
    const inputs: string[] = [];
    const formation = new AcnFormation(knowledge, (_route, _system, input) => { inputs.push(input); return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); }, await loadPromptRenderer(), { pollMs: 10 });
    try {
      await formation.reconcileArchives(new Set(['session-a'])); await formation.start();
      const jobs = await formation.worker.queue.list(); expect(jobs).toHaveLength(1);
      const job = jobs[0]; if (!job) throw new Error('Missing recovered archive'); await waitJob(formation.worker.queue, job.id);
      expect(job).toMatchObject({ kind: 'finalize', payload: { untilSeq: 2, trigger: 'archive' } });
      expect(inputs).toHaveLength(1); expect(inputs[0]).toContain('FROZEN_RANGE'); expect(inputs[0]).not.toContain('LATE_RANGE');
      expect(await formation.transcript.state('session-a')).toMatchObject({ autoPaused: true, archiveIntent: null, archivePending: false, recappedThroughSeq: 2, lastSeenSeq: 4 });
      await formation.scan(Date.now() + 7_200_000); expect(await formation.worker.queue.list()).toHaveLength(1);
    } finally { await formation.close(); }
  });
  it.each(['prepared', 'after-claim', 'after-progress', 'after-trace', 'after-upload', 'after-applied', 'before-state'])('SIGKILL at %s completes the exact checkpoint without duplicate entities or uploads', async (stage) => {
    const ctx = context(root, 'team'); await new ClaimStore(ctx).write(sampleClaim());
    const transcript = new TranscriptStore(ctx);
    await transcript.record('session-a', { entry: { seq: 1, type: 'user', text: 'Verify retry budgets.' } });
    await transcript.record('session-a', { entry: { seq: 2, type: 'assistant', text: 'Checked the service contracts.' } });
    const queue = new JobQueue(ctx); const job = await queue.enqueue('finalize', { untilSeq: 2 }, 'session-a');
    const first = spawn(stage); await first.ready; await first.kill(); await expireOrphanLocks(root);
    const saved = await new FormationStore(ctx).read('session-a'); expect(saved).not.toBeNull();
    await new FormationStore(ctx).recover(); await new FormationStore(ctx).recover();
    const restored = await new FormationStore(ctx).read('session-a'); expect(restored).toMatchObject({ status: 'applied', jobId: job.id });
    expect(await new ClaimStore(ctx).list()).toHaveLength(3); expect(await new DisputeStore(ctx).list()).toHaveLength(1); expect(await new TraceStore(ctx).list()).toHaveLength(1);
    const trace = (await new TraceStore(ctx).list())[0]; expect(trace?.id).toBe(saved?.trace?.id); expect(trace?.output_claims).toHaveLength(3);
    expect((await new UploadStore(ctx).read()).claims).toHaveLength(3); expect((await new UploadStore(ctx).read()).disputes).toHaveLength(1);
    expect(processedThrough(await transcript.state('session-a'))).toBe(2); expect(await transcript.read('session-a')).toEqual([]);
    const resumed = new DurableWorker(ctx, { pollMs: 10 });
    resumed.register('finalize', async () => { expect(processedThrough(await transcript.state('session-a'))).toBe(2); return { recovered: true }; });
    try { await resumed.start(); expect(await waitJob(queue, job.id)).toMatchObject({ attempts: 2 }); }
    finally { await resumed.close(); }
    expect((await new ClaimStore(ctx).list()).map((claim) => claim.id).sort()).toEqual(restored?.appliedClaims.map((claim) => claim.id).sort());
  });
  it('two processes share one worker and the survivor takes over after SIGKILL', async () => {
    const ctx = context(root, 'team'); const queue = new JobQueue(ctx);
    const a = spawn('serve'); await a.ready; const b = spawn('serve'); await b.ready;
    const jobs = await Promise.all(Array.from({ length: 12 }, (_, index) => queue.enqueue('finalize', { index }, `session-${index}`)));
    await Promise.all(jobs.map((job) => waitJob(queue, job.id)));
    const executions = (await fs.readFile(join(root, 'executions.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { jobId: string; process: number });
    expect(new Set(executions.map((entry) => entry.jobId)).size).toBe(12); expect(executions).toHaveLength(12); expect(new Set(executions.map((entry) => entry.process)).size).toBe(1);
    const holder = executions[0]?.process === a.child.pid ? a : b; await holder.kill(); await expireOrphanLocks(root);
    const next = await queue.enqueue('finalize', { index: 13 }, 'session-13'); await waitJob(queue, next.id);
    const all = (await fs.readFile(join(root, 'executions.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { process: number });
    expect(all).toHaveLength(13); expect(all.at(-1)?.process).not.toBe(holder.child.pid);
  });
});
