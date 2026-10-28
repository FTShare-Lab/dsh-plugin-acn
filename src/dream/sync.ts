// 旧整合依赖只在当前版本语义复核后重绑；它不修改任何 Claim。
import { join } from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { StoreContext } from '../store/context.js';
import { UploadStore, ConsolidationDeliverySchema } from '../store/uploads.js';
import { ClaimStore } from '../store/claims.js';
import { withFileLock } from '../store/lock.js';
import { readYaml, readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { hasCode, StoreError } from '../store/errors.js';
import { ClaimSchema } from '../protocol/claim.js';
import type { ClaimId } from '../protocol/ids.js';
import { sameClaim, ensureKnowledgeReady } from '../knowledge/alignment.js';
import { SemanticReviewSchema, KeySchema, HashSchema, requireDream, DreamValidationError } from './schema.js';
import type { SemanticReview } from './schema.js';
import { sameIds, valueHash, validateConsolidationSources } from './plan.js';
import { validateEvidenceSummaryPreservation } from './preservation.js';

export const SyncValidationSchema = z.strictObject({ validation_id: HashSchema, input: z.strictObject({ before: ClaimSchema, carriers: z.array(ClaimSchema), previous_dependency: ConsolidationDeliverySchema, current_source: ClaimSchema }) });
const SyncRecordSchema = z.strictObject({ validation: SyncValidationSchema, review: SemanticReviewSchema, applied: z.boolean(), abandoned: z.boolean().default(false) });
export type SyncValidation = z.infer<typeof SyncValidationSchema>;
export class DreamSync {
  constructor(readonly context: StoreContext, private readonly semanticReview = false) {}
  async resume(jobId: string, sourceId: ClaimId, signal: AbortSignal): Promise<boolean> {
    const root = join(this.context.paths.dreamJob(jobId), 'sync_reviews'); let files: string[];
    try { files = await fs.readdir(root); } catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
    for (const file of files.filter((name) => /^[0-9a-f]{64}\.yaml$/.test(name)).sort()) {
      const path = join(root, file); const record = await readYaml(path, SyncRecordSchema);
      if (record.validation.input.before.id !== sourceId || record.abandoned) continue;
      if (record.applied) return true;
      try { await this.apply(jobId, record.validation, record.review, signal); return true; }
      catch (error) {
        if (!(error instanceof DreamValidationError || error instanceof StoreError && error.kind === 'conflict')) throw error;
        // 旧承接已被外部修改：留下拒绝回执，让本轮重新读取和复核当前版本。
        await writeYamlAtomic(path, { ...record, abandoned: true }, SyncRecordSchema, this.context.logger);
      }
    }
    return false;
  }
  async prepare(sourceId: ClaimId, carrierIds: readonly ClaimId[], signal?: AbortSignal): Promise<SyncValidation> {
    return withFileLock(this.context.paths.knowledgeLock, async () => { await ensureKnowledgeReady(this.context.paths.root); return this.prepareLocked(sourceId, carrierIds); }, { signal });
  }
  private async prepareLocked(sourceId: ClaimId, carrierIds: readonly ClaimId[]): Promise<SyncValidation> {
    requireDream(this.context.mode === 'team', '单人模式没有整合交付依赖。');
    const previous = (await new UploadStore(this.context).read()).consolidations?.find((group) => group.retired.id === sourceId); requireDream(previous !== undefined, '没有对应的待交付整合来源。');
    const current = await new ClaimStore(this.context).list(); const source = current.find((claim) => claim.id === sourceId);
    requireDream(source !== undefined && sameClaim(source, previous.retired) && source.holder === this.context.agentId, '来源已变化，旧弃用请求不能重绑。');
    const carriers = carrierIds.map((id) => current.find((claim) => claim.id === id));
    requireDream(carriers.length > 0 && new Set(carrierIds).size === carrierIds.length && carriers.every((claim) => claim !== undefined && claim.holder === this.context.agentId && claim.status !== 'deprecated'), '承接必须是当前完整、唯一、存续的自身 Claim。');
    const input = { before: previous.before, carriers: carriers.filter((claim) => claim !== undefined), previous_dependency: previous, current_source: source };
    if (!this.semanticReview) validateEvidenceSummaryPreservation(input.before, input.carriers);
    return SyncValidationSchema.parse({ validation_id: valueHash(input), input });
  }
  async apply(jobId: string, validation: SyncValidation, review: SemanticReview, signal: AbortSignal): Promise<void> {
    const input = validation.input; const carrierIds = input.carriers.map((claim) => claim.id);
    requireDream(valueHash(input) === validation.validation_id, '同步复核哈希必须绑定完整输入。');
    requireDream(review.claims.length === 1 && review.claims[0]?.claim_id === input.before.id, '同步复核只描述原整合来源。');
    const item = review.claims[0]; requireDream(item !== undefined && item.final_name === input.current_source.name && item.name_reason.trim() !== '' && !item.factual_correction && item.evidence_ids.length === 0 && sameIds(item.output_ids, carrierIds), '同步复核只能确认当前承接完整保留信息，不能纠正事实或省略承接项。');
    validateConsolidationSources(input.before, input.carriers, carrierIds);
    await withFileLock(this.context.paths.knowledgeLock, async () => {
      await ensureKnowledgeReady(this.context.paths.root); const path = join(this.context.paths.dreamJob(KeySchema.parse(jobId)), 'sync_reviews', `${validation.validation_id}.yaml`);
      const saved = await readYamlOr(path, SyncRecordSchema, () => null); if (saved?.applied) return;
      const current = await this.prepareLocked(input.before.id, carrierIds);
      const revised = { ...input.previous_dependency, carriers: input.carriers };
      const rebound = valueHash(current.input.previous_dependency) === valueHash(revised) && current.input.carriers.every((claim, index) => input.carriers[index] !== undefined && sameClaim(claim, input.carriers[index]));
      requireDream(current.validation_id === validation.validation_id || rebound, '同步输入版本已变化，必须重新读取和复核。');
      signal.throwIfAborted();
      await writeYamlAtomic(path, { validation, review, applied: false }, SyncRecordSchema, this.context.logger);
      await new UploadStore(this.context).rebind(input.previous_dependency, revised);
      await writeYamlAtomic(path, { validation, review, applied: true }, SyncRecordSchema, this.context.logger);
    }, { signal });
  }
}
