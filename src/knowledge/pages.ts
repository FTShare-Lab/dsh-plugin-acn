// 统一稳定排序、有界摘要和 Unicode 字符分页，避免截断代理项。
import type { Claim } from '../protocol/claim.js';
import { effectiveUpdatedAt } from '../protocol/claim.js';
import { timestampNanos } from '../protocol/time.js';
import { KnowledgeError } from './errors.js';
import type { BoundedText, ClaimListPage, ClaimListQuery, Page } from './types.js';
import { MAX_CLAIM_PAGE_LIMIT } from './types.js';

export function boundedText(value: string, limit: number): BoundedText {
  const chars = Array.from(value);
  return { text: chars.slice(0, limit).join(''), truncated: chars.length > limit };
}
export function validatePage(offset: number, limit: number, maximum = MAX_CLAIM_PAGE_LIMIT): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new KnowledgeError('validation', `Offset must be nonnegative and limit must be within 1..${maximum}.`);
}
export function page<T>(items: T[], offset: number, limit: number): Page<T> {
  const selected = items.slice(offset, offset + limit);
  const end = Math.min(offset + selected.length, items.length);
  return { items: selected, offset, limit, omitted: items.length - end, next_offset: end < items.length ? end : null };
}
export function sortClaims(claims: readonly Claim[]): Claim[] {
  return [...claims].sort((a, b) => {
    const delta = timestampNanos(effectiveUpdatedAt(b)) - timestampNanos(effectiveUpdatedAt(a));
    return delta === 0n ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : delta > 0n ? 1 : -1;
  });
}
export function claimListPage(claims: readonly Claim[], query: ClaimListQuery): ClaimListPage {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 20;
  validatePage(offset, limit);
  const term = query.query?.trim().toLowerCase();
  const matched = claims.filter((claim) => (query.includeDeprecated || claim.status !== 'deprecated') &&
    (!term || [claim.name, claim.scope, claim.statement].some((value) => value.toLowerCase().includes(term))));
  return page(sortClaims(matched).map((claim) => ({
    id: claim.id, name: boundedText(claim.name, 120), scope: boundedText(claim.scope, 240),
    confidence: claim.confidence, status: claim.status, updated_at: effectiveUpdatedAt(claim),
  })), offset, limit);
}
