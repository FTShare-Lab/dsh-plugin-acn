// 知识应用后的投递与空闲补传合并触发；卸载统一取消并等待收敛。
import type { AcnKnowledge } from '../knowledge/service.js';
import { UploadStore } from '../store/uploads.js';
import { UploadDelivery } from './deliver.js';

export class UploadScheduler {
  private pending: Promise<void> | undefined;
  private requested = false;
  private closed = false;
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  readonly delivery: UploadDelivery;
  constructor(readonly knowledge: AcnKnowledge, private readonly intervalMs = 10 * 60_000) { this.delivery = new UploadDelivery(knowledge.context(), knowledge.team); }
  start(): void {
    if (this.knowledge.team === null) return;
    this.unsubscribe = this.knowledge.onClaimsChanged(() => { this.kick(); });
    this.timer = setInterval(() => { this.kick(); }, this.intervalMs); this.timer.unref(); this.kick();
  }
  kick(): void {
    if (this.closed || this.knowledge.team === null) return;
    this.requested = true;
    if (this.pending !== undefined) return;
    const work = this.run().catch(() => { if (!this.closed) this.knowledge.logger.warn('Could not finish local upload bookkeeping; pending delivery is retained.'); });
    this.pending = work;
    void work.finally(() => { if (this.pending === work) { this.pending = undefined; if (this.requested && !this.closed) this.kick(); } });
  }
  private async run(): Promise<void> {
    while (this.requested && !this.closed) {
      this.requested = false;
      const queue = await new UploadStore(this.knowledge.context()).read();
      if (queue.claims.length > 0 || queue.disputes.length > 0) await this.delivery.deliver(this.abort.signal);
    }
  }
  async flush(): Promise<void> { await this.pending; }
  async close(): Promise<void> { this.closed = true; this.unsubscribe?.(); if (this.timer !== undefined) clearInterval(this.timer); this.abort.abort(); await this.pending; }
}
