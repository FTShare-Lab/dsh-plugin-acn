// 连接各自拥有领域服务和私有存储；会话记录决定路由，界面切换不会重绑定已开始的工作。
import { join, resolve } from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import type { ResolvedConfig } from '../config.js';
import { AcnKnowledge } from '../knowledge/service.js';
import { KnowledgeSessions } from '../knowledge/sessions.js';
import type { ChangeAdmission } from '../knowledge/sessions.js';
import { AcnFormation } from '../formation/service.js';
import { AcnInbox } from '../inbox/service.js';
import { AcnDream } from '../dream/service.js';
import { AcnMemory } from '../memory/service.js';
import { MemorySessions } from '../memory/sessions.js';
import { MemoryReview } from '../memory/review.js';
import { UploadScheduler } from '../upload/scheduler.js';
import { loadPromptRenderer } from '../prompt/render.js';
import { isSubagent, isEvidenceAgent } from '../tools/subagent.js';
import { structuredBackend } from './llm.js';
import { teamCredentials } from './team-credentials.js';
import { autonomousDreamRunner } from './dream-agent.js';
import { compactionEnd, projectEvent } from './formation.js';
import { identityOf, sessionAllowed, sessionSelection, restoreSessionBinding, rememberConfiguration, runningConfiguration, forgetConfiguration, configurationActivation, markSessionEligible, sessionEligible, sessionHasWork, sessionUnbound, unboundSession } from './session-binding.js';
import { connectArchives } from './formation-archive.js';
import { readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { withFileLock } from '../store/lock.js';
import { agentHomePath } from '../store/paths.js';
import { RouteSchema } from '../formation/transcript.js';
import { JobError } from '../worker/types.js';
import { abortable } from '../llm/structured.js';
import type { SessionView } from '../interaction.js';
import { recentProjectSelection } from './project-upstream.js';
import { upstreamsOf, resolveUpstream, defaultUpstream } from '../upstreams.js';

export interface Runtime {
  knowledge: AcnKnowledge; formation: AcnFormation; inbox: AcnInbox; dream: AcnDream; memory: AcnMemory;
  catalog: KnowledgeSessions; memories: MemorySessions; review: MemoryReview; uploads: UploadScheduler;
  components: Set<RuntimeComponent>; setComponent(component: RuntimeComponent, enabled: boolean): Promise<void>;
  close(): Promise<void>;
}
export type RuntimeComponent = 'prompt' | 'formation' | 'inbox' | 'dream' | 'memory';
declare module '@deepseek-ai/cordis' { interface Context { acnRuntime: RuntimePool } }
type SyncState = { phase: 'ready' | 'syncing' | 'failed'; message: string; controller?: AbortController };
export class RuntimePool {
  private readonly runtimes = new Map<string, Promise<Runtime>>();
  private readonly ready = new Map<string, Runtime>();
  private readonly workers = new Map<string, Runtime>();
  private readonly preferredWorkers = new Map<string, string>();
  private readonly retiredWorkers = new Set<Runtime>();
  private starting = Promise.resolve();
  private readonly instructions = new Map<string, string>();
  private render: Awaited<ReturnType<typeof loadPromptRenderer>> | undefined;
  private readonly syncs = new Map<string, SyncState>();
  private readonly syncTasks = new Map<string, Promise<void>>();
  private readonly baselines = new Set<(id: string, fetchOverview?: boolean) => Promise<void>>();
  private readonly baselineRenderers = new Map<(id: string, fetchOverview?: boolean) => Promise<void>, (header: SessionHeader) => Record<string, string>>();
  private readonly admissions = new Map<string, { id: string; runtime: Runtime; notice: ChangeAdmission }>();
  private readonly resumed = new Set<string>();
  private readonly attached = new Map<string, string>();
  private readonly unboundTools = new Map<string, { names: string; release: () => void }>();
  private readonly components = new Map<RuntimeComponent, Set<symbol>>();
  private pending = Promise.resolve();
  private closed = false;
  get preparing(): boolean { return this.runtimes.size !== this.ready.size || [...this.syncs.values()].some((state) => state.phase === 'syncing'); }
  private host: Context | undefined;
  get ctx(): Context { return this.host ?? this.owner; }
  constructor(private readonly owner: Context, readonly base: AcnKnowledge) {
    void owner.inject(['agents', 'sessions', 'systemPrompt', 'llm', 'tools'], async (child) => { this.host = child; await this.install(child); });
  }
  component(name: RuntimeComponent): () => Promise<void> {
    const token = Symbol(name); const owners = this.components.get(name) ?? new Set<symbol>(); owners.add(token); this.components.set(name, owners);
    this.schedule(async () => { const values = await Promise.allSettled([...this.runtimes.values()]); for (const value of values) if (value.status === 'fulfilled') await value.value.setComponent(name, true); });
    return async () => { owners.delete(token); if (owners.size > 0) return; await this.pending; for (const runtime of this.ready.values()) await runtime.setComponent(name, false); };
  }
  supportsJob(key: string, kind: import('../worker/types.js').JobKind): boolean {
    const config = this.config(key, true); if (config === undefined) return false;
    const component = kind === 'recap' || kind === 'finalize' ? 'formation' : kind === 'memory_review' ? 'memory' : kind;
    return this.enabled(component) && (kind !== 'memory_review' || config.memory.enabled && config.memory.review.enabled) && (kind !== 'dream' || config.dream.enabled);
  }
  private enabled(name: RuntimeComponent): boolean { return (this.components.get(name)?.size ?? 0) > 0; }
  choices() {
    return Object.entries(upstreamsOf(this.base.config)).map(([key, item]) => ({ key, name: item.name || key, agentId: item.agentId, enabled: item.enabled, mode: item.routerEndpoint ? 'team' as const : 'solo' as const }));
  }
  config(key: string, includeDisabled = false): ResolvedConfig | undefined {
    const profiles = upstreamsOf(this.base.config);
    const mapped = profiles[key] === undefined ? Object.keys(profiles).find((name) => profiles[name]?.legacyKey === key) : key;
    return mapped === undefined ? undefined : resolveUpstream(this.base.config, mapped, includeDisabled);
  }
  private forSession(header: SessionHeader): ResolvedConfig | undefined {
    const config = this.config(this.key(header));
    const running = runningConfiguration(header);
    return config !== undefined && running !== undefined && identityOf(running) === identityOf(config) ? running : config;
  }
  private runtimeId(key: string, config: ResolvedConfig): string {
    return key + '@' + createHash('sha256').update(JSON.stringify([config.home, config.agentId, config.team, config.llm])).digest('hex');
  }
  private prefer(header: SessionHeader): void {
    if (isSubagent(header) || !this.allowed(header)) return;
    const config = this.forSession(header);
    if (config !== undefined) this.preferredWorkers.set(identityOf(config), this.runtimeId(this.key(header), config));
  }
  private readyFor(header: SessionHeader): Runtime | undefined {
    const config = this.forSession(header);
    return config === undefined ? undefined : this.ready.get(this.runtimeId(this.key(header), config));
  }
  backgroundSelection(config: ResolvedConfig) {
    const identity = identityOf(config);
    const key = this.choices().find((choice) => { const current = this.config(choice.key); return current !== undefined && identityOf(current) === identity; })?.key;
    return key === undefined ? undefined : { schemaVersion: 1 as const, key, identity, prepared: true };
  }
  private selected(header: SessionHeader) {
    return sessionSelection(this.ctx, header);
  }
  private defaultFor(): string { return defaultUpstream(this.base.config); }
  sessionView(header: SessionHeader, events?: readonly SessionEvent[]): Promise<SessionView> {
    return Promise.resolve(this.view(header, events));
  }
  key(header: SessionHeader): string {
    const key = this.selected(header)?.key ?? (this.base.config.upstreams === undefined ? (this.base.mode === 'team' ? 'legacy' : 'personal') : this.defaultFor());
    const profiles = upstreamsOf(this.base.config);
    return profiles[key] === undefined ? Object.keys(profiles).find((name) => profiles[name]?.legacyKey === key) ?? key : key;
  }
  isBase(key: string): boolean { return key === '' || this.base.config.upstreams === undefined && key === (this.base.mode === 'team' ? 'legacy' : 'personal'); }
  allowed(header: SessionHeader): boolean {
    const selected = this.selected(header);
    if (selected === undefined) return this.base.config.upstreams === undefined ? sessionAllowed(this.ctx, this.base.config, header) : Object.keys(this.base.config.upstreams).length === 0;
    const config = this.config(selected.key);
    return config !== undefined && selected.identity === identityOf(config) && config.agentId !== '';
  }
  unbound(header: SessionHeader, events?: readonly SessionEvent[]): boolean { return !this.allowed(header) && sessionUnbound(this.ctx, header, events); }
  chatAllowed(header: SessionHeader): boolean { return this.allowed(header) || this.unbound(header); }
  async knowledge(header: SessionHeader): Promise<AcnKnowledge> {
    await this.pending;
    if (!this.allowed(header)) throw new JobError('identity', this.unbound(header) ? unboundSession : '团队连接不可用或身份已改变，请检查连接，或新建会话。');
    const key = this.key(header);
    return this.isBase(key) ? this.base : (await this.ensure(key, header.cwd, this.forSession(header))).knowledge;
  }
  async service(header: SessionHeader) {
    await this.pending;
    if (!this.allowed(header)) throw new JobError('identity', this.unbound(header) ? unboundSession : '当前会话的知识身份不可用。');
    const key = this.key(header);
    if (!this.isBase(key)) {
      const runtime = await this.ensure(key, header.cwd, this.forSession(header));
      return { knowledge: runtime.knowledge, formation: runtime.components.has('formation') ? runtime.formation : undefined, inbox: runtime.components.has('inbox') ? runtime.inbox : undefined, dream: runtime.components.has('dream') ? runtime.dream : undefined, memory: runtime.components.has('memory') ? runtime.memory : undefined };
    }
    return { knowledge: this.base, formation: this.ctx.get('acnFormation'), inbox: this.ctx.get('acnInbox'), dream: this.ctx.get('acnDream'), memory: this.ctx.get('acnMemory') };
  }
  async activate(key: string): Promise<AcnKnowledge> {
    await this.pending;
    const config = this.config(key);
    if (config === undefined || config.agentId === '') throw new JobError('connection', '知识身份不可用，请恢复连接后重试。');
    this.preferredWorkers.set(identityOf(config), this.runtimeId(key, config));
    return this.isBase(key) ? this.base : (await this.ensure(key)).knowledge;
  }
  async dreamService(key: string): Promise<AcnDream | undefined> {
    await this.activate(key);
    if (this.isBase(key)) return this.ctx.get('acnDream');
    const runtime = await this.ensure(key);
    return runtime.components.has('dream') ? runtime.dream : undefined;
  }
  registerBaseline(refresh: (id: string, fetchOverview?: boolean) => Promise<void>, render: (header: SessionHeader) => Record<string, string>): () => void {
    this.baselines.add(refresh); this.baselineRenderers.set(refresh, render);
    return () => { this.baselines.delete(refresh); this.baselineRenderers.delete(refresh); };
  }
  private hasUser(header: SessionHeader): boolean {
    const session = this.ctx.sessions.get(header.id);
    return session === undefined || session.snapshotEvents().some((event) => event.type === 'user/message' && event.data.source.kind === 'user');
  }
  private selectionLocked(header: SessionHeader, events?: readonly SessionEvent[]): boolean {
    const history = events ?? this.ctx.sessions.get(header.id)?.snapshotEvents();
    // 空白草稿可初始化；派生历史和已经发起的工作不能借初始化绕过身份边界。
    return history === undefined || header.isSeeded === true || header.parentSession !== undefined || isSubagent(header)
      || this.unbound(header, history) && !sessionEligible(this.ctx, header, history) || sessionHasWork(history);
  }
  view(header: SessionHeader, events?: readonly SessionEvent[]): SessionView {
    if (events !== undefined) restoreSessionBinding(header, events);
    const state = this.syncs.get(header.id);
    const available = this.allowed(header);
    const unbound = this.unbound(header, events);
    const key = unbound ? '' : this.key(header);
    const active = unbound ? undefined : this.forSession(header); const current = this.config(key);
    const configurationChanged = active !== undefined && current !== undefined && JSON.stringify(active.team) !== JSON.stringify(current.team);
    let message = state?.message ?? '';
    if (unbound) message = this.selectionLocked(header, events) ? unboundSession : '本会话尚未启用 ACN，可直接聊天，或在首条消息前选择工作配置。';
    else if (!available) message = !this.selectionLocked(header, events) ? '请从 ACN 菜单选择可用的工作配置，初始化当前空白会话。' : '工作配置已停用、缺失或 Agent ID 已改变；请在设置中恢复同一配置及原 Agent ID，或使用新会话。';
    else if (configurationChanged && message === '') message = '已保存新连接，当前会话仍使用启动时的配置。';
    else if (message === '' && this.selected(header)?.prepared === false) message = '上次同步未完成，可继续本地工作或重试同步。';
    return {
      sessionId: header.id, key, name: this.choices().find((item) => item.key === key)?.name ?? '选择工作配置',
      activeMode: active?.team.routerEndpoint ? 'team' : 'solo', configurationChanged, available,
      locked: this.selectionLocked(header, events),
      explicitSelection: this.selected(header) !== undefined, needsPreparation: this.syncTasks.has(header.id),
      phase: unbound ? 'unbound' : !available ? 'blocked' : this.syncTasks.has(header.id) ? 'syncing' : state?.phase ?? (this.selected(header)?.prepared === false ? 'failed' : 'ready'), message,
      choices: this.choices(), defaultConnection: this.defaultFor(),
      showCompletion: this.base.config.showCompletion,
    };
  }
  async select(header: SessionHeader, key: string): Promise<SessionView> {
    await this.pending;
    if (this.selectionLocked(header)) throw new JobError('bound', '会话开始后不能切换知识归属，请新建会话。');
    if (this.syncs.get(header.id)?.phase === 'syncing') throw new JobError('busy', '收件同步仍在进行，可取消等待后重试。');
    const config = this.config(key);
    if (config === undefined || config.agentId === '') throw new JobError('connection', '请先配置可用身份和团队连接。');
    const attached = this.attached.get(header.id); const previous = attached === undefined ? undefined : this.ready.get(attached);
    if (previous !== undefined) await previous.catalog.flush(header.id);
    // 等待旧目录落盘时首轮可能已开始；检查到持久化改绑必须在同一同步片段完成。
    if (this.selectionLocked(header)) throw new JobError('bound', '会话开始后不能切换知识归属，请新建会话。');
    const session = this.ctx.sessions.get(header.id);
    if (session === undefined) throw new JobError('session', '会话已关闭，请重新打开。');
    if (previous !== undefined) { previous.formation.disposed(header.id); previous.memories.forget(header.id); previous.catalog.clear(header.id); this.attached.delete(header.id); }
    // 先持久化归属再访问知识；收件失败只降级本地工作，不改绑其他配置。
    appendPluginRecord(session, 'plugin:acn/team-selection', { schemaVersion: 1, key, identity: identityOf(config), prepared: config.team.routerEndpoint === '' });
    rememberConfiguration(header, config); this.prefer(header); this.instructions.delete(header.id);
    if (!this.isBase(key)) await this.ensure(key, header.cwd, config);
    if (config.team.routerEndpoint !== '') await this.sync(header);
    else this.syncs.set(header.id, { phase: 'ready', message: '单人模式已就绪，不连接团队服务。' });
    if (config.team.routerEndpoint === '' && this.syncs.get(header.id)?.phase !== 'failed' && this.key(header) === key) {
      if (this.isBase(key)) for (const refresh of this.baselines) await refresh(header.id);
      else await this.attach(header, 'clear');
    }
    return this.view(header);
  }
  async cancel(header: SessionHeader): Promise<void> {
    const preparing = this.syncTasks.get(header.id);
    if (preparing === undefined) return;
    const state = this.syncs.get(header.id);
    state?.controller?.abort();
    if (state !== undefined) state.message = '正在结束同步并准备本地知识，已持久化的收件保留。';
    await preparing;
  }
  sync(header: SessionHeader): Promise<void> {
    if (this.syncTasks.has(header.id)) return Promise.reject(new JobError('busy', '收件同步仍在进行。'));
    const task = this.synchronize(header);
    this.syncTasks.set(header.id, task);
    const finish = () => { if (this.syncTasks.get(header.id) === task) this.syncTasks.delete(header.id); };
    void task.then(finish, finish);
    return task;
  }
  private async synchronize(header: SessionHeader): Promise<void> {
    const hadUserAtStart = this.hasUser(header);
    if (this.syncs.get(header.id)?.phase === 'syncing') throw new JobError('busy', '收件同步仍在进行。');
    const selectedKey = this.key(header);
    if (this.base.config.upstreams === undefined && selectedKey === 'personal') throw new JobError('connection', '单人模式没有团队收件箱。');
    const controller = new AbortController();
    const state: SyncState = { phase: 'syncing', message: '正在同步团队收件并准备本地知识…', controller };
    this.syncs.set(header.id, state);
    try {
      const services = await this.service(header);
      if (services.inbox === undefined || services.knowledge.jobs === null) throw new JobError('unavailable', '收件处理器不可用，请启用对应插件组件。');
      // 首次收件可能早于首个模型请求；沿用模型时从真实会话选项准备后台路由。
      const agent = this.ctx.agents.get(header.id);
      if (!services.knowledge.config.llm.provider && agent !== undefined) {
        let pending: { provider: string; model: string } | undefined;
        let last: { provider: string; model: string } | undefined;
        for (const event of agent.session.snapshotEvents()) {
          if (event.type === 'model/selection') pending = { provider: event.data.provider, model: event.data.model };
          if (event.type === 'request/header') {
            last = { provider: event.data.header.config.provider, model: event.data.header.config.model };
            if (pending?.provider === last.provider && pending.model === last.model) pending = undefined;
          }
        }
        const route = pending ?? last ?? RouteSchema.safeParse({ provider: agent.options.provider, model: agent.options.model }).data;
        if (route !== undefined) { const context = services.knowledge.context(); await withFileLock(`${context.paths.lastRoute}.lock`, () => writeYamlAtomic(context.paths.lastRoute, route, RouteSchema, context.logger)); }
      }
      let routerFailed = false;
      if (services.knowledge.team !== null) {
        const team = services.knowledge.team;
        try { await team.request('router', () => team.router.overview(controller.signal)); } catch { routerFailed = true; }
      }
      const report = await services.inbox.request(controller.signal, header.id);
      const deadline = Date.now() + services.knowledge.config.llm.timeoutMs;
      for (;;) {
        controller.signal.throwIfAborted();
        const job = (await services.knowledge.jobs.queue.list()).find((item) => item.id === report.jobId);
        if (job?.state === 'failed') throw new JobError('inbox', job.lastError ?? '收件内化失败，请检查知识模型后重试。');
        if (job?.state === 'succeeded') break;
        if (Date.now() >= deadline) throw new JobError('timeout', '收件处理仍在后台进行，请稍后重试同步并查看处理活动。');
        await new Promise<void>((resolve) => { const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, 100); controller.signal.addEventListener('abort', finish, { once: true }); });
      }
      controller.signal.throwIfAborted();
      if (this.key(header) !== selectedKey) throw new JobError('superseded', '同步已被新的选择取代。');
      controller.signal.throwIfAborted();
      const session = this.ctx.sessions.get(header.id); const selection = this.selected(header);
      if (session !== undefined && selection !== undefined && this.key(header) === selectedKey) appendPluginRecord(session, 'plugin:acn/team-selection', { ...selection, prepared: true });
      state.phase = routerFailed || report.warnings.length > 0 ? 'failed' : 'ready';
      state.message = [routerFailed ? 'Router 概览暂不可用。' : '', report.warnings.length > 0 ? 'Maintainer 收件或确认未完成。' : `收件同步完成：拉取 ${report.pulled} 条。`, '本地收件已处理，可继续使用本地知识。'].filter(Boolean).join(' ');
    } catch (error) {
      state.phase = 'failed'; state.message = controller.signal.aborted ? '已取消同步等待，已持久化的收件保留，可继续使用本地知识。' : (error instanceof JobError ? error.message : '同步失败，请检查 Router、Maintainer 地址、团队鉴权密钥、知识模型和本地存储后重试。') + ' 可继续使用本地知识。';
    } finally {
      delete state.controller;
      const selectedConfig = this.forSession(header);
      const missingAttachment = !this.isBase(this.key(header)) && selectedConfig !== undefined && this.attached.get(header.id) !== this.runtimeId(this.key(header), selectedConfig);
      if (this.allowed(header) && (!hadUserAtStart || missingAttachment)) {
        if (this.isBase(this.key(header))) for (const refresh of this.baselines) await refresh(header.id, state.phase !== 'failed');
        else await this.attach(header, hadUserAtStart ? 'resume' : 'clear', false);
      }
    }
  }
  private ensure(key: string, workspace?: string, selected?: ResolvedConfig): Promise<Runtime> {
    const config = selected ?? this.config(key);
    if (config === undefined || this.closed) return Promise.reject(new JobError('connection', '团队连接不可用。'));
    const runtimeId = this.runtimeId(key, config);
    const previous = this.runtimes.get(runtimeId); const ready = this.ready.get(runtimeId);
    const ownsCurrent = this.preferredWorkers.get(identityOf(config)) === runtimeId;
    if (previous !== undefined && (!ownsCurrent || ready === undefined || !this.retiredWorkers.has(ready))) return previous;
    const creating = this.starting.then(async () => {
      if (ready !== undefined) { this.ready.delete(runtimeId); await ready.close(); this.retiredWorkers.delete(ready); }
      return this.create(config, workspace, ownsCurrent);
    });
    this.starting = creating.then(() => {}, () => {});
    this.runtimes.set(runtimeId, creating);
    void creating.then((runtime) => { this.ready.set(runtimeId, runtime); }, () => {});
    void creating.catch(() => { if (this.runtimes.get(runtimeId) === creating) this.runtimes.delete(runtimeId); });
    return creating;
  }
  private async create(config: ResolvedConfig, workspace?: string, current = true): Promise<Runtime> {
    const knowledge = new AcnKnowledge(config, this.ctx.logger, teamCredentials(this.ctx)); await knowledge.initialize();
    if (workspace !== undefined) await writeYamlAtomic(knowledge.context().paths.dreamWorkspace, workspace, z.string(), knowledge.logger);
    const render = await loadPromptRenderer(); this.render = render; const backend = structuredBackend(this.ctx);
    const catalog = new KnowledgeSessions(knowledge); const memory = new AcnMemory(knowledge);
    const memories = new MemorySessions(memory, render); const review = new MemoryReview(memory, backend, render);
    const formation = new AcnFormation(knowledge, backend, render, {}, knowledge.jobs ?? undefined, async (route) => { try { await this.ctx.llm.prepareCall(route, AbortSignal.timeout(15_000)); return true; } catch { return false; } });
    const inbox = new AcnInbox(knowledge, backend, render);
    const dream = new AcnDream(knowledge, backend, render, () => this.pending, { workspace: () => readYamlOr(knowledge.context().paths.dreamWorkspace, z.string(), () => process.cwd()), run: autonomousDreamRunner(this.ctx) });
    const uploads = new UploadScheduler(knowledge);
    const runtime: Runtime = { knowledge, formation, inbox, dream, memory, catalog, memories, review, uploads, components: new Set(), setComponent: async (component, enabled) => {
      if (runtime.components.has(component) === enabled) return;
      if (enabled) {
        if (component === 'formation') { runtime.formation = new AcnFormation(knowledge, backend, render, {}, knowledge.jobs ?? undefined); await runtime.formation.start(); }
        if (component === 'inbox') { runtime.inbox = new AcnInbox(knowledge, backend, render); await runtime.inbox.start(); }
        if (component === 'dream') { runtime.dream = new AcnDream(knowledge, backend, render, () => this.pending, { workspace: () => readYamlOr(knowledge.context().paths.dreamWorkspace, z.string(), () => process.cwd()), run: autonomousDreamRunner(this.ctx) }); await runtime.dream.start(); }
        if (component === 'memory') { runtime.review = new MemoryReview(memory, backend, render); await runtime.review.start(); }
        runtime.components.add(component);
        for (const agent of this.ctx.agents.list()) if (this.allowed(agent.session.header) && this.readyFor(agent.session.header) === runtime) await this.attach(agent.session.header, 'resume', false);
      } else {
        runtime.components.delete(component);
        if (component === 'formation') await runtime.formation.close();
        if (component === 'inbox') await runtime.inbox.close();
        if (component === 'dream') await runtime.dream.close();
        if (component === 'memory') await runtime.review.close();
        if (component === 'prompt') await runtime.catalog.flush();
      }
    }, close: async () => { await runtime.formation.close(); await runtime.inbox.close(); await runtime.dream.close(); await runtime.review.close(); await catalog.flush(); await uploads.close(); await knowledge.jobs?.close(); await knowledge.team?.close(); } };
    try {
      const identity = identityOf(config);
      const previous = this.workers.get(identity);
      if (previous !== undefined) {
        if (current) { await previous.uploads.close(); await previous.knowledge.jobs?.close(); this.retiredWorkers.add(previous); }
        else { await knowledge.jobs?.close(); await uploads.close(); this.retiredWorkers.add(runtime); }
      }
      if (current || previous === undefined) this.workers.set(identity, runtime);
      await this.ctx.inject(['workspaceRegistry'], (child) => connectArchives(child, { beginArchive: (id, upper) => runtime.components.has('formation') ? runtime.formation.beginArchive(id, upper) : Promise.resolve(null), cancelArchive: (id) => runtime.formation.cancelArchive(id), archived: (id, upper) => runtime.formation.archived(id, upper), reconcileArchives: (ids) => runtime.formation.reconcileArchives(ids) }));
      for (const name of ['prompt', 'formation', 'inbox', 'dream', 'memory'] as const) {
        if (this.enabled(name) && (name !== 'memory' || config.memory.enabled)) {
          runtime.components.add(name);
          if (name === 'formation') await formation.start(); if (name === 'inbox') await inbox.start(); if (name === 'dream') await dream.start(); if (name === 'memory') await review.start();
        } else { if (name === 'formation') await formation.close(); if (name === 'inbox') await inbox.close(); if (name === 'dream') await dream.close(); if (name === 'memory') await review.close(); }
      }
      await knowledge.jobs?.start(); uploads.start();
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }
  private async freezeInstructions(header: SessionHeader, knowledge: AcnKnowledge): Promise<void> {
    if (this.base.config.upstreams === undefined || this.instructions.has(header.id)) return;
    const file = join(knowledge.context().paths.session(header.id), 'upstream-instructions.yaml');
    let text = await readYamlOr(file, z.string(), () => null);
    if (text === null && header.parentSession !== undefined) text = await readYamlOr(join(knowledge.context().paths.session(header.parentSession), 'upstream-instructions.yaml'), z.string(), () => null);
    if (text === null) {
      text = '';
      const requested = this.ctx.sessions.get(header.id)?.snapshotEvents().some((event) => event.type === 'request/header') ?? true;
      if (!requested) {
        try { text = await fs.readFile(join(resolve(agentHomePath(this.base.config.home, 'example'), '..', '..'), this.key(header), 'ACN.md'), 'utf8'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      }
      await writeYamlAtomic(file, text, z.string(), knowledge.logger);
    }
    this.instructions.set(header.id, text);
  }
  private async bind(header: SessionHeader): Promise<void> {
    if (this.base.config.upstreams === undefined || isEvidenceAgent(header)) return;
    const session = this.ctx.sessions.get(header.id);
    if (session === undefined) return;
    let selection = this.selected(header);
    if (selection === undefined && header.parentSession !== undefined) {
      const parent = this.ctx.sessions.get(header.parentSession);
      if (parent !== undefined && this.allowed(parent.header)) selection = this.selected(parent.header);
    }
    if (selection === undefined) {
      // 已绑定身份的格式迁移也适用于驻留会话；复用完整日志校验，不能据首条记录改绑。
      restoreSessionBinding(header, session.snapshotEvents());
      const key = this.choices().find((choice) => { const config = this.config(choice.key); return config !== undefined && config.agentId !== '' && sessionAllowed(this.ctx, config, header); })?.key;
      const config = key === undefined ? undefined : this.config(key);
      if (key !== undefined && config !== undefined) selection = { schemaVersion: 1, key, identity: identityOf(config), prepared: true };
    }
    if (selection === undefined && session.firstLiveSeq === 0 && sessionEligible(this.ctx, header) && !sessionHasWork(session.snapshotEvents()) && !header.isSeeded && header.parentSession === undefined) {
      const recent = await recentProjectSelection(this.ctx, header);
      const previous = recent === undefined ? undefined : this.config(recent.key);
      const key = recent !== undefined && previous !== undefined && recent.identity === identityOf(previous) ? recent.key : this.defaultFor();
      const config = this.config(key);
      if (config !== undefined) selection = { schemaVersion: 1, key, identity: identityOf(config), prepared: true };
    }
    if (selection === undefined) return;
    if (this.selected(header) === undefined) {
      appendPluginRecord(session, 'plugin:acn/team-selection', selection);
      // 热重载时事件观察器可能尚未注册，落盘后也须同步恢复选择缓存。
      restoreSessionBinding(header, session.snapshotEvents());
    }
    const config = this.config(selection.key);
    if (config !== undefined && identityOf(config) === selection.identity && runningConfiguration(header) === undefined) rememberConfiguration(header, config);
  }
  private async attach(header: SessionHeader, source: 'startup' | 'clear' | 'resume' | 'compact', synchronize = true, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.allowed(header) || this.isBase(this.key(header)) || isEvidenceAgent(header)) return;
    const ready = this.ensure(this.key(header), header.cwd, this.forSession(header));
    const runtime = signal === undefined ? await ready : await abortable(ready, signal);
    if (synchronize && this.base.config.upstreams !== undefined && (source === 'startup' || source === 'resume') && !isSubagent(header) && runtime.components.has('inbox') && runtime.knowledge.config.inbox.pullOnSessionStart) {
      await this.sync(header);
      if (!this.hasUser(header)) return;
    }
    await this.freezeInstructions(header, runtime.knowledge);
    if (runtime.components.has('prompt')) await runtime.catalog.freeze(header.id, source, header.parentSession, this.syncs.get(header.id)?.phase !== 'failed', signal);
    if (!isSubagent(header)) {
      if (runtime.components.has('memory') && runtime.knowledge.config.memory.enabled) { await runtime.memories.freeze(header.id, source, header.parentSession); await runtime.review.attach(header.id, source); }
      if (runtime.components.has('formation')) { runtime.formation.attach(header.id); if (this.ctx.agents.get(header.id)?.status === 'running') runtime.formation.running(header.id); }
      if (header.cwd !== undefined) await writeYamlAtomic(runtime.knowledge.context().paths.dreamWorkspace, header.cwd, z.string(), runtime.knowledge.logger);
      if (runtime.components.has('dream')) runtime.dream.trigger();
    }
    this.attached.set(header.id, this.runtimeId(this.key(header), runtime.knowledge.config));
  }
  private async prepareSession(header: SessionHeader, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const preparing = Promise.all([this.pending, this.syncTasks.get(header.id)]);
    if (signal === undefined) await preparing; else await abortable(preparing, signal);
    signal?.throwIfAborted();
    if (this.unbound(header)) {
      // 未启用的会话不向模型展示 ACN 工具；最终门禁仍独立拒绝直接调用。
      const agent = this.ctx.agents.get(header.id);
      const deny = ['claim', 'consult_router', 'memory'].filter((name) => this.ctx.tools.get(name) !== undefined);
      const previous = this.unboundTools.get(header.id);
      if (agent !== undefined && previous?.names !== deny.join(',')) {
        previous?.release(); this.unboundTools.delete(header.id);
        if (deny.length > 0) this.unboundTools.set(header.id, { names: deny.join(','), release: agent.ctx.tools.restrict({ deny }) });
      }
      return;
    }
    if (!this.allowed(header)) throw new JobError('identity', '会话的知识归属不可用，请恢复原连接或新建会话。');
    const state = this.syncs.get(header.id);
    if (state?.phase === 'syncing') throw new JobError('sync', '收件同步仍在进行，可取消等待后继续本地工作。');
    if (!this.isBase(this.key(header))) {
      const ready = this.ensure(this.key(header), header.cwd, this.forSession(header));
      const runtime = signal === undefined ? await ready : await abortable(ready, signal);
      if (this.attached.get(header.id) !== this.runtimeId(this.key(header), runtime.knowledge.config)) await this.attach(header, 'resume', false, signal);
      // 领域组件可能在 Agent 存活期间重载；请求准入前从持久快照恢复缺失缓存。
      if (runtime.components.has('prompt') && runtime.catalog.catalog(header.id) === '') await runtime.catalog.freeze(header.id, 'resume', header.parentSession, true, signal);
      if (runtime.components.has('memory') && !isSubagent(header) && runtime.memories.text(header.id) === '') { await runtime.memories.freeze(header.id, 'resume', header.parentSession); await runtime.review.attach(header.id, 'resume'); }
    }
  }
  private async install(ctx: Context): Promise<void> {
    const forAgent = (header: SessionHeader | undefined, component: RuntimeComponent) => { const runtime = header === undefined || !this.allowed(header) || this.isBase(this.key(header)) ? undefined : this.readyFor(header); return runtime?.components.has(component) ? runtime : undefined; };
    const contributions: PromptSection[] = [
      { name: 'acn:upstream-instructions', order: 730, interpolate: false, text: ({ agent }) => agent === undefined || isEvidenceAgent(agent.session.header) || !this.allowed(agent.session.header) ? '' : this.instructions.get(agent.session.id) ?? '' },
      { name: 'acn:connection-knowledge', order: 700, interpolate: false, text: ({ agent }) => { const runtime = forAgent(agent?.session.header, 'prompt'); return runtime === undefined ? '' : this.render?.('knowledge.j2', { agent_id: runtime.knowledge.agentId, team: runtime.knowledge.mode === 'team' }) ?? ''; } },
      { name: 'acn:connection-catalog', order: 710, interpolate: false, text: ({ agent }) => forAgent(agent?.session.header, 'prompt')?.catalog.catalog(agent?.session.id ?? '') ?? '' },
      { name: 'acn:connection-memory', order: 720, interpolate: false, text: ({ agent }) => agent === undefined || isSubagent(agent.session.header) ? '' : forAgent(agent.session.header, 'memory')?.memories.text(agent.session.id) ?? '' }
    ];
    for (const section of contributions) ctx.systemPrompt.section(section);
    // 宿主在 pre-step 之前已经组装系统段落，准备完成后须刷新本次的插件贡献。
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const header = context.agent?.session.header;
      if (header === undefined || isEvidenceAgent(header)) return next();
      if (this.unbound(header)) {
        await this.prepareSession(header, context.signal);
        const assembly = await next();
        // 本轮工具 schema 可能已在门禁前收集，过滤它；后续组装由作用域限制处理。
        return { ...assembly, tools: assembly.tools.filter((tool) => !['claim', 'consult_router', 'memory'].includes(tool.name)) };
      }
      if (!this.allowed(header)) return next();
      await this.prepareSession(header, context.signal); context.signal?.throwIfAborted();
      const assembly = await next();
      const baseSections = this.isBase(this.key(header)) ? Object.assign({}, ...[...this.baselineRenderers.values()].map((render) => render(header))) as Record<string, string> : {};
      return { ...assembly, sections: assembly.sections.map((section) => {
        if (Object.hasOwn(baseSections, section.name)) return { ...section, text: baseSections[section.name] ?? '' };
        const definition = contributions.find((item) => item.name === section.name);
        return definition === undefined ? section : { ...section, text: typeof definition.text === 'function' ? definition.text(context) : definition.text };
      }) };
    });
    ctx.on('agent/created', async ({ agent, source, signal }) => { if (source === 'startup') markSessionEligible(ctx, agent.session.header); await this.bind(agent.session.header); this.prefer(agent.session.header); await this.attach(agent.session.header, source, true, signal); if (source === 'resume') this.resumed.add(agent.session.id); });
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (isEvidenceAgent(agent.session.header)) return next();
      await this.prepareSession(agent.session.header, signal);
      if (this.unbound(agent.session.header)) return next();
      if (this.resumed.delete(agent.session.id) && this.base.config.upstreams === undefined && !isSubagent(agent.session.header) && !this.isBase(this.key(agent.session.header))) {
        const runtime = await this.ensure(this.key(agent.session.header), agent.session.header.cwd, this.forSession(agent.session.header));
        if (runtime.components.has('inbox') && runtime.knowledge.mode === 'team' && runtime.knowledge.config.inbox.pullOnSessionStart) await runtime.inbox.enqueue(true, agent.session.id);
      }
      const decision = await next();
      if (decision.kind === 'reject' || this.isBase(this.key(agent.session.header))) return decision;
      const runtime = await this.ensure(this.key(agent.session.header), agent.session.header.cwd, this.forSession(agent.session.header)); const notice = runtime.components.has('prompt') ? await runtime.catalog.prepare(agent.session.id, signal) : null; signal.throwIfAborted();
      if (notice === null) return decision;
      const message = createUserMessage({ content: [{ type: 'text', text: notice.text }], source: { kind: 'acn-claim-changes' } });
      this.admissions.set(message.id, { id: agent.session.id, runtime, notice });
      return { ...decision, messages: [...decision.messages, message] };
    });
    ctx.on('session/event', (session, event) => {
      const admission = event.type === 'user/message' ? this.admissions.get(event.data.id) : undefined;
      if (admission?.id === session.id && event.type === 'user/message') { this.admissions.delete(event.data.id); admission.runtime.catalog.admitted(session.id, admission.notice); }
      if (!this.allowed(session.header) || this.isBase(this.key(session.header)) || isSubagent(session.header)) return;
      const runtime = this.readyFor(session.header); if (runtime === undefined) return;
      const projection = projectEvent(event); const until = compactionEnd(event);
      if (runtime.components.has('formation') && (Object.keys(projection).length > 0 || until !== undefined)) runtime.formation.capture(session.id, projection, until);
      const user = event.type === 'user/message' && event.data.source.kind === 'user';
      if (runtime.components.has('memory') && runtime.knowledge.config.memory.enabled) runtime.review.capture(session.id, { seq: event.seq, projection: event.type === 'user/message' && !user ? {} : projection, user, completed: event.type === 'turn/end' && event.data.reason.kind === 'completed', ended: event.type === 'turn/end' });
      if (projection.route !== undefined) this.schedule(() => withFileLock(`${runtime.knowledge.context().paths.lastRoute}.lock`, () => writeYamlAtomic(runtime.knowledge.context().paths.lastRoute, projection.route, RouteSchema, runtime.knowledge.logger)));
    });
    ctx.on('agent/status', ({ agent, status }) => { if (!this.allowed(agent.session.header) || this.isBase(this.key(agent.session.header)) || isSubagent(agent.session.header)) return; const runtime = this.readyFor(agent.session.header); if (runtime === undefined) return; if (status === 'running') runtime.formation.running(agent.session.id); else runtime.formation.idle(agent.session.id); });
    ctx.on('agent/disposed', ({ agent }) => { this.unboundTools.get(agent.session.id)?.release(); this.unboundTools.delete(agent.session.id); const key = this.attached.get(agent.session.id); if (key === undefined) return; const runtime = this.ready.get(key); if (runtime === undefined) return; runtime.formation.disposed(agent.session.id); runtime.memories.forget(agent.session.id); this.schedule(() => runtime.catalog.forget(agent.session.id)); this.attached.delete(agent.session.id); this.instructions.delete(agent.session.id); forgetConfiguration(agent.session.header); });
    // 配置重载时宿主可能保留 Agent；不能只依赖下一次 created 事件恢复冻结上下文。
    const existing = ctx.agents.list();
    for (const agent of existing) { await this.bind(agent.session.header); }
    // 先恢复最近实际启动的实例所拥有的后台管线，保存配置本身不激活新团队。
    existing.sort((left, right) => configurationActivation(right.session.header) - configurationActivation(left.session.header));
    for (const agent of existing) {
      const config = this.forSession(agent.session.header);
      if (config !== undefined && !this.preferredWorkers.has(identityOf(config))) this.prefer(agent.session.header);
    }
    for (const agent of existing) { await this.attach(agent.session.header, 'resume', false); this.resumed.add(agent.session.id); }
  }
  private schedule(action: () => Promise<unknown>): void { if (this.closed) return; this.pending = this.pending.then(action).then(() => {}).catch(() => { this.ctx.logger.warn('Could not persist a connection runtime event.'); }); }
  async close(): Promise<void> { this.closed = true; for (const entry of this.unboundTools.values()) entry.release(); this.unboundTools.clear(); for (const state of this.syncs.values()) state.controller?.abort(); await this.pending; await Promise.allSettled([...this.syncTasks.values()]); const runtimes = await Promise.allSettled([...this.runtimes.values()]); for (const result of runtimes) if (result.status === 'fulfilled') await result.value.close(); }
}
