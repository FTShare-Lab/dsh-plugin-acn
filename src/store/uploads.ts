// 上传队列的持久化与本地合并；单人模式不读取或创建团队队列。
import { z } from 'zod';
import { ClaimSchema, effectiveUpdatedAt, type Claim } from '../protocol/claim.js';
import { DisputeSchema, type Dispute } from '../protocol/dispute.js';
import { ClaimIdSchema } from '../protocol/ids.js';
import type { PolicyId } from '../protocol/ids.js';
import { timestampNanos } from '../protocol/time.js';
import { claimRevision } from '../protocol/revision.js';
import { sameClaim } from '../knowledge/alignment.js';
import { pruneDeliveries } from '../upload/consolidation.js';
import type { ConsolidationDelivery } from '../upload/consolidation.js';
import { StoreError } from './errors.js';
import type { StoreContext } from './context.js';
import { withFileLock } from './lock.js';
import { removeFile } from './atomic.js';
import { readYamlOr, writeYamlAtomic } from './yaml.js';
import { RejectedDisputeStore, disputeVersion } from './rejected-disputes.js';

export const ConsolidationDeliverySchema = z.object({ before: ClaimSchema, retired: ClaimSchema, carriers: z.array(ClaimSchema) });
export const PendingUploadsSchema = z.object({
  consolidations: z.array(ConsolidationDeliverySchema).default([]).transform((items) => items.length === 0 ? undefined : items),
  acknowledgements: z.array(ClaimSchema).default([]).transform((items) => items.length === 0 ? undefined : items),
  claims: z.array(ClaimSchema).default([]),
  durable_claim_ids: z.array(ClaimIdSchema).default([]).transform((items) => items.length === 0 ? undefined : [...new Set(items)].sort()),
  disputes: z.array(DisputeSchema).default([]),
});
export type PendingUploads = z.infer<typeof PendingUploadsSchema>;

