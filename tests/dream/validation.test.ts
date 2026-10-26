// 对照整理协议的候选、草稿、全文引用和名称绑定约束，不把模型结论当成事实证明。
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.js';
import { DreamStateSchema, DraftGroupSchema } from '../../src/dream/schema.js';
import { validateCandidates, expandDraft, prepareGroup, reviewInput, contentHash } from '../../src/dream/plan.js';
import { validateSelfReview, validateSemanticReview, coverageGaps } from '../../src/dream/review.js';
import { dreamEligible, claimInput, versions, conservativeTokens } from '../../src/dream/candidates.js';
import { ClaimIdSchema, AgentIdSchema, SourceIdSchema } from '../../src/protocol/ids.js';
import { candidate, claims, prepared, reviews, consolidationDraft, qualityDraft } from './helpers.js';

const owner = AgentIdSchema.parse('agent-a');
describe('Dream candidate and draft boundary', () => {
  it('validates the whole batch without accepting overlaps, unread IDs, foreign holders or calibration', () => {
    const input = claims(); const first = input[0]; if (!first) throw new Error('Missing test input.');
    expect(() => validateCandidates([candidate(input)], input, owner)).not.toThrow();
    for (const items of [[candidate(input), candidate([first], 'quality', 'other')], [candidate(input), candidate([], 'quality')], [candidate(input, 'evidence')], [candidate([{ ...first, id: ClaimIdSchema.parse('claim_99999999') }])]]) expect(() => validateCandidates(items, input, owner)).toThrow();
    expect(() => validateCandidates([candidate(input)], input.map((value) => ({ ...value, holder: AgentIdSchema.parse('agent-b') })), owner)).toThrow();
    expect(() => validateCandidates([candidate(input)], input.map((value) => ({ ...value, status: 'deprecated' })), owner)).toThrow();
  });
  it('expands quality shorthand without rewriting the retired historical body', () => {
    const input = claims(1); const { group } = prepared(input); const result = prepareGroup(group, input, owner, '2026-01-01T00:00:00Z');
    expect(result.after[0]).toMatchObject({ ...input[0], status: 'deprecated', updated_at: '2026-01-01T00:00:01Z' });
    expect(group.change_basis).toHaveLength(1);
    const draft = qualityDraft(input); const op = draft.operations[0]; if (!op) throw new Error('Missing operation.');
    op.changes.statement = 'Rewritten history'; expect(() => expandDraft(draft, input)).toThrow();
  });
  it.each(['keep-changes', 'empty-update', 'duplicate-basis', 'missing-basis', 'invented-evidence', 'increase-confidence', 'invented-source'])('rejects draft bypass %s', (mode) => {
    const input = claims(1); const draft = qualityDraft(input); const op = draft.operations[0]; if (!op) throw new Error('Missing operation.');
    if (mode === 'keep-changes') { op.action = 'keep'; delete op.reason; op.changes.scope = 'Changed'; }
    if (mode === 'empty-update') { op.action = 'update'; delete op.reason; }
    if (mode === 'duplicate-basis') draft.change_basis.push({ claim_id: op.id, removed_or_changed: 'Remove', added: '', justification: 'One-time', evidence_ids: [] });
    if (mode === 'missing-basis') delete op.reason;
    if (mode === 'invented-evidence') draft.evidence_ids.push('receipt-unknown');
    if (mode === 'increase-confidence') { delete op.reason; op.action = 'update'; op.changes.confidence = 'high'; }
    if (mode === 'invented-source') { delete op.reason; op.action = 'update'; op.changes.source_claim_ids = [SourceIdSchema.parse('policy_00000001')]; }
    expect(() => prepareGroup(expandDraft(draft, input), input, owner)).toThrow();
  });
  it('rejects incomplete consolidation, retired destinations, dropped provenance and confidence laundering', () => {
    const input = claims(); const first = input[0]; if (!first) throw new Error('Missing input.');
    for (const mode of ['missing-input', 'retired-output', 'no-rewrite', 'source-loss', 'weak-input']) {
      const before = structuredClone(input); if (mode === 'source-loss') { const item = before[1]; if (item) item.source_claim_ids = [SourceIdSchema.parse('policy_00000001')]; }
      const draft = consolidationDraft(before);
      if (mode === 'missing-input') draft.coverage.pop();
      if (mode === 'retired-output') for (const item of draft.coverage) item.output_ids = [ClaimIdSchema.parse('claim_00000002')];
      if (mode === 'no-rewrite') { const op = draft.operations[0]; if (op) op.changes.statement = first.statement; }
      if (mode === 'source-loss') { const op = draft.operations[0]; if (op) op.changes.source_claim_ids = []; }
      if (mode === 'weak-input') { const item = before[1]; if (item) item.confidence = 'low'; }
      expect(() => prepareGroup(expandDraft(draft, before), before, owner)).toThrow();
    }
  });
  it('inherits provenance, permits returning to its source and rejects a newly introduced graph cycle', () => {
    const input = claims(3); const [first, second, third] = input; if (!first || !second || !third) throw new Error('Missing input.');
    second.source_claim_ids = [first.id];
    expect(() => prepareGroup(expandDraft(consolidationDraft([first, second]), [first, second]), input, owner)).not.toThrow();
    second.source_claim_ids = [third.id]; third.source_claim_ids = [first.id];
    expect(() => prepareGroup(expandDraft(consolidationDraft([first, second]), input), input, owner)).toThrow(/环/);
  });
  it('does not mutate inputs and leaves no-op versions unchanged', () => {
    const input = claims(1); const original = structuredClone(input); const draft = DraftGroupSchema.parse({ kind: 'quality', reason: 'Keep useful knowledge.', operations: input.map((claim) => ({ id: claim.id, action: 'keep' })) });
    const result = prepareGroup(expandDraft(draft, input), input, owner); expect(input).toEqual(original); expect(result.after).toEqual(original);
  });
});
describe('Dream review version and full information coverage', () => {
  it.each(['quality', 'consolidation'] as const)('accepts a complete %s review', (kind) => { const p = prepared(claims(), kind); expect(() => validateSelfReview(p.validation, p.self_review)).not.toThrow(); expect(() => validateSemanticReview(p.validation, p.semantic)).not.toThrow(); });
  it.each(['missing-before', 'missing-after', 'wrong-side', 'foreign-id', 'stale-hash', 'deprecated-output', 'corrected', 'evidence', 'unsupported-output'])('rejects incomplete or unauthorized quote review %s', (mode) => {
    const p = prepared(claims(), 'consolidation'); const r = p.self_review; const first = r.preservation[0]; const supported = r.support[0]; if (!first || !supported) throw new Error('Missing review.');
    if (mode === 'missing-before') r.preservation.splice(0, 1);
    if (mode === 'missing-after') r.support.splice(0, 1);
    if (mode === 'wrong-side') first.before.quote = 'Text from another side.';
    if (mode === 'foreign-id') first.before.claim_id = ClaimIdSchema.parse('claim_99999999');
    if (mode === 'stale-hash') r.validation_id = '0'.repeat(64);
    if (mode === 'deprecated-output') { const retired = p.validation.input.after.find((claim) => claim.status === 'deprecated'); if (retired) first.after = [{ claim_id: retired.id, field: 'name', quote: retired.name }]; }
    if (mode === 'corrected') first.disposition = 'corrected';
    if (mode === 'evidence') first.evidence.push({ evidence_id: 'unread', quote: 'Unknown receipt' });
    if (mode === 'unsupported-output') supported.before = [];
    expect(() => validateSelfReview(p.validation, r)).toThrow();
  });
  it('reports omitted alternatives, negation, digits and operators while allowing sentence separators', () => {
    const input = claims(1); const first = input[0]; if (!first) throw new Error('Missing input.'); first.statement = 'A，B；C。not <= 2 or safe alternative';
    const p = prepared(input); p.self_review.preservation = p.self_review.preservation.filter((item) => item.before.field !== 'statement');
    const base = { claim_id: first.id, field: 'statement' as const }; for (const quote of ['A', 'B', 'C']) p.self_review.preservation.push({ before: { ...base, quote }, after: [], disposition: 'episodic', reason: 'One-time fragment.', evidence: [] });
    const gaps = coverageGaps(p.validation, p.self_review); expect(gaps).toEqual([expect.objectContaining({ field: 'statement', missing_fragments: ['not', '<=', '2', 'or', 'safe', 'alternative'] })]);
    expect(() => validateSelfReview(p.validation, p.self_review)).toThrow(/否定/);
    p.self_review.preservation.push({ before: { ...base, quote: 'not <= 2 or safe alternative' }, after: [], disposition: 'episodic', reason: 'One-time fragment.', evidence: [] }); expect(() => validateSelfReview(p.validation, p.self_review)).not.toThrow();
  });
  it.each(['name', 'name-reason', 'missing-claim', 'wrong-destination', 'fact', 'new-evidence'])('rejects semantic review mismatch %s', (mode) => {
    const p = prepared(claims(), 'consolidation'); const item = p.semantic.claims[0]; if (!item) throw new Error('Missing input.');
    if (mode === 'name') item.final_name = 'Old name'; if (mode === 'name-reason') item.name_reason = ''; if (mode === 'missing-claim') p.semantic.claims.pop(); if (mode === 'wrong-destination') item.output_ids = []; if (mode === 'fact') item.factual_correction = true; if (mode === 'new-evidence') item.evidence_ids = ['receipt'];
    expect(() => validateSemanticReview(p.validation, p.semantic)).toThrow();
  });
  it('binds validation to the complete draft including a renamed retired input', () => { const p = prepared(claims()); const changed = structuredClone(p.group); const item = changed.updates[0]; if (item) item.name = 'Changed'; const v = reviewInput('group-a', changed, p.validation.input.before); expect(v.validation_id).not.toBe(p.validation.validation_id); expect(() => validateSelfReview(v, p.self_review)).toThrow(); expect(reviews(v).semantic.claims[0]?.final_name).toBe('Changed'); });
});
describe('Dream eligibility and bounded input', () => {
  it('uses 24h success cooling and five distinct changed own versions, with manual bypass', () => {
    const config = resolveConfig({}).dream; const input = claims(5); const state = DreamStateSchema.parse({}); const now = Date.parse('2026-01-03T00:00:00Z');
    expect(dreamEligible(config, state, input.slice(0, 4), owner, false, now)).toBe(false); expect(dreamEligible(config, state, input, owner, false, now)).toBe(true);
    state.known_versions = versions(input); expect(dreamEligible(config, state, input, owner, false, now)).toBe(false);
    state.last_success_at = '2026-01-02T01:00:00Z'; state.known_versions = {}; expect(dreamEligible(config, state, input, owner, false, now)).toBe(false); expect(dreamEligible(config, state, input, owner, true, now)).toBe(true);
    state.last_success_at = '2026-01-02T00:00:00Z'; expect(dreamEligible(config, state, input, owner, false, now)).toBe(true);
    expect(dreamEligible({ ...config, enabled: false }, state, input, owner, true, now)).toBe(false); expect(dreamEligible(config, state, input.map((claim) => ({ ...claim, status: 'deprecated' })), owner, true, now)).toBe(false);
    const first = input[0]; if (!first) throw new Error('Missing input.'); expect(contentHash(first)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('omits whole old claims, skips a single oversized claim and reports exact coverage', () => {
    const input = claims(3); const first = input[0]; const last = input[2]; if (!first || !last) throw new Error('Missing input.'); first.statement = 'x'.repeat(2000); last.updated_at = '2026-02-01T00:00:00Z';
    const result = claimInput(input, 600); expect(result.loaded.map((claim) => claim.id)).toEqual([last.id]); expect(result.coverage).toMatchObject({ total: 3, included: 1, omitted: 2 }); expect(conservativeTokens('a中')).toBe(4);
  });
});
