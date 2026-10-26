// 在真实原子提交边界暂停，交由父进程 SIGKILL；恢复进程不得重放模型。
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { AgentIdSchema } from '../../../lib/protocol.js';
import { AgentPaths, ClaimStore, UploadStore } from '../../../lib/store.js';
import { DreamStore, DreamSync, DraftGroupSchema, expandDraft, reviewInput, ProgressSchema, CheckpointSchema } from '../../../lib/dream.js';

const [root, jobId, stage] = process.argv.slice(2);
const context = { paths: new AgentPaths(root), agentId: AgentIdSchema.parse('agent-a'), mode: 'team', logger: { warn() {}, debug() {} } };
const store = new DreamStore(context); const input = await new ClaimStore(context).list(); const [first, second] = input;
if (!first || !second) throw new Error('Missing crash inputs.');
process.on('message', () => {});
async function pause() { await new Promise((resolve, reject) => process.send({ stage }, (error) => error ? reject(error) : resolve())); await new Promise(() => {}); }
const semantic = (validation) => ({ claims: validation.input.before.map((claim) => ({ claim_id: claim.id, final_name: validation.input.after.find((output) => output.id === claim.id).name, name_reason: 'The final name matches the final body.', information_preserved: 'All input conditions retained by the carrier.', removal_or_correction: 'Only overlapping wording is reorganized.', factual_correction: false, output_ids: [first.id], evidence_ids: [] })), scope_and_certainty: 'No new evidence or confidence increase.' });
const fields = ['name', 'statement', 'scope', 'evidence_summary'];
const quote = (claim, field) => ({ claim_id: claim.id, field, quote: claim[field] });
const draft = DraftGroupSchema.parse({ kind: 'consolidation', reason: 'Combine related conditions.', coverage: input.map((claim) => ({ input_id: claim.id, output_ids: [first.id], note: 'Complete information goes to the combined topic.' })), change_basis: input.map((claim) => ({ claim_id: claim.id, removed_or_changed: 'Reorganize shared topic.', added: claim.id === first.id ? 'All conditions retained.' : '', justification: 'The surviving text covers both inputs.', evidence_ids: [] })), operations: input.map((claim) => claim.id === first.id ? { id: claim.id, action: 'update', changes: { statement: input.map((value) => value.statement).join(' '), evidence_summary: input.map((value) => value.evidence_summary).join(' ') } } : { id: claim.id, action: 'deprecate' }) });
const group = expandDraft(draft, input); const validation = reviewInput('group-a', group, input); const outputs = validation.input.after.filter((claim) => claim.status !== 'deprecated');
const selfReview = { group_id: 'group-a', validation_id: validation.validation_id, preservation: input.flatMap((claim) => fields.map((field) => ({ before: quote(claim, field), after: outputs.map((output) => quote(output, field)), disposition: 'preserved', reason: 'Represented by the surviving topic.', evidence: [] }))), support: outputs.flatMap((claim) => fields.map((field) => ({ after: quote(claim, field), before: input.map((before) => quote(before, field)), evidence: [], reason: 'Supported by the complete input fields.' }))), scope_and_certainty: 'Scope and certainty unchanged.' };
const review = { quality: 'No episodic cleanup required.', evidence: 'Calibration unavailable.', consolidation: 'Combine complete related conditions.' };
await store.saveOrigin(jobId, { snapshot_at: '2026-01-04T00:00:00Z', claims: input, coverage: { total: 2, included: 2, omitted: 0 } });
const progress = ProgressSchema.parse({ schemaVersion: 1, discovery: { review, candidates: [{ group_id: 'group-a', claim_ids: input.map((claim) => claim.id), kind: 'consolidation', reason: 'Shared topic.' }], sync_candidates: [] }, entries: [{ candidate: { group_id: 'group-a', claim_ids: input.map((claim) => claim.id), kind: 'consolidation', reason: 'Shared topic.' }, status: 'pending', reason: '', draft: group, validation, review: { decision: 'apply', reason: 'Complete review.', reason_kind: 'useful_knowledge', semantic: semantic(validation), self_review: selfReview } }], syncCompleted: [], finished: false, summary: null });
await store.saveProgress(jobId, progress); await fs.writeFile(join(root, 'model-calls'), 'one', { mode: 0o600 });
let finalizing = false;
const rename = fs.rename;
const unlink = fs.unlink;
fs.unlink = async (path) => { await unlink(path); if (path === context.paths.dreamPending && stage === (finalizing ? 'final-pointer-removed' : 'pointer-removed')) await pause(); };
fs.rename = async (source, target) => {
  await rename(source, target);
  let match = stage === 'pending' && target === context.paths.dreamPending
    || !finalizing && stage === 'trace' && dirname(target) === context.paths.traces
    || stage === 'upload' && target === context.paths.pendingUploads
    || stage === (finalizing ? 'final-state' : 'state') && target === context.paths.dreamState;
  if (dirname(target) === context.paths.claims) { const claim = parse(await fs.readFile(target, 'utf8')); match ||= stage === 'carrier' && claim.status !== 'deprecated' || stage === 'retired' && claim.status === 'deprecated'; }
  if (target === context.paths.dreamExecution(jobId, validation.validation_id)) { const cp = CheckpointSchema.parse(parse(await fs.readFile(target, 'utf8'))); match ||= stage === 'prepared' && !cp.applied && !cp.groups[0].completed || stage === 'group-completed' && !cp.applied && cp.groups[0].completed || stage === 'applied' && cp.applied; }
  if (finalizing) {
    match ||= stage === 'final-trace' && dirname(target) === context.paths.traces;
    if (target === context.paths.dreamFinal(jobId)) { const cp = CheckpointSchema.parse(parse(await fs.readFile(target, 'utf8'))); match ||= stage === 'final-prepared' && !cp.applied || stage === 'final-applied' && cp.applied; }
  }
  if (stage.startsWith('sync-') && String(target).includes('/sync_reviews/')) { const record = parse(await fs.readFile(target, 'utf8')); match ||= stage === 'sync-prepared' && !record.applied || stage === 'sync-applied' && record.applied; }
  if (stage === 'sync-upload' && target === context.paths.pendingUploads && finalizing) match = true;
  if (match) await pause();
};
await store.commitGroup(jobId, 'group-a', group, validation, semantic(validation), selfReview, { signal: new AbortController().signal, prepared() {} });
progress.entries[0].status = 'executed'; await store.saveProgress(jobId, progress); finalizing = true;
if (stage.startsWith('sync-')) {
  const carrier = await new ClaimStore(context).read(first.id); const revised = { ...carrier, statement: `${carrier.statement} Keep the original scope.`, updated_at: '2027-01-01T00:00:00Z' }; await new ClaimStore(context).write(revised);
  const sync = new DreamSync(context); const v = await sync.prepare(second.id, [first.id]); const r = { ...semantic(validation), claims: [{ ...semantic(validation).claims[1], output_ids: [first.id] }] };
  await sync.apply(jobId, v, r, new AbortController().signal);
  if (stage === 'sync-upload') throw new Error('Upload hook did not stop.');
} else await store.finish(jobId, progress, { signal: new AbortController().signal, prepared() {} });
await new UploadStore(context).read();
throw new Error('Requested crash boundary was not reached.');
