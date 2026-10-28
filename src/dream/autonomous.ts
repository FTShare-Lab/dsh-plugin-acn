// 自主整理的工具事务与持久预算；模型循环由宿主提供，模型不能直接写知识文件。
import { z } from 'zod';
import type { AcnKnowledge } from '../knowledge/service.js';
import type { Job } from '../worker/types.js';
import { JobError } from '../worker/types.js';
import type { JobControl } from '../worker/worker.js';
import type { Claim } from '../protocol/claim.js';
import { ClaimIdSchema, TraceIdSchema } from '../protocol/ids.js';
import { TraceStore } from '../store/traces.js';
import { UploadStore } from '../store/uploads.js';
import { sameClaim } from '../knowledge/alignment.js';
import { claimInput } from './candidates.js';
import { CandidateSchema, DraftGroupSchema, HashSchema, KeepReasonSchema, KeySchema, ProgressSchema, ReviewSummarySchema, SemanticReviewSchema, requireDream } from './schema.js';
import type { Progress, Candidate } from './schema.js';
import { expandDraft, prepareGroup, reviewInput, sameIds, validateCandidates } from './plan.js';
import { EvidenceStore, ReadArgs, GlobArgs, GrepArgs } from './evidence-store.js';
import { DreamSync } from './sync.js';

