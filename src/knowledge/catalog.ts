// 目录只含有界身份字段，按更新时间排序并在严格字符预算内保留遗漏计数。
import type { Claim } from '../protocol/claim.js';
import { boundedText, sortClaims } from './pages.js';

export function renderCatalog(claims: readonly Claim[], budget: { maxClaims: number; maxChars: number }): string {
  const active = sortClaims(claims.filter((claim) => claim.status !== 'deprecated'));
  const lines: string[] = [];
  for (const claim of active.slice(0, budget.maxClaims)) {
    const line = `${claim.id} | ${JSON.stringify(boundedText(claim.name, 120).text)} | ${JSON.stringify(boundedText(claim.scope, 240).text)} | ${claim.confidence} | ${claim.status}`;
    const omitted = active.length - lines.length - 1;
    const candidate = [...lines, line, ...(omitted > 0 ? [`另有 ${omitted} 条，用 claim 工具搜索。`] : [])].join('\n');
    if (Array.from(candidate).length > budget.maxChars) break;
    lines.push(line);
  }
  const omitted = active.length - lines.length;
  if (omitted > 0) lines.push(`另有 ${omitted} 条，用 claim 工具搜索。`);
  if (active.length === 0) lines.push('暂无 active/stale Claim。');
  return boundedText(lines.join('\n'), budget.maxChars).text;
}
