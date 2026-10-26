// 内化只使用展示过的 Policy、Claim 与冻结仲裁；持有权、来源与最终状态整批校验。
import { RecapOutputSchema, FormationValidationError } from '../formation/schema.js';
import { prepareFormation, type PreparedFormation } from '../formation/prepare.js';
import type { Claim } from '../protocol/claim.js';
import type { Dispute } from '../protocol/dispute.js';
import { DisputeResolutionSchema } from '../protocol/arbitration.js';
import type { InboxMessage } from '../protocol/inbox.js';
import type { AgentId } from '../protocol/ids.js';
import { nowSeconds } from '../protocol/time.js';

export const InternalizeOutputSchema = RecapOutputSchema.omit({ used_claim_ids: true });
function valid(condition: boolean, message: string): asserts condition { if (!condition) throw new FormationValidationError(message); }
const sameSet = (a: readonly string[], b: readonly string[]): boolean => new Set(a).size === new Set(b).size && a.every((id) => b.includes(id));
const resolutionOf = (message: InboxMessage) => message.message_type === 'claim_attribute_update' ? message.arbitration_resolution : undefined;
export function validateArbitration(message: InboxMessage): void {
  const resolution = resolutionOf(message);
  if (resolution === undefined) return;
  valid(resolution.dispute_id === resolution.dispute_snapshot.id, '仲裁 dispute_id 与冻结 Dispute 不一致。');
  valid(resolution.resolution_type !== 'unresolved' && resolution.resolution_basis !== 'insufficient_evidence', '未解决或证据不足的仲裁不能内化。');
  const direct = resolution.direct_claim_snapshots.map((claim) => claim.id);
  const disputed = resolution.dispute_snapshot.claims;
  valid(new Set(direct).size === direct.length && new Set(disputed).size === disputed.length && sameSet(direct, disputed), '仲裁直接 Claim 快照必须唯一且完整覆盖 Dispute。');
  const assessed = resolution.claim_assessments?.map((item) => item.claim_id) ?? [];
  valid(assessed.length === 0 || new Set(assessed).size === assessed.length && sameSet(assessed, direct), '仲裁 assessment 必须唯一且完整覆盖直接 Claim。');
}
export function inboxContext(agentId: AgentId, messages: readonly InboxMessage[], local: readonly Claim[]) {
  valid(messages.length > 0, '内化批次不能为空。');
  valid(local.every((claim) => claim.holder === agentId) && new Set(local.map((claim) => claim.id)).size === local.length, '本地 Claim 持有权或 ID 不合法。');
  for (const message of messages) validateArbitration(message);
  const first = messages[0];
  valid(first !== undefined && messages.every((message) => message.message_type === first.message_type && !(message.message_type === 'policy_update' && message.policy.status === 'deprecated')), '内化批次类型不一致或含待确定性处理的废弃 Policy。');
  const directClaims = messages.flatMap((message) => resolutionOf(message)?.direct_claim_snapshots ?? []);
  const directIds = new Set(directClaims.map((claim) => claim.id));
  const editable = local.filter((claim) => claim.status !== 'deprecated' || directIds.has(claim.id));
  const input = first.message_type === 'policy_update' ? { agent_id: agentId, inbox_messages: messages, local_claims: editable } : {
    agent_id: agentId, claim_attribute_updates: messages.map((message) => {
      const context = resolutionOf(message);
      if (context === undefined) return { claim_attribute_update: message, conclusion: message.policy.statement, direct_claims: [] };
      return { claim_attribute_update: message, conclusion: context.conclusion, resolution: DisputeResolutionSchema.parse(context), dispute: context.dispute_snapshot, direct_claims: context.direct_claim_snapshots };
    }), local_claims: editable,
  };
  return { input, editable, directClaims, directIds };
}
function semantics(claim: Claim): string {
  return JSON.stringify({ id: claim.id, name: claim.name, statement: claim.statement, scope: claim.scope, holder: claim.holder, confidence: claim.confidence, status: claim.status, evidence_summary: claim.evidence_summary, source_claim_ids: [...new Set(claim.source_claim_ids)].sort() });
}
function repeatsResolved(dispute: Dispute, messages: readonly InboxMessage[], local: readonly Claim[], targets: readonly Claim[]): boolean {
  return messages.some((message) => {
    const context = resolutionOf(message);
    if (context === undefined || !sameSet(dispute.claims, context.dispute_snapshot.claims)) return false;
    return context.direct_claim_snapshots.every((before) => {
      const current = targets.find((claim) => claim.id === before.id) ?? local.find((claim) => claim.id === before.id) ?? before;
      return semantics(current) === semantics(before);
    });
  });
}
export function prepareInbox(raw: unknown, agentId: AgentId, messages: readonly InboxMessage[], local: readonly Claim[], now = nowSeconds()): PreparedFormation {
  const context = inboxContext(agentId, messages, local);
  const output = InternalizeOutputSchema.parse(raw);
  const policyIds = [...new Set(messages.map((message) => message.policy.id))];
  if (messages[0]?.message_type === 'claim_attribute_update') for (const draft of [...output.new_claims, ...output.updated_claims]) {
    if (policyIds.length === 1 && policyIds[0] !== undefined && !draft.source_claim_ids.some((source) => policyIds.some((id) => id === source))) draft.source_claim_ids.push(policyIds[0]);
    valid(draft.source_claim_ids.some((source) => policyIds.some((id) => id === source)), '每条 CAU 变更必须引用真正相关的本批 Policy；多 Policy 批次不能自动归因。');
  }
  const prepared = prepareFormation({ ...output, used_claim_ids: [] }, agentId, context.editable, policyIds, now, { directClaims: context.directClaims, editableDeprecatedIds: context.directIds });
  const final = new Map([...context.directClaims, ...local, ...prepared.claims].map((claim) => [claim.id, claim]));
  valid(prepared.disputes.every((dispute) => dispute.claims.every((id) => final.get(id)?.status !== 'deprecated')), '新 Dispute 不得引用本批最终状态为 deprecated 的 Claim。');
  prepared.disputes = prepared.disputes.filter((dispute) => !repeatsResolved(dispute, messages, local, prepared.claims));
  return prepared;
}
