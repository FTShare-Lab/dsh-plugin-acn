// 在真实证据和固定目标提交的原子边界暂停，由父进程强杀并交给新实例恢复。
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { AgentIdSchema } from '../../../lib/protocol.js';
import { AgentPaths, ClaimStore } from '../../../lib/store.js';
import { DreamStore, EvidenceStore, DraftGroupSchema, expandDraft, reviewInput, ProgressSchema } from '../../../lib/dream.js';

const [root, workspace, jobId, stage] = process.argv.slice(2);
const context = { paths: new AgentPaths(root), agentId: AgentIdSchema.parse('agent-a'), mode: 'solo', logger: { warn() {}, debug() {} } };
const store = new DreamStore(context); const evidence = new EvidenceStore(context, jobId, 'group-a'); const input = await new ClaimStore(context).list();
process.on('message', () => {});
async function pause() { await new Promise((resolve, reject) => process.send({ stage }, (error) => error ? reject(error) : resolve())); await new Promise(() => {}); }
const rename = fs.rename;
fs.rename = async (source, target) => {
  await rename(source, target); let match = false;
  if (target === evidence.path) { const manifest = parse(await fs.readFile(target, 'utf8')); const count = Object.keys(manifest.receipts).length; match = stage === 'permission' && manifest.calls === 0 || stage === 'budget' && manifest.calls === 1 && count === 0 || stage === 'receipt' && count === 1 || stage === 'evidence-completed' && manifest.completed; }
  if (String(target).includes('/executions/') && String(target).endsWith('.yaml')) { const checkpoint = parse(await fs.readFile(target, 'utf8')); match ||= stage === 'prepared' && !checkpoint.applied && !checkpoint.groups[0].completed || stage === 'group-completed' && checkpoint.groups[0].completed && !checkpoint.applied || stage === 'applied' && checkpoint.applied; }
  if (dirname(target) === context.paths.claims) match ||= stage === 'first-claim';
  match ||= stage === 'pending' && target === context.paths.dreamPending || stage === 'trace' && dirname(target) === context.paths.traces || stage === 'state' && target === context.paths.dreamState;
  if (match) await pause();
};
await store.saveOrigin(jobId, { snapshot_at: '2026-01-04T00:00:00Z', claims: input, coverage: { included: input.length }, workspace_root: workspace });
await evidence.initialize(workspace, input, { evidenceCalibration: true, evidenceMaxCalls: 16, evidenceMaxSteps: 8, evidenceMaxBytes: 65536, evidenceMaxChars: 4000, evidenceMaxFiles: 64 });
for (const claim of input) await evidence.execute('read', { path: 'source.txt', claim_ids: [claim.id] }, input, new AbortController().signal);
await evidence.complete(new AbortController().signal); const manifest = await evidence.read(); const receipts = manifest.receipts;
const ids = (claim) => Object.entries(receipts).filter(([, receipt]) => receipt.input.claim_ids.includes(claim.id)).map(([id]) => id);
const body = 'The verified rule applies only to read operations. Writes require a separate check.';
const draft = DraftGroupSchema.parse({ kind: 'evidence', reason: 'Calibrate with direct file material.', evidence_ids: Object.keys(receipts), change_basis: input.map((claim) => ({ claim_id: claim.id, removed_or_changed: 'Correct the broad scope.', added: body, justification: 'The material states the limitation.', evidence_ids: ids(claim) })), operations: input.map((claim) => ({ id: claim.id, action: 'update', changes: { statement: body, confidence: 'high', evidence_summary: `Historical evidence: ${claim.evidence_summary}\nA versioned file supports only read operations; writes remain unverified.` } })) });
const group = expandDraft(draft, input); const validation = reviewInput('group-a', group, input, receipts);
const fields = ['name', 'statement', 'scope', 'evidence_summary']; const quote = (claim, field) => ({ claim_id: claim.id, field, quote: claim[field] });
const proof = (claim) => ids(claim).map((evidence_id) => ({ evidence_id, quote: receipts[evidence_id].output.content }));
const self = { group_id: 'group-a', validation_id: validation.validation_id, preservation: input.flatMap((claim) => fields.map((field) => { const output = group.updates.find((value) => value.id === claim.id); const changed = claim[field] !== output[field]; return { before: quote(claim, field), after: [quote(output, field)], disposition: changed ? 'corrected' : 'preserved', reason: 'Direct material corrects the bounded field.', evidence: changed ? proof(claim) : [] }; })), support: group.updates.flatMap((claim) => fields.map((field) => ({ after: quote(claim, field), before: input.filter((value) => value.id === claim.id).map((value) => quote(value, field)), evidence: proof(claim), reason: 'Supported by direct file material.' }))), scope_and_certainty: 'Only the verified read scope is supported.' };
const semantic = { claims: input.map((claim) => ({ claim_id: claim.id, final_name: claim.name, name_reason: 'The unchanged name still describes the bounded body.', information_preserved: 'Conditions and uncertainty reviewed.', removal_or_correction: 'Corrected the broad scope with direct material.', factual_correction: true, output_ids: [claim.id], evidence_ids: ids(claim) })), scope_and_certainty: 'Evidence does not establish write behavior.' };
const candidate = { group_id: 'group-a', claim_ids: input.map((claim) => claim.id), kind: 'evidence', reason: 'Check the direct scope evidence.' };
await store.saveProgress(jobId, ProgressSchema.parse({ schemaVersion: 1, discovery: { review: { quality: 'No cleanup.', evidence: 'Direct material read.', consolidation: 'No consolidation.' }, candidates: [candidate], sync_candidates: [] }, entries: [{ candidate, status: 'pending', reason: '', draft: group, validation, review: { decision: 'apply', reason: 'Verified scope.', reason_kind: 'useful_knowledge', semantic, self_review: self } }], syncCompleted: [], finished: false, summary: null }));
await fs.writeFile(join(root, 'model-calls'), 'one');
await store.commitGroup(jobId, 'group-a', group, validation, semantic, self, { signal: new AbortController().signal, prepared() {} });
throw new Error('Requested crash boundary was not reached.');
