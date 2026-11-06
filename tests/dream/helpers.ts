// 整理测试使用真实磁盘与结构化阶段响应，模型替身不具有知识写入权限。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveConfig, type ConfigInput } from '../../src/config.js';
import { AcnKnowledge } from '../../src/knowledge/service.js';
import { AcnDream } from '../../src/dream/service.js';
import type { DreamOptions } from '../../src/dream/service.js';
import { DraftGroupSchema, type Validation, type SelfReview, type SemanticReview, type Candidate } from '../../src/dream/schema.js';
import { expandDraft, reviewInput } from '../../src/dream/plan.js';
import type { Claim } from '../../src/protocol/claim.js';
import { ClaimIdSchema } from '../../src/protocol/ids.js';
import type { StructuredBackend } from '../../src/llm/structured.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import { ClaimStore } from '../../src/store/claims.js';
import { logger } from '../helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';

export const reviewSummary = { quality: '逐条检查一次性记录。', evidence: '本阶段不校准事实。', consolidation: '核对同主题信息去向。' };
export const claims = (count = 2): Claim[] => Array.from({ length: count }, (_, index) => sampleClaim({ id: ClaimIdSchema.parse(`claim_${String(index + 1).padStart(8, '0')}`), name: `example_rule_${index + 1}`, statement: `Preserve example condition ${index + 1}; do not retry unsafe writes.`, evidence_summary: `Checked example limitation ${index + 1}.` }));
export function candidate(input: readonly Claim[], kind: Candidate['kind'] = 'quality', group_id = 'group-a'): Candidate { return { group_id, claim_ids: input.map((claim) => claim.id), kind, reason: 'Review this complete topic.' }; }
export function qualityDraft(input: readonly Claim[]) { return DraftGroupSchema.parse({ kind: 'quality', reason: 'Remove an episodic record while retaining history.', operations: input.map((claim) => ({ id: claim.id, action: 'deprecate', reason: 'This is an explicitly reviewed one-time observation.' })) }); }
export function consolidationDraft(input: readonly Claim[]) {
  const first = input[0]; if (first === undefined) throw new Error('Test requires inputs.');
  const sources = [...new Set(input.flatMap((claim) => claim.source_claim_ids))].filter((id) => id !== first.id);
  return DraftGroupSchema.parse({ kind: 'consolidation', reason: 'Combine the complete topic without removing conditions.', coverage: input.map((claim) => ({ input_id: claim.id, output_ids: [first.id], note: 'All conditions and limitations are carried by the combined text.' })), change_basis: input.map((claim) => ({ claim_id: claim.id, removed_or_changed: 'Combine overlapping wording.', added: claim.id === first.id ? 'Preserve all input conditions in the combined topic.' : '', justification: 'The surviving topic carries the full information.', evidence_ids: [] })), operations: input.map((claim) => claim.id === first.id ? { id: claim.id, action: 'update', changes: { name: 'example_combined_rule', statement: input.map((value) => value.statement).join(' '), evidence_summary: input.map((value) => value.evidence_summary).join(' '), source_claim_ids: sources } } : { id: claim.id, action: 'deprecate' }) });
}
const fields = ['name', 'statement', 'scope', 'evidence_summary'] as const;
export function reviews(validation: Validation): { semantic: SemanticReview; self_review: SelfReview } {
  const outputs = validation.input.after.filter((claim) => claim.status !== 'deprecated');
  const quote = (claim: Pick<Claim, 'id' | typeof fields[number]>, field: typeof fields[number]) => ({ claim_id: claim.id, field, quote: claim[field] });
  const self_review: SelfReview = { group_id: validation.input.group_id, validation_id: validation.validation_id, preservation: validation.input.before.flatMap((claim) => fields.map((field) => ({ before: quote(claim, field), after: outputs.map((output) => quote(output, field)), disposition: outputs.length ? 'preserved' as const : 'episodic' as const, reason: outputs.length ? 'The full input field is represented by the reviewed output.' : 'Explicit one-time material; historical body remains.', evidence: [] }))), support: outputs.flatMap((claim) => fields.map((field) => ({ after: quote(claim, field), before: validation.input.before.map((input) => quote(input, field)), evidence: [], reason: 'Bounded by these existing input fields.' }))), scope_and_certainty: 'No new facts or increased certainty.' };
  const semantic: SemanticReview = { claims: validation.input.before.map((claim) => ({ claim_id: claim.id, final_name: validation.input.after.find((output) => output.id === claim.id)?.name ?? '', name_reason: 'The final name describes the final body; retired history keeps its name.', information_preserved: 'Checked the complete fields and information destinations.', removal_or_correction: outputs.length ? 'Only overlapping wording is reorganized.' : 'Only a one-time record is removed from active knowledge.', factual_correction: false, output_ids: validation.input.kind === 'consolidation' ? validation.input.coverage.find((coverage) => coverage.input_id === claim.id)?.output_ids ?? [] : outputs.filter((output) => output.id === claim.id).map((output) => output.id), evidence_ids: [] })), scope_and_certainty: 'The original scope and certainty remain bounded.' };
  return { semantic, self_review };
}
export function prepared(input: readonly Claim[], kind: 'quality' | 'consolidation' = 'quality', groupId = 'group-a') { const group = expandDraft(kind === 'quality' ? qualityDraft(input) : consolidationDraft(input), input); const validation = reviewInput(groupId, group, input); return { group, validation, ...reviews(validation) }; }
export function phaseBackend(input: readonly Claim[], kind: 'quality' | 'consolidation' = 'quality'): StructuredBackend {
  return (_route, _system, text) => {
    const request = JSON.parse(text) as { phase: string; validation?: Validation };
    const response = request.phase === 'candidates' ? { review: reviewSummary, candidates: [candidate(input, kind)], sync_candidates: [] } : request.phase === 'draft' ? { action: 'stage', group: kind === 'quality' ? qualityDraft(input) : consolidationDraft(input) } : request.phase === 'review' && request.validation ? { decision: 'apply', reason: 'All fields reviewed.', reason_kind: 'useful_knowledge', ...reviews(request.validation) } : { checked: 'All completed records.', findings: 'Kept complete information.', uncertainties: 'No independent evidence.', next_steps: 'Review remaining candidates.' };
    return Promise.resolve({ text: JSON.stringify(response) });
  };
}
export async function dreamFixture(backend: StructuredBackend, config: ConfigInput = {}, initial: Claim[] = claims(), options: DreamOptions = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-dream-')); const warnings: string[] = [];
  const knowledge = new AcnKnowledge(resolveConfig({ ...config, agentId: 'agent-a', home: root, llm: { provider: 'mock', model: 'mock', structuredRetries: 2, ...config.llm }, dream: { minChangedClaims: 100, ...config.dream } }), { ...logger, warn: (message: string) => { warnings.push(message); } });
  await knowledge.initialize(); for (const claim of initial) await new ClaimStore(knowledge.context()).write(claim);
  const worker = knowledge.jobs; if (worker === null) throw new Error('Missing configured worker.');
  const failures: unknown[] = []; const register = worker.register.bind(worker);
  worker.register = (kind, handler) => register(kind, async (job, control) => {
    try { return await handler(job, control); }
    catch (error) { failures.push(error); throw error; }
  });
  const dream = new AcnDream(knowledge, backend, await loadPromptRenderer(), undefined, options);
  return { root, knowledge, dream, worker, warnings, failures, start: async () => { await knowledge.jobs?.start(); await dream.start(); }, close: async () => { await dream.close(); await knowledge.jobs?.close(); await knowledge.team?.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
export async function until(check: () => Promise<boolean>, label = 'condition'): Promise<void> { const end = Date.now() + (process.platform === 'win32' ? 30_000 : 8000); while (Date.now() < end) { if (await check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
export function deferred() { let resolve = () => {}; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
