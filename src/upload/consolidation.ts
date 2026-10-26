// 精确承接版本的确认与显式整合链；普通后续修改不能自动授权旧弃用请求。
import type { Claim } from '../protocol/claim.js';
import type { ClaimId } from '../protocol/ids.js';
import { sameClaim } from '../knowledge/alignment.js';
import type { z } from 'zod';
import type { ConsolidationDeliverySchema } from '../store/uploads.js';

export type ConsolidationDelivery = z.infer<typeof ConsolidationDeliverySchema>;
export function relatedIds(groups: readonly ConsolidationDelivery[]): Set<ClaimId> { return new Set(groups.flatMap((group) => [group.retired.id, ...group.carriers.map((claim) => claim.id)])); }
function carrierReady(claim: Claim, groups: readonly ConsolidationDelivery[], acknowledged: readonly Claim[], current: readonly Claim[], visiting: Set<ClaimId>): boolean {
  if (claim.status !== 'deprecated' && current.some((value) => sameClaim(value, claim)) && acknowledged.some((value) => sameClaim(value, claim))) return true;
  if (visiting.has(claim.id)) return false; visiting.add(claim.id);
  const result = groups.some((group) => sameClaim(group.before, claim) && current.some((value) => sameClaim(value, group.retired)) && group.carriers.length > 0 && group.carriers.every((carrier) => carrierReady(carrier, groups, acknowledged, current, visiting)));
  visiting.delete(claim.id); return result;
}
export function consolidationReady(claim: Claim, groups: readonly ConsolidationDelivery[], acknowledged: readonly Claim[], current: readonly Claim[]): boolean {
  return groups.filter((group) => sameClaim(group.retired, claim)).every((group) => group.carriers.length > 0 && group.carriers.every((carrier) => carrierReady(carrier, groups, acknowledged, current, new Set())));
}
export function pruneDeliveries(groups: readonly ConsolidationDelivery[], acknowledgements: readonly Claim[], pending: readonly Claim[]) {
  const keep = new Set(groups.filter((group) => pending.some((claim) => sameClaim(claim, group.retired))));
  let size = -1;
  while (size !== keep.size) { size = keep.size; for (const group of keep) for (const carrier of group.carriers) for (const next of groups) if (sameClaim(next.before, carrier)) keep.add(next); }
  const retained = groups.filter((group) => keep.has(group)); const related = relatedIds(retained);
  return { consolidations: retained, acknowledgements: acknowledgements.filter((claim) => related.has(claim.id)) };
}
