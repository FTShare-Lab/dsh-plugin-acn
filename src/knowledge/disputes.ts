// 本地留存与团队投递分别去重，单人记录不能冒充已排队或已上报的争议。
import type { Dispute } from '../protocol/dispute.js';
import type { StoreContext } from '../store/context.js';
import { ReportedSetStore, reportedClaimSetKey } from '../store/reported-sets.js';
import { UploadStore } from '../store/uploads.js';

export async function newDisputes(context: StoreContext, proposed: readonly Dispute[], local: readonly Dispute[]): Promise<Dispute[]> {
  const sets = new Set<string>();
  if (context.mode === 'solo') for (const dispute of local) sets.add(reportedClaimSetKey(dispute.claims));
  else {
    // delivery 先记成功台账再移除 pending；按此顺序读取避免在交接中漏掉两端。
    for (const dispute of (await new UploadStore(context).read()).disputes) sets.add(reportedClaimSetKey(dispute.claims));
    for (const key of Object.keys((await new ReportedSetStore(context).read()).reported_claim_sets)) sets.add(key);
  }
  return proposed.filter((dispute) => {
    const key = reportedClaimSetKey(dispute.claims);
    if (sets.has(key)) return false;
    sets.add(key); return true;
  });
}
