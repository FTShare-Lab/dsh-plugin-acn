// 真进程在 journal、Claim、Trace、队列与 done 的原子 rename 边界停下等待强杀。
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { AgentIdSchema, InboxMessageSchema } from '../../../lib/protocol.js';
import { AgentPaths, ClaimStore, InboxStore } from '../../../lib/store.js';
import { InboxEffectSchema, InboxEffectStore, prepareInbox } from '../../../lib/inbox.js';

const [root, mode] = process.argv.slice(2);
const context = { paths: new AgentPaths(root), agentId: AgentIdSchema.parse('agent-a'), mode: 'team', logger: { warn() {}, debug() {} } };
process.on('message', () => {});
async function pause() { await new Promise((resolve, reject) => process.send({ stage: mode }, (error) => error ? reject(error) : resolve())); await new Promise(() => {}); }
const messages = [1, 2].map((index) => InboxMessageSchema.parse({ id: `inbox_0000000${index}`, message_type: 'claim_attribute_update', policy: { id: 'policy_00000001', message_type: 'claim_attribute_update', name: 'retry_bound', statement: 'Bound retry attempts.', scope: 'service', status: 'active', created_at: '2026-01-02T00:00:00Z' } }));
for (const message of messages) await new InboxStore(context).acceptPulled(message);
await new InboxStore(context).claimPending();
const original = fs.rename;
fs.rename = async (source, target) => {
  if (mode === 'before-done' && String(target).endsWith('.done.yaml')) await pause();
  await original(source, target);
  let match = mode === 'after-claim' && dirname(target) === context.paths.claims
    || mode === 'after-trace' && dirname(target) === context.paths.traces
    || mode === 'after-upload' && target === context.paths.pendingUploads
    || mode === 'after-ref' && target === context.paths.inboxEffect('inbox_00000002')
    || mode === 'after-done' && String(target).endsWith('.done.yaml');
  if (target === context.paths.inboxEffect('inbox_00000001')) {
    const effect = InboxEffectSchema.parse(parse(await fs.readFile(target, 'utf8')));
    match ||= mode === 'prepared' && effect.status === 'prepared' && effect.appliedClaims.length === 0
      || mode === 'after-progress' && effect.status === 'prepared' && effect.appliedClaims.length === 1
      || mode === 'after-applied' && effect.status === 'applied';
  }
  if (match) await pause();
};
const local = await new ClaimStore(context).list(); const existing = local[0];
const draft = (index) => ({ id: `$new_claim_${index}$`, name: `retry_bound_${index}`, statement: 'Retry only idempotent requests within the service budget.', scope: 'service', confidence: 'high', evidence_summary: 'Checked the service contract.', source_claim_ids: ['policy_00000001'] });
await fs.writeFile(join(root, 'model-calls'), 'one', { mode: 0o600 });
const prepared = prepareInbox({ new_claims: [draft(0), draft(1)], updated_claims: [{ ...draft(2), id: existing.id, status: 'stale' }], new_disputes: [{ id: '$new_dispute_0$', name: 'retry_conflict', summary: 'Conflicting retry budgets.', claims: [existing.id, '$new_claim_0$'] }] }, context.agentId, messages, local);
await new InboxEffectStore(context).commit(messages, local, prepared, { signal: new AbortController().signal, prepared() {} });
