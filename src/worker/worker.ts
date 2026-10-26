// 单持有者消费持久队列；卸载取消模型调用，prepared 提交收敛后才释放租约。
import type { StoreContext } from '../store/context.js';
import { acquireFileLease } from '../store/lock.js';
import { LockTimeoutError } from '../store/errors.js';
import { JobQueue, runnableJob } from './queue.js';
import { JobError, Preempted, DreamStopped, DreamYield, jobPriority } from './types.js';
import { DreamStore } from '../dream/checkpoint.js';
import type { Job, JobKind } from './types.js';

export interface JobControl { signal: AbortSignal; prepared(): void; committed?(): void }
export type JobHandler = (job: Job, control: JobControl) => Promise<Job['result']>;
export class DurableWorker {
  readonly queue: JobQueue;
  private readonly handlers = new Map<JobKind, JobHandler>();
  private lease: Awaited<ReturnType<typeof acquireFileLease>> | undefined;
  private active: { job: Job; abort: AbortController; prepared: boolean } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;
  private started = false;
  private nextAcquire = 0;
  constructor(readonly context: StoreContext, private readonly options: { pollMs?: number; takeoverMs?: number; retryBaseMs?: number; staleMs?: number } = {}) { this.queue = new JobQueue(context); }
  register(kind: JobKind, handler: JobHandler): () => void {
    this.handlers.set(kind, handler); this.wake(true);
    return () => {
      if (this.handlers.get(kind) !== handler) return;
      this.handlers.delete(kind);
      if (this.active?.job.kind === kind && !this.active.prepared) this.active.abort.abort(new JobError('suspended', '后台处理器已暂停，任务保留。'));
    };
  }
  canRun(job: Job): boolean { return runnableJob(job, this.handlers); }
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.timer = setInterval(() => { this.wake(); }, this.options.pollMs ?? 1000);
    this.timer.unref();
    this.wake();
    await Promise.resolve();
  }
  wake(force = false): void {
    if (!this.started || this.closed || this.ticking !== undefined) return;
    if (force) this.nextAcquire = 0;
    const tick = this.tick().catch(() => { this.context.logger.warn('Background worker could not read or commit its local queue.'); });
    this.ticking = tick;
    void tick.finally(() => { if (this.ticking === tick) this.ticking = undefined; });
  }
  async enqueue(kind: JobKind, payload: Job['payload'], sessionId?: string): Promise<Job> {
    const job = await this.queue.enqueue(kind, payload, sessionId);
    if (this.canRun(job) && this.active?.job.kind === 'dream' && !this.active.prepared && jobPriority[kind] < jobPriority.dream) this.active.abort.abort(new DreamYield());
    if (this.canRun(job) && kind === 'finalize' && this.active?.job.kind === 'recap' && this.active.job.sessionId === sessionId && !this.active.prepared) this.active.abort.abort(new Preempted());
    this.wake(true); return job;
  }
  async retry(id: string): Promise<Job> { const job = await this.queue.retry(id); this.wake(true); return job; }
  cancelDream(reason = new DreamStopped()): void { if (this.active?.job.kind === 'dream') this.active.abort.abort(reason); }
  private async tick(): Promise<void> {
    if (this.lease === undefined) {
      if (Date.now() < this.nextAcquire) return;
      try {
        this.lease = await acquireFileLease(this.context.paths.workerLock, { timeoutMs: 0, staleMs: this.options.staleMs });
        await this.queue.recoverRunning();
      } catch (error) {
        if (this.lease !== undefined) { await this.lease.release(); this.lease = undefined; }
        this.nextAcquire = Date.now() + (this.options.takeoverMs ?? 60_000);
        if (!(error instanceof LockTimeoutError)) throw error;
        return;
      }
    }
    while (!this.closed) {
      this.lease.check();
      // 本地提交恢复先于领取任务，恢复故障不消耗其他知识任务的 attempt。
      await new DreamStore(this.context).recover();
      const job = await this.queue.claim(new Set(this.handlers.keys()));
      if (job === null) return;
      const handler = this.handlers.get(job.kind);
      // 领取含 I/O；插件可能在这段等待中卸载，任务必须退回队列供重新注册后消费。
      if (handler === undefined) { await this.queue.settle(job, 'queued'); return; }
      const active = { job, abort: new AbortController(), prepared: false };
      this.active = active;
      // 其他进程也会排入高优先级任务或暂停 Dream；模型等待期间轮询共享状态。
      let checking = false;
      const monitor = setInterval(() => {
        if (checking || active.prepared || job.kind !== 'recap' && job.kind !== 'dream') return;
        checking = true;
        void this.queue.list().then((jobs) => {
          if (job.kind === 'recap' && jobs.some((candidate) => candidate.kind === 'finalize' && candidate.sessionId === job.sessionId && this.canRun(candidate))) active.abort.abort(new Preempted());
          if (job.kind === 'dream' && jobs.some((candidate) => candidate.id === job.id && candidate.payload['paused'] === true)) active.abort.abort(new DreamStopped());
          if (job.kind === 'dream' && jobs.some((candidate) => this.canRun(candidate) && jobPriority[candidate.kind] < jobPriority.dream)) active.abort.abort(new DreamYield());
        }).catch(() => { active.abort.abort(new JobError('storage', 'Cannot inspect preemption queue.')); }).finally(() => { checking = false; });
      }, this.options.pollMs ?? 1000);
      monitor.unref();
      try {
        const result = await handler(job, { signal: active.abort.signal, prepared: () => { active.prepared = true; }, committed: () => { active.prepared = false; } });
        this.lease.check();
        await this.queue.settle(job, 'succeeded', result === undefined ? {} : { result });
      } catch (error) {
        const reason: unknown = active.abort.signal.aborted ? active.abort.signal.reason : error;
        if (active.prepared) await this.queue.settle(job, job.attempts < 5 ? 'queued' : 'failed', { lastError: '本地提交待 checkpoint 恢复；请检查存储后重试任务。', nextRunAt: Date.now() + 1000 });
        else if (reason instanceof DreamStopped || reason instanceof DreamYield) await this.queue.settle(job, 'queued', { attempts: Math.max(0, job.attempts - 1) });
        else if (this.closed || reason instanceof JobError && reason.kind === 'suspended') await this.queue.settle(job, 'queued');
        else if (reason instanceof Preempted) await this.queue.settle(job, 'succeeded', { result: { skipped: 'superseded' } });
        else {
          const retryable = reason instanceof JobError && reason.retryable && job.attempts < 5;
          await this.queue.settle(job, retryable ? 'queued' : 'failed', {
            lastError: reason instanceof JobError ? reason.message : '后台任务失败；请检查本地存储和模型路由后重试。',
            ...(retryable ? { nextRunAt: Date.now() + (this.options.retryBaseMs ?? 500) * 2 ** (job.attempts - 1) } : {}),
          });
        }
      } finally { clearInterval(monitor); this.active = undefined; }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.active?.abort.abort(new JobError('disposed', 'Worker disposed.'));
    const finish = async () => { await this.ticking; if (this.lease !== undefined) { await this.lease.release(); this.lease = undefined; } };
    const completion = finish();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([completion, new Promise<void>((resolve) => { timer = setTimeout(() => { this.context.logger.warn('Worker is still reaching a safe point; lease retained until completion.'); resolve(); }, 10_000); })]);
    if (timer !== undefined) clearTimeout(timer);
    void completion.catch(() => { this.context.logger.warn('Worker lease cleanup failed.'); });
  }
}
