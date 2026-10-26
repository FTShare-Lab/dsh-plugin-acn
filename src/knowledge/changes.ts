// 相对冻结基线形成累计身份差异，正文始终通过 Claim 工具按需读取。
import { z } from 'zod';
import type { Claim } from '../protocol/claim.js';
import { ClaimStatusSchema } from '../protocol/claim.js';
import { claimRevision } from '../protocol/revision.js';

export const ClaimIdentitySchema = z.object({ name: z.string(), scope: z.string(), status: ClaimStatusSchema, revision: z.string() });
export const ClaimIndexSchema = z.record(z.string(), ClaimIdentitySchema);
export type ClaimIndex = z.infer<typeof ClaimIndexSchema>;
export function claimIndex(claims: readonly Claim[]): ClaimIndex {
  return Object.fromEntries([...claims].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((claim) => [claim.id, { name: claim.name, scope: claim.scope, status: claim.status, revision: claimRevision(claim) }]));
}
export function claimChanges(baseline: ClaimIndex, current: ClaimIndex, known: ClaimIndex) {
  const changes = [];
  for (const [id, item] of Object.entries(current)) {
    if (baseline[id]?.revision === item.revision) continue;
    changes.push({ change: item.status === 'deprecated' ? 'deprecated' : baseline[id] === undefined ? 'created' : 'updated', id, name: item.name, scope: item.scope, status: item.status });
  }
  for (const [id, item] of Object.entries({ ...baseline, ...known })) {
    if (current[id] === undefined) changes.push({ change: 'removed', id, name: item.name, scope: item.scope, status: item.status });
  }
  return changes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function changeNotice(revision: string, baseline: ClaimIndex, current: ClaimIndex, known: ClaimIndex): string {
  const payload = { revision, refresh_all: false, changes: claimChanges(baseline, current, known) };
  return `claim_changes_since_system_prompt: ${JSON.stringify(payload)}\nThis cumulative identity snapshot supersedes earlier claim notices. Assess relevance from name/scope; use claim action="read" for current content only when the current task needs to cite or rely on that Claim. Do not read every changed Claim merely because it is listed. Deprecated/removed entries must not be relied on; no content read is needed to stop using them.`;
}
