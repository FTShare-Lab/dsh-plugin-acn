// Policy 撤回只废弃直接依赖它的本地 Claim，历史实体保持可读且时间戳单调。
import type { Claim } from '../protocol/claim.js';
import { effectiveUpdatedAt } from '../protocol/claim.js';
import type { PolicyId } from '../protocol/ids.js';
import { nextClaimUpdateAt } from '../knowledge/timestamps.js';
import { nowSeconds } from '../protocol/time.js';

export function deprecatePolicyClaims(policyId: PolicyId, local: readonly Claim[], now = nowSeconds()): Claim[] {
  return local.filter((claim) => claim.source_claim_ids.includes(policyId)).map((claim) => claim.status === 'deprecated' ? claim : ({ ...claim, status: 'deprecated', updated_at: nextClaimUpdateAt(now, effectiveUpdatedAt(claim)) }));
}
