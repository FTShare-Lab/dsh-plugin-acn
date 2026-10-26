// 独立进程在真实 rename/fsync 边界暂停；父进程使用 SIGKILL 验证持久恢复。
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AgentIdSchema } from '../../../lib/protocol.js';
import { AgentPaths, ClaimStore } from '../../../lib/store.js';
import { CheckpointSchema, DurableWorker, FormationStore, TranscriptStore, prepareFormation, processedThrough } from '../../../lib/formation.js';
import { parse } from 'yaml';

const [root, mode] = process.argv.slice(2);
const context = { paths: new AgentPaths(root), agentId: AgentIdSchema.parse('agent-a'), mode: 'team', logger: { warn() {}, debug() {} } };
process.on('message', () => {});
const send = (value) => new Promise((resolve, reject) => process.send(value, (error) => error ? reject(error) : resolve()));
const pause = async () => { await send({ stage: mode }); await new Promise(() => {}); };
const originalRename = fs.rename;
let stopped = false;
if (mode !== 'serve') fs.rename = async (source, target) => {
  const state = target === context.paths.sessionState('session-a');
  if (mode === 'before-state' && state) {
    const value = parse(await fs.readFile(source, 'utf8'));
    if (value.finalizedThroughSeq === 2) await pause();
  }
  await originalRename(source, target);
  let match = mode === 'after-claim' && dirname(target) === context.paths.claims
    || mode === 'after-trace' && dirname(target) === context.paths.traces
    || mode === 'after-upload' && target === context.paths.pendingUploads;
  if (target === context.paths.finalizeCheckpoint('session-a')) {
    const checkpoint = CheckpointSchema.parse(parse(await fs.readFile(target, 'utf8')));
    match ||= mode === 'prepared' && checkpoint.status === 'prepared' && checkpoint.appliedClaims.length === 0
      || mode === 'after-progress' && checkpoint.status === 'prepared' && checkpoint.appliedClaims.length === 1
      || mode === 'after-applied' && checkpoint.status === 'applied';
  }
  if (match && !stopped) { stopped = true; await pause(); }
};

const worker = new DurableWorker(context, { pollMs: 10, takeoverMs: 20 });
worker.register('finalize', async (job, control) => {
  if (mode === 'serve') {
    const file = await fs.open(join(root, 'executions.jsonl'), 'a', 0o600);
    try { await file.writeFile(`${JSON.stringify({ jobId: job.id, process: process.pid })}\n`); await file.sync(); } finally { await file.close(); }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { done: true };
  }
  const store = new FormationStore(context);
  await store.recover();
  const state = await new TranscriptStore(context).state('session-a');
  if (processedThrough(state) >= 2) return { skipped: 'already_processed' };
  const local = await new ClaimStore(context).list(); const existing = local[0];
  const draft = (index) => ({ id: `$new_claim_${index}$`, name: `retry_bound_${index}`, statement: 'Retry only idempotent operations within the service budget.', scope: 'service / imports', confidence: 'high', evidence_summary: 'Compared service constraints using the current task evidence.', source_claim_ids: [existing.id] });
  const prepared = prepareFormation({ new_claims: [draft(0), draft(1)], updated_claims: [{ ...draft(2), id: existing.id, status: 'stale', source_claim_ids: [] }], used_claim_ids: [existing.id], new_disputes: [{ id: '$new_dispute_0$', name: 'retry_conflict', summary: 'Incompatible retry bounds in the two example service contracts.', claims: [existing.id, '$new_claim_0$'] }] }, context.agentId, local, []);
  return store.commit({ sessionId: 'session-a', jobId: job.id, kind: 'finalize', fromSeq: -1, untilSeq: 2, analysisClaims: local, prepared, task: 'Verify retry budgets using the service contracts.' }, control);
});
await worker.start();
if (mode === 'serve') await send({ stage: 'serving' });
