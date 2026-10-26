// 先展开操作再做全组硬校验；事实修订和置信度提升需要逐 Claim 的独立新证据。
import { createHash } from 'node:crypto';
import type { Claim } from '../protocol/claim.js';
import { effectiveUpdatedAt } from '../protocol/claim.js';
import type { AgentId, ClaimId } from '../protocol/ids.js';
import { claimRevision } from '../protocol/revision.js';
import { nextClaimUpdateAt } from '../knowledge/timestamps.js';
import { validateClaimText } from '../knowledge/safety.js';
import { nowSeconds } from '../protocol/time.js';
import { sameClaim } from '../knowledge/alignment.js';
import { GroupSchema, UpdateSchema, requireDream } from './schema.js';
import type { Candidate, DraftGroup, Group, PreparedGroup, Validation } from './schema.js';
import { directEvidence, independentReceipt, requireEvidenceIds, type Receipts } from './evidence.js';
import { validateEvidenceSummaryPreservation } from './preservation.js';

export const contentHash = (claim: Claim): string => claimRevision(claim).slice('sha256-v1:'.length);
export function valueHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex'); }
export function sameIds(a: readonly string[], b: readonly string[]): boolean { return new Set(a).size === a.length && new Set(b).size === b.length && a.length === b.length && a.every((id) => b.includes(id)); }
const rank = { low: 0, medium: 1, high: 2 };
export function validateCandidates(candidates: readonly Candidate[], readable: readonly Claim[], owner: AgentId, evidenceEnabled = false): void {
  const groups = new Set<string>(); const ids = new Set<ClaimId>();
  for (const candidate of candidates) {
    requireDream(!groups.has(candidate.group_id), '候选 group_id 重复。'); groups.add(candidate.group_id);
    requireDream(candidate.kind !== 'evidence' || evidenceEnabled, '证据校准未启用或受限查证能力不可用。');
    requireDream(new Set(candidate.claim_ids).size === candidate.claim_ids.length, '候选 Claim ID 必须唯一。');
    for (const id of candidate.claim_ids) {
      const claim = readable.find((claim) => claim.id === id);
      requireDream(claim !== undefined && claim.holder === owner && claim.status !== 'deprecated', '候选只能包含完整展示过的自身非 deprecated Claim。');
      requireDream(candidate.kind !== 'evidence' || claim.confidence !== 'high', 'high Claim 不进入证据校准；不能先降级再纠正。');
      requireDream(!ids.has(id), '同一 Claim 不得被多个未处理候选占用。'); ids.add(id);
    }
  }
}
export function expandDraft(draft: DraftGroup, readable: readonly Claim[]): Group {
  const basis = [...draft.change_basis];
  const updates = draft.operations.map((operation) => {
    const original = readable.find((claim) => claim.id === operation.id); requireDream(original !== undefined, '操作只能针对本轮完整读过的 Claim。');
    const fields = Object.keys(operation.changes);
    if (operation.reason !== undefined) {
      requireDream(draft.kind === 'quality' && operation.action === 'deprecate' && fields.length === 0 && operation.reason.trim() !== '' && !basis.some((item) => item.claim_id === operation.id), `${operation.id} 的 operation.reason 不是通用备注；当前为 ${draft.kind}/${operation.action}，请省略 reason，将修改依据放入 group.change_basis.justification。仅无 changes 且无对应 change_basis 的 quality/deprecate 可使用 reason 简写。`);
      basis.push({ claim_id: operation.id, removed_or_changed: '从当前知识中移除一次性记录，历史正文保持。', added: '', justification: operation.reason, evidence_ids: [] });
    }
    requireDream(operation.action !== 'keep' || fields.length === 0, 'keep 不得携带 changes。');
    requireDream(operation.action !== 'update' || fields.length > 0, 'update 必须携带 changes。');
    requireDream(operation.action !== 'deprecate' || fields.every((key) => key === 'evidence_summary'), 'deprecate 仅允许补充 evidence_summary；其余历史正文保持。');
    const update = UpdateSchema.strip().parse({ ...original, ...operation.changes, ...operation.action === 'deprecate' ? { status: 'deprecated' } : {} });
    requireDream(operation.action === 'deprecate' || update.status !== 'deprecated', '废弃必须使用 deprecate 动作。');
    return update;
  });
  return GroupSchema.parse({ kind: draft.kind, reason: draft.reason, evidence_ids: draft.evidence_ids, coverage: draft.coverage, change_basis: basis, updates });
}
export function reaches(id: ClaimId, target: ClaimId, graph: readonly Claim[], visited = new Set<ClaimId>()): boolean {
  if (id === target) return true;
  if (visited.has(id)) return false; visited.add(id);
  return graph.find((claim) => claim.id === id)?.source_claim_ids.some((source) => source.startsWith('claim_') && graph.some((claim) => claim.id === source && reaches(claim.id, target, graph, visited))) ?? false;
}
export function validateConsolidationSources(input: Claim, after: readonly Claim[], destinations: readonly ClaimId[]): void {
  const missing = input.source_claim_ids.filter((source) => !after.some((claim) => destinations.includes(claim.id) && claim.status !== 'deprecated' && (claim.source_claim_ids.includes(source) || source === claim.id)));
  requireDream(missing.length === 0, `整合必须在存续去向中保留 ${input.id} 的既有来源：${missing.join(', ')}；来源对应输入将被 deprecated 也不能删除，仅合回来源 ID 自身时免去自引用。`);
}
export interface EvidenceContext { enabled: boolean; receipts: Receipts }
export function prepareGroup(group: Group, readable: readonly Claim[], owner: AgentId, now = nowSeconds(), evidence: EvidenceContext = { enabled: false, receipts: {} }): PreparedGroup {
  requireDream(group.kind !== 'evidence' || evidence.enabled, '证据校准未启用。');
  requireDream(group.evidence_ids.length === 0 || evidence.enabled, '证据校准关闭时不能引入新证据。');
  requireEvidenceIds(group.evidence_ids, Object.keys(evidence.receipts), '组引用了不存在或重复的查证回执。');
  for (const basis of group.change_basis) {
    requireEvidenceIds(basis.evidence_ids, group.evidence_ids, 'change_basis 只能引用本组已读证据。');
    requireDream(directEvidence(evidence.receipts, basis.evidence_ids, basis.claim_id).length === basis.evidence_ids.length, '直接证据必须绑定对应 Claim，不能借用其他 Claim 的查证。');
  }
  requireDream(group.updates.length > 0 && new Set(group.updates.map((item) => item.id)).size === group.updates.length, '组必须包含唯一的更新 ID。');
  const before: Claim[] = []; const after: Claim[] = [];
  const inputs = group.updates.map((item) => readable.find((claim) => claim.id === item.id));
  requireDream(inputs.every((claim) => claim !== undefined && claim.holder === owner && claim.status !== 'deprecated'), '整理只能修改完整读过、自身持有、非废弃的 Claim。');
  const inherited = new Set(inputs.flatMap((claim) => claim?.source_claim_ids ?? []));
  for (const update of group.updates) {
    const original = readable.find((claim) => claim.id === update.id); requireDream(original !== undefined, '缺少原 Claim。');
    validateClaimText({ name: update.name, statement: update.statement, scope: update.scope, evidence_summary: update.evidence_summary });
    const ids = group.change_basis.find((basis) => basis.claim_id === original.id)?.evidence_ids ?? [];
    const supported = directEvidence(evidence.receipts, ids, original.id).length > 0 && update.evidence_summary !== original.evidence_summary;
    requireDream(rank[update.confidence] <= rank[original.confidence] || supported, '没有对应 Claim 的新独立证据和新的 evidence_summary，不得提高置信度。');
    requireDream(new Set(update.source_claim_ids).size === update.source_claim_ids.length && update.source_claim_ids.every((source) => source !== update.id && inherited.has(source)), 'source_claim_ids 只能继承本组已有来源，不得自引用或新增输入 ID。');
    const target: Claim = { ...original, ...update };
    validateEvidenceSummaryPreservation(original, [target]);
    if (group.kind === 'evidence' && !sameClaim(original, target)) requireDream(original.confidence !== 'high' && supported, 'B 类事实校准必须针对原始 medium/low Claim，引用对应新证据并更新 evidence_summary。');
    if (!sameClaim(original, target)) target.updated_at = nextClaimUpdateAt(now, effectiveUpdatedAt(original));
    before.push(original); after.push(target);
  }
  const changed = before.filter((claim, index) => after[index] !== undefined && !sameClaim(claim, after[index])).map((claim) => claim.id);
  requireDream(sameIds(group.change_basis.map((item) => item.claim_id), changed), 'change_basis 必须恰好解释全部变更，不能遗漏、重复或解释 keep。');
  if (group.kind === 'consolidation') {
    const outputs = after.filter((claim) => claim.status !== 'deprecated');
    requireDream(before.length >= 2 && outputs.length > 0, '整合至少两个输入且必须有存续输出。');
    requireDream(sameIds(group.coverage.map((item) => item.input_id), before.map((claim) => claim.id)), 'coverage 必须恰好覆盖每条输入。');
    for (const coverage of group.coverage) {
      requireDream(coverage.output_ids.length > 0 && new Set(coverage.output_ids).size === coverage.output_ids.length && coverage.output_ids.every((id) => outputs.some((claim) => claim.id === id)), 'coverage 的去向必须是本组存续 Claim。');
      const original = before.find((claim) => claim.id === coverage.input_id); requireDream(original !== undefined, 'coverage 输入不存在。');
      validateConsolidationSources(original, outputs, coverage.output_ids);
      validateEvidenceSummaryPreservation(original, outputs.filter((claim) => coverage.output_ids.includes(claim.id)));
      requireDream(outputs.filter((claim) => coverage.output_ids.includes(claim.id)).every((claim) => rank[claim.confidence] <= rank[original.confidence] || directEvidence(evidence.receipts, group.change_basis.find((basis) => basis.claim_id === claim.id)?.evidence_ids ?? [], claim.id).length > 0 && claim.evidence_summary !== before.find((input) => input.id === claim.id)?.evidence_summary), '整合不得把较弱来源无证据提升为更高置信度。');
    }
    requireDream(outputs.some((claim) => before.find((input) => input.id === claim.id)?.statement !== claim.statement), '整合必须改写存续正文：至少一个存续 ID 应使用 update，并在 operations[].changes.statement 中提交不同于原文、完整承接有效信息的正文。仅 keep 一条并 deprecate 其余，或只修改名称/依据，均不满足要求。若没有安全且有收益的重组，返回 action=keep、reason_kind=no_consolidation_benefit，不能为通过校验无依据改写。');
  }
  const graph = [...readable.filter((claim) => !after.some((target) => target.id === claim.id)), ...after];
  for (const target of after) for (const source of target.source_claim_ids) if (!before.find((claim) => claim.id === target.id)?.source_claim_ids.includes(source)) {
    const claim = graph.find((claim) => claim.id === source); requireDream(claim === undefined || !reaches(claim.id, target.id, graph), '整理不得引入来源环。');
  }
  return { before, after, completed: false, skipped: false };
}
export function reviewInput(groupId: string, group: Group, readable: readonly Claim[], receipts: Receipts = {}): Validation {
  const input = { group_id: groupId, kind: group.kind, reason: group.reason, before: group.updates.flatMap((update) => readable.filter((claim) => claim.id === update.id)), after: group.updates, changes: group.updates.map((update) => {
    const original = readable.find((claim) => claim.id === update.id);
    const changes = Object.fromEntries(Object.entries(update).filter(([key, value]) => key !== 'id' && JSON.stringify(original?.[key as keyof Claim]) !== JSON.stringify(value)));
    return { id: update.id, action: update.status === 'deprecated' ? 'deprecate' as const : Object.keys(changes).length === 0 ? 'keep' as const : 'update' as const, changes: update.status === 'deprecated' ? Object.fromEntries(Object.entries(changes).filter(([key]) => key === 'evidence_summary')) : changes };
  }), coverage: group.coverage, change_basis: group.change_basis, unversioned_evidence_omitted: group.evidence_ids.filter((id) => independentReceipt(receipts, id) === null), evidence: Object.fromEntries(group.evidence_ids.flatMap((id) => { const receipt = receipts[id]; return receipt !== undefined && independentReceipt(receipts, id) !== null ? [[id, receipt]] : []; })) };
  return { validation_id: valueHash(input), input };
}