const groupId = { group_id: KeySchema };
export const DreamTools = {
  dream_record_candidates: z.strictObject({ candidates: z.array(CandidateSchema).min(1) }),
  dream_stage_group: z.strictObject({ ...groupId, group: DraftGroupSchema.nullable() }),
  dream_validate: z.strictObject(groupId),
  dream_apply_group: z.strictObject({ ...groupId, validation_id: HashSchema, review: SemanticReviewSchema }),
  dream_keep_candidate: z.strictObject({ ...groupId, reason_kind: KeepReasonSchema, reason: z.string().min(1) }),
  dream_read_draft: z.strictObject({ group_id: KeySchema.optional() }),
  dream_read_history: z.strictObject({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(10).default(5) }),
  dream_review_sync: z.strictObject({ source_id: ClaimIdSchema, carrier_ids: z.array(ClaimIdSchema).min(1), validation_id: HashSchema.optional(), review: SemanticReviewSchema.optional() }),
  dream_finish: z.strictObject({ review: ReviewSummarySchema }),
  read_claim: z.strictObject({ id: ClaimIdSchema }),
  read_trace: z.strictObject({ id: TraceIdSchema, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(8000).default(4000) }),
  file_read: ReadArgs,
  file_glob: GlobArgs,
  file_grep: GrepArgs,
};
export type DreamTool = keyof typeof DreamTools;
export const isDreamTool = (name: string): name is DreamTool => Object.hasOwn(DreamTools, name);
export class DreamSession {
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(readonly knowledge: AcnKnowledge, readonly job: Job, readonly control: JobControl, readonly progress: Progress, private readonly claims: Claim[], readonly workspace: string, private readonly boundary: () => Promise<void>) {}
  static async create(knowledge: AcnKnowledge, job: Job, control: JobControl, boundary: () => Promise<void>): Promise<DreamSession> {
    const store = knowledge.dreamStore(); const origin = await store.origin(job.id);
    requireDream(origin?.workspace_root !== undefined, '缺少 Dream 工作区快照。');
    const progress = await store.progress(job.id) ?? ProgressSchema.parse({ schemaVersion: 1, discovery: { review: { quality: '尚未检查', evidence: '尚未探索', consolidation: '尚未检查' }, candidates: [], sync_candidates: [] }, entries: [], syncCompleted: [], finished: false, summary: null });
    const input = claimInput(origin.claims.filter((claim) => claim.status !== 'deprecated'));
    // 旧额度批次只作历史信息；恢复和手动触发都不得重置同一任务的额度。
    if (progress.autonomy === undefined) progress.autonomy = { steps: 0, epoch: 0, limit: knowledge.config.dream.maxModelSteps, read_ids: input.loaded.map((claim) => claim.id) };
    const claims = [...origin.claims];
    // 已完成组按版本时间恢复到最新自身写入，不把并发外部修改当作新的授权。
    for (const { checkpoint } of await store.records(job.id)) for (const group of checkpoint.groups.filter((item) => item.completed && !item.skipped)) for (const after of group.after) {
      const index = claims.findIndex((claim) => claim.id === after.id); const previous = claims[index];
      if (index >= 0 && previous !== undefined && Date.parse(after.updated_at ?? after.created_at) >= Date.parse(previous.updated_at ?? previous.created_at)) claims[index] = after;
    }
    for (const entry of progress.entries.filter((item) => item.status === 'pending')) {
      const record = (await store.records(job.id)).find(({ checkpoint }) => checkpoint.operation?.group_id === entry.candidate.group_id && checkpoint.applied);
      if (record !== undefined) { entry.status = record.checkpoint.groups.some((group) => group.skipped) ? 'skipped' : 'executed'; entry.reason = '从持久执行回执恢复。'; }
    }
    if ((await store.final(job.id))?.applied) progress.finished = true;
    await store.saveProgress(job.id, progress);
    return new DreamSession(knowledge, job, control, progress, claims, origin.workspace_root, boundary);
  }
  get finished(): boolean { return this.progress.finished; }
  get exhausted(): boolean { const budget = this.progress.autonomy; return budget !== undefined && budget.steps >= budget.limit; }
  get wrappingUp(): boolean { return this.progress.autonomy?.wrap_up !== undefined; }
  budgetNotice(): string {
    const budget = this.progress.autonomy; if (budget === undefined) return '';
    return `Dream 运行额度：\n${JSON.stringify({ budget, phase: this.wrappingUp ? 'wrap_up' : 'exploration', instruction: this.wrappingUp
      ? '探索额度已用尽，现在进行本次 Dream 的有限收尾。禁止发现新候选、读取新证据或启动同步复核；只可完成已登记项的草稿、校验与提交，或保留原样。立即用 dream_finish 总结真实覆盖和未完成事项，剩余 pending 将记为未完成并丢弃未提交草稿。本次结束后不会再次续做；不为赶结束跳过校验。'
      : '按剩余额度安排探索；完成时调用 dream_finish，不把未执行事项写成已完成。' })}`;
  }
  async admitStep(signal?: AbortSignal): Promise<void> {
    this.control.signal.throwIfAborted(); signal?.throwIfAborted(); await this.boundary(); requireDream(!this.finished, 'Dream 已结束。');
    const budget = this.progress.autonomy; requireDream(budget !== undefined, '缺少持久轮数预算。');
    if (this.exhausted) {
      budget.wrap_up ??= { steps: 0, limit: this.knowledge.config.dream.maxWrapUpSteps };
      if (budget.wrap_up.steps >= budget.wrap_up.limit) { await this.finishBudget(signal); throw new JobError('dream_finished', 'Dream 已按额度收尾结束。'); }
      budget.wrap_up.steps += 1;
    } else budget.steps += 1;
    // 先记账再调用模型：崩溃、抢占和自动重试不能退还已经准入的轮数。
    await this.save(); signal?.throwIfAborted();
  }
  async finishBudget(signal?: AbortSignal): Promise<void> {
    if (this.finished) return;
    requireDream(this.exhausted, '尚未耗尽探索额度。');
    const control = { ...this.control, signal: signal === undefined ? this.control.signal : AbortSignal.any([this.control.signal, signal]) };
    control.signal.throwIfAborted();
    const review = Object.fromEntries((['quality', 'evidence', 'consolidation'] as const).map((kind) => {
      const entries = this.progress.entries.filter((entry) => entry.candidate.kind === kind);
      return [kind, `模型未提交收尾总结，插件按持久记录终结本次：${entries.filter((entry) => entry.status === 'executed').length} 项已执行，${entries.filter((entry) => entry.status === 'kept').length} 项明确保留，${entries.filter((entry) => entry.status === 'pending' || entry.status === 'skipped').length} 项未完成或跳过。未检查范围不能视作已验证；详见逐项回执。`];
    }));
    await this.finish(ReviewSummarySchema.parse(review), control);
  }
  private async finish(review: z.infer<typeof ReviewSummarySchema>, control: JobControl): Promise<unknown> {
    if (this.exhausted) for (const entry of this.progress.entries.filter((item) => item.status === 'pending')) {
      entry.status = 'skipped'; entry.reason = '本次额度已用尽，收尾时仍未完成；丢弃未提交草稿，不代表知识无效。'; entry.draft = null; entry.validation = null; entry.review = null;
    }
    requireDream(this.progress.entries.every((entry) => entry.status !== 'pending'), '仍有候选待处理。');
    this.progress.discovery.review = review; await this.save();
    const checkpoint = await this.knowledge.dreamStore().finish(this.job.id, this.progress, control); control.committed?.(); this.progress.finished = true; await this.save();
    return { finished: true, updatedClaimIds: Object.keys(checkpoint.self_versions), budget_limited: this.exhausted };
  }
  private save(): Promise<void> { return this.knowledge.dreamStore().saveProgress(this.job.id, this.progress); }
  private current(groupId?: string) {
    const entry = this.progress.entries.find((item) => item.status === 'pending');
    requireDream(entry !== undefined && (groupId === undefined || entry.candidate.group_id === groupId), '请先处理 candidate_progress.current；不能跳过当前候选或重放已执行组。'); return entry;
  }
  private readable(): Claim[] { return this.claims.filter((claim) => this.progress.autonomy?.read_ids.includes(claim.id)); }
  private candidateProgress() { return { current: this.progress.entries.find((entry) => entry.status === 'pending')?.candidate ?? null, entries: this.progress.entries.map(({ candidate, status, reason }) => ({ ...candidate, status, reason })) }; }
  async input(): Promise<object> {
    const store = this.knowledge.dreamStore(); const origin = await store.origin(this.job.id);
    return { workspace_root: this.workspace, dream_context: { agent_id: this.knowledge.agentId, snapshot_at: origin?.snapshot_at, eligibility: this.claims.map((claim) => ({ id: claim.id, owned: true, evidence_eligible: origin?.claims.some((original) => original.id === claim.id && original.confidence !== 'high') && claim.status !== 'deprecated' })) }, claims: this.readable(), coverage: origin?.coverage,
      claim_catalog: this.claims.filter((claim) => !this.progress.autonomy?.read_ids.includes(claim.id)).map(({ id, name, scope, status }) => ({ id, name, scope, status })),
      policy_context: { available: false, complete: false }, pending_consolidation_sync: (await new UploadStore(this.knowledge.context()).read()).consolidations ?? [],
      capabilities: { evidence_calibration: this.knowledge.config.dream.evidenceCalibration, shell: false, evidence_limits: { calls_per_group: this.knowledge.config.dream.evidenceMaxCalls, bytes_per_group: this.knowledge.config.dream.evidenceMaxBytes } },
      budget: this.progress.autonomy, authoritative_state: { candidate_progress: this.candidateProgress(), drafts: this.progress.entries.filter((entry) => entry.status === 'pending'), executions: (await store.records(this.job.id)).map(({ checkpoint }) => ({ operation: checkpoint.operation, groups: checkpoint.groups })), evidence: await this.evidenceState() } };
  }
  private async evidenceState(): Promise<object> { return Object.fromEntries(await Promise.all(this.progress.entries.filter((entry) => entry.status === 'pending').map(async (entry) => [entry.candidate.group_id, await new EvidenceStore(this.knowledge.context(), this.job.id, entry.candidate.group_id).read()] as const))); }
  private register(candidate: Candidate): void {
    requireDream(candidate.group_id !== '_discovery', '该组名为宿主只读探索保留，请使用其他 group_id。');
    const prior = this.progress.entries.find((entry) => entry.candidate.group_id === candidate.group_id);
    if (prior !== undefined) { requireDream(prior.status === 'pending' && sameIds(prior.candidate.claim_ids, candidate.claim_ids) && prior.candidate.kind === candidate.kind, '不能更换已登记组的目标或种类。'); return; }
    validateCandidates([candidate], this.readable(), this.knowledge.context().agentId, this.knowledge.config.dream.evidenceCalibration);
    requireDream(!this.progress.entries.some((entry) => entry.status === 'pending' && entry.candidate.claim_ids.some((id) => candidate.claim_ids.includes(id))), '待处理候选不能重叠；先处理已有组。');
    this.progress.discovery.candidates.push(candidate); this.progress.entries.push({ candidate, status: 'pending', reason: '', draft: null, validation: null, review: null });
  }
  execute(name: DreamTool, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const control = { ...this.control, signal: signal === undefined ? this.control.signal : AbortSignal.any([this.control.signal, signal]) };
    const result = this.pending.then(async () => { control.signal.throwIfAborted(); await this.boundary(); control.signal.throwIfAborted(); requireDream(!this.finished, 'Dream 已结束。'); return this.dispatch(name, args, control); });
    this.pending = result.catch(() => {}); return result;
  }
  private async dispatch(name: DreamTool, args: unknown, control: JobControl): Promise<unknown> {
    if (this.wrappingUp) requireDream(!['dream_record_candidates', 'file_read', 'file_glob', 'file_grep', 'read_trace', 'dream_review_sync'].includes(name), '已进入有限收尾；不能展开新探索，请处理已有候选或调用 dream_finish。');
    if (name === 'dream_record_candidates') { const input = DreamTools[name].parse(args); for (const candidate of input.candidates) this.register(candidate); await this.save(); }
    else if (name === 'read_claim') {
      const { id } = DreamTools[name].parse(args); const claim = this.claims.find((claim) => claim.id === id); requireDream(claim !== undefined, '只可读取本轮冻结的自有 Claim。');
      const current = (await this.knowledge.snapshot()).claims.find((value) => value.id === id); requireDream(current !== undefined && sameClaim(current, claim), 'Claim 已被外部修改，本轮请保留该项。');
      if (!this.progress.autonomy?.read_ids.includes(id)) this.progress.autonomy?.read_ids.push(id); await this.save(); return claim;
    } else if (name === 'read_trace') {
      const input = DreamTools[name].parse(args); const trace = await new TraceStore(this.knowledge.context()).read(input.id);
      requireDream(trace !== null && trace.agent === this.knowledge.agentId && [...trace.input_claims, ...trace.output_claims].some((id) => this.readable().some((claim) => claim.id === id)), '只可读取本轮已读 Claim 关联的本地自身 Trace。');
      const chars = Array.from(JSON.stringify(trace)); return { content: chars.slice(input.offset, input.offset + input.limit).join(''), total_chars: chars.length, truncated: input.offset > 0 || input.offset + input.limit < chars.length, independent_evidence: false };
    } else if (name === 'file_read' || name === 'file_glob' || name === 'file_grep') {
      // 发现候选前也可定位文件；真正的证据读取仍绑定已登记的当前候选。
      const entry = name === 'file_read' ? this.current() : undefined;
      const original = await this.knowledge.dreamStore().origin(this.job.id);
      const eligible = entry === undefined ? (original?.claims ?? []).filter((claim) => claim.confidence !== 'high' && claim.status !== 'deprecated')
        : this.readable().filter((claim) => entry.candidate.claim_ids.includes(claim.id) && original?.claims.some((input) => input.id === claim.id && input.confidence !== 'high') && claim.status !== 'deprecated');
      const evidence = new EvidenceStore(this.knowledge.context(), this.job.id, entry?.candidate.group_id ?? '_discovery');
      await evidence.initialize(this.workspace, eligible, this.knowledge.config.dream, control.signal);
      await evidence.reopen(control.signal);
      return evidence.execute(name === 'file_read' ? 'read' : name === 'file_glob' ? 'glob' : 'grep', DreamTools[name].parse(args), eligible, control.signal);
    } else if (name === 'dream_stage_group') {
      const input = DreamTools[name].parse(args);
      if (input.group !== null && !this.progress.entries.some((entry) => entry.candidate.group_id === input.group_id)) {
        requireDream(!this.wrappingUp, '收尾阶段不能新增候选。');
        requireDream(!this.progress.entries.some((entry) => entry.status === 'pending'), '先处理当前候选。');
        this.register({ group_id: input.group_id, claim_ids: input.group.operations.map((op) => op.id), kind: input.group.kind, reason: input.group.reason });
      }
      const entry = this.current(input.group_id);
      if (input.group === null) { entry.draft = null; entry.validation = null; entry.review = null; await this.save(); }
      else {
        requireDream(input.group.kind === entry.candidate.kind && sameIds(input.group.operations.map((op) => op.id), entry.candidate.claim_ids), '草稿必须包含当前候选全部且仅这些 ID 与 kind。');
        const group = expandDraft(input.group, this.readable()); const receipts = z.record(z.string(), z.json()).parse((await new EvidenceStore(this.knowledge.context(), this.job.id, input.group_id).read())?.receipts ?? {});
        prepareGroup(group, this.readable(), this.knowledge.context().agentId, undefined, { enabled: this.knowledge.config.dream.evidenceCalibration, receipts, semanticReview: true });
        entry.draft = group; entry.validation = null; entry.review = null; await this.save();
      }
    } else if (name === 'dream_validate') {
      const input = DreamTools[name].parse(args); const entry = this.current(input.group_id); requireDream(entry.draft !== null, '请先暂存完整草稿。');
      const receipts = z.record(z.string(), z.json()).parse((await new EvidenceStore(this.knowledge.context(), this.job.id, input.group_id).read())?.receipts ?? {});
      prepareGroup(entry.draft, this.readable(), this.knowledge.context().agentId, undefined, { enabled: this.knowledge.config.dream.evidenceCalibration, receipts, semanticReview: true });
      entry.validation = reviewInput(input.group_id, entry.draft, this.readable(), receipts); await this.save(); return entry.validation;
    } else if (name === 'dream_apply_group') {
      const input = DreamTools[name].parse(args); const entry = this.current(input.group_id);
      requireDream(entry.draft !== null && entry.validation !== null && input.validation_id === entry.validation.validation_id, '缺少当前草稿版本的 validate，请重新校验。');
      const evidence = new EvidenceStore(this.knowledge.context(), this.job.id, input.group_id); if (await evidence.read() !== null) await evidence.complete(control.signal);
      const checkpoint = await this.knowledge.applyDreamGroup(this.job.id, input.group_id, entry.draft, entry.validation, input.review, null, control); control.committed?.();
      entry.status = checkpoint.groups.some((group) => group.skipped) ? 'skipped' : 'executed'; entry.reason = entry.status === 'executed' ? '已按逐 Claim 语义复核提交。' : '外部版本或证据变化，未继续旧修改。';
      entry.review = { decision: 'apply', reason: entry.reason, reason_kind: 'useful_knowledge', semantic: input.review, self_review: null };
      if (entry.status === 'executed') for (const after of checkpoint.groups.flatMap((group) => group.after)) { const index = this.claims.findIndex((claim) => claim.id === after.id); if (index >= 0) this.claims[index] = after; }
      await this.save(); return { executed: entry.status === 'executed', candidate_progress: this.candidateProgress(), changes: checkpoint.groups };
    } else if (name === 'dream_keep_candidate') {
      const input = DreamTools[name].parse(args); const entry = this.current(input.group_id);
      requireDream(input.reason_kind !== 'no_consolidation_benefit' || entry.candidate.kind === 'consolidation', 'no_consolidation_benefit 仅适用于 C。');
      entry.status = 'kept'; entry.reason = `${input.reason_kind}: ${input.reason}`; entry.draft = null; entry.validation = null; await this.save();
    } else if (name === 'dream_read_draft') {
      const input = DreamTools[name].parse(args); return { candidate_progress: this.candidateProgress(), drafts: this.progress.entries.filter((entry) => input.group_id === undefined ? entry.status === 'pending' : entry.candidate.group_id === input.group_id), budget: this.progress.autonomy };
    } else if (name === 'dream_read_history') {
      const input = DreamTools[name].parse(args); const records = await this.knowledge.dreamStore().records(this.job.id); return { records: records.slice(input.offset, input.offset + input.limit).map(({ checkpoint }) => checkpoint), total: records.length };
    } else if (name === 'dream_review_sync') {
      const input = DreamTools[name].parse(args); const sync = new DreamSync(this.knowledge.context(), true); const validation = await sync.prepare(input.source_id, input.carrier_ids, control.signal);
      if (input.review === undefined) return validation;
      requireDream(input.validation_id === validation.validation_id, '同步依赖版本已变化，请重新读取并复核。');
      await sync.apply(this.job.id, validation, input.review, control.signal); return { synchronized: input.source_id };
    } else if (name === 'dream_finish') {
      return this.finish(DreamTools[name].parse(args).review, control);
    }
    return { candidate_progress: this.candidateProgress(), budget: this.progress.autonomy };
  }
}
