// 全批次预校验后再进入 I/O；合法引用来自本轮正文和明确展示过的来源。
import type { Claim } from '../protocol/claim.js';
import { effectiveUpdatedAt } from '../protocol/claim.js';
import type { Dispute } from '../protocol/dispute.js';
import { ClaimIdSchema, DisputeIdSchema, SourceIdSchema, deriveClaimId, deriveDisputeId } from '../protocol/ids.js';
import type { AgentId, ClaimId, SourceId } from '../protocol/ids.js';
import { nowSeconds } from '../protocol/time.js';
import { nextClaimUpdateAt } from '../knowledge/timestamps.js';
import { validateClaimText } from '../knowledge/safety.js';
import { FormationValidationError, RecapOutputSchema } from './schema.js';

export interface PreparedFormation { claims: Claim[]; disputes: Dispute[]; usedClaimIds: ClaimId[]; warnings: string[]; syncClaims?: Claim[] }
export interface PreparationVisibility { directClaims?: readonly Claim[]; editableDeprecatedIds?: ReadonlySet<ClaimId> }
function requireValid(condition: boolean, message: string): asserts condition { if (!condition) throw new FormationValidationError(message); }
// 只从本次已过滤投影提取完整合法 ID；不继承已消费区间或私有工具的引用权限。
export function recapClaimIds(texts: readonly string[]): ClaimId[] {
  return [...new Set(texts.flatMap((text) => [...text.matchAll(/(?<![A-Za-z0-9_])claim_[0-9a-f]{8}(?![A-Za-z0-9_])/g)].map((match) => ClaimIdSchema.parse(match[0]))))];
}
export function prepareFormation(raw: unknown, agentId: AgentId, local: readonly Claim[], seenSourceIds: readonly string[], now = nowSeconds(), visibility: PreparationVisibility = {}): PreparedFormation {
  const output = RecapOutputSchema.parse(raw);
  const placeholders = new Map<string, string>();
  const occupied = new Set([...local, ...visibility.directClaims ?? []].map((claim) => String(claim.id)));
  function reserve(make: () => string): string {
    for (let attempt = 0; attempt < 8; attempt += 1) { const id = make(); if (!occupied.has(id)) { occupied.add(id); return id; } }
    throw new FormationValidationError('生成 ID 冲突，请重试本批复盘。');
  }
  output.new_claims.forEach((draft, index) => {
    requireValid(draft.id === `$new_claim_${index}$`, 'new_claims.id 必须是按数组位置递增的占位符。');
    placeholders.set(draft.id, reserve(() => deriveClaimId(now, draft.name, draft.scope)));
  });
  output.new_disputes.forEach((draft, index) => {
    requireValid(draft.id === `$new_dispute_${index}$`, 'new_disputes.id 必须是按数组位置递增的占位符。');
    placeholders.set(draft.id, reserve(() => deriveDisputeId(now, draft.name, draft.claims, draft.summary)));
  });
  const replace = (value: string): string => value.replace(/\$new_(?:claim|dispute)_\d+\$/g, (token) => {
    const id = placeholders.get(token); requireValid(id !== undefined, '输出含未声明的占位符。'); return id;
  });
  // 遍历值而不替换 JSON 转义文本，避免自然语言字符串破坏结构。
  const resolved = RecapOutputSchema.parse(JSON.parse(JSON.stringify(output), (_key, value: unknown) => typeof value === 'string' ? replace(value) : value));
  const visibleClaims = new Set<string>(local.filter((claim) => claim.status !== 'deprecated').map((claim) => claim.id));
  for (const claim of visibility.directClaims ?? []) visibleClaims.add(claim.id);
  for (const id of visibility.editableDeprecatedIds ?? []) visibleClaims.add(id);
  const policies = new Set<string>();
  for (const source of seenSourceIds) { if (ClaimIdSchema.safeParse(source).success) visibleClaims.add(source); else if (SourceIdSchema.safeParse(source).success) policies.add(source); }
  const sourceClaims = new Set(visibleClaims);
  for (const claim of [...local.filter((claim) => visibleClaims.has(claim.id)), ...visibility.directClaims ?? []]) for (const source of claim.source_claim_ids) { if (source.startsWith('policy_')) policies.add(source); else sourceClaims.add(source); }
  const disputeClaims = new Set(visibleClaims);
  for (const claim of resolved.new_claims) { sourceClaims.add(claim.id); disputeClaims.add(claim.id); }
  const warnings: string[] = [];
  const usedClaimIds: ClaimId[] = [];
  for (const raw of resolved.used_claim_ids) {
    const id = ClaimIdSchema.safeParse(raw);
    requireValid(id.success && visibleClaims.has(id.data), 'used_claim_ids 包含不在本次上下文中的合法 Claim ID；请核对来源后重试整批。');
    if (!usedClaimIds.includes(id.data)) usedClaimIds.push(id.data);
  }
  function sources(values: string[], self: string): SourceId[] {
    return [...new Set(values.map((value) => {
      const parsed = SourceIdSchema.safeParse(value);
      requireValid(parsed.success, 'source_claim_ids 必须是合法 Claim 或 Policy ID。');
      requireValid(value !== self, 'source_claim_ids 不得引用自身。');
      requireValid(value.startsWith('policy_') ? policies.has(value) : sourceClaims.has(value), 'source_claim_ids 引用了本轮不可见的来源。');
      return parsed.data;
    }))];
  }
  const claims: Claim[] = resolved.new_claims.map(({ id: rawId, source_claim_ids, ...draft }) => {
    validateClaimText({ name: draft.name, statement: draft.statement, scope: draft.scope, evidence_summary: draft.evidence_summary });
    const id = ClaimIdSchema.parse(rawId);
    return { ...draft, id, holder: agentId, status: 'active', created_at: now, source_claim_ids: sources(source_claim_ids, id) };
  });
  const updated = new Set<string>();
  for (const { id: rawId, source_claim_ids, ...draft } of resolved.updated_claims) {
    const existing = local.find((claim) => claim.id === rawId);
    requireValid(existing !== undefined && existing.holder === agentId && (existing.status !== 'deprecated' || visibility.editableDeprecatedIds?.has(existing.id) === true), 'updated_claims 只能更新本轮可见且由当前 agent 持有的 Claim。');
    requireValid(!updated.has(rawId), 'updated_claims 含重复 ID。'); updated.add(rawId);
    validateClaimText({ name: draft.name, statement: draft.statement, scope: draft.scope, evidence_summary: draft.evidence_summary });
    claims.push({ ...existing, ...draft, source_claim_ids: sources(source_claim_ids, rawId), updated_at: nextClaimUpdateAt(now, effectiveUpdatedAt(existing)) });
    if (!usedClaimIds.includes(existing.id)) usedClaimIds.push(existing.id);
  }
  const disputes: Dispute[] = resolved.new_disputes.map((draft) => {
    validateClaimText({ name: draft.name, summary: draft.summary });
    const ids = draft.claims.map((raw) => { const id = ClaimIdSchema.safeParse(raw); requireValid(id.success && disputeClaims.has(raw), 'Dispute 引用了本轮不可见的 Claim。'); return id.data; });
    requireValid(new Set(ids).size === ids.length, 'Dispute 至少引用两条不同的 Claim。');
    return { ...draft, id: DisputeIdSchema.parse(draft.id), claims: ids, reporter_agent_id: agentId, status: 'open', created_at: now };
  });
  return { claims, disputes, usedClaimIds, warnings };
}
