// 只装入完整自有 Claim，记录覆盖范围；自动触发依据成功冷却与不同 Claim 版本。
import type { Claim } from '../protocol/claim.js';
import type { AgentId } from '../protocol/ids.js';
import { effectiveUpdatedAt } from '../protocol/claim.js';
import { timestampNanos } from '../protocol/time.js';
import type { ResolvedConfig } from '../config.js';
import type { z } from 'zod';
import type { DreamStateSchema } from './schema.js';
import { contentHash } from './plan.js';

export const INPUT_TOKENS = 64_000;
export function conservativeTokens(text: string): number { return Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0) !== undefined && char.charCodeAt(0) < 128 ? 1 : 3), 0); }
export function claimInput(claims: readonly Claim[], budget = INPUT_TOKENS) {
  const sorted = [...claims].sort((a, b) => {
    const changed = timestampNanos(effectiveUpdatedAt(b)) - timestampNanos(effectiveUpdatedAt(a));
    const created = timestampNanos(b.created_at) - timestampNanos(a.created_at);
    return changed !== 0n ? changed > 0n ? 1 : -1 : created !== 0n ? created > 0n ? 1 : -1 : a.id.localeCompare(b.id);
  });
  const loaded: Claim[] = []; let used = 0;
  for (const claim of sorted) { const cost = conservativeTokens(JSON.stringify(claim)); if (cost > budget) continue; if (used + cost > budget) break; used += cost; loaded.push(claim); }
  return { loaded, coverage: { total: claims.length, included: loaded.length, omitted: claims.length - loaded.length, order: 'effective_updated_at descending; oldest omitted first', estimated_tokens: used, budget_tokens: budget } };
}
export function versions(claims: readonly Claim[]) { return Object.fromEntries([...claims].sort((a, b) => a.id.localeCompare(b.id)).map((claim) => [claim.id, contentHash(claim)])); }
export function dreamEligible(config: ResolvedConfig['dream'], state: z.infer<typeof DreamStateSchema>, claims: readonly Claim[], owner: AgentId, manual: boolean, now = Date.now()): boolean {
  const owned = claims.filter((claim) => claim.holder === owner);
  if (!config.enabled || !owned.some((claim) => claim.status !== 'deprecated')) return false;
  if (manual) return true;
  if (state.last_success_at !== undefined && state.last_success_at !== null && now - Date.parse(state.last_success_at) < config.minIntervalHours * 3_600_000) return false;
  return owned.filter((claim) => state.known_versions[claim.id] !== contentHash(claim)).length >= config.minChangedClaims;
}
