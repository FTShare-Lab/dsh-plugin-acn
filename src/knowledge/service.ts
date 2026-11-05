// 知识服务拥有本地浏览、CAS 修订和形成批次提交；网络传输由独立模块负责。
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ResolvedConfig } from '../config.js';
import type { AgentId, ClaimId, TraceId } from '../protocol/ids.js';
import type { Claim } from '../protocol/claim.js';
import { effectiveUpdatedAt } from '../protocol/claim.js';
import { claimRevision } from '../protocol/revision.js';
import { nowSeconds, timestampNanos } from '../protocol/time.js';
import { AgentPaths, agentHomePath } from '../store/paths.js';
import type { StoreContext, StoreLogger } from '../store/context.js';
import { ClaimStore } from '../store/claims.js';
import { TraceStore } from '../store/traces.js';
import { ClaimEditStore } from '../store/claim-edits.js';
import { UploadStore } from '../store/uploads.js';
import { removeFile, cleanupAtomicTemps } from '../store/atomic.js';
import { hasCode, LockTimeoutError, StoreError } from '../store/errors.js';
import { withFileLock } from '../store/lock.js';
import { KnowledgeError, RevisionConflict } from './errors.js';
import { ClaimUpdateSchema, DEFAULT_TRACE_TASK_PAGE_LIMIT, MAX_TRACE_TASK_PAGE_LIMIT } from './types.js';
import type { ClaimDetail, ClaimListPage, ClaimListQuery, ClaimUpdate, ClaimUpdateResult, KnowledgeVersion, TraceDetail, TraceListPage, TraceListQuery } from './types.js';
import { claimListPage, page, validatePage } from './pages.js';
import { validateClaimText } from './safety.js';
import { FormationStore } from '../formation/checkpoint.js';
import { TeamFacade } from '../team/service.js';
import type { TeamStatus } from '../team/service.js';
import type { CredentialResolver } from '../team/http.js';
import { DurableWorker } from '../worker/worker.js';
import { InboxEffectStore } from '../inbox/effects.js';
import { DreamStore } from '../dream/checkpoint.js';
import { AnalysisReadBoundary, KnowledgeBusy } from './alignment.js';
import { PresentationStore } from '../store/presentation.js';

import { nextClaimUpdateAt } from './timestamps.js';
export { nextClaimUpdateAt } from './timestamps.js';
function missing(error: unknown): boolean { return hasCode(error, 'ENOENT') || (error instanceof StoreError && error.kind === 'io' && hasCode(error.cause, 'ENOENT')); }

