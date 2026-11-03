// 共享 worker 顺序处理持久候选、草稿、复核和提交；停止与让位均保留已接受进度。
import { z } from 'zod';
import { DreamSession } from './autonomous.js';
import fs from 'node:fs/promises';
import type { Claim } from '../protocol/claim.js';
import type { ResolvedConfig } from '../config.js';
import type { Route } from '../formation/transcript.js';
import type { AcnKnowledge } from '../knowledge/service.js';
import { resolveRoute, structuredCall } from '../llm/structured.js';
import type { StructuredBackend, StructuredPhase } from '../llm/structured.js';
import type { Job } from '../worker/types.js';
import { JobError, DreamStopped, DreamYield, jobPriority } from '../worker/types.js';
import type { JobControl } from '../worker/worker.js';
import { nowSeconds } from '../protocol/time.js';
import { KnowledgeBusy, sameClaim } from '../knowledge/alignment.js';
import { LockTimeoutError } from '../store/errors.js';
import { UploadDelivery } from '../upload/deliver.js';
import { UploadStore } from '../store/uploads.js';
import { DiscoverySchema, DraftResponseSchema, ProgressSchema, ReviewResponseSchema, SemanticReviewSchema, requireDream, DreamValidationError } from './schema.js';
import type { Progress, Validation } from './schema.js';
import { claimInput, dreamEligible, INPUT_TOKENS, conservativeTokens } from './candidates.js';
import { expandDraft, validateCandidates, prepareGroup, reviewInput, sameIds } from './plan.js';
import { validateSelfReview, validateSemanticReview } from './review.js';
import { DreamSync } from './sync.js';
import { EvidenceStore } from './evidence-store.js';
import type { Receipts } from './evidence.js';
import { validateEvidencePreservation } from './preservation.js';

