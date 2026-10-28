// 形成服务统一编排增量、触发、抢占和恢复；模型调用与本地提交分阶段执行。
import type { AcnKnowledge } from '../knowledge/service.js';
import type { StructuredBackend } from '../llm/structured.js';
import { structuredCall } from '../llm/structured.js';
import { DurableWorker } from '../worker/worker.js';
import type { JobControl } from '../worker/worker.js';
import { JobError, Preempted } from '../worker/types.js';
import type { Job } from '../worker/types.js';
import { writeYamlAtomic } from '../store/yaml.js';
import { withFileLock } from '../store/lock.js';
import { FormationStore } from './checkpoint.js';
import { TranscriptStore, RouteSchema, processedThrough } from './transcript.js';
import type { Projection, Route } from './transcript.js';
import { RecapOutputSchema } from './schema.js';
import { prepareFormation } from './prepare.js';
import { idleTrigger } from './triggers.js';

export class AcnFormation {
  readonly worker: DurableWorker;
  readonly transcript: TranscriptStore;
  private pending = Promise.resolve();
  private captureError: unknown;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attached = new Set<string>();
  private readonly activeSessions = new Set<string>();
  private scanner: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private closing = false;
  private readonly unregister: (() => void)[];
  private readonly ownsWorker: boolean;
  constructor(readonly knowledge: AcnKnowledge, private readonly backend: StructuredBackend, private readonly render: (name: string, context: object) => string, workerOptions: ConstructorParameters<typeof DurableWorker>[1] = {}, worker?: DurableWorker, private readonly routeReady?: (route: Route) => Promise<boolean>) {
    this.worker = worker ?? new DurableWorker(knowledge.context(), workerOptions);
    this.ownsWorker = worker === undefined;
    this.transcript = new TranscriptStore(knowledge.context());
    this.unregister = [this.worker.register('recap', (job, control) => this.run(job, control)), this.worker.register('finalize', (job, control) => this.run(job, control))];
  }
  async start(): Promise<void> {
    await new FormationStore(this.knowledge.context()).recover();
    for (const id of await this.transcript.sessions()) {
      await this.transcript.record(id, {});
      const state = await this.transcript.state(id);
      if (state.archivePending) await this.finishArchive(id);
    }
    await this.worker.start();
    this.started = true;
    this.scanner = setInterval(() => { this.schedule(() => this.scanPending(Date.now())); }, this.knowledge.config.formation.recapScanSeconds * 1000);
    this.scanner.unref();
    await this.scanPending(Date.now());
  }
  attach(id: string): void { this.attached.add(id); this.idle(id); }
  capture(id: string, projection: Projection, compactedUntil?: number): void {
    if (this.closing) return;
    this.schedule(async () => {
      await this.transcript.record(id, projection);
      if (projection.route !== undefined) await this.rememberRoute(projection.route);
      if (compactedUntil !== undefined && this.knowledge.config.formation.recapOnCompaction) await this.enqueueNew(id, 'recap', 'compaction', compactedUntil);
    });
  }
  private schedule(action: () => Promise<unknown>): void {
    this.pending = this.pending.then(action).then(() => undefined).catch((error: unknown) => { this.captureError = error; this.knowledge.logger.warn('Knowledge formation could not persist a session event.'); });
  }
  async flush(): Promise<void> { await this.pending; if (this.captureError !== undefined) throw new JobError('transcript', '会话投影未完整持久化；请检查存储空间和 transcript 限制后重试。'); }
  private async rememberRoute(route: Route): Promise<void> {
    const context = this.knowledge.context();
    await withFileLock(`${context.paths.lastRoute}.lock`, () => writeYamlAtomic(context.paths.lastRoute, route, RouteSchema, context.logger));
  }
  running(id: string): void { this.activeSessions.add(id); const timer = this.timers.get(id); if (timer !== undefined) clearTimeout(timer); this.timers.delete(id); }
  idle(id: string): void {
    this.running(id);
    this.activeSessions.delete(id);
    if (!this.closing) this.schedule(() => this.checkIdle(id, Date.now()));
    const minutes = this.knowledge.config.formation.finalizeIdleMinutes;
    if (this.closing || minutes === 0) return;
    // 配置允许较长空闲时间，分段等待避免平台计时器溢出后立即触发。
    const deadline = Date.now() + minutes * 60_000;
    const wait = () => {
      const remaining = deadline - Date.now();
      if (remaining > 0) { const timer = setTimeout(wait, Math.min(remaining, 2_147_483_647)); timer.unref(); this.timers.set(id, timer); }
      else { this.timers.delete(id); this.schedule(() => this.enqueue(id, 'finalize')); }
    };
    wait();
  }
  disposed(id: string): void {
    this.running(id); this.attached.delete(id);
    this.activeSessions.delete(id);
    if (!this.closing && this.knowledge.config.formation.finalizeOnDispose) this.schedule(() => this.enqueue(id, 'finalize'));
  }
  async finalize(id: string): Promise<Job> { await this.flush(); return this.enqueue(id, 'finalize'); }
  async recap(id: string): Promise<Job | null> {
    await this.flush();
    const state = await this.transcript.state(id);
    const until = this.activeSessions.has(id) ? Math.max(processedThrough(state), ...state.completedTurns) : state.lastSeenSeq;
    return this.enqueueNew(id, 'recap', 'manual', until);
  }
  async scan(now = Date.now()): Promise<void> { await this.flush(); await this.scanPending(now); }
  private async scanPending(now: number): Promise<void> {
    if (this.closing) return;
    for (const id of await this.transcript.sessions()) await this.checkIdle(id, now);
  }
  private async checkIdle(id: string, now: number): Promise<void> {
    if (!this.started || this.closing || this.activeSessions.has(id)) return;
    const state = await this.transcript.state(id);
    const trigger = idleTrigger(this.knowledge.config.formation, state, await this.transcript.read(id), now);
    if (trigger === undefined) return;
    const config = this.knowledge.config.llm;
    const route = config.provider && config.model ? { provider: config.provider, model: config.model } : state.lastRoute;
    if (route === undefined || this.routeReady !== undefined && !await this.routeReady(route)) return;
    if (!this.activeSessions.has(id)) await this.enqueueNew(id, 'recap', trigger);
  }
  async beginArchive(id: string, upper?: number): Promise<number | null> {
    await this.flush();
    if (!this.attached.has(id) && await this.transcript.states.read(id) === null) return null;
    const state = await this.transcript.lifecycle(id, (current) => {
      current.archiveIntent = current.autoPaused && current.archivedThroughSeq !== null ? current.archivedThroughSeq : Math.min(upper ?? current.lastSeenSeq, current.lastSeenSeq);
    });
    return state.archiveIntent;
  }
  async cancelArchive(id: string): Promise<void> { await this.transcript.lifecycle(id, (state) => { state.archiveIntent = null; }); }
  async archived(id: string, upper: number): Promise<void> {
    await this.flush();
    await this.transcript.lifecycle(id, (state) => {
      if (!state.autoPaused) { state.autoPaused = true; state.archivedThroughSeq = upper; state.archivePending = true; }
      state.archiveIntent = null;
    });
    await this.finishArchive(id);
  }
  async reconcileArchives(archived: ReadonlySet<string>): Promise<void> {
    await this.flush();
    for (const id of await this.transcript.sessions()) {
      const state = await this.transcript.state(id);
      if (state.archiveIntent !== null) {
        if (archived.has(id)) await this.archived(id, state.archiveIntent); else await this.cancelArchive(id);
      } else if (archived.has(id) && state.archivedThroughSeq === null) await this.archived(id, state.lastSeenSeq);
    }
  }
  private async finishArchive(id: string): Promise<void> {
    const state = await this.transcript.state(id);
    if (!state.archivePending || state.archivedThroughSeq === null) return;
    await this.enqueueNew(id, 'finalize', 'archive', state.archivedThroughSeq);
    await this.transcript.lifecycle(id, (current) => { current.archivePending = false; });
  }
  private async enqueueNew(id: string, kind: 'finalize' | 'recap', trigger: string, requestedUntil?: number): Promise<Job | null> {
    const state = await this.transcript.state(id);
    if (state.archiveIntent !== null || state.autoPaused && trigger !== 'archive' && trigger !== 'manual') return null;
    const untilSeq = Math.min(requestedUntil ?? state.lastSeenSeq, state.lastSeenSeq, state.autoPaused ? state.archivedThroughSeq ?? -1 : state.lastSeenSeq);
    const cursor = processedThrough(state);
    if (untilSeq <= cursor || !(await this.transcript.read(id)).some((entry) => entry.seq > cursor && entry.seq <= untilSeq && entry.text.trim() !== '')) return null;
    const existing = (await this.worker.queue.list()).find((job) => job.sessionId === id && (job.kind === kind || kind === 'recap' && job.kind === 'finalize') && typeof job.payload['untilSeq'] === 'number' && job.payload['untilSeq'] >= untilSeq && (job.state === 'queued' || job.state === 'running' || trigger.endsWith('-idle') && job.state === 'failed'));
    if (existing !== undefined) return existing;
    return this.worker.enqueue(kind, { untilSeq, trigger }, id);
  }
  private async enqueue(id: string, kind: 'finalize' | 'recap', requestedUntil?: number): Promise<Job> {
    const state = await this.transcript.state(id);
    const untilSeq = Math.min(requestedUntil ?? state.lastSeenSeq, state.lastSeenSeq, state.archiveIntent ?? (state.autoPaused ? state.archivedThroughSeq ?? -1 : state.lastSeenSeq));
    return this.worker.enqueue(kind, { untilSeq }, id);
  }
  private async run(job: Job, control: JobControl): Promise<Job['result']> {
    await this.flush();
    const id = job.sessionId;
    const until = job.payload['untilSeq'];
    if (id === undefined || typeof until !== 'number' || !Number.isSafeInteger(until)) throw new JobError('validation', '形成任务缺少合法会话或区间。');
    await new FormationStore(this.knowledge.context()).recover();
    const state = await this.transcript.state(id);
    const fromSeq = processedThrough(state);
    const untilSeq = Math.min(until, state.lastSeenSeq, state.archiveIntent ?? (state.autoPaused ? state.archivedThroughSeq ?? -1 : state.lastSeenSeq));
    if (untilSeq <= fromSeq) {
      if (job.kind === 'finalize' && untilSeq >= 0) await this.transcript.advance(id, 'finalize', untilSeq);
      return { skipped: 'already_processed' };
    }
    const entries = (await this.transcript.read(id)).filter((entry) => entry.seq > fromSeq && entry.seq <= untilSeq);
    if (entries.length === 0) throw new JobError('transcript', '待处理区间的会话投影缺失；已保留任务，请检查本地 transcript 后重试。');
    const analysisClaims = (await this.knowledge.snapshot()).claims;
    const configured = this.knowledge.config.llm;
    const route = configured.provider && configured.model ? { provider: configured.provider, model: configured.model } : state.lastRoute;
    // 会话任务只能使用自身已记录路由；全局 last_route 留给后续无会话任务。
    if (route === undefined) throw new JobError('route', '没有本会话的 request/header 路由。请先完成一次会话请求，或配置 llm.provider 和 llm.model，然后用 /acn-status retry 重试。');
    const input = JSON.stringify({ instruction: '根据本段真实任务证据形成可复用知识；没有有价值的新增或更新时返回空数组。', transcript_projection: { complete_history: false, from_seq_exclusive: fromSeq, until_seq_inclusive: untilSeq, excluded: ['system_instructions', 'catalog_injection', 'compaction_replacement', 'reasoning', 'private_memory', 'run_code_wrapper'], tool_result_max_chars: 4000, legacy_tool_result_completeness: 'unknown' }, transcript: entries.map((entry) => ({ role: entry.type, content: entry.text, ...(entry.projection === undefined ? {} : { projection: entry.projection }) })), local_claims: analysisClaims.filter((claim) => claim.status !== 'deprecated') });
    const prepared = await structuredCall({ backend: this.backend, context: this.knowledge.context(), config: configured, route, jobId: job.id, system: this.render('session_recap.j2', { memory_enabled: false }), input, schema: RecapOutputSchema,
      parse: (value) => prepareFormation(value, this.knowledge.context().agentId, analysisClaims, state.seenSourceIds), signal: control.signal });
    control.signal.throwIfAborted();
    if (job.kind === 'recap' && (await this.worker.queue.list()).some((candidate) => candidate.kind === 'finalize' && candidate.sessionId === id && candidate.state === 'queued')) throw new Preempted();
    const task = Array.from(entries.filter((entry) => entry.type === 'user').map((entry) => entry.text).join('\n') || '本段会话知识复盘').slice(0, 16_000).join('');
    return this.knowledge.applyFormation({ sessionId: id, jobId: job.id, kind: job.kind === 'recap' ? 'recap' : 'finalize', fromSeq, untilSeq, analysisClaims, prepared, task }, control);
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.scanner !== undefined) clearInterval(this.scanner);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    try {
      await this.pending;
      if (this.knowledge.config.formation.finalizeOnDispose) for (const id of this.attached) await this.enqueue(id, 'finalize');
    } finally { for (const unregister of this.unregister) unregister(); if (this.ownsWorker) await this.worker.close(); }
  }
}
