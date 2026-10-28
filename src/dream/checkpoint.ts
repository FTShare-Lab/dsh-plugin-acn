// 整理组先记录固定目标再提交；恢复完成本地效果及队列，不等待远端或再次调用模型。
import fs from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { StoreContext } from '../store/context.js';
import { readYaml, readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { writeTextAtomic, removeFile } from '../store/atomic.js';
import { withFileLock } from '../store/lock.js';
import { hasCode, StoreError } from '../store/errors.js';
import { ClaimStore } from '../store/claims.js';
import { TraceStore } from '../store/traces.js';
import { UploadStore } from '../store/uploads.js';
import { sameClaim } from '../knowledge/alignment.js';
import { deriveTraceId, SourceIdSchema } from '../protocol/ids.js';
import { TraceSchema } from '../protocol/trace.js';
import { nowSeconds } from '../protocol/time.js';
import type { JobControl } from '../worker/worker.js';
import { CheckpointSchema, DreamStateSchema, OriginSchema, ProgressSchema, KeySchema, requireDream } from './schema.js';
import type { Checkpoint, Group, OriginSchema as OriginType, Progress, SemanticReview, SelfReview, Validation } from './schema.js';
import { contentHash, prepareGroup, reaches, reviewInput, valueHash } from './plan.js';
import { versions } from './candidates.js';
import { validateSemanticReview, validateSelfReview } from './review.js';
import { executionAudit, jobReport } from './audit.js';
import { EvidenceStore } from './evidence-store.js';

type Origin = z.infer<typeof OriginType>;
const sameJson = (a: unknown, b: unknown) => valueHash(a) === valueHash(b);
export class DreamStore {
  constructor(readonly context: StoreContext, private readonly settleRegular?: () => Promise<void>) {}
  state() { return readYamlOr(this.context.paths.dreamState, DreamStateSchema, () => DreamStateSchema.parse({})); }
  origin(jobId: string): Promise<Origin | null> { return readYamlOr(join(this.context.paths.dreamJob(jobId), 'origin.yaml'), OriginSchema, () => null); }
  progress(jobId: string): Promise<Progress | null> { return readYamlOr(join(this.context.paths.dreamJob(jobId), 'progress.yaml'), ProgressSchema, () => null); }
  final(jobId: string): Promise<Checkpoint | null> { return readYamlOr(this.context.paths.dreamFinal(jobId), CheckpointSchema, () => null); }
  async saveOrigin(jobId: string, origin: Origin): Promise<void> { if (await this.origin(jobId) === null) await writeYamlAtomic(join(this.context.paths.dreamJob(jobId), 'origin.yaml'), origin, OriginSchema, this.context.logger); }
  async saveProgress(jobId: string, progress: Progress): Promise<void> {
    await writeYamlAtomic(join(this.context.paths.dreamJob(jobId), 'progress.yaml'), progress, ProgressSchema, this.context.logger);
    await this.report(jobId, progress);
  }
  async report(jobId: string, progress: Progress): Promise<void> { await jobReport(this.context, jobId, progress, (await this.origin(jobId))?.coverage, (await this.records(jobId)).map((entry) => entry.checkpoint)); }
  async records(jobId: string): Promise<{ path: string; checkpoint: Checkpoint }[]> {
    const root = join(this.context.paths.dreamJob(jobId), 'executions'); let files: string[];
    try { files = (await fs.readdir(root)).filter((name) => /^[0-9a-f]{64}\.yaml$/.test(name)); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    const records = await Promise.all(files.sort().map(async (name) => {
      const path = join(root, name); const checkpoint = await readYaml(path, CheckpointSchema);
      if (checkpoint.operation?.job_id !== jobId || checkpoint.operation.validation_id !== name.slice(0, -5)) throw new StoreError('conflict', 'Dream execution identity differs from its directory.');
      return { path, checkpoint };
    }));
    return records;
  }
  private async jobs(): Promise<string[]> {
    try { return (await fs.readdir(this.context.paths.dreamRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && KeySchema.safeParse(entry.name).success).map((entry) => entry.name); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
  }
  private async pending(): Promise<string | null> {
    const path = await readYamlOr(this.context.paths.dreamPending, z.string(), () => null); if (path === null) return null;
    const resolved = resolve(path); const location = relative(this.context.paths.root, resolved).split('\\').join('/');
    if (!/^dream\/[a-zA-Z0-9_-]+\/executions\/[0-9a-f]{64}\.yaml$/.test(location) && !/^runtime\/supervisor\/dream\/[a-zA-Z0-9_-]+\.yaml$/.test(location)) throw new StoreError('conflict', 'Dream pending path is outside the allowed commit directories.');
    return resolved;
  }
  private async unfinished(): Promise<string[]> {
    const pending = await this.pending(); const paths = new Set(pending === null ? [] : [pending]);
    for (const job of await this.jobs()) for (const record of await this.records(job)) if (!record.checkpoint.applied) paths.add(record.path);
    // 最终记录也先于 pending 指针落盘；这一窗口崩溃不能漏掉成功冷却与最终 Trace。
    const root = dirname(this.context.paths.dreamFinal('scan'));
    let files: string[] = [];
    try { files = await fs.readdir(root); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    for (const file of files.filter((name) => /^[a-zA-Z0-9_-]+\.yaml$/.test(name)).sort()) {
      const path = join(root, file); if (!(await readYaml(path, CheckpointSchema)).applied) paths.add(path);
    }
    return [...paths];
  }
  async recover(): Promise<void> {
    if ((await this.unfinished()).length === 0) return;
    await withFileLock(this.context.paths.knowledgeLock, () => this.recoverLocked(), { timeoutMs: this.context.lockTimeoutMs });
  }
  async recoverLocked(): Promise<void> { for (const path of await this.unfinished()) await this.applyLocked(path); }
  async commitGroup(jobId: string, groupId: string, group: Group, validation: Validation, semantic: SemanticReview, selfReview: SelfReview | null, control: JobControl): Promise<Checkpoint> {
    const evidence = new EvidenceStore(this.context, jobId, groupId);
    const receipts = z.record(z.string(), z.json()).parse((await evidence.read())?.receipts ?? {});
    requireDream(sameJson(reviewInput(groupId, group, validation.input.before, receipts), validation), '草稿、真实查证回执与复核版本不一致。');
    if (selfReview !== null) validateSelfReview(validation, selfReview); validateSemanticReview(validation, semantic);
    const prepared = prepareGroup(group, validation.input.before, this.context.agentId, nowSeconds(), { enabled: group.kind === 'evidence' || Object.keys(receipts).length > 0, receipts, semanticReview: selfReview === null });
    return withFileLock(this.context.paths.knowledgeLock, async () => {
      await this.recoverLocked(); await this.settleRegular?.();
      const path = this.context.paths.dreamExecution(jobId, validation.validation_id);
      const existing = await readYamlOr(path, CheckpointSchema, () => null); if (existing !== null) { requireDream(existing.operation?.group_id === groupId, '执行回执属于其他组。'); return this.applyLocked(path); }
      const origin = await this.origin(jobId); requireDream(origin !== null, '缺少 Dream 原始快照。');
      const priorTargets = (await this.records(jobId)).flatMap(({ checkpoint }) => checkpoint.groups.filter((item) => item.completed && !item.skipped).flatMap((item) => item.after));
      requireDream(prepared.before.every((claim) => origin.claims.some((original) => sameClaim(original, claim)) || selfReview === null && priorTargets.some((target) => sameClaim(target, claim))), '执行前 Claim 必须来自冻结快照或本轮已提交版本，不能采用外部并发修改。');
      for (const item of semantic.claims) if (item.factual_correction || group.kind === 'evidence') requireDream(origin.claims.some((claim) => claim.id === item.claim_id && claim.confidence !== 'high'), '本轮原始 high Claim 不得先降级再进行事实校准。');
      await evidence.authorize(validation.input.evidence, origin.workspace_root, prepared.before);
      const snapshot_at = nowSeconds();
      const checkpoint = CheckpointSchema.parse({ snapshot_at, input_versions: {}, coverage: origin.coverage, plan: { review: { quality: '逐组复核', evidence: '独立文件版本、逐 Claim 依据与引用校验；不保证语义正确', consolidation: '逐输入核对信息去向' }, groups: [group] }, receipts: validation.input.evidence, exploration_receipts: Object.keys(receipts).length, groups: [prepared], safety_reviews: [], self_reviews: selfReview === null ? [] : [{ validation, review: selfReview }], trace_id: deriveTraceId(snapshot_at, 'dream_claim_review', prepared.before.map((claim) => claim.id), prepared.after.map((claim) => claim.id)), applied: false, success_at: null, self_versions: {}, operation: { job_id: jobId, group_id: groupId, validation_id: validation.validation_id, review: semantic, hard_validation_passed: true } });
      control.signal.throwIfAborted(); control.prepared();
      await writeYamlAtomic(path, checkpoint, CheckpointSchema, this.context.logger);
      return this.applyLocked(path);
    }, { timeoutMs: this.context.lockTimeoutMs, signal: control.signal });
  }
  async finish(jobId: string, progress: Progress, control: JobControl): Promise<Checkpoint> {
    requireDream(progress.entries.every((entry) => entry.status !== 'pending'), '仍有已登记候选未执行或明确保留，不能结束。');
    return withFileLock(this.context.paths.knowledgeLock, async () => {
      await this.recoverLocked(); await this.settleRegular?.();
      const path = this.context.paths.dreamFinal(jobId); const saved = await readYamlOr(path, CheckpointSchema, () => null); if (saved !== null) return this.applyLocked(path);
      const origin = await this.origin(jobId); requireDream(origin !== null, '缺少 Dream 原始快照。');
      const records = (await this.records(jobId)).map((record) => record.checkpoint); requireDream(records.every((record) => record.applied), '整理组仍待恢复。');
      const checkpoint = CheckpointSchema.parse({ snapshot_at: origin.snapshot_at, input_versions: versions(origin.claims), coverage: origin.coverage, plan: { review: progress.discovery.review, groups: records.flatMap((record) => record.plan.groups) }, receipts: Object.fromEntries(records.flatMap((record) => Object.entries(record.receipts))), exploration_receipts: records.reduce((count, record) => count + (record.exploration_receipts ?? 0), 0), groups: records.flatMap((record) => record.groups), safety_reviews: [], self_reviews: records.flatMap((record) => record.self_reviews), trace_id: deriveTraceId(nowSeconds(), 'dream_claim_review', [], []), applied: false, success_at: null, self_versions: Object.fromEntries(records.flatMap((record) => Object.entries(record.self_versions))), operation: null });
      control.signal.throwIfAborted(); control.prepared(); await writeYamlAtomic(path, checkpoint, CheckpointSchema, this.context.logger); return this.applyLocked(path);
    }, { timeoutMs: this.context.lockTimeoutMs, signal: control.signal });
  }
  private async applyLocked(path: string): Promise<Checkpoint> {
    const checkpoint = await readYaml(path, CheckpointSchema); const pointer = await this.pending();
    if (pointer !== null && pointer !== path) throw new StoreError('conflict', 'Another Dream group requires recovery first.');
    if (checkpoint.applied && pointer === null) return checkpoint;
    const jobId = checkpoint.operation?.job_id ?? KeySchema.parse(path.slice(dirname(path).length + 1, -5));
    requireDream(checkpoint.operation === null || checkpoint.operation === undefined || checkpoint.operation.hard_validation_passed, '执行记录尚未通过硬校验。');
    requireDream(checkpoint.safety_reviews.length === 0, '不支持没有受限查证授权清单的旧 safety_reviews；不能跳过其证据依赖。');
    requireDream(checkpoint.groups.length === checkpoint.plan.groups.length, '整理提交的组数量不一致。');
    for (const group of checkpoint.groups) requireDream(group.before.length === group.after.length && group.before.every((claim, index) => claim.id === group.after[index]?.id && claim.holder === this.context.agentId && group.after[index]?.holder === this.context.agentId), '整理提交的 before/after 或 holder 不一致。');
    await executionAudit(this.context, jobId, checkpoint);
    if (!checkpoint.applied) {
      await writeYamlAtomic(this.context.paths.dreamPending, path, z.string(), this.context.logger);
      for (const [index, group] of checkpoint.groups.entries()) {
        if (group.completed) continue;
        const plan = checkpoint.plan.groups[index]; requireDream(plan !== undefined, '缺少提交计划。');
        const selected = Object.fromEntries(plan.evidence_ids.map((id) => { const receipt = checkpoint.receipts[id]; requireDream(receipt !== undefined, '执行记录缺少证据依赖。'); return [id, receipt]; }));
        const origin = await this.origin(jobId);
        const validEvidence = await new EvidenceStore(this.context, jobId, checkpoint.operation?.group_id ?? 'legacy').authorize(selected, origin?.workspace_root, group.before);
        const current = await new ClaimStore(this.context).list();
        const graph = [...current.filter((claim) => !group.after.some((target) => target.id === claim.id)), ...group.after];
        const conflict = !validEvidence || group.before.some((before, index) => !current.some((claim) => claim.id === before.id && (sameClaim(claim, before) || group.after[index] !== undefined && sameClaim(claim, group.after[index])))) || group.after.some((after) => after.source_claim_ids.some((source) => !group.before.find((before) => before.id === after.id)?.source_claim_ids.includes(source) && graph.some((claim) => claim.id === source && reaches(claim.id, after.id, graph))));
        if (!conflict) for (const target of [...group.after].sort((a, b) => Number(a.status === 'deprecated') - Number(b.status === 'deprecated'))) if (!current.some((claim) => sameClaim(claim, target))) await new ClaimStore(this.context).write(target);
        const actual = await new ClaimStore(this.context).list(); const staged = group.after.filter((target) => actual.some((claim) => sameClaim(claim, target)));
        const dependencies = plan.kind === 'consolidation' ? staged.filter((claim) => claim.status === 'deprecated').map((retired) => {
          const before = group.before.find((claim) => claim.id === retired.id); requireDream(before !== undefined, '整合缺少来源原文。');
          const ids = plan.coverage.find((item) => item.input_id === retired.id)?.output_ids ?? [];
          return { before, retired, carriers: group.after.filter((claim) => ids.includes(claim.id) && claim.status !== 'deprecated') };
        }) : [];
        await new UploadStore(this.context).enqueue(staged, [], true, dependencies);
        for (const claim of staged) if (!group.before.some((before) => sameClaim(before, claim))) checkpoint.self_versions[claim.id] = contentHash(claim);
        group.skipped = conflict; group.completed = true;
        await writeYamlAtomic(path, checkpoint, CheckpointSchema, this.context.logger); await executionAudit(this.context, jobId, checkpoint);
      }
      const input_claims = [...new Set(checkpoint.groups.flatMap((group) => group.before.map((claim) => claim.id)))].map((id) => SourceIdSchema.parse(id));
      await new TraceStore(this.context).write(TraceSchema.parse({ id: checkpoint.trace_id, name: 'dream_claim_review', task: JSON.stringify({ kind: 'dream', coverage: checkpoint.coverage, review: checkpoint.plan, evidence: checkpoint.receipts, groups: checkpoint.groups, self_reviews: checkpoint.self_reviews }), agent: this.context.agentId, input_claims, output_claims: Object.keys(checkpoint.self_versions), created_at: checkpoint.snapshot_at }));
      checkpoint.applied = true; checkpoint.success_at = nowSeconds(); await writeYamlAtomic(path, checkpoint, CheckpointSchema, this.context.logger);
    }
    await executionAudit(this.context, jobId, checkpoint);
    const previous = await this.state();
    const state = checkpoint.operation !== null && checkpoint.operation !== undefined || previous.last_success_at !== undefined && previous.last_success_at !== null && checkpoint.success_at !== null && checkpoint.success_at !== undefined && Date.parse(previous.last_success_at) > Date.parse(checkpoint.success_at)
      ? { ...previous, known_versions: { ...previous.known_versions, ...checkpoint.self_versions } }
      : { last_success_at: checkpoint.success_at, last_input_snapshot_at: checkpoint.snapshot_at, known_versions: { ...checkpoint.input_versions, ...checkpoint.self_versions } };
    await writeYamlAtomic(this.context.paths.dreamState, state, DreamStateSchema, this.context.logger);
    await removeFile(this.context.paths.dreamPending, this.context.logger); return checkpoint;
  }
  async archive(jobId: string, key: string, value: unknown): Promise<void> { await writeTextAtomic(join(this.context.paths.dreamJob(jobId), 'history', `${KeySchema.parse(key)}.json`), JSON.stringify(value, null, 2), this.context.logger); }
}
