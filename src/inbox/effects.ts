// 批次正文先落 canonical journal，再补成员引用；applied 与 done 都可幂等恢复。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StoreContext } from '../store/context.js';
import { readYaml, readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { withFileLock } from '../store/lock.js';
import { DreamStore } from '../dream/checkpoint.js';
import { StoreError, hasCode } from '../store/errors.js';
import { ClaimStore } from '../store/claims.js';
import { ClaimEditStore } from '../store/claim-edits.js';
import { TraceStore } from '../store/traces.js';
import { DisputeStore } from '../store/disputes.js';
import { UploadStore } from '../store/uploads.js';
import { InboxStore } from '../store/inbox.js';
import { newDisputes } from '../knowledge/disputes.js';
import { ClaimSchema, type Claim } from '../protocol/claim.js';
import { DisputeSchema } from '../protocol/dispute.js';
import { InboxMessageSchema, inboxEventAt, type InboxMessage } from '../protocol/inbox.js';
import { TraceSchema } from '../protocol/trace.js';
import { InboxIdSchema, PolicyIdSchema, SourceIdSchema, deriveTraceId } from '../protocol/ids.js';
import { nowSeconds } from '../protocol/time.js';
import { ensureKnowledgeReady, AnalysisChanged, analysisIsStale, claimChanges, observeApplied, sameClaim, STALE_PLAN_WARNING } from '../knowledge/alignment.js';
import { FormationStore } from '../formation/checkpoint.js';
import type { PreparedFormation } from '../formation/prepare.js';
import type { JobControl } from '../worker/worker.js';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const MemberSchema = z.strictObject({ id: InboxIdSchema, hash: HashSchema, message: InboxMessageSchema });
export const InboxEffectSchema = z.strictObject({
  schemaVersion: z.literal(1), type: z.literal('effect'), canonicalId: InboxIdSchema, batchHash: HashSchema,
  members: z.array(MemberSchema).min(1), status: z.enum(['prepared', 'applied']),
  analysisClaims: z.array(ClaimSchema).nullable(), preparedClaims: z.array(ClaimSchema), appliedClaims: z.array(ClaimSchema),
  teamAuthorized: z.boolean().optional(), syncClaims: z.array(ClaimSchema).optional(), disputes: z.array(DisputeSchema), trace: TraceSchema.nullable(), warnings: z.array(z.string()), retiredPolicies: z.array(PolicyIdSchema),
});
const RefSchema = z.strictObject({ schemaVersion: z.literal(1), type: z.literal('ref'), id: InboxIdSchema, canonicalId: InboxIdSchema, batchHash: HashSchema, messageHash: HashSchema });
const JournalSchema = z.discriminatedUnion('type', [InboxEffectSchema, RefSchema]);
export type InboxEffect = z.infer<typeof InboxEffectSchema>;
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'object' && item !== null && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const inboxMessageHash = (message: InboxMessage): string => hash(JSON.parse(JSON.stringify({ ...message, handled_at: undefined })));
const batchHash = (members: InboxEffect['members']): string => hash(members.map(({ id, hash }) => ({ id, hash })));
function integrity(condition: boolean): asserts condition { if (!condition) throw new StoreError('conflict', 'Inbox effect journal integrity check failed.'); }

export class InboxEffectStore {
  constructor(readonly context: StoreContext) {}
  private async journals() {
    let names: string[];
    try { names = (await fs.readdir(join(this.context.paths.inbox, 'effects'))).filter((name) => name.endsWith('.yaml') && !name.includes('.tmp.')); }
    catch (error) { if (hasCode(error, 'ENOENT')) return new Map<string, z.infer<typeof JournalSchema>>(); throw error; }
    const entries = await Promise.all(names.sort().map(async (name) => {
      const journal = await readYaml(join(this.context.paths.inbox, 'effects', name), JournalSchema);
      integrity(name === `${journal.type === 'effect' ? journal.canonicalId : journal.id}.yaml`);
      return [name.slice(0, -5), journal] as const;
    }));
    const result = new Map(entries);
    for (const [id, journal] of result) {
      if (journal.type === 'ref') {
        const canonical = result.get(journal.canonicalId);
        integrity(canonical?.type === 'effect' && canonical.canonicalId !== id);
        const member = canonical.members.find((member) => member.id === id);
        integrity(member !== undefined && member.hash === journal.messageHash && canonical.batchHash === journal.batchHash);
      } else {
        integrity(journal.members[0]?.id === journal.canonicalId && new Set(journal.members.map((member) => member.id)).size === journal.members.length && batchHash(journal.members) === journal.batchHash);
        integrity(journal.members.every((member) => member.id === member.message.id && member.hash === inboxMessageHash(member.message)));
        integrity([...journal.preparedClaims, ...journal.appliedClaims].every((claim) => claim.holder === this.context.agentId));
        integrity((journal.syncClaims ?? []).every((claim) => claim.holder === this.context.agentId && claim.status === 'deprecated' && journal.retiredPolicies.some((id) => claim.source_claim_ids.includes(id))));
        integrity(journal.trace === null || journal.trace.agent === this.context.agentId);
        integrity(journal.disputes.every((dispute) => dispute.reporter_agent_id === this.context.agentId));
        for (const member of journal.members.slice(1)) {
          const ref = result.get(member.id);
          integrity(ref === undefined || ref.type === 'ref' && ref.canonicalId === id && ref.batchHash === journal.batchHash && ref.messageHash === member.hash);
        }
      }
    }
    return result;
  }
  private write(effect: InboxEffect): Promise<void> { return writeYamlAtomic(this.context.paths.inboxEffect(effect.canonicalId), effect, InboxEffectSchema, this.context.logger); }
  private async references(effect: InboxEffect): Promise<void> {
    for (const member of effect.members.slice(1)) {
      const ref = { schemaVersion: 1, type: 'ref', id: member.id, canonicalId: effect.canonicalId, batchHash: effect.batchHash, messageHash: member.hash } as const;
      const existing = await readYamlOr(this.context.paths.inboxEffect(member.id), JournalSchema, () => null);
      if (existing === null) await writeYamlAtomic(this.context.paths.inboxEffect(member.id), ref, RefSchema, this.context.logger);
      else integrity(canonicalJson(existing) === canonicalJson(ref));
    }
  }
  async recover(): Promise<void> {
    const journals = await this.journals();
    if (journals.size === 0) return;
    await withFileLock(this.context.paths.knowledgeLock, () => this.recoverLocked(), { timeoutMs: this.context.lockTimeoutMs });
  }
  async recoverLocked(): Promise<void> {
    await new DreamStore(this.context).recoverLocked();
    const journals = await this.journals();
    const effects = [...journals.values()].filter((journal) => journal.type === 'effect').sort((a, b) => (a.members[0] === undefined ? '' : inboxEventAt(a.members[0].message)).localeCompare(b.members[0] === undefined ? '' : inboxEventAt(b.members[0].message)));
    // 当前消息和冻结成员也必须一致；不能先落 Claim 再在 done 阶段才发现冲突。
    for (const effect of effects) for (const member of effect.members) await new InboxStore(this.context).validateSnapshotLocked(member.message);
    for (const effect of effects) {
      await this.references(effect);
      if (effect.status === 'prepared') await this.applyLocked(effect);
      else for (const member of effect.members) await new InboxStore(this.context).completeSnapshotLocked(member.message);
    }
  }
  async commit(messages: readonly InboxMessage[], analysisClaims: Claim[], prepared: PreparedFormation, control: JobControl): Promise<{ applied: number; warnings: string[]; entityIds?: string[] }> {
    return withFileLock(this.context.paths.knowledgeLock, async () => {
      await new DreamStore(this.context).recoverLocked();
      await ensureKnowledgeReady(this.context.paths.root);
      await new ClaimEditStore(this.context).recoverLocked();
      await new FormationStore(this.context).recoverLocked();
      await this.recoverLocked();
      const first = messages[0]; integrity(first !== undefined);
      for (const message of messages) await new InboxStore(this.context).validateSnapshotLocked(message);
      const existing = await this.journals();
      if (messages.some((message) => existing.has(message.id))) {
        integrity(messages.every((message) => {
          const journal = existing.get(message.id);
          const canonical = journal?.type === 'effect' ? journal : journal === undefined ? undefined : existing.get(journal.canonicalId);
          return canonical?.type === 'effect' && canonical.members.some((member) => member.id === message.id && member.hash === inboxMessageHash(message));
        }));
        return { applied: 0, warnings: [] };
      }
      // 让 worker 重新领取原消息，只有固定本地效果成功后才能把消息标记 done。
      if (claimChanges(analysisClaims, prepared.claims, [], await new ClaimStore(this.context).list()).length > 0) throw new AnalysisChanged();
      const members = messages.map((message) => ({ id: message.id, hash: inboxMessageHash(message), message }));
      const traceInputs = [...new Set([...messages.map((message) => message.policy.id), ...messages.flatMap((message) => message.message_type === 'claim_attribute_update' ? message.arbitration_resolution?.direct_claim_snapshots.map((claim) => claim.id) ?? [] : []), ...prepared.usedClaimIds, ...prepared.claims.flatMap((claim) => claim.source_claim_ids)])].map((id) => SourceIdSchema.parse(id)).sort();
      const createdAt = nowSeconds();
      const name = first.message_type;
      const traceIds = new Set((await new TraceStore(this.context).list()).map((trace) => trace.id));
      let traceId = deriveTraceId(createdAt, name, traceInputs, prepared.claims.map((claim) => claim.id));
      for (let attempt = 0; traceIds.has(traceId); attempt += 1) {
        if (attempt >= 7) throw new StoreError('conflict', 'Inbox Trace ID collision; retry the task.');
        traceId = deriveTraceId(createdAt, name, traceInputs, prepared.claims.map((claim) => claim.id));
      }
      const trace = prepared.claims.length === 0 && prepared.disputes.length === 0 ? null : TraceSchema.parse({ id: traceId, name, task: `Inbox ${messages.map((message) => message.id).join(', ')}`, agent: this.context.agentId, input_claims: traceInputs, output_claims: prepared.claims.map((claim) => claim.id), created_at: createdAt });
      const existingDisputes = await new DisputeStore(this.context).list();
      const disputes = await newDisputes(this.context, prepared.disputes, existingDisputes);
      if (disputes.some((dispute) => existingDisputes.some((existing) => existing.id === dispute.id))) throw new StoreError('conflict', 'Inbox Dispute ID collision; retry the task.');
      const effect = InboxEffectSchema.parse({ schemaVersion: 1, type: 'effect', canonicalId: first.id, batchHash: batchHash(members), members, status: 'prepared', teamAuthorized: this.context.mode === 'team', syncClaims: prepared.syncClaims ?? [], analysisClaims, preparedClaims: prepared.claims, appliedClaims: [], disputes, trace, warnings: prepared.warnings, retiredPolicies: messages.filter((message) => message.message_type === 'policy_update' && message.policy.status === 'deprecated').map((message) => message.policy.id) });
      control.signal.throwIfAborted(); control.prepared();
      await this.write(effect); await this.references(effect); await this.applyLocked(effect);
      return { applied: effect.appliedClaims.length, warnings: effect.warnings, entityIds: [...effect.appliedClaims.map((claim) => claim.id), ...effect.disputes.map((dispute) => dispute.id), ...effect.trace === null ? [] : [effect.trace.id]] };
    }, { timeoutMs: this.context.lockTimeoutMs, signal: control.signal });
  }
  private async applyLocked(effect: InboxEffect): Promise<void> {
    await ensureKnowledgeReady(this.context.paths.root);
    const current = await new ClaimStore(this.context).list();
    observeApplied(effect.preparedClaims, current, effect.appliedClaims);
    if (analysisIsStale(effect.analysisClaims, claimChanges(effect.analysisClaims, effect.preparedClaims, effect.appliedClaims, current))) {
      effect.warnings.push(STALE_PLAN_WARNING); this.context.logger.warn(STALE_PLAN_WARNING);
      effect.preparedClaims = []; effect.syncClaims = []; effect.disputes = []; effect.analysisClaims = current;
      await this.write(effect);
    }
    for (const target of [...effect.preparedClaims].sort((a, b) => Number(a.status === 'deprecated') - Number(b.status === 'deprecated'))) {
      if (effect.appliedClaims.some((claim) => claim.id === target.id)) continue;
      await new ClaimStore(this.context).write(target); effect.appliedClaims.push(target); await this.write(effect);
    }
    if (effect.trace !== null) { effect.trace.output_claims = effect.appliedClaims.map((claim) => claim.id); await new TraceStore(this.context).write(effect.trace); }
    for (const dispute of effect.disputes) await new DisputeStore(this.context).write(dispute);
    if (effect.teamAuthorized === undefined && this.context.mode === 'team') {
      const warning = '旧 Inbox 事务缺少团队共享授权，仅恢复本地效果。'; effect.warnings.push(warning); this.context.logger.warn(warning);
    }
    if (effect.teamAuthorized === true && this.context.mode === 'team') {
      const uploads = new UploadStore(this.context);
      for (const policy of effect.retiredPolicies) await uploads.withdrawPolicy(policy);
      const actual = await new ClaimStore(this.context).list();
      const staged = [...new Map([...effect.appliedClaims, ...effect.syncClaims ?? []].map((claim) => [claim.id, claim])).values()];
      await uploads.enqueue(staged.filter((claim) => actual.some((value) => sameClaim(value, claim))), effect.disputes, true);
    }
    effect.status = 'applied'; await this.write(effect);
    for (const member of effect.members) await new InboxStore(this.context).completeSnapshotLocked(member.message);
  }
}
