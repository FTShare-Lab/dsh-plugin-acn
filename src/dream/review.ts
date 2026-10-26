// 逐字引用覆盖双向信息边界，绑定具体草稿版本；这不证明语义判断正确。
import type { z } from 'zod';
import { requireDream, type Validation, type SelfReview, type SemanticReview, type QuoteSchema } from './schema.js';
import { sameIds } from './plan.js';
import { directEvidence, evidenceBody, independentReceipt, requireEvidenceIds } from './evidence.js';
import { validateEvidencePreservation } from './preservation.js';

const fields = ['name', 'statement', 'scope', 'evidence_summary'] as const;
type Quote = z.infer<typeof QuoteSchema>;
function quoted(validation: Validation, side: 'before' | 'after', quote: Quote): string {
  const claim = validation.input[side].find((claim) => claim.id === quote.claim_id);
  requireDream(claim !== undefined, `复核引用 ${side}.${quote.claim_id}.${quote.field} 对应的 Claim 不存在。`);
  requireDream(side !== 'after' || claim.status !== 'deprecated', `after 引用 ${quote.claim_id}.${quote.field} 指向 deprecated Claim，不能承接保留信息。其历史记录仍会保留，但 preservation.after 和 support.after 只能引用存续输出；按 coverage.output_ids 找到实际承接字段，不能把历史原名或 scope 当成存续去向。`);
  const value = claim[quote.field]; requireDream(quote.quote.trim() !== '' && value.includes(quote.quote), `复核引用 ${side}.${quote.claim_id}.${quote.field} 必须是对应字段的逐字非空子串。请直接复制该字段原文，不翻译、改写或合并不连续片段；字段值中的引号与换行使用 JSON 转义。`);
  return value;
}
export interface CoverageGap { side: string; claim_id: string; field: string; missing_fragments: string[] }
export function coverageGaps(validation: Validation, review: SelfReview): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const side of ['before', 'after'] as const) {
    const quotes = side === 'before' ? review.preservation.map((item) => item.before) : review.support.map((item) => item.after);
    for (const claim of validation.input[side]) {
      if (side === 'after' && claim.status === 'deprecated') continue;
      for (const field of fields) {
        const text = claim[field]; const covered = new Set<number>();
        for (const quote of quotes.filter((quote) => quote.claim_id === claim.id && quote.field === field && quote.quote !== '')) {
          let start = text.indexOf(quote.quote);
          while (start !== -1) { for (let index = start; index < start + quote.quote.length; index += 1) covered.add(index); start = text.indexOf(quote.quote, start + 1); }
        }
        const missing: string[] = []; let fragment = ''; let offset = 0;
        for (const char of text) {
          if (!covered.has(offset) && !/[\s，。；：、,;:]/u.test(char)) fragment += char;
          else if (fragment !== '') { missing.push(fragment); fragment = ''; }
          offset += char.length;
        }
        if (fragment !== '') missing.push(fragment);
        if (missing.length > 0) gaps.push({ side, claim_id: claim.id, field, missing_fragments: missing });
      }
    }
  }
  return gaps;
}
export function validateSelfReview(validation: Validation, review: SelfReview): void {
  requireDream(review.validation_id === validation.validation_id && review.group_id === validation.input.group_id, '复核对应的草稿版本已变化，必须重新 validate。');
  validateEvidencePreservation(validation.input);
  const bad: object[] = [];
  for (const [section, items] of [['preservation', review.preservation], ['support', review.support]] as const) for (const [index, item] of items.entries()) for (const [offset, quote] of item.evidence.entries()) {
    const receipt = independentReceipt(validation.input.evidence, quote.evidence_id); const text = quote.quote.trim();
    if (receipt === null || text === '' || !receipt.output.content.includes(text) && !evidenceBody(receipt).includes(text)) bad.push({ location: `${section}.${index}.evidence.${offset}`, evidence_id: quote.evidence_id, source_preview: receipt === null ? '' : evidenceBody(receipt).slice(0, 240) });
  }
  requireDream(bad.length === 0, `新证据引用必须逐字出现在对应版本回执中；错误 ${bad.length} 处：${JSON.stringify(bad.slice(0, 8))}`);
  for (const item of review.preservation) {
    quoted(validation, 'before', item.before);
    for (const quote of item.after) quoted(validation, 'after', quote);
    if (item.disposition === 'preserved') requireDream(item.after.length > 0, '有效信息必须有存续输出引用。');
    else if (item.disposition === 'episodic') requireDream(validation.input.kind !== 'evidence' && item.after.length === 0 && item.evidence.length === 0, '仅纯情景片段可在 A/C 中无证据移除。');
    else validateCorrection(validation, item.before.claim_id, item.evidence.map((quote) => quote.evidence_id));
  }
  for (const item of review.support) {
    quoted(validation, 'after', item.after); for (const quote of item.before) quoted(validation, 'before', quote);
    requireDream(item.before.length > 0 || item.evidence.length > 0, '每个输出断言必须有具体原文或新独立证据。');
    if (item.evidence.length > 0) validateCorrection(validation, item.after.claim_id, [...new Set(item.evidence.map((quote) => quote.evidence_id))]);
  }
  const gaps = coverageGaps(validation, review);
  requireDream(gaps.length === 0, `复核未覆盖完整 name/statement/scope/evidence_summary，含条件、否定、备选行动和证据限制：${JSON.stringify(gaps.slice(0, 8))}`);
}
function validateCorrection(validation: Validation, id: Quote['claim_id'], ids: readonly string[]): void {
  const before = validation.input.before.find((claim) => claim.id === id); const after = validation.input.after.find((claim) => claim.id === id);
  requireDream(before !== undefined && after !== undefined && before.confidence !== 'high', 'high Claim 不能事实纠正，包括混入 A/C 或先降低置信度。');
  const basis = validation.input.change_basis.find((basis) => basis.claim_id === id)?.evidence_ids ?? [];
  const direct = directEvidence(validation.input.evidence, basis, id);
  requireDream(ids.length > 0 && ids.every((id) => direct.includes(id)), '事实修订必须引用对应 Claim 的 change_basis 中的新直接证据。');
  requireDream(after.evidence_summary !== before.evidence_summary, '事实修订必须更新 evidence_summary，说明新证据与限制。');
}
export function validateSemanticReview(validation: Validation, review: SemanticReview): void {
  requireDream(sameIds(review.claims.map((item) => item.claim_id), validation.input.before.map((claim) => claim.id)), '语义复核必须恰好覆盖全部输入 Claim。');
  for (const item of review.claims) {
    const after = validation.input.after.find((claim) => claim.id === item.claim_id); requireDream(after !== undefined, '复核缺少输出 Claim。');
    requireDream(item.final_name === after.name && item.name_reason.trim() !== '', 'final_name 必须绑定最终名称，并说明名称与正文一致；废弃保留历史名称。');
    requireEvidenceIds(item.evidence_ids, Object.keys(validation.input.evidence).filter((id) => independentReceipt(validation.input.evidence, id) !== null), '语义复核引用了无版本、未知或重复的独立证据。');
    if (item.factual_correction || validation.input.kind === 'evidence' && validation.input.changes.some((change) => change.id === item.claim_id && change.action !== 'keep')) validateCorrection(validation, item.claim_id, item.evidence_ids);
    requireDream(new Set(item.output_ids).size === item.output_ids.length && item.output_ids.every((id) => validation.input.after.some((claim) => claim.id === id && claim.status !== 'deprecated')), '复核去向必须唯一且属于本组存续 Claim。');
    if (validation.input.kind === 'consolidation') requireDream(sameIds(item.output_ids, validation.input.coverage.find((coverage) => coverage.input_id === item.claim_id)?.output_ids ?? []), '语义复核必须与 coverage 的信息去向一致。');
    else if (after.status !== 'deprecated') requireDream(item.output_ids.includes(item.claim_id), '存续 Claim 必须包含自身信息去向。');
  }
}
