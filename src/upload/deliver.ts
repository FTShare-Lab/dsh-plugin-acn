// 交付使用单飞租约；网络期间不持知识锁或 pending 锁，成功按精确版本清理。
import type { StoreContext } from '../store/context.js';
import { acquireFileLease } from '../store/lock.js';
import { LockTimeoutError } from '../store/errors.js';
import { DeliveryStatusStore } from '../store/delivery-status.js';
import { ClaimStore } from '../store/claims.js';
import { withFileLock } from '../store/lock.js';
import { ensureKnowledgeReady, KnowledgeBusy, sameClaim } from '../knowledge/alignment.js';
import { relatedIds, consolidationReady } from './consolidation.js';
import { UploadStore } from '../store/uploads.js';
import { ReportedSetStore, reportedClaimSetKey } from '../store/reported-sets.js';
import { RejectedDisputeStore, disputeVersion } from '../store/rejected-disputes.js';
import { TeamError } from '../team/errors.js';
import type { TeamFacade } from '../team/service.js';
import { nowSeconds } from '../protocol/time.js';

export interface DeliveryReport { deliveredClaims: number; deliveredDisputes: number; pendingClaims: number; pendingDisputes: number; warnings: string[] }
export class UploadDelivery {
  constructor(readonly context: StoreContext, readonly team: TeamFacade | null) {}
  async deliver(signal?: AbortSignal): Promise<DeliveryReport> {
    const report: DeliveryReport = { deliveredClaims: 0, deliveredDisputes: 0, pendingClaims: 0, pendingDisputes: 0, warnings: [] };
    const team = this.team;
    if (team === null || this.context.mode === 'solo') return report;
    const queue = new UploadStore(this.context); const status = new DeliveryStatusStore(this.context);
    let snapshot = await queue.read();
    if (snapshot.claims.length === 0 && snapshot.disputes.length === 0) return report;
    let lease;
    try { lease = await acquireFileLease(this.context.paths.deliveryLock, { timeoutMs: 0 }); }
    catch (error) { if (error instanceof LockTimeoutError) return { ...report, pendingClaims: snapshot.claims.length, pendingDisputes: snapshot.disputes.length }; throw error; }
    try {
      snapshot = await queue.read();
      const initialIds = new Set(snapshot.claims.map((claim) => claim.id)); const attempted = new Set<string>(); let stopped = false;
      for (let round = 0; round <= initialIds.size && !stopped; round += 1) {
        let progressed = false;
        for (const queued of (await queue.read()).claims.filter((claim) => initialIds.has(claim.id))) {
          signal?.throwIfAborted(); lease.check();
          let current;
          try {
            current = await withFileLock(this.context.paths.knowledgeLock, async () => { await ensureKnowledgeReady(this.context.paths.root); return new ClaimStore(this.context).list(); }, { timeoutMs: 0 });
          } catch (error) { if (!(error instanceof LockTimeoutError || error instanceof KnowledgeBusy)) throw error; continue; }
          const pending = await queue.read();
          const claim = pending.claims.find((claim) => claim.id === queued.id); if (claim === undefined) continue;
          if (attempted.has(claim.id)) continue;
          // 单人期间的修改没有团队授权，也可能包含尚未交付的整合；保留旧项待确认。
          if (!current.some((value) => sameClaim(value, claim))) { await status.record({ kind: 'claim', id: claim.id, reason: 'version' }); report.warnings.push(`Claim ${claim.id} 的待上传版本与本地不一致，已暂停该项；请在团队模式确认修订后重试。`); continue; }
          if (relatedIds(pending.consolidations ?? []).has(claim.id) && !consolidationReady(claim, pending.consolidations ?? [], pending.acknowledgements ?? [], current)) { await status.record({ kind: 'claim', id: claim.id, reason: 'dependency' }); continue; }
          attempted.add(claim.id); progressed = true;
          try {
            await team.request('maintainer', () => team.maintainer.upload(claim, signal));
            lease.check(); await queue.removeDeliveredClaims([claim]); report.deliveredClaims += 1; await status.clear('claim', claim.id);
          } catch (error) { if (!(error instanceof TeamError)) throw error; if (error.kind !== 'cancelled') await status.record({ kind: 'claim', id: claim.id, reason: error.kind === 'legacy_route' ? 'client' : error.kind, ...(error.status === undefined ? {} : { status: error.status }) }); report.warnings.push(error.message); if (error.kind === 'auth' || error.kind === 'cancelled') { stopped = true; break; } }
        }
        if (!progressed) break;
      }
      const ledger = new ReportedSetStore(this.context);
      const rejected = new RejectedDisputeStore(this.context);
      for (const dispute of snapshot.disputes) {
        signal?.throwIfAborted(); lease.check();
        if (await rejected.contains(dispute)) { await queue.removeDeliveredDisputes([dispute]); continue; }
        // Claim 更新失败不阻止已有团队版本的争议上报；缺失依赖由服务端判定并重试。
        try {
          const recorded = (await ledger.read()).reported_claim_sets[reportedClaimSetKey(dispute.claims)];
          if (recorded === undefined) {
            await team.request('maintainer', () => team.maintainer.report(dispute, signal));
            lease.check(); await ledger.record(dispute.claims, dispute.id, nowSeconds()); report.deliveredDisputes += 1;
          }
          await queue.removeDeliveredDisputes([dispute]); await status.clear('dispute', dispute.id);
        } catch (error) {
          if (!(error instanceof TeamError)) throw error;
          if (error.kind === 'client' && error.status === 409) {
            // 明确冲突（如直接 Claim 已废弃）不会因重试恢复；本地争议仍保留供检查。
            lease.check(); const previous = (await status.read()).issues[`dispute-${dispute.id}`];
            await rejected.record(dispute, (previous?.version === disputeVersion(dispute) ? previous.attempts : 0) + 1);
            await status.record({ kind: 'dispute', id: dispute.id, version: disputeVersion(dispute), reason: 'rejected', status: 409 });
            const warning = `Dispute ${dispute.id} 被团队服务以 409 拒绝，已停止自动重试；本地记录保留，请核对当前 Claim。`;
            report.warnings.push(warning); this.context.logger.warn(warning);
            await queue.removeDeliveredDisputes([dispute]);
          } else {
            if (error.kind !== 'cancelled') await status.record({ kind: 'dispute', id: dispute.id, version: disputeVersion(dispute), reason: error.kind === 'legacy_route' ? 'client' : error.kind, ...(error.status === undefined ? {} : { status: error.status }) });
            report.warnings.push(error.message);
          }
          if (error.kind === 'auth' || error.kind === 'cancelled') break;
        }
      }
      const pending = await queue.read(); report.pendingClaims = pending.claims.length; report.pendingDisputes = pending.disputes.length;
      report.warnings = [...new Set(report.warnings)]; return report;
    } finally { await lease.release(); }
  }
}
