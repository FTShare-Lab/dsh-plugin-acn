// 对照事实校准的逐 Claim 授权、原始 high 门禁、证据正文引用和置信度规则。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentIdSchema } from '../../src/protocol/ids.js';
import { nowSeconds } from '../../src/protocol/time.js';
import { expandDraft, prepareGroup, reviewInput, validateCandidates, valueHash } from '../../src/dream/plan.js';
import { validateSelfReview, validateSemanticReview } from '../../src/dream/review.js';
import { ReceiptSchema, evidenceBody } from '../../src/dream/evidence.js';
import { calibrationDraft, calibrationReviews, evidenceFixture } from './evidence-helpers.js';
import { candidate, claims } from './helpers.js';

describe('Dream evidence hard boundaries', () => {
  it('keeps previous version limits even when new direct versioned evidence authorizes calibration', async () => {
    const input = claims(1); const original = input[0]; if (!original) throw new Error('Missing input.'); original.evidence_summary = 'The original source version could not be proved; production behavior was unverified.';
    const f = await evidenceFixture({ input });
    try {
      await f.read(); const manifest = await f.store.read(); if (!manifest) throw new Error('Missing receipts.'); const receipts = z.record(z.string(), z.json()).parse(manifest.receipts);
      const draft = calibrationDraft(f.initial, receipts); const check = () => prepareGroup(expandDraft(draft, f.initial), f.initial, f.knowledge.context().agentId, nowSeconds(), { enabled: true, receipts });
      expect(check().after[0]?.evidence_summary).toContain(original.evidence_summary);
      const operation = draft.operations[0]; if (!operation) throw new Error('Missing output.'); operation.changes.evidence_summary = 'The new file supports reads; confidence is high.';
      expect(check).toThrow(/原证据摘要/);
    } finally { await f.close(); }
  });
  it('defaults off; only original medium/low self Claims are calibration candidates', () => {
    const input = claims(); const owner = AgentIdSchema.parse('agent-a');
    expect(() => validateCandidates([candidate(input, 'evidence')], input, owner)).toThrow();
    for (const confidence of ['low', 'medium'] as const) { const values = input.map((claim) => ({ ...claim, confidence })); expect(() => validateCandidates([candidate(values, 'evidence')], values, owner, true)).not.toThrow(); }
    const high = input.map((claim) => ({ ...claim, confidence: 'high' as const }));
    expect(() => validateCandidates([candidate(high, 'evidence')], high, owner, true)).toThrow('high');
    expect(() => validateCandidates([candidate(high, 'quality')], high, owner, true)).not.toThrow();
  });
  it.each(['valid', 'missing-proof', 'old-summary', 'borrowed', 'unknown', 'duplicate', 'unversioned', 'claim-proof', 'trace-proof', 'high', 'high-lowered', 'disabled'])('validates calibration and confidence increase: %s', async (mode) => {
    const f = await evidenceFixture({ input: claims(2) });
    try {
      await f.read(f.initial[0]?.id); await f.read(f.initial[1]?.id); const manifest = await f.store.read(); if (!manifest) throw new Error('Missing evidence.');
      const receipts = z.record(z.string(), z.json()).parse(manifest.receipts); const draft = calibrationDraft(f.initial, receipts);
      const basis = draft.change_basis[0]; const operation = draft.operations[0]; const original = f.initial[0]; if (!basis || !operation || !original) throw new Error('Missing test inputs.');
      if (mode === 'missing-proof') { basis.evidence_ids = []; draft.evidence_ids = []; }
      if (mode === 'old-summary') operation.changes.evidence_summary = original.evidence_summary;
      if (mode === 'borrowed') basis.evidence_ids = draft.change_basis[1]?.evidence_ids ?? [];
      if (mode === 'unknown') draft.evidence_ids.push('invented');
      if (mode === 'duplicate') draft.evidence_ids.push(...draft.evidence_ids);
      if (mode === 'unversioned') for (const id of Object.keys(receipts)) receipts[id] = { tool: 'code_run', output: { text: 'Checked successfully.' } };
      if (mode === 'claim-proof' || mode === 'trace-proof') for (const id of Object.keys(receipts)) receipts[id] = { tool: mode === 'claim-proof' ? 'claim' : 'trace', output: { text: 'Old knowledge cannot independently authorize a correction.' } };
      if (mode === 'high-lowered') operation.changes.confidence = 'low';
      const input = mode === 'high' || mode === 'high-lowered' ? f.initial.map((claim) => ({ ...claim, confidence: 'high' as const })) : f.initial;
      const check = () => prepareGroup(expandDraft(draft, input), input, f.knowledge.context().agentId, nowSeconds(), { enabled: mode !== 'disabled', receipts });
      if (mode === 'valid') expect(check().after.every((claim) => claim.confidence === 'high')).toBe(true); else expect(check).toThrow();
    } finally { await f.close(); }
  });
  it.each(['valid', 'missing-semantic-proof', 'wrong-claim', 'unknown-quote', 'invented-quote', 'high-in-quality', 'high-in-consolidation', 'unchanged-summary', 'stale-validation'])('validates independent quotes and correction review: %s', async (mode) => {
    const f = await evidenceFixture({ input: claims(2) });
    try {
      await f.read(f.initial[0]?.id); await f.read(f.initial[1]?.id); const manifest = await f.store.read(); if (!manifest) throw new Error('Missing receipts.'); const receipts = z.record(z.string(), z.json()).parse(manifest.receipts);
      const group = expandDraft(calibrationDraft(f.initial, receipts), f.initial); const validation = reviewInput('group-a', group, f.initial, receipts); const review = calibrationReviews(validation);
      const semantic = review.semantic.claims[0]; const preservation = review.self_review.preservation.find((item) => item.disposition === 'corrected'); if (!semantic || !preservation) throw new Error('Missing review.');
      if (mode === 'missing-semantic-proof') semantic.evidence_ids = [];
      if (mode === 'wrong-claim') { const other = review.semantic.claims[1]; if (!other) throw new Error('Missing second input.'); semantic.evidence_ids = other.evidence_ids; }
      if (mode === 'unknown-quote') preservation.evidence = [{ evidence_id: 'unknown', quote: 'not read' }];
      if (mode === 'invented-quote') { const quote = preservation.evidence[0]; if (quote) quote.quote = 'A fabricated guarantee.'; }
      if (mode.startsWith('high-in-')) { const claim = validation.input.before[0]; if (claim) claim.confidence = 'high'; validation.input.kind = mode.endsWith('quality') ? 'quality' : 'consolidation'; }
      if (mode === 'unchanged-summary') { const after = validation.input.after[0]; const before = validation.input.before[0]; if (after && before) after.evidence_summary = before.evidence_summary; }
      if (mode === 'stale-validation') review.self_review.validation_id = '0'.repeat(64);
      const check = () => { validateSelfReview(validation, review.self_review); validateSemanticReview(validation, review.semantic); };
      if (mode === 'valid') { expect(check).not.toThrow(); expect(valueHash(validation.input)).toBe(validation.validation_id); } else expect(check).toThrow();
    } finally { await f.close(); }
  });
  it.each([
    ['1|First\n2|  indented', 1, 2, true, 'First\n  indented'],
    ['1|First\n3|  indented', 1, 2, true, '1|First\n3|  indented'],
    ['1|literal\n2|data', 1, 2, false, '1|literal\n2|data'],
    ['1|First\n2|Second', 1, 3, true, '1|First\n2|Second'],
  ])('strips only confirmed display line prefixes: %s', (content, start, end, show, expected) => {
    const receipt = ReceiptSchema.parse({ tool: 'file_read', input: { path: '/workspace/example.txt', show_linenos: show }, output: { content, page: { returned_start: start, returned_end: end }, file_version: { path: '/workspace/example.txt', revision: { sha256: '0'.repeat(64), byte_len: 30 } } } });
    expect(evidenceBody(receipt)).toBe(expected);
  });
  it('reports all bad evidence locations with bounded source previews', async () => {
    const f = await evidenceFixture();
    try { await f.read(); const receipts = z.record(z.string(), z.json()).parse((await f.store.read())?.receipts); const validation = reviewInput('group-a', expandDraft(calibrationDraft(f.initial, receipts), f.initial), f.initial, receipts); const review = calibrationReviews(validation); for (const item of review.self_review.preservation) item.evidence = [{ evidence_id: Object.keys(receipts)[0] ?? '', quote: 'invented' }]; expect(() => validateSelfReview(validation, review.self_review)).toThrow(/preservation\.0.*preservation\.3/); }
    finally { await f.close(); }
  });
});
