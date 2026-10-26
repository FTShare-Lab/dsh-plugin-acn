// 只创建新的临时公共验收数据；旧草稿故意遗漏版本限制，交给真实宿主重新起草。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { ClaimSchema } from '../lib/protocol.js';
import { DraftGroupSchema, expandDraft, reviewInput, ProgressSchema } from '../lib/dream.js';

const scenario = process.argv[2] ?? 'legacy'; assert.ok(['legacy', 'fresh'].includes(scenario), 'Use legacy or fresh.');
const root = await fs.mkdtemp(join(tmpdir(), 'acn-dream-preservation-'));
const agent = join(root, 'knowledge', 'agents', 'agent-a');
const project = join(root, 'documents', 'deepseek-harness', 'default-workspace'); await fs.mkdir(project, { recursive: true });
const common = { holder: 'agent-a', confidence: 'medium', status: 'active', created_at: '2026-01-01T00:00:00Z', source_claim_ids: [] };
const claims = [
  ClaimSchema.parse({ ...common, id: 'claim_00000001', name: 'bounded_read_retry', statement: 'In this disposable project, retry only idempotent read requests within an explicit retry budget; writes require a separate idempotency check.', scope: 'local retry contract', evidence_summary: 'Observed in the disposable contract.txt; this has not been validated in production.' }),
  ClaimSchema.parse({ ...common, id: 'claim_00000002', name: 'retry_contract_version_limit', statement: 'In this disposable project, retrying a read requires both idempotency and a remaining explicit retry budget. Never retry writes without a separate idempotency check.', scope: 'local retry contract', evidence_summary: 'The current contract matches the earlier note, but the same source version cannot be proved. No production behavior was verified.' }),
];
await fs.mkdir(join(agent, 'claims'), { recursive: true });
for (const claim of claims) await fs.writeFile(join(agent, 'claims', `${claim.id}.yaml`), stringify(claim), { mode: 0o600 });
await fs.writeFile(join(root, 'before.json'), JSON.stringify({ scenario, claims }, null, 2), { mode: 0o600 });
if (scenario === 'fresh') {
  await fs.mkdir(join(agent, 'jobs'), { recursive: true }); const now = Date.now();
  await fs.writeFile(join(agent, 'jobs', 'disabled-memory-review.yaml'), stringify({ schemaVersion: 1, id: 'disabled-memory-review', kind: 'memory_review', sessionId: 'prior-session', payload: { request_id: 'queued-before-disable' }, state: 'queued', attempts: 0, createdAt: now, updatedAt: now, ordinal: 0 }), { mode: 0o600 });
}
if (scenario === 'legacy') {
  const [carrier, source] = claims; assert.ok(carrier && source);
  const candidate = { group_id: 'preserve-version', kind: 'consolidation', claim_ids: claims.map((claim) => claim.id), reason: 'Combine overlapping retry rules without losing their distinct evidence and version limitations.' };
  const draft = DraftGroupSchema.parse({ kind: 'consolidation', reason: candidate.reason, coverage: claims.map((claim) => ({ input_id: claim.id, output_ids: [carrier.id], note: 'The surviving rule carries the full boundary.' })), change_basis: claims.map((claim) => ({ claim_id: claim.id, removed_or_changed: 'Reorganize duplicate retry wording.', added: claim.id === carrier.id ? 'All read and write boundaries.' : '', justification: 'The carrier represents the complete retry contract.', evidence_ids: [] })), operations: [{ id: carrier.id, action: 'update', changes: { statement: `${carrier.statement} The budget must not be exhausted.`, evidence_summary: carrier.evidence_summary } }, { id: source.id, action: 'deprecate' }] });
  const group = expandDraft(draft, claims); const validation = reviewInput(candidate.group_id, group, claims); const outputs = validation.input.after.filter((claim) => claim.status !== 'deprecated');
  const fields = ['name', 'statement', 'scope', 'evidence_summary']; const quote = (claim, field) => ({ claim_id: claim.id, field, quote: claim[field] });
  const semantic = { claims: claims.map((claim) => ({ claim_id: claim.id, final_name: claim.name, name_reason: 'The name follows the stored body.', information_preserved: 'All information is claimed to be preserved.', removal_or_correction: 'Only duplicate wording is removed.', factual_correction: false, output_ids: [carrier.id], evidence_ids: [] })), scope_and_certainty: 'Confidence stays medium.' };
  const self_review = { group_id: candidate.group_id, validation_id: validation.validation_id, preservation: claims.flatMap((claim) => fields.map((field) => ({ before: quote(claim, field), after: outputs.map((output) => quote(output, field)), disposition: 'preserved', reason: 'Confidence medium is claimed to retain caution.', evidence: [] }))), support: outputs.flatMap((claim) => fields.map((field) => ({ after: quote(claim, field), before: claims.map((input) => quote(input, field)), evidence: [], reason: 'Based on the existing claims.' }))), scope_and_certainty: 'Confidence stays medium.' };
  const review = { quality: 'Reusable retry rules.', evidence: 'Calibration disabled; version and production limitations must remain explicit.', consolidation: candidate.reason };
  const jobId = 'legacy-version-case'; const now = Date.now();
  for (const path of [join(agent, 'jobs'), join(agent, 'dream', jobId)]) await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(agent, 'jobs', `${jobId}.yaml`), stringify({ schemaVersion: 1, id: jobId, kind: 'dream', payload: { manual: true, workspace_root: await fs.realpath(project) }, state: 'queued', attempts: 0, createdAt: now, updatedAt: now, ordinal: 0 }), { mode: 0o600 });
  await fs.writeFile(join(agent, 'dream', jobId, 'origin.yaml'), stringify({ snapshot_at: new Date(now).toISOString(), claims, coverage: { total: 2, included: 2, omitted: 0 }, workspace_root: await fs.realpath(project) }), { mode: 0o600 });
  const progress = ProgressSchema.parse({ schemaVersion: 1, discovery: { review, candidates: [candidate], sync_candidates: [] }, entries: [{ candidate, status: 'pending', reason: '', draft: group, validation, review: { decision: 'apply', reason: 'The old review treats medium as sufficient caution.', reason_kind: 'useful_knowledge', semantic, self_review } }], syncCompleted: [], finished: false, summary: null });
  await fs.writeFile(join(agent, 'dream', jobId, 'progress.yaml'), stringify(progress), { mode: 0o600 });
}
process.stdout.write(JSON.stringify({ root, scenario, ...(scenario === 'legacy' ? { jobId: 'legacy-version-case' } : {}) }) + '\n');
