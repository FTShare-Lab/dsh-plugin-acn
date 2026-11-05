// 本地列表沿用管理台的状态分组与最近变更顺序，时间相同时保持稳定分页。
import { effectiveUpdatedAt } from '../protocol/claim.js';
import type { Claim } from '../protocol/claim.js';
import type { Dispute } from '../protocol/dispute.js';
import type { Trace } from '../protocol/trace.js';
import { timestampNanos } from '../protocol/time.js';

type Entity = Claim | Dispute | Trace;
export function knowledgeChangedAt(item: Entity): string {
  return 'holder' in item ? effectiveUpdatedAt(item) : 'reporter_agent_id' in item ? item.resolved_at ?? item.created_at : item.created_at;
}
function statusOrder(item: Entity): number {
  if ('holder' in item) return { active: 0, stale: 1, deprecated: 2 }[item.status];
  return 'reporter_agent_id' in item && item.status === 'resolved' ? 1 : 0;
}
function recentFirst(left: string, right: string): number {
  const a = timestampNanos(left); const b = timestampNanos(right);
  return a === b ? 0 : a > b ? -1 : 1;
}
export function compareKnowledge(left: Entity, right: Entity): number {
  return statusOrder(left) - statusOrder(right)
    || recentFirst(knowledgeChangedAt(left), knowledgeChangedAt(right))
    || recentFirst(left.created_at, right.created_at)
    || left.id.localeCompare(right.id);
}
