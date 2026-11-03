// prepared 保存固定实体与分析快照；恢复只补本地效果和队列，不再次调用模型。
import { z } from 'zod';
import type { StoreContext } from '../store/context.js';
import { readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { withFileLock } from '../store/lock.js';
import { DreamStore } from '../dream/checkpoint.js';
import { ClaimStore } from '../store/claims.js';
import { TraceStore } from '../store/traces.js';
import { DisputeStore } from '../store/disputes.js';
import { UploadStore } from '../store/uploads.js';
import { ClaimEditStore } from '../store/claim-edits.js';
import { ClaimSchema } from '../protocol/claim.js';
import { DisputeSchema } from '../protocol/dispute.js';
import { TraceSchema } from '../protocol/trace.js';
import { deriveTraceId } from '../protocol/ids.js';
import { nowSeconds } from '../protocol/time.js';
import { STALE_PLAN_WARNING, AnalysisChanged, analysisIsStale, claimChanges, observeApplied, sameClaim, ensureKnowledgeReady } from '../knowledge/alignment.js';
import { newDisputes } from '../knowledge/disputes.js';
import { StoreError } from '../store/errors.js';
import { JobError } from '../worker/types.js';
import type { Claim } from '../protocol/claim.js';
import type { JobControl } from '../worker/worker.js';
import type { PreparedFormation } from './prepare.js';
import { TranscriptStore, processedThrough } from './transcript.js';

export const CheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1), sessionId: z.string().regex(/^[a-zA-Z0-9_-]+$/), jobId: z.string().regex(/^[a-zA-Z0-9_-]+$/), kind: z.enum(['recap', 'finalize']),
  fromSeq: z.number().int().min(-1), untilSeq: z.number().int().nonnegative(), status: z.enum(['prepared', 'applied']),
  analysisClaims: z.array(ClaimSchema).nullable(), preparedClaims: z.array(ClaimSchema), appliedClaims: z.array(ClaimSchema),
  teamAuthorized: z.boolean().optional(), disputes: z.array(DisputeSchema), trace: TraceSchema.nullable(), warnings: z.array(z.string()),
});
export type FormationCheckpoint = z.infer<typeof CheckpointSchema>;
export class FormationStore {
  readonly transcript: TranscriptStore;
  constructor(readonly context: StoreContext) { this.transcript = new TranscriptStore(context); }
  async read(sessionId: string): Promise<FormationCheckpoint | null> {
    const checkpoint = await readYamlOr(this.context.paths.finalizeCheckpoint(sessionId), CheckpointSchema, () => null);
    if (checkpoint !== null && checkpoint.sessionId !== sessionId) throw new StoreError('decode', 'Checkpoint session differs from its directory.');
    return checkpoint;
  }
  private write(checkpoint: FormationCheckpoint): Promise<void> { return writeYamlAtomic(this.context.paths.finalizeCheckpoint(checkpoint.sessionId), checkpoint, CheckpointSchema, this.context.logger); }
  async recover(): Promise<void> {
    const ids = await this.transcript.sessions();
    // 无 checkpoint 时不争用全局知识锁。
    const pending = (await Promise.all(ids.map((id) => this.read(id)))).filter((value) => value !== null);
    if (pending.length === 0) return;
    await withFileLock(this.context.paths.knowledgeLock, () => this.recoverLocked(), { timeoutMs: this.context.lockTimeoutMs });
  }
  async recoverLocked(): Promise<void> {
    await new DreamStore(this.context).recoverLocked();
    for (const id of await this.transcript.sessions()) {
      const checkpoint = await this.read(id);
      if (checkpoint === null) continue;
      if (checkpoint.status === 'prepared') await this.applyLocked(checkpoint);
      else {
        const state = await this.transcript.state(id);
        if (processedThrough(state) < checkpoint.untilSeq || checkpoint.kind === 'finalize' && state.finalizedThroughSeq < checkpoint.untilSeq) await this.transcript.advance(id, checkpoint.kind, checkpoint.untilSeq);
      }
    }
  }
  async commit(input: { sessionId: string; jobId: string; kind: 'recap' | 'finalize'; fromSeq: number; untilSeq: number; analysisClaims: Claim[]; prepared: PreparedFormation; task: string }, control: JobControl): Promise<{ applied: boolean; warnings: string[]; claimCount: number; disputeCount: number; traceCount: number }> {
    return withFileLock(this.context.paths.knowledgeLock, async () => {
      await new DreamStore(this.context).recoverLocked();
      await ensureKnowledgeReady(this.context.paths.root);
      await new ClaimEditStore(this.context).recoverLocked();
      await this.recoverLocked();
      const state = await this.transcript.state(input.sessionId);
      if (processedThrough(state) >= input.untilSeq) return { applied: false, warnings: [], claimCount: 0, disputeCount: 0, traceCount: 0 };
      control.signal.throwIfAborted();
      const { claims, disputes, usedClaimIds, warnings } = input.prepared;
      // 尚未 prepared 时可以安全重新分析，不能消耗原对话区间来掩盖并发失效。
      if (claimChanges(input.analysisClaims, claims, [], await new ClaimStore(this.context).list()).length > 0) throw new AnalysisChanged();
      const createdAt = nowSeconds();
      const traceName = Array.from(input.task.split('\n').find((line) => line.trim()) ?? 'session_recap').slice(0, 60).join('');
      const existingTraces = new Set((await new TraceStore(this.context).list()).map((trace) => trace.id));
      let traceId = deriveTraceId(createdAt, traceName, usedClaimIds, claims.map((claim) => claim.id));
      for (let attempt = 0; existingTraces.has(traceId); attempt += 1) {
        if (attempt >= 7) throw new JobError('id_collision', 'Trace ID 冲突；请重试本次形成任务。');
        traceId = deriveTraceId(createdAt, traceName, usedClaimIds, claims.map((claim) => claim.id));
      }
      const trace = claims.length === 0 && usedClaimIds.length === 0 ? null : TraceSchema.parse({ id: traceId, name: traceName, task: input.task, agent: this.context.agentId, input_claims: usedClaimIds, output_claims: claims.map((claim) => claim.id), created_at: createdAt });
      const existingDisputes = await new DisputeStore(this.context).list();
      const uniqueDisputes = await newDisputes(this.context, disputes, existingDisputes);
      if (uniqueDisputes.some((dispute) => existingDisputes.some((value) => value.id === dispute.id))) throw new JobError('id_collision', 'Dispute ID 冲突；请重试本次形成任务。');
      const checkpoint = CheckpointSchema.parse({ schemaVersion: 1, sessionId: input.sessionId, jobId: input.jobId, kind: input.kind, fromSeq: input.fromSeq, untilSeq: input.untilSeq, status: 'prepared', teamAuthorized: this.context.mode === 'team', analysisClaims: input.analysisClaims, preparedClaims: claims, appliedClaims: [], disputes: uniqueDisputes, trace, warnings });
      // JS 同步边界先声明 prepared 所有权，取消与持久化开始只能一方获胜。
      control.signal.throwIfAborted(); control.prepared();
      await this.write(checkpoint);
      await this.applyLocked(checkpoint);
      return { applied: true, warnings: checkpoint.warnings, claimCount: checkpoint.appliedClaims.length, disputeCount: checkpoint.disputes.length, traceCount: checkpoint.trace === null ? 0 : 1 };
    }, { timeoutMs: this.context.lockTimeoutMs, signal: control.signal });
  }
  private async applyLocked(checkpoint: FormationCheckpoint): Promise<void> {
    await ensureKnowledgeReady(this.context.paths.root);
    const current = await new ClaimStore(this.context).list();
    observeApplied(checkpoint.preparedClaims, current, checkpoint.appliedClaims);
    if (analysisIsStale(checkpoint.analysisClaims, claimChanges(checkpoint.analysisClaims, checkpoint.preparedClaims, checkpoint.appliedClaims, current))) {
      if (checkpoint.preparedClaims.some((claim) => !checkpoint.appliedClaims.some((applied) => applied.id === claim.id)) || checkpoint.disputes.length > 0) {
        checkpoint.warnings.push(STALE_PLAN_WARNING); this.context.logger.warn(STALE_PLAN_WARNING);
      }
      checkpoint.preparedClaims = []; checkpoint.disputes = []; checkpoint.analysisClaims = current;
      await this.write(checkpoint);
    }
    const targets = [...checkpoint.preparedClaims].sort((a, b) => Number(a.status === 'deprecated') - Number(b.status === 'deprecated'));
    for (const claim of targets) if (!checkpoint.appliedClaims.some((applied) => applied.id === claim.id)) {
      await new ClaimStore(this.context).write(claim);
      checkpoint.appliedClaims.push(claim);
      await this.write(checkpoint);
    }
    if (checkpoint.trace !== null) {
      checkpoint.trace.output_claims = checkpoint.appliedClaims.map((claim) => claim.id);
      if (checkpoint.trace.output_claims.length > 0 || checkpoint.trace.input_claims.length > 0) await new TraceStore(this.context).write(checkpoint.trace);
    }
    for (const dispute of checkpoint.disputes) await new DisputeStore(this.context).write(dispute);
    // 队列也属于可恢复本地效果：先知识锁再上传锁，prepared 到 applied 之间不留补传缺口。
    if (checkpoint.teamAuthorized === undefined && this.context.mode === 'team') checkpoint.warnings.push('旧形成事务缺少团队共享授权，仅恢复本地效果。');
    if (checkpoint.teamAuthorized === true && this.context.mode === 'team') {
      const actual = await new ClaimStore(this.context).list();
      await new UploadStore(this.context).enqueue(checkpoint.appliedClaims.filter((claim) => actual.some((value) => sameClaim(value, claim))), checkpoint.disputes, true);
    }
    checkpoint.status = 'applied'; await this.write(checkpoint);
    await this.transcript.advance(checkpoint.sessionId, checkpoint.kind, checkpoint.untilSeq);
    for (const warning of checkpoint.warnings) this.context.logger.warn(warning);
  }
}
