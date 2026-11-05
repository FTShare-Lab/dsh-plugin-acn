// 队列的短事务使用独立文件锁；持锁期间不执行任务或调用模型。
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { StoreContext } from '../store/context.js';
import { hasCode, StoreError } from '../store/errors.js';
import { readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { withFileLock } from '../store/lock.js';
import { JobError, JobSchema, jobPriority } from './types.js';
import type { Job, JobKind } from './types.js';

// 领取与抢占共享可执行条件；保留的禁用、暂停或退避任务不能阻塞低优先级工作。
export function runnableJob(job: Job, kinds: Pick<ReadonlySet<JobKind>, 'has'>, now = Date.now()): boolean {
  return job.state === 'queued' && job.payload['paused'] !== true && kinds.has(job.kind) && (job.nextRunAt ?? 0) <= now;
}

export class JobQueue {
  constructor(readonly context: StoreContext) {}
  async list(): Promise<Job[]> {
    let entries;
    try { entries = await fs.readdir(this.context.paths.jobs, { withFileTypes: true }); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    const values = await Promise.all(entries.filter((entry) => entry.isFile() && /^[a-zA-Z0-9_-]+\.yaml$/.test(entry.name)).map((entry) => this.read(entry.name.slice(0, -5))));
    return values.filter((value) => value !== null);
  }
  async read(id: string): Promise<Job | null> {
    // 已移除的旧任务保留原文件，不加载、不执行，也不阻塞现有知识任务。
    const value = await readYamlOr(this.context.paths.job(id), z.preprocess((value) => typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'memory_review' ? null : value, JobSchema.nullable()), () => null);
    if (value !== null && value.id !== id) throw new StoreError('decode', 'Job ID differs from its filename.');
    return value;
  }
  private write(job: Job): Promise<void> { return writeYamlAtomic(this.context.paths.job(job.id), job, JobSchema, this.context.logger); }
  private locked<T>(action: () => Promise<T>): Promise<T> { return withFileLock(this.context.paths.jobQueueLock, action, { timeoutMs: this.context.lockTimeoutMs }); }
  enqueue(kind: JobKind, payload: Job['payload'], sessionId?: string): Promise<Job> {
    return this.locked(async () => {
      const jobs = await this.list();
      if (kind === 'dream') { const pending = jobs.find((job) => job.kind === kind && (job.state === 'queued' || job.state === 'running')); if (pending !== undefined) return pending; }
      const same = jobs.find((job) => job.kind === kind && job.sessionId === sessionId && job.state === 'queued' && JSON.stringify(job.payload) === JSON.stringify(payload));
      if (same !== undefined) return same;
      if (kind === 'finalize') for (const job of jobs) {
        if (job.kind === 'recap' && job.sessionId === sessionId && job.state === 'queued') await this.write({ ...job, state: 'succeeded', updatedAt: Date.now(), result: { skipped: 'superseded' } });
      }
      const now = Date.now();
      const job = JobSchema.parse({ schemaVersion: 1, id: randomUUID(), kind, ...(sessionId === undefined ? {} : { sessionId }), payload, state: 'queued', attempts: 0, createdAt: now, updatedAt: now, ordinal: Math.max(0, ...jobs.map((job) => job.ordinal ?? 0)) + 1 });
      await this.write(job);
      return job;
    });
  }
  recoverRunning(): Promise<void> { return this.locked(async () => {
    for (const job of await this.list()) if (job.state === 'running') await this.write({ ...job, state: 'queued', updatedAt: Date.now() });
  }); }
  claim(kinds: ReadonlySet<JobKind>): Promise<Job | null> { return this.locked(async () => {
    const now = Date.now(); const jobs = (await this.list()).filter((job) => runnableJob(job, kinds, now));
    jobs.sort((a, b) => jobPriority[a.kind] - jobPriority[b.kind] || (a.ordinal !== undefined && b.ordinal !== undefined ? a.ordinal - b.ordinal : a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
    const first = jobs[0];
    if (first === undefined) return null;
    const job: Job = { ...first, state: 'running', attempts: first.attempts + 1, updatedAt: Date.now() };
    await this.write(job);
    return job;
  }); }
  settle(job: Job, state: Job['state'], details: Partial<Pick<Job, 'lastError' | 'lastErrorKind' | 'nextRunAt' | 'result' | 'attempts'>> = {}): Promise<void> { return this.locked(async () => {
    const current = await this.read(job.id);
    const next = { ...job, payload: current?.payload ?? job.payload, state, updatedAt: Date.now() };
    delete next.lastError; delete next.lastErrorKind; delete next.nextRunAt; delete next.result;
    await this.write({ ...next, ...details });
  }); }
  pauseDream(paused: boolean): Promise<Job[]> { return this.locked(async () => {
    const result: Job[] = [];
    for (const job of await this.list()) if (job.kind === 'dream' && (job.state === 'queued' || job.state === 'running')) {
      // 兼容旧额度暂停：恢复后只做有限收尾，不给原任务重新分配探索额度。
      const next: Job = { ...job, payload: { ...job.payload, paused }, updatedAt: Date.now() };
      delete next.payload['budget_exhausted']; delete next.payload['budget_epoch'];
      await this.write(next); result.push(next);
    }
    return result;
  }); }
  retry(id: string): Promise<Job> { return this.locked(async () => {
    const job = await this.read(id);
    if (job === null || job.state !== 'failed') throw new JobError('validation', '只能重试已失败的任务；请从 /acn-status 复制任务 ID。');
    const next: Job = { ...job, state: 'queued', attempts: 0, updatedAt: Date.now() };
    delete next.lastError; delete next.lastErrorKind; delete next.nextRunAt;
    await this.write(next); return next;
  }); }
}
