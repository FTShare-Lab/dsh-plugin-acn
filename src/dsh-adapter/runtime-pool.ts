// 连接各自拥有领域服务和私有存储；会话记录决定路由，界面切换不会重绑定已开始的工作。
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { resolveConfig } from '../config.js';
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
import { autonomousDreamRunner } from './dream-agent.js';
import { compactionEnd, projectEvent } from './formation.js';
import { identityOf, sessionAllowed, sessionSelection, restoreSessionBinding } from './session-binding.js';
import { connectArchives } from './formation-archive.js';
import { readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { withFileLock } from '../store/lock.js';
import { RouteSchema } from '../formation/transcript.js';
import { JobError } from '../worker/types.js';
import type { SessionView } from '../interaction.js';

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
  private render: Awaited<ReturnType<typeof loadPromptRenderer>> | undefined;
  private readonly syncs = new Map<string, SyncState>();
  private readonly baselines = new Set<(id: string) => Promise<void>>();
  private readonly admissions = new Map<string, { id: string; runtime: Runtime; notice: ChangeAdmission }>();
  private readonly resumed = new Set<string>();
  private readonly attached = new Map<string, string>();
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
  private enabled(name: RuntimeComponent): boolean { return (this.components.get(name)?.size ?? 0) > 0; }
  choices() {
    const config = this.base.config;
    return [
      { key: 'personal', name: '单人模式', agentId: config.agentId, enabled: true, mode: 'solo' as const },
      ...(this.base.mode === 'team' ? [{ key: 'legacy', name: '原有团队连接', agentId: config.agentId, enabled: config.legacyEnabled, mode: 'team' as const }] : []),
      ...config.connections.map((item) => ({ key: item.id, name: item.name, agentId: item.agentId, enabled: item.enabled, mode: 'team' as const })),
    ];
  }
  config(key: string, includeDisabled = false): ResolvedConfig | undefined {
    const base = this.base.config;
    if (key === 'legacy') return this.base.mode === 'team' && (base.legacyEnabled || includeDisabled) ? base : undefined;
    if (key === 'personal') return this.base.mode === 'solo' ? base : resolveConfig({ ...base, home: join(base.home, 'personal'), team: { ...base.team, routerEndpoint: '', maintainerEndpoint: '', keyEnv: '' }, connections: [], defaultConnection: '' });
    const connection = base.connections.find((item) => item.id === key && (item.enabled || includeDisabled));
    if (connection === undefined) return undefined;
    return resolveConfig({ ...base, agentId: connection.agentId, home: join(base.home, 'connections', connection.id), sessionEpoch: 0, legacyEnabled: true, connections: [], defaultConnection: '', team: { ...base.team, routerEndpoint: connection.routerEndpoint, maintainerEndpoint: connection.maintainerEndpoint, keyEnv: connection.keyEnv, timeoutMs: connection.timeoutMs } });
  }
  backgroundSelection(config: ResolvedConfig) {
    const identity = identityOf(config);
    const key = this.choices().find((choice) => { const current = this.config(choice.key); return current !== undefined && identityOf(current) === identity; })?.key;
    return key === undefined ? undefined : { schemaVersion: 1 as const, key, identity, prepared: true };
  }
  private selected(header: SessionHeader) {
    return sessionSelection(this.ctx, header);
  }
  key(header: SessionHeader): string {
    return this.selected(header)?.key ?? (this.base.mode === 'team' ? 'legacy' : 'personal');
  }
  isBase(key: string): boolean { return key === (this.base.mode === 'team' ? 'legacy' : 'personal'); }
  allowed(header: SessionHeader): boolean {
    const selected = this.selected(header);
    if (selected === undefined) return sessionAllowed(this.ctx, this.base.config, header);
    const config = this.config(selected.key);
    return config !== undefined && selected.identity === identityOf(config) && config.agentId !== '';
  }
  async knowledge(header: SessionHeader): Promise<AcnKnowledge> {
    await this.pending;
    if (!this.allowed(header)) throw new JobError('identity', '团队连接不可用或身份已改变，请检查连接，或新建会话。');
    const key = this.key(header);
    return this.isBase(key) ? this.base : (await this.ensure(key, header.cwd)).knowledge;
  }
  async service(header: SessionHeader) {
    await this.pending;
    if (!this.allowed(header)) throw new JobError('identity', '当前会话的知识身份不可用。');
    const key = this.key(header);
    if (!this.isBase(key)) {
      const runtime = await this.ensure(key, header.cwd);
      return { knowledge: runtime.knowledge, formation: runtime.components.has('formation') ? runtime.formation : undefined, inbox: runtime.components.has('inbox') ? runtime.inbox : undefined, dream: runtime.components.has('dream') ? runtime.dream : undefined, memory: runtime.components.has('memory') ? runtime.memory : undefined };
    }
    return { knowledge: this.base, formation: this.ctx.get('acnFormation'), inbox: this.ctx.get('acnInbox'), dream: this.ctx.get('acnDream'), memory: this.ctx.get('acnMemory') };
  }
  async activate(key: string): Promise<AcnKnowledge> {
    await this.pending;
    const config = this.config(key);
    if (config === undefined || config.agentId === '') throw new JobError('connection', '知识身份不可用，请恢复连接后重试。');
    return this.isBase(key) ? this.base : (await this.ensure(key)).knowledge;
  }
  registerBaseline(refresh: (id: string) => Promise<void>): () => void { this.baselines.add(refresh); return () => { this.baselines.delete(refresh); }; }
  private hasUser(header: SessionHeader): boolean {
    const session = this.ctx.sessions.get(header.id);
    return session === undefined || session.snapshotEvents().some((event) => event.type === 'user/message' && event.data.source.kind === 'user');
  }
  view(header: SessionHeader, events?: readonly SessionEvent[]): SessionView {
    if (events !== undefined) restoreSessionBinding(header, events);
    const state = this.syncs.get(header.id);
    const available = this.allowed(header);
    const key = this.key(header);
    return { sessionId: header.id, key, name: this.choices().find((item) => item.key === key)?.name ?? '连接不可用', locked: (events === undefined ? this.hasUser(header) : events.some((event) => event.type === 'user/message' && event.data.source.kind === 'user')) || header.parentSession !== undefined || isSubagent(header), available, explicitSelection: this.selected(header) !== undefined, needsPreparation: this.selected(header)?.prepared === false,
      phase: !available ? 'blocked' : state?.phase ?? (this.selected(header)?.prepared === false ? 'failed' : 'ready'), message: !available ? (key === 'personal' ? '此会话的个人知识身份已改变；请新建会话使用当前身份。' : '团队连接已停用、删除或身份已改变；恢复原连接后可继续，其他团队请新建会话。') : state?.message ?? (this.selected(header)?.prepared === false ? '上次首次同步未完成，请重试同步后发送。' : ''), choices: this.choices(), defaultConnection: this.base.config.defaultConnection, showCompletion: this.base.config.showCompletion };
  }
  async select(header: SessionHeader, key: string): Promise<SessionView> {
    await this.pending;
    if (this.hasUser(header) || header.parentSession !== undefined || isSubagent(header)) throw new JobError('bound', '会话开始后不能切换知识归属，请新建会话。');
    if (this.syncs.get(header.id)?.phase === 'syncing') throw new JobError('busy', '收件同步仍在进行，可取消等待后重试。');
    const config = this.config(key);
    if (config === undefined || config.agentId === '') throw new JobError('connection', '请先配置可用身份和团队连接。');
    const session = this.ctx.sessions.get(header.id);
    if (session === undefined) throw new JobError('session', '会话已关闭，请重新打开。');
    // 准备完成前保留选择，失败时阻止首发；切换会话与重启都不能悄悄改到其他连接。
    appendPluginRecord(session, 'plugin:acn/team-selection', { schemaVersion: 1, key, identity: identityOf(config), prepared: config.team.routerEndpoint === '' });
    if (!this.isBase(key)) await this.ensure(key, header.cwd);
    if (config.team.routerEndpoint !== '') await this.sync(header);
    else this.syncs.set(header.id, { phase: 'ready', message: '单人模式已就绪，不连接团队服务。' });
    if (config.team.routerEndpoint === '' && this.syncs.get(header.id)?.phase !== 'failed' && this.key(header) === key) {
      if (this.isBase(key)) for (const refresh of this.baselines) await refresh(header.id);
      else await this.attach(header, 'clear');
    }
    return this.view(header);
  }
  cancel(header: SessionHeader): void {
    const state = this.syncs.get(header.id);
    if (state?.phase !== 'syncing' || state.controller === undefined) return;
    state.controller.abort();
    this.syncs.set(header.id, { phase: 'failed', message: '已取消等待，已持久化的收件保留。请重试同步，或在首发前选择单人模式。' });
  }
  async sync(header: SessionHeader): Promise<void> {
    if (this.syncs.get(header.id)?.phase === 'syncing') throw new JobError('busy', '收件同步仍在进行。');
    const selectedKey = this.key(header);
    if (selectedKey === 'personal') throw new JobError('connection', '单人模式没有团队收件箱。');
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
      if (services.knowledge.team !== null) {
        const team = services.knowledge.team;
        await team.request('router', () => team.router.overview(controller.signal));
      }
      const report = await services.inbox.request(controller.signal, header.id);
      if (report.warnings.length > 0) throw new JobError('connection', '团队收件未完整同步，请检查连接与认证后重试。');
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
      if (!this.hasUser(header)) {
        if (this.isBase(this.key(header))) for (const refresh of this.baselines) await refresh(header.id);
        else await this.attach(header, 'clear');
      }
      controller.signal.throwIfAborted();
      const session = this.ctx.sessions.get(header.id); const selection = this.selected(header);
      if (session !== undefined && selection !== undefined && this.key(header) === selectedKey) appendPluginRecord(session, 'plugin:acn/team-selection', { ...selection, prepared: true });
      state.phase = 'ready'; state.message = `收件同步完成：拉取 ${report.pulled} 条，知识将在新步骤中生效。`;
    } catch (error) {
      state.phase = 'failed'; state.message = error instanceof JobError ? error.message : '同步失败，请检查团队连接、认证环境变量和知识模型后重试。';
    } finally { delete state.controller; }
  }
  private ensure(key: string, workspace?: string): Promise<Runtime> {
    const previous = this.runtimes.get(key); if (previous !== undefined) return previous;
    const config = this.config(key);
    if (config === undefined || this.closed) return Promise.reject(new JobError('connection', '团队连接不可用。'));
    const creating = this.create(config, workspace);
    this.runtimes.set(key, creating);
    void creating.then((runtime) => { this.ready.set(key, runtime); }, () => {});
    void creating.catch(() => { if (this.runtimes.get(key) === creating) this.runtimes.delete(key); });
    return creating;
  }
  private async create(config: ResolvedConfig, workspace?: string): Promise<Runtime> {
    const knowledge = new AcnKnowledge(config, this.ctx.logger); await knowledge.initialize();
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
        for (const agent of this.ctx.agents.list()) if (this.allowed(agent.session.header) && this.config(this.key(agent.session.header))?.home === config.home) await this.attach(agent.session.header, 'resume');
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
  private async attach(header: SessionHeader, source: 'startup' | 'clear' | 'resume' | 'compact'): Promise<void> {
    if (!this.allowed(header) || this.isBase(this.key(header)) || isEvidenceAgent(header)) return;
    const runtime = await this.ensure(this.key(header), header.cwd);
    if (runtime.components.has('prompt')) await runtime.catalog.freeze(header.id, source, header.parentSession);
    if (!isSubagent(header)) {
      if (runtime.components.has('memory') && runtime.knowledge.config.memory.enabled) { await runtime.memories.freeze(header.id, source, header.parentSession); await runtime.review.attach(header.id, source); }
      if (runtime.components.has('formation')) runtime.formation.attach(header.id);
      if (header.cwd !== undefined) await writeYamlAtomic(runtime.knowledge.context().paths.dreamWorkspace, header.cwd, z.string(), runtime.knowledge.logger);
      if (runtime.components.has('dream')) runtime.dream.trigger();
    }
    this.attached.set(header.id, this.key(header));
  }
  private async install(ctx: Context): Promise<void> {
    const forAgent = (header: SessionHeader | undefined, component: RuntimeComponent) => { const runtime = header === undefined || !this.allowed(header) || this.isBase(this.key(header)) ? undefined : this.ready.get(this.key(header)); return runtime?.components.has(component) ? runtime : undefined; };
    ctx.systemPrompt.section({ name: 'acn:connection-knowledge', order: 700, interpolate: false, text: ({ agent }) => { const runtime = forAgent(agent?.session.header, 'prompt'); return runtime === undefined ? '' : this.render?.('knowledge.j2', { agent_id: runtime.knowledge.agentId, team: runtime.knowledge.mode === 'team' }) ?? ''; } });
    ctx.systemPrompt.section({ name: 'acn:connection-catalog', order: 710, interpolate: false, text: ({ agent }) => forAgent(agent?.session.header, 'prompt')?.catalog.catalog(agent?.session.id ?? '') ?? '' });
    ctx.systemPrompt.section({ name: 'acn:connection-memory', order: 720, interpolate: false, text: ({ agent }) => agent === undefined || isSubagent(agent.session.header) ? '' : forAgent(agent.session.header, 'memory')?.memories.text(agent.session.id) ?? '' });
    ctx.on('agent/created', async ({ agent, source }) => { await this.attach(agent.session.header, source); if (source === 'resume') this.resumed.add(agent.session.id); });
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (isEvidenceAgent(agent.session.header)) return next();
      await this.pending;
      if (!this.allowed(agent.session.header)) throw new JobError('identity', '会话的知识归属不可用，请恢复原连接或新建会话。');
      const state = this.syncs.get(agent.session.id);
      if (this.selected(agent.session.header)?.prepared === false || !this.hasUser(agent.session.header) && state !== undefined && state.phase !== 'ready') throw new JobError('sync', state?.message ?? '首次收件同步未完成，请重试同步。');
      if (!this.isBase(this.key(agent.session.header))) {
        const runtime = await this.ensure(this.key(agent.session.header));
        // 领域组件可能在 Agent 存活期间重载；请求准入前从持久快照恢复缺失缓存。
        if (runtime.components.has('prompt') && runtime.catalog.catalog(agent.session.id) === '') await runtime.catalog.freeze(agent.session.id, 'resume', agent.session.header.parentSession);
        if (runtime.components.has('memory') && !isSubagent(agent.session.header) && runtime.memories.text(agent.session.id) === '') { await runtime.memories.freeze(agent.session.id, 'resume', agent.session.header.parentSession); await runtime.review.attach(agent.session.id, 'resume'); }
      }
      if (this.resumed.delete(agent.session.id) && !isSubagent(agent.session.header) && !this.isBase(this.key(agent.session.header))) {
        const runtime = await this.ensure(this.key(agent.session.header));
        if (runtime.components.has('inbox') && runtime.knowledge.mode === 'team' && runtime.knowledge.config.inbox.pullOnSessionStart) await runtime.inbox.enqueue(true, agent.session.id);
      }
      const decision = await next();
      if (decision.kind === 'reject' || this.isBase(this.key(agent.session.header))) return decision;
      const runtime = await this.ensure(this.key(agent.session.header)); const notice = runtime.components.has('prompt') ? await runtime.catalog.prepare(agent.session.id) : null; signal.throwIfAborted();
      if (notice === null) return decision;
      const message = createUserMessage({ content: [{ type: 'text', text: notice.text }], source: { kind: 'acn-claim-changes' } });
      this.admissions.set(message.id, { id: agent.session.id, runtime, notice });
      return { ...decision, messages: [...decision.messages, message] };
    });
    ctx.on('session/event', (session, event) => {
      const admission = event.type === 'user/message' ? this.admissions.get(event.data.id) : undefined;
      if (admission?.id === session.id && event.type === 'user/message') { this.admissions.delete(event.data.id); admission.runtime.catalog.admitted(session.id, admission.notice); }
      if (!this.allowed(session.header) || this.isBase(this.key(session.header)) || isSubagent(session.header)) return;
      const runtime = this.ready.get(this.key(session.header)); if (runtime === undefined) return;
      const projection = projectEvent(event); const until = compactionEnd(event);
      if (runtime.components.has('formation') && (Object.keys(projection).length > 0 || until !== undefined)) runtime.formation.capture(session.id, projection, until);
      const user = event.type === 'user/message' && event.data.source.kind === 'user';
      if (runtime.components.has('memory') && runtime.knowledge.config.memory.enabled) runtime.review.capture(session.id, { seq: event.seq, projection: event.type === 'user/message' && !user ? {} : projection, user, completed: event.type === 'turn/end' && event.data.reason.kind === 'completed', ended: event.type === 'turn/end' });
      if (projection.route !== undefined) this.schedule(() => withFileLock(`${runtime.knowledge.context().paths.lastRoute}.lock`, () => writeYamlAtomic(runtime.knowledge.context().paths.lastRoute, projection.route, RouteSchema, runtime.knowledge.logger)));
    });
    ctx.on('agent/status', ({ agent, status }) => { if (!this.allowed(agent.session.header) || this.isBase(this.key(agent.session.header)) || isSubagent(agent.session.header)) return; const runtime = this.ready.get(this.key(agent.session.header)); if (runtime === undefined) return; if (status === 'running') runtime.formation.running(agent.session.id); else runtime.formation.idle(agent.session.id); });
    ctx.on('agent/disposed', ({ agent }) => { const key = this.attached.get(agent.session.id); if (key === undefined) return; const runtime = this.ready.get(key); if (runtime === undefined) return; runtime.formation.disposed(agent.session.id); runtime.memories.forget(agent.session.id); this.schedule(() => runtime.catalog.forget(agent.session.id)); this.attached.delete(agent.session.id); });
    // 配置重载时宿主可能保留 Agent；不能只依赖下一次 created 事件恢复冻结上下文。
    for (const agent of ctx.agents.list()) { await this.attach(agent.session.header, 'resume'); this.resumed.add(agent.session.id); }
  }
  private schedule(action: () => Promise<unknown>): void { if (this.closed) return; this.pending = this.pending.then(action).then(() => {}).catch(() => { this.ctx.logger.warn('Could not persist a connection runtime event.'); }); }
  async close(): Promise<void> { this.closed = true; for (const state of this.syncs.values()) state.controller?.abort(); await this.pending; const runtimes = await Promise.allSettled([...this.runtimes.values()]); for (const result of runtimes) if (result.status === 'fulfilled') await result.value.close(); }
}
