// 复现版本与证据限制被笼统引用替代；完整原依据必须进入指定存续去向。
import { describe, expect, it } from 'vitest';
import { AgentIdSchema } from '../../src/protocol/ids.js';
import { expandDraft, prepareGroup, reviewInput } from '../../src/dream/plan.js';
import { validateSelfReview } from '../../src/dream/review.js';
import { claims, consolidationDraft, reviews } from './helpers.js';

const owner = AgentIdSchema.parse('agent-a');
function example() {
  const input = claims(); const [carrier, source] = input;
  if (!carrier || !source) throw new Error('Missing inputs.');
  carrier.evidence_summary = 'Read the disposable contract; production behavior is unverified.';
  source.evidence_summary = 'The current file matches the earlier note, but the same version cannot be proved.';
  const draft = consolidationDraft(input); const operation = draft.operations[0];
  if (!operation) throw new Error('Missing output.');
  return { input, carrier, source, draft, operation };
}
describe('Dream evidence summary preservation', () => {
  it('rejects the observed merge even when medium and a complete quote review claim preservation', () => {
    const f = example(); f.operation.changes.evidence_summary = f.carrier.evidence_summary;
    const group = expandDraft(f.draft, f.input); const validation = reviewInput('version-case', group, f.input);
    expect(() => prepareGroup(group, f.input, owner)).toThrow(/原证据摘要/);
    expect(() => validateSelfReview(validation, reviews(validation).self_review)).toThrow(/原证据摘要/);
  });
  it.each([
    '无法证明同一版本；只核对当前文件，生产环境未验证。',
    'Observed on revision r1 only; no evidence for revision r2 or later.',
    'The source is incomplete, and absence of a result does not show failure.',
    'Unknown provenance must remain an explicit limitation.',
  ])('keeps arbitrary original evidence boundaries, without depending on keywords: %s', (summary) => {
    const f = example(); f.source.evidence_summary = summary; f.operation.changes.evidence_summary = f.carrier.evidence_summary;
    expect(() => prepareGroup(expandDraft(f.draft, f.input), f.input, owner)).toThrow();
    f.operation.changes.evidence_summary += `\nOriginal evidence (${f.source.id}): ${summary}`;
    expect(() => prepareGroup(expandDraft(f.draft, f.input), f.input, owner)).not.toThrow();
  });
  it.each(['history-only', 'statement-only', 'paraphrase', 'negated'])('rejects misplaced or replaced evidence: %s', (mode) => {
    const f = example(); f.operation.changes.evidence_summary = f.carrier.evidence_summary;
    if (mode === 'statement-only') f.operation.changes.statement += ` ${f.source.evidence_summary}`;
    if (mode === 'paraphrase') f.operation.changes.evidence_summary += ' Confidence remains medium because the material is temporary.';
    if (mode === 'negated') f.operation.changes.evidence_summary += ' The same version has been proved.';
    expect(() => prepareGroup(expandDraft(f.draft, f.input), f.input, owner)).toThrow(/原证据摘要/);
  });
  it('accepts the complete old summaries plus an explicit new evidence note', () => {
    const f = example(); f.operation.changes.evidence_summary += '\nNew check: read-only request limits were confirmed, with no new production evidence.';
    const group = expandDraft(f.draft, f.input); const validation = reviewInput('version-case', group, f.input);
    expect(() => prepareGroup(group, f.input, owner)).not.toThrow();
    expect(() => validateSelfReview(validation, reviews(validation).self_review)).not.toThrow();
  });
  it('does not allow an empty or unrelated output to replace a non-empty original summary', () => {
    const f = example(); f.operation.changes.evidence_summary = '';
    expect(() => prepareGroup(expandDraft(f.draft, f.input), f.input, owner)).toThrow();
  });
  it('rejects an unchanged medium confidence as a replacement for original evidence in quality updates', () => {
    const f = example(); const draft = { ...f.draft, kind: 'quality' as const, coverage: [], change_basis: [f.draft.change_basis[0]].filter((item) => item !== undefined), operations: [{ id: f.carrier.id, action: 'update' as const, changes: { evidence_summary: 'Confidence remains medium.' } }] };
    expect(() => prepareGroup(expandDraft(draft, [f.carrier]), [f.carrier], owner)).toThrow(/原证据摘要/);
  });
  it('requires preservation in the coverage destination even when another active output has the text', () => {
    const input = claims(3); const [carrier, source, unrelated] = input; if (!carrier || !source || !unrelated) throw new Error('Missing inputs.');
    const draft = consolidationDraft(input); const operation = draft.operations[0]; if (!operation) throw new Error('Missing output.');
    operation.changes.evidence_summary = `${carrier.evidence_summary} ${unrelated.evidence_summary}`;
    draft.operations[2] = { id: unrelated.id, action: 'update', changes: { evidence_summary: `${unrelated.evidence_summary} ${source.evidence_summary}` } };
    expect(() => prepareGroup(expandDraft(draft, input), input, owner)).toThrow(/原证据摘要/);
  });
});