export class UploadStore {
  constructor(readonly context: StoreContext) {}
  async read(): Promise<PendingUploads> {
    if (this.context.mode === 'solo') return PendingUploadsSchema.parse({});
    return readYamlOr(this.context.paths.pendingUploads, PendingUploadsSchema, () => PendingUploadsSchema.parse({}));
  }
  async save(value: unknown): Promise<void> {
    if (this.context.mode === 'solo') return;
    await this.modify(() => PendingUploadsSchema.parse(value));
  }
  private async persist(value: PendingUploads): Promise<void> {
    if (value.claims.length === 0 && value.disputes.length === 0 && !value.consolidations?.length && !value.acknowledgements?.length) await removeFile(this.context.paths.pendingUploads, this.context.logger);
    else await writeYamlAtomic(this.context.paths.pendingUploads, value, PendingUploadsSchema, this.context.logger);
  }
  async modify(update: (current: PendingUploads) => PendingUploads | Promise<PendingUploads>): Promise<void> {
    if (this.context.mode === 'solo') return;
    await withFileLock(this.context.paths.pendingUploadsLock, async () => { await this.persist(PendingUploadsSchema.parse(await update(await this.read()))); }, { timeoutMs: this.context.lockTimeoutMs });
  }
  async enqueue(claims: readonly Claim[], disputes: readonly Dispute[], durable = false, dependencies: readonly ConsolidationDelivery[] = []): Promise<void> {
    if (this.context.mode === 'solo') return;
    await this.modify(async (pending) => {
      const rejected = await new RejectedDisputeStore(this.context).read();
      const byClaim = new Map(pending.claims.map((claim) => [claim.id, claim]));
      let consolidations = pending.consolidations ?? [];
      for (const value of claims) {
        const claim = ClaimSchema.parse(value);
        const existing = byClaim.get(claim.id);
        if (existing !== undefined && timestampNanos(effectiveUpdatedAt(claim)) < timestampNanos(effectiveUpdatedAt(existing))) continue;
        // 本地普通修订不能继续交付旧的来源版本；承接依赖的交付执行留到整合阶段。
        consolidations = claim.status === 'deprecated'
          ? consolidations.map((group) => group.retired.id === claim.id ? { ...group, retired: claim } : group)
          : consolidations.filter((group) => group.retired.id !== claim.id);
        byClaim.set(claim.id, claim);
      }
      const byDispute = new Map(pending.disputes.map((dispute) => [dispute.id, dispute]));
      for (const value of disputes) {
        const dispute = DisputeSchema.parse(value);
        if (Object.hasOwn(rejected, disputeVersion(dispute))) continue;
        const existing = byDispute.get(dispute.id);
        if (existing === undefined || timestampNanos(dispute.created_at) >= timestampNanos(existing.created_at)) byDispute.set(dispute.id, dispute);
      }
      const durableIds = new Set(pending.durable_claim_ids ?? []);
      if (durable) for (const claim of claims) durableIds.add(claim.id);
      for (const dependency of dependencies) if (byClaim.get(dependency.retired.id) !== undefined && sameClaim(byClaim.get(dependency.retired.id) ?? dependency.before, dependency.retired)) {
        consolidations = consolidations.filter((group) => group.retired.id !== dependency.retired.id);
        consolidations.push(ConsolidationDeliverySchema.parse(dependency));
      }
      return PendingUploadsSchema.parse({ ...pending, consolidations, claims: [...byClaim.values()].sort((a, b) => a.id.localeCompare(b.id)), durable_claim_ids: [...durableIds].filter((id) => byClaim.has(id)).sort(), disputes: [...byDispute.values()].sort((a, b) => a.id.localeCompare(b.id)) });
    });
  }
  async removeDeliveredClaims(delivered: readonly Claim[]): Promise<void> {
    if (this.context.mode === 'solo') return;
    const revisions = new Map(delivered.map((claim) => [claim.id, claimRevision(claim)]));
    await this.modify((pending) => {
      const claims = pending.claims.filter((claim) => revisions.get(claim.id) !== claimRevision(claim));
      const ids = new Set(claims.map((claim) => claim.id));
      const acknowledgements = [...pending.acknowledgements ?? []];
      for (const claim of delivered) { const index = acknowledgements.findIndex((value) => value.id === claim.id); if (index >= 0) acknowledgements.splice(index, 1); acknowledgements.push(claim); }
      return PendingUploadsSchema.parse({ ...pending, ...pruneDeliveries(pending.consolidations ?? [], acknowledgements, claims), claims, durable_claim_ids: pending.durable_claim_ids?.filter((id) => ids.has(id)) });
    });
  }
  async rebind(previous: ConsolidationDelivery, revised: ConsolidationDelivery): Promise<void> {
    if (this.context.mode === 'solo') throw new StoreError('conflict', 'Team delivery is disabled.');
    await this.modify((pending) => {
      const exact = (group: ConsolidationDelivery, value: ConsolidationDelivery) => sameClaim(group.before, value.before) && sameClaim(group.retired, value.retired) && group.carriers.length === value.carriers.length && group.carriers.every((claim, index) => value.carriers[index] !== undefined && sameClaim(claim, value.carriers[index]));
      if (pending.consolidations?.some((group) => exact(group, revised))) return pending;
      if (!pending.consolidations?.some((group) => exact(group, previous)) || !pending.claims.some((claim) => sameClaim(claim, previous.retired))) throw new StoreError('conflict', 'Consolidation dependency changed; review current versions.');
      const claims = pending.claims.filter((claim) => !revised.carriers.some((carrier) => carrier.id === claim.id)); claims.push(...revised.carriers);
      return PendingUploadsSchema.parse({ ...pending, claims, durable_claim_ids: [...new Set([...pending.durable_claim_ids ?? [], ...revised.carriers.map((claim) => claim.id)])], consolidations: [...pending.consolidations.filter((group) => group.retired.id !== revised.retired.id), revised] });
    });
  }
  async removeDeliveredDisputes(delivered: readonly Dispute[]): Promise<void> {
    if (this.context.mode === 'solo') return;
    const encoded = new Set(delivered.map((dispute) => JSON.stringify(DisputeSchema.parse(dispute))));
    await this.modify((pending) => PendingUploadsSchema.parse({ ...pending, disputes: pending.disputes.filter((dispute) => !encoded.has(JSON.stringify(dispute))) }));
  }
  async withdrawPolicy(policyId: PolicyId): Promise<void> {
    if (this.context.mode === 'solo') return;
    await this.modify((pending) => {
      const obsolete = (pending.consolidations ?? []).filter((group) => group.before.source_claim_ids.includes(policyId) || group.retired.source_claim_ids.includes(policyId));
      const obsoleteIds = new Set(obsolete.map((group) => group.retired.id));
      const carriers = new Set(obsolete.flatMap((group) => group.carriers.map((claim) => claim.id)));
      const retained = (pending.consolidations ?? []).filter((group) => !obsoleteIds.has(group.retired.id));
      const stillNeeded = new Set(retained.flatMap((group) => group.carriers.map((claim) => claim.id)));
      return PendingUploadsSchema.parse({ ...pending, consolidations: retained,
        claims: pending.claims.filter((claim) => !carriers.has(claim.id) || stillNeeded.has(claim.id) || pending.durable_claim_ids?.includes(claim.id) || claim.source_claim_ids.some((source) => source === policyId)),
      });
    });
  }
}