const SummarySchema = z.strictObject({ checked: z.string(), findings: z.string(), uncertainties: z.string(), next_steps: z.string() });
export type EvidenceExplorer = (input: { store: EvidenceStore; claims: readonly Claim[]; route: Route; config: ResolvedConfig['llm']; signal: AbortSignal }) => Promise<void>;
export type AutonomousDreamRunner = (input: { session: DreamSession; route: Route; config: ResolvedConfig['llm']; system: string; signal: AbortSignal }) => Promise<void>;
export interface DreamOptions { workspace?: () => Promise<string>; explore?: EvidenceExplorer; run?: AutonomousDreamRunner }
export class AcnDream {
  private readonly unregister: () => void;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private eligibilityRetry: ReturnType<typeof setTimeout> | undefined;
  private pending = Promise.resolve(); private stopped = false; private closed = false;
  private active: Promise<Job['result']> | undefined;
  constructor(readonly knowledge: AcnKnowledge, private readonly backend: StructuredBackend, private readonly render: (name: string, context: object) => string, private readonly beforeCall?: () => Promise<void>, private readonly options: DreamOptions = {}) {
    const worker = knowledge.jobs; if (worker === null) throw new JobError('unconfigured', '请先配置 agentId。');
    this.unregister = knowledge.config.dream.enabled ? worker.register('dream', async (job, control) => {
      const run = this.run(job, control); this.active = run;
      try { return await run; } finally { if (this.active === run) this.active = undefined; }
    }) : () => {};
  }
  async start(): Promise<void> {
    const worker = this.knowledge.jobs; if (worker === null) return;
    if (!this.knowledge.config.dream.enabled) { await worker.queue.pauseDream(true); return; }
    await worker.queue.pauseDream(false); worker.wake(true); await this.check(); this.schedule();
  }
  private schedule(): void {
    const deadline = Date.now() + this.knowledge.config.dream.checkIntervalHours * 3_600_000;
    const wait = () => {
      if (this.closed) return; const remaining = deadline - Date.now();
      if (remaining > 0) { const timer = setTimeout(() => { this.timers.delete(timer); wait(); }, Math.min(remaining, 2_147_483_647)); timer.unref(); this.timers.add(timer); }
      else { this.trigger(); this.schedule(); }
    }; wait();
  }
  trigger(): void { this.pending = this.pending.then(() => this.check()).catch(() => { this.knowledge.logger.warn('Dream eligibility check could not complete; the next trigger will retry.'); }); }
  async flush(): Promise<void> { await this.pending; }
  async check(): Promise<void> {
    if (this.closed || this.stopped || !this.knowledge.config.dream.enabled) return;
    const worker = this.knowledge.jobs; if (worker === null || (await worker.queue.list()).some((job) => job.kind === 'dream' && (job.state === 'queued' || job.state === 'running'))) return;
    const eligible = await this.eligible(false);
    if (this.closed || this.stopped) return;
    if (eligible === null) {
      // 一次提交争用不能推迟整个检查周期；只保留一个短重试，关闭时由 timers 统一清理。
      if (this.eligibilityRetry === undefined) {
        const timer = setTimeout(() => { this.timers.delete(timer); this.eligibilityRetry = undefined; this.trigger(); }, 1000);
        timer.unref(); this.timers.add(timer); this.eligibilityRetry = timer;
      }
    } else if (eligible) await worker.enqueue('dream', { manual: false, workspace_root: await this.workspace() });
  }
  private async eligible(manual: boolean): Promise<boolean | null> {
    try {
      const snapshot = await this.knowledge.snapshot(undefined, 0);
      return dreamEligible(this.knowledge.config.dream, await this.knowledge.dreamStore().state(), snapshot.claims, this.knowledge.context().agentId, manual);
    } catch (error) { if (error instanceof KnowledgeBusy || error instanceof LockTimeoutError) return null; throw error; }
  }
  private async workspace(input?: string): Promise<string> { return fs.realpath(input ?? await this.options.workspace?.() ?? process.cwd()); }
  async request(workspace?: string, sessionId?: string): Promise<Job> {
    if (!this.knowledge.config.dream.enabled) throw new JobError('disabled', 'Dream 已关闭，请先启用 dream.enabled。');
    const worker = this.knowledge.jobs; if (worker === null) throw new JobError('unconfigured', '请先配置 agentId。');
    this.stopped = false; const pending = await worker.queue.pauseDream(false); worker.wake(true);
    if (pending[0] !== undefined) return pending[0];
    // 预检遇忙不阻塞手动入队；worker 在可取消的初始快照锁内重检资格，不使用半批知识。
    if (await this.eligible(true) === false) throw new JobError('empty', '没有可整理的自身 active/stale Claim。');
    return worker.enqueue('dream', { manual: true, workspace_root: await this.workspace(workspace) }, sessionId);
  }
  async stop(): Promise<number> { this.stopped = true; if (this.eligibilityRetry !== undefined) { clearTimeout(this.eligibilityRetry); this.timers.delete(this.eligibilityRetry); this.eligibilityRetry = undefined; } const worker = this.knowledge.jobs; if (worker === null) return 0; const jobs = await worker.queue.pauseDream(true); worker.cancelDream(new DreamStopped()); return jobs.length; }
  private async boundary(job: Job, control: JobControl): Promise<void> {
    control.signal.throwIfAborted();
    const jobs = await this.knowledge.jobs?.queue.list() ?? [];
    if (jobs.some((current) => current.id === job.id && current.payload['paused'] === true)) throw new DreamStopped();
    if (jobs.some((job) => this.knowledge.jobs?.canRun(job) && jobPriority[job.kind] < jobPriority.dream)) throw new DreamYield();
  }
  private async call<T>(job: Job, control: JobControl, phase: StructuredPhase, data: object, schema: z.ZodType<T>, parse: (value: T) => T = (value) => value, systemName = 'claim_dream_legacy.j2'): Promise<T> {
    await this.boundary(job, control); await this.beforeCall?.(); const route = await resolveRoute(this.knowledge.config.llm, this.knowledge.context());
    return structuredCall({ backend: this.backend, context: this.knowledge.context(), config: this.knowledge.config.llm, route, jobId: job.id, phase, system: this.render(systemName, {}), input: JSON.stringify({ phase, ...data }), schema, parse: (value) => parse(schema.parse(value)), signal: control.signal });
  }
  private async run(job: Job, control: JobControl): Promise<Job['result']> {
    const store = this.knowledge.dreamStore(); await store.recover(); await this.boundary(job, control);
    let origin = await store.origin(job.id);
    if (origin === null) {
      const claims = (await this.knowledge.dreamSnapshot(control.signal)).filter((claim) => claim.holder === this.knowledge.agentId);
      if (!dreamEligible(this.knowledge.config.dream, await store.state(), claims, this.knowledge.context().agentId, job.payload['manual'] === true)) return { skipped: 'not_eligible' };
      const input = claimInput(claims.filter((claim) => claim.status !== 'deprecated')); origin = { snapshot_at: nowSeconds(), claims, coverage: input.coverage, workspace_root: await this.workspace(typeof job.payload['workspace_root'] === 'string' ? job.payload['workspace_root'] : undefined) };
      await store.saveOrigin(job.id, origin);
    }
    // 宿主使用自主工具会话；旧固定阶段入口保留用于旧协议适配器与恢复测试。
    if (this.options.run !== undefined) {
      const session = await DreamSession.create(this.knowledge, job, control, () => this.boundary(job, control));
      if (!session.finished) {
        await this.beforeCall?.();
        await this.options.run({ session, route: await resolveRoute(this.knowledge.config.llm, this.knowledge.context()), config: this.knowledge.config.llm, system: this.render('claim_dream.j2', {}), signal: control.signal });
        requireDream(session.finished, '自主 Dream 尚未完成。');
      }
      await new UploadDelivery(this.knowledge.context(), this.knowledge.team).deliver(control.signal);
      return { updatedClaimIds: [...new Set((await store.records(job.id)).flatMap(({ checkpoint }) => Object.keys(checkpoint.self_versions)))], modelSteps: session.progress.autonomy?.steps ?? 0, wrapUpSteps: session.progress.autonomy?.wrap_up?.steps ?? 0, budgetLimited: session.exhausted, incompleteCandidates: session.progress.entries.filter((entry) => entry.status === 'skipped').map((entry) => ({ groupId: entry.candidate.group_id, claimIds: entry.candidate.claim_ids, reason: entry.reason ?? '' })), report: 'Dream report.md 已保存。' };
    }
    const loaded = claimInput(origin.claims.filter((claim) => claim.status !== 'deprecated')).loaded;
    const evidenceEnabled = this.knowledge.config.dream.evidenceCalibration && this.options.explore !== undefined && origin.workspace_root !== undefined;
    let progress = await store.progress(job.id);
    if (progress === null) {
      const discovery = await this.call(job, control, 'candidates', { dream_context: { agent_id: this.knowledge.agentId, snapshot_at: origin.snapshot_at, trigger: job.payload['manual'] === true ? 'manual' : 'automatic' }, claims: loaded, coverage: origin.coverage, policy_context: { available: false, complete: false }, pending_consolidation_sync: (await new UploadStore(this.knowledge.context()).read()).consolidations ?? [], evidence_calibration: { available: evidenceEnabled, tools: evidenceEnabled ? ['read', 'grep', 'glob', 'claim(list/read)'] : [], high_excluded: true } }, DiscoverySchema, (value) => { validateCandidates(value.candidates, loaded, this.knowledge.context().agentId, evidenceEnabled); requireDream(new Set(value.sync_candidates.map((item) => item.source_id)).size === value.sync_candidates.length, '同步候选来源不能重复。'); return value; });
      progress = ProgressSchema.parse({ schemaVersion: 1, discovery, entries: discovery.candidates.map((candidate) => ({ candidate, status: 'pending', reason: '', draft: null, validation: null, review: null })), syncCompleted: [], finished: false, summary: null }); await store.saveProgress(job.id, progress);
    }
    await this.compact(job, control, progress);
    for (const entry of progress.entries) {
      if (entry.status !== 'pending') continue; await this.boundary(job, control);
      const previous = (await store.records(job.id)).find((record) => record.checkpoint.operation?.group_id === entry.candidate.group_id);
      if (previous?.checkpoint.applied) { entry.status = previous.checkpoint.groups.some((group) => group.skipped) ? 'skipped' : 'executed'; entry.reason = entry.status === 'skipped' ? '外部版本变化，旧方案未继续。' : '从已持久执行回执恢复，未重放模型。'; await store.saveProgress(job.id, progress); continue; }
      const before = loaded.filter((claim) => entry.candidate.claim_ids.includes(claim.id)); const current = (await this.knowledge.snapshot()).claims;
      if (!before.every((claim) => current.some((value) => sameClaim(value, claim)))) { entry.status = 'skipped'; entry.reason = '分析后 Claim 已被外部修改，本候选保留当前版本。'; await store.saveProgress(job.id, progress); continue; }
      let receipts: Receipts = {};
      let evidenceStore: EvidenceStore | undefined;
      if (entry.candidate.kind === 'evidence') {
        if (!evidenceEnabled || origin.workspace_root === undefined || this.options.explore === undefined) { entry.status = 'kept'; entry.reason = '证据校准已关闭或受限子会话不可用，保持原样。'; await store.saveProgress(job.id, progress); continue; }
        const evidence = new EvidenceStore(this.knowledge.context(), job.id, entry.candidate.group_id);
        evidenceStore = evidence;
        let manifest = await evidence.initialize(origin.workspace_root, before, this.knowledge.config.dream, control.signal);
        if (!await evidence.current(manifest)) { entry.status = 'skipped'; entry.reason = '查证文件版本已变化，本组保持原样；不会重用旧证据授权。'; await store.saveProgress(job.id, progress); continue; }
        if (!manifest.completed) {
          await this.boundary(job, control); await this.beforeCall?.();
          await this.options.explore({ store: evidence, claims: before, route: await resolveRoute(this.knowledge.config.llm, this.knowledge.context()), config: this.knowledge.config.llm, signal: control.signal });
          await this.boundary(job, control); await evidence.complete(control.signal); manifest = await evidence.read() ?? manifest;
        }
        receipts = z.record(z.string(), z.json()).parse(manifest.receipts);
        if (manifest.model_steps >= manifest.limits.steps && Object.keys(receipts).length === 0) { entry.status = 'kept'; entry.reason = '查证模型轮数已耗尽且未取得直接证据，保持原样。'; await store.saveProgress(job.id, progress); continue; }
      }
      let repairs = 0;
      while (entry.status === 'pending') {
        await this.boundary(job, control);
        // 旧版本尚未 prepared 的草稿按新约束重起草；已 prepared 的固定提交由存储恢复完成。
        if (entry.validation !== null) {
          try { validateEvidencePreservation(entry.validation.input); }
          catch (error) {
            if (!(error instanceof DreamValidationError)) throw error;
            entry.reason = error.message; entry.draft = null; entry.validation = null; entry.review = null;
            await store.saveProgress(job.id, progress);
          }
        }
        if (evidenceStore !== undefined) { const manifest = await evidenceStore.read(); requireDream(manifest !== null, '查证清单丢失。'); if (!await evidenceStore.current(manifest)) { entry.status = 'skipped'; entry.reason = '查证材料已改变；不复用旧验证或复核授权。'; await store.saveProgress(job.id, progress); break; } }
        if (entry.draft === null || entry.validation === null) {
          const proposed = await this.call(job, control, 'draft', { candidate: entry.candidate, before, evidence: receipts, coverage: origin.coverage, review_summary: progress.discovery.review, prior_feedback: entry.reason, prior_summary: progress.summary }, DraftResponseSchema, (value) => {
            if (value.action === 'keep') { requireDream(value.reason_kind !== 'no_consolidation_benefit' || entry.candidate.kind === 'consolidation', 'no_consolidation_benefit 仅用于整合。'); return value; }
            requireDream(value.group.kind === entry.candidate.kind && sameIds(value.group.operations.map((operation) => operation.id), entry.candidate.claim_ids), '草稿必须处理当前候选的全部且仅这些 ID 与 kind。');
            prepareGroup(expandDraft(value.group, before), loaded, this.knowledge.context().agentId, nowSeconds(), { enabled: evidenceEnabled, receipts }); return value;
          });
          await store.archive(job.id, `${entry.candidate.group_id}-draft-${repairs}`, proposed);
          if (proposed.action === 'keep') { entry.status = 'kept'; entry.reason = `${proposed.reason_kind}: ${proposed.reason}`; await store.saveProgress(job.id, progress); break; }
          entry.draft = expandDraft(proposed.group, before); entry.validation = reviewInput(entry.candidate.group_id, entry.draft, before, receipts); entry.review = null; await store.saveProgress(job.id, progress);
        }
        const validation: Validation = entry.validation;
        const reviewed = await this.call(job, control, 'review', { candidate: entry.candidate, validation, draft: entry.draft, before, review_summary: progress.discovery.review, prior_feedback: entry.reason, prior_summary: progress.summary }, ReviewResponseSchema, (value) => {
          if (value.decision !== 'apply') return value;
          requireDream(value.semantic !== null && value.self_review !== null, '执行前必须同时给出逐 Claim 语义复核与双向全文引用复核。'); validateSelfReview(validation, value.self_review); validateSemanticReview(validation, value.semantic); return value;
        });
        entry.review = reviewed; await store.saveProgress(job.id, progress);
        if (reviewed.decision === 'keep') { entry.status = 'kept'; entry.reason = `${reviewed.reason_kind}: ${reviewed.reason}`; await store.saveProgress(job.id, progress); break; }
        if (reviewed.decision === 'repair') { repairs += 1; entry.reason = reviewed.reason; entry.draft = null; entry.validation = null; await store.saveProgress(job.id, progress); if (repairs >= this.knowledge.config.llm.structuredRetries) throw new JobError('dream_repair', '本组多次复核要求修复，已保留候选与草稿反馈；请检查报告后重试。'); continue; }
        requireDream(reviewed.semantic !== null && reviewed.self_review !== null, '缺少复核。'); await this.boundary(job, control);
        const record = await this.knowledge.applyDreamGroup(job.id, entry.candidate.group_id, entry.draft, validation, reviewed.semantic, reviewed.self_review, control); control.committed?.();
        entry.status = record.groups.some((group) => group.skipped) ? 'skipped' : 'executed'; entry.reason = entry.status === 'skipped' ? '外部版本或证据版本变化，或来源环冲突；已生效结果保留。' : reviewed.reason; await store.saveProgress(job.id, progress);
      }
      await this.compact(job, control, progress);
    }
    for (const candidate of progress.discovery.sync_candidates) if (!progress.syncCompleted.includes(candidate.source_id)) {
      await this.boundary(job, control); const sync = new DreamSync(this.knowledge.context());
      if (await sync.resume(job.id, candidate.source_id, control.signal)) { progress.syncCompleted.push(candidate.source_id); await store.saveProgress(job.id, progress); continue; }
      const validation = await sync.prepare(candidate.source_id, candidate.carrier_ids);
      const review = await this.call(job, control, 'sync_review', { validation, reason: candidate.reason, note: '只确认完整信息承接，不修改 Claim，不纠正事实。' }, SemanticReviewSchema);
      await sync.apply(job.id, validation, review, control.signal); progress.syncCompleted.push(candidate.source_id); await store.saveProgress(job.id, progress);
    }
    await this.boundary(job, control); const final = await store.finish(job.id, progress, control); control.committed?.(); progress.finished = true; await store.saveProgress(job.id, progress);
    await new UploadDelivery(this.knowledge.context(), this.knowledge.team).deliver(control.signal);
    return { updatedClaimIds: Object.keys(final.self_versions), report: 'Dream report.md 已保存。', skipped: progress.entries.filter((entry) => entry.status === 'skipped').map((entry) => entry.candidate.group_id), kept: progress.entries.filter((entry) => entry.status === 'kept').map((entry) => entry.candidate.group_id) };
  }
  private async compact(job: Job, control: JobControl, progress: Progress): Promise<void> {
    const handled = progress.entries.filter((entry) => entry.status !== 'pending'); const history = handled.slice(progress.compactedThrough); if (conservativeTokens(JSON.stringify(history)) < INPUT_TOKENS / 2) return;
    await this.knowledge.dreamStore().archive(job.id, `context-${history.length}`, history);
    const previews = history.map((entry) => ({ group_id: entry.candidate.group_id, status: entry.status, validation_id: entry.validation?.validation_id, preview: Array.from(entry.reason).slice(0, 400).join(''), preview_truncated: Array.from(entry.reason).length > 400 }));
    const summary = await this.call(job, control, 'compaction', { prior_summary: progress.summary, history: previews }, SummarySchema, (value) => { requireDream(Object.values(value).reduce((sum, value) => sum + Array.from(value).length, 0) <= 12_000, '压缩摘要超过 12000 字符。'); return value; }, 'dream_compaction.j2'); progress.summary = summary; progress.compactedThrough = handled.length;
    await this.knowledge.dreamStore().saveProgress(job.id, progress);
  }
  async close(): Promise<void> {
    this.closed = true; this.unregister(); this.knowledge.jobs?.cancelDream();
    for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    await this.pending; await this.active?.catch(() => {});
  }
}