export class AcnKnowledge {
  readonly agentId: AgentId | null;
  readonly mode: 'solo' | 'team';
  readonly storeContext: StoreContext | null;
  readonly team: TeamFacade | null;
  readonly jobs: DurableWorker | null;
  private cache: { stamp: string; checked: number; claims: Claim[]; version: KnowledgeVersion } | undefined;
  private readonly listeners = new Set<(version: KnowledgeVersion) => void>();
  constructor(readonly config: ResolvedConfig, readonly logger: StoreLogger, credential?: CredentialResolver) {
    this.agentId = config.agentId || null;
    this.mode = config.team.routerEndpoint ? 'team' : 'solo';
    this.storeContext = this.agentId === null ? null : { agentId: this.agentId, paths: new AgentPaths(agentHomePath(config.home, this.agentId)), mode: this.mode, logger };
    this.team = this.agentId !== null && this.mode === 'team' ? new TeamFacade(config.team, this.agentId, logger, credential) : null;
    this.jobs = this.storeContext === null ? null : new DurableWorker(this.storeContext);
  }
  get active(): boolean { return this.mode === 'solo' || this.config.legacyEnabled; }
  get configured(): boolean { return this.agentId !== null; }
  teamStatus(): TeamStatus { return this.team?.status() ?? { mode: 'solo', router: { state: 'unknown' }, maintainer: { state: 'unknown' } }; }
  context(): StoreContext {
    if (this.storeContext === null) throw new KnowledgeError('unconfigured', 'Configure agentId on the acn-knowledge row first.');
    return this.storeContext;
  }
  async initialize(): Promise<void> {
    if (!this.configured) return;
    await new PresentationStore(this.context()).initialize();
    await cleanupAtomicTemps(this.context().paths.root, this.logger);
    await new DreamStore(this.context()).recover();
    await new ClaimEditStore(this.context()).recover();
    await new FormationStore(this.context()).recover();
    await new InboxEffectStore(this.context()).recover();
  }
  async snapshot(signal?: AbortSignal, lockTimeoutMs?: number): Promise<{ claims: Claim[]; version: KnowledgeVersion }> {
    return this.consistentRead(async () => {
    const context = this.context();
    let stamp: string;
    try { const stat = await fs.stat(context.paths.claims, { bigint: true }); stamp = `${stat.mtimeNs}:${stat.ctimeNs}`; }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; stamp = 'missing'; }
    if (this.cache !== undefined && this.cache.stamp === stamp && performance.now() - this.cache.checked < 2000) return structuredClone({ claims: this.cache.claims, version: this.cache.version });
    const claims = await new ClaimStore(context).list();
    const revisions = [...claims].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((claim) => `${claim.id}:${claimRevision(claim)}`).join('\n');
    const version = { claimsDigest: createHash('sha256').update(revisions).digest('hex') };
    this.cache = { stamp, checked: performance.now(), claims, version };
    return structuredClone({ claims, version });
    }, signal, lockTimeoutMs);
  }
  async knowledgeVersion(signal?: AbortSignal, lockTimeoutMs?: number): Promise<KnowledgeVersion> { return (await this.snapshot(signal, lockTimeoutMs)).version; }
  async listClaims(query: ClaimListQuery = {}, signal?: AbortSignal): Promise<ClaimListPage> {
    return this.consistentRead(async () => {
    return claimListPage(await new ClaimStore(this.context()).list(), query);
    }, signal);
  }
  async readClaim(id: ClaimId, signal?: AbortSignal): Promise<ClaimDetail> {
    return this.consistentRead(async () => {
    const claim = await this.readOwnedClaim(id);
    return { claim, revision: claimRevision(claim) };
    }, signal);
  }
  private async readOwnedClaim(id: ClaimId): Promise<Claim> {
    let claim: Claim;
    try { claim = await new ClaimStore(this.context()).read(id); }
    catch (error) { if (missing(error)) throw new KnowledgeError('not_found', `Claim ${id} was not found.`); throw error; }
    if (claim.holder !== this.agentId) throw new KnowledgeError('ownership', `Claim ${id} is not held by this agent.`);
    return claim;
  }
  async updateClaim(input: ClaimUpdate, signal?: AbortSignal): Promise<ClaimUpdateResult> {
    const parsed = ClaimUpdateSchema.safeParse(input);
    if (!parsed.success) throw new KnowledgeError('validation', 'Invalid Claim update fields.');
    const { id, expected_revision, ...fields } = parsed.data;
    if (!Object.values(fields).some((value) => value !== undefined)) throw new KnowledgeError('validation', 'Claim update requires at least one editable field.');
    const context = this.context();
    const result = await withFileLock(context.paths.knowledgeLock, async () => {
      signal?.throwIfAborted();
      await new DreamStore(context).recoverLocked();
      await new ClaimEditStore(context).recoverLocked();
      await new FormationStore(context).recoverLocked();
      await new InboxEffectStore(context).recoverLocked();
      const current = await this.readOwnedClaim(id);
      const revision = claimRevision(current);
      if (expected_revision !== revision) throw new RevisionConflict(revision);
      const next: Claim = { ...current };
      for (const key of ['name', 'statement', 'scope', 'evidence_summary', 'confidence', 'status'] as const) {
        const value = fields[key];
        if (value !== undefined) Object.assign(next, { [key]: value });
      }
      validateClaimText({ name: next.name, statement: next.statement, scope: next.scope, evidence_summary: next.evidence_summary });
      next.updated_at = nextClaimUpdateAt(nowSeconds(), effectiveUpdatedAt(current));
      signal?.throwIfAborted();
      if (context.mode === 'team') await new ClaimEditStore(context).write({ expected_revision: revision, target: next });
      await new ClaimStore(context).write(next);
      if (context.mode === 'team') {
        await new UploadStore(context).enqueue([next], [], true);
        await removeFile(context.paths.claimEditPending, this.logger);
      }
      this.cache = undefined;
      return { claim: next, revision: claimRevision(next), sync_pending: context.mode === 'team', ...(context.mode === 'team' ? { sync_warning: 'Claim 已保存到本地，等待团队同步。' } : {}) };
    }, { signal, timeoutMs: context.lockTimeoutMs });
    await this.notifyChanged(signal);
    return result;
  }
  async listTraces(query: TraceListQuery = {}, signal?: AbortSignal): Promise<TraceListPage> {
    return this.consistentRead(async () => {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 20;
    validatePage(offset, limit);
    const traces = (await new TraceStore(this.context()).list()).filter((trace) => trace.agent === this.agentId &&
      (query.claimId === undefined || trace.input_claims.includes(query.claimId) || trace.output_claims.includes(query.claimId)));
    traces.sort((a, b) => {
      const delta = timestampNanos(b.created_at) - timestampNanos(a.created_at);
      return delta === 0n ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : delta > 0n ? 1 : -1;
    });
    return page(traces.map(({ id, name, created_at, input_claims, output_claims }) => ({ id, name, created_at, input_claims, output_claims })), offset, limit);
    }, signal);
  }
  async readTrace(id: TraceId, options: { taskOffset?: number; taskLimit?: number } = {}, signal?: AbortSignal): Promise<TraceDetail> {
    return this.consistentRead(async () => {
    const offset = options.taskOffset ?? 0;
    const limit = options.taskLimit ?? DEFAULT_TRACE_TASK_PAGE_LIMIT;
    validatePage(offset, limit, MAX_TRACE_TASK_PAGE_LIMIT);
    let trace;
    try { trace = await new TraceStore(this.context()).read(id); }
    catch (error) { if (missing(error)) throw new KnowledgeError('not_found', `Trace ${id} was not found.`); throw error; }
    if (trace.agent !== this.agentId) throw new KnowledgeError('ownership', `Trace ${id} is not owned by this agent.`);
    const chars = Array.from(trace.task);
    const end = Math.min(offset + limit, chars.length);
    return { ...trace, task: chars.slice(offset, end).join(''), task_offset: offset, task_limit: limit, task_omitted: chars.length - end, next_task_offset: end < chars.length ? end : null };
    }, signal);
  }
  onClaimsChanged(listener: (version: KnowledgeVersion) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async applyFormation(...args: Parameters<FormationStore['commit']>): ReturnType<FormationStore['commit']> {
    const result = await new FormationStore(this.context()).commit(...args);
    if (result.applied) await this.notifyChanged(args[1].signal);
    return result;
  }
  async applyInboxEffect(...args: Parameters<InboxEffectStore['commit']>): ReturnType<InboxEffectStore['commit']> {
    const result = await new InboxEffectStore(this.context()).commit(...args);
    if (result.applied > 0) await this.notifyChanged(args[3].signal);
    return result;
  }
  private async consistentRead<T>(action: () => Promise<T>, signal?: AbortSignal, lockTimeoutMs?: number): Promise<T> {
    const context = this.context();
    // 恢复和读取共享写方的知识锁，避免普通批量提交跨越文件扫描而产生混合快照。
    try { return await withFileLock(context.paths.knowledgeLock, async () => {
      signal?.throwIfAborted();
      await new DreamStore(context).recoverLocked(); await new ClaimEditStore(context).recoverLocked();
      await new FormationStore(context).recoverLocked(); await new InboxEffectStore(context).recoverLocked();
      const boundary = await AnalysisReadBoundary.begin(context.paths.root);
      const result = await action(); await boundary.finish(context.paths.root); signal?.throwIfAborted(); return result;
    }, { signal, timeoutMs: lockTimeoutMs ?? context.lockTimeoutMs }); }
    catch (error) { signal?.throwIfAborted(); if (error instanceof LockTimeoutError) throw new KnowledgeBusy(); throw error; }
  }
  private async notifyChanged(signal?: AbortSignal): Promise<void> {
    this.cache = undefined;
    try {
      const version = await this.knowledgeVersion(signal);
      for (const listener of this.listeners) { try { listener(version); } catch { this.logger.warn('Claim change observer failed.'); } }
    } catch { this.logger.warn('Knowledge was committed; its change notice will be checked on the next foreground step.'); }
  }
  dreamStore(): DreamStore {
    return new DreamStore(this.context(), async () => { await new ClaimEditStore(this.context()).recoverLocked(); await new FormationStore(this.context()).recoverLocked(); await new InboxEffectStore(this.context()).recoverLocked(); });
  }
  async dreamSnapshot(signal: AbortSignal): Promise<Claim[]> {
    return withFileLock(this.context().paths.knowledgeLock, async () => {
      await new DreamStore(this.context()).recoverLocked(); await new ClaimEditStore(this.context()).recoverLocked(); await new FormationStore(this.context()).recoverLocked(); await new InboxEffectStore(this.context()).recoverLocked();
      signal.throwIfAborted(); return new ClaimStore(this.context()).list();
    }, { signal, timeoutMs: this.context().lockTimeoutMs });
  }
  async applyDreamGroup(...args: Parameters<DreamStore['commitGroup']>): ReturnType<DreamStore['commitGroup']> {
    const result = await this.dreamStore().commitGroup(...args);
    await this.notifyChanged(args[6].signal);
    return result;
  }
}
