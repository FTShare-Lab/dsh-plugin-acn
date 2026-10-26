// 不猜测哪些原依据属于限制；完整保留原文，再追加本轮证据和历史说明。
import type { Claim } from '../protocol/claim.js';
import { requireDream } from './schema.js';
import type { Validation } from './schema.js';

type EvidenceSummary = Pick<Claim, 'id' | 'evidence_summary'>;
export function validateEvidenceSummaryPreservation(input: EvidenceSummary, outputs: readonly EvidenceSummary[]): void {
  if (input.evidence_summary.trim() === '') return;
  requireDream(outputs.some((output) => output.evidence_summary.includes(input.evidence_summary)), `必须在指定去向的 evidence_summary 中逐字保留 ${input.id} 的完整原证据摘要；置信度等级、相似引用或废弃历史不能代替。请保留原文，再追加本轮新证据、版本和适用限制；无法安全承接时 keep。`);
}
export function validateEvidencePreservation(input: Pick<Validation['input'], 'kind' | 'before' | 'after' | 'coverage'>): void {
  for (const original of input.before) {
    validateEvidenceSummaryPreservation(original, input.after.filter((claim) => claim.id === original.id));
    if (input.kind === 'consolidation') {
      const destinations = input.coverage.find((item) => item.input_id === original.id)?.output_ids ?? [];
      validateEvidenceSummaryPreservation(original, input.after.filter((claim) => claim.status !== 'deprecated' && destinations.includes(claim.id)));
    }
  }
}
