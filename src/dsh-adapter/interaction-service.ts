// 交互 API 读取领域台账，显式操作才发起同步或模型请求，错误不回传底层配置。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { messageInfo } from '../interaction-messages.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { AcnKnowledge } from '../knowledge/service.js';
import { InteractionRequestSchema } from '../interaction.js';
import type { InteractionRequest, InteractionResult, KnowledgeView } from '../interaction.js';
import { DisputeStore } from '../store/disputes.js';
import { TraceStore } from '../store/traces.js';
import { ClaimStore } from '../store/claims.js';
import { JobQueue } from '../worker/queue.js';
import { UploadStore } from '../store/uploads.js';
import { JobError } from '../worker/types.js';
import { allActivities, activityPage } from '../activities.js';
import type { ActivityPage } from '../activities.js';
import { UploadDelivery } from '../upload/deliver.js';
import { TeamFacade } from '../team/service.js';
import { TeamError } from '../team/errors.js';
import { resolveConfig } from '../config.js';
import { PresentationStore } from '../store/presentation.js';
import { teamCredentials } from './team-credentials.js';
import type { RuntimePool } from './runtime-pool.js';
import type { CredentialResolver } from '../team/http.js';

export async function checkTeamConnection(ctx: Context, connection: Extract<InteractionRequest, { action: 'check' }>['connection'], credential: CredentialResolver = teamCredentials(ctx), signal?: AbortSignal): Promise<InteractionResult> {
  if (!connection.routerEndpoint || !connection.maintainerEndpoint) return { ok: false, message: '单人配置不需要连接检查；请先填写两个团队地址。' };
  const config = resolveConfig({ agentId: connection.agentId, team: { routerEndpoint: connection.routerEndpoint, maintainerEndpoint: connection.maintainerEndpoint, keyEnv: connection.keyEnv, timeoutMs: connection.timeoutMs, retryCount: 0 } });
  if (config.agentId === '') return { ok: false, message: '请先填写 Agent ID。' };
  const team = new TeamFacade(config.team, config.agentId, ctx.logger, credential);
  try {
    const checks = await Promise.all((['maintainer', 'router'] as const).map(async (service) => {
      const bounded = AbortSignal.any([AbortSignal.timeout(Math.min(config.team.timeoutMs, 15_000)), ...signal === undefined ? [] : [signal]]);
      try { await team.request(service, async () => { const health = await team[service].health(bounded); if (health.team_auth_enabled && health.auth_passed !== true) throw new JobError('auth', '认证未通过，请检查团队鉴权密钥。'); if (service === 'router') await team.router.overview(bounded); }); return { service, state: 'ok' as const, message: '连接与认证通过' }; }
      catch (error) {
        const reason = bounded.aborted ? bounded.reason instanceof Error && bounded.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled' : error instanceof TeamError ? error.connectionFailure ?? error.kind : error instanceof JobError ? error.kind : 'network';
        const messages: Record<string, string> = { retryable: '服务暂时不可用，请检查服务状态后重试。', auth: '认证未通过，请检查 Agent ID 和团队鉴权密钥。', timeout: '连接超时，请检查服务状态和网络后重试。', dns: '无法解析服务域名，请检查地址和网络。', unreachable: '无法连接服务，请检查地址、端口和服务是否已启动。', network: '网络连接失败，请检查网络或代理后重试。', protocol: '服务响应不符合 ACN 协议，请联系团队管理员检查服务版本。', client: '服务拒绝了请求，请检查服务地址和访问权限。', cancelled: '检查已取消。' };
        return { service, state: 'failed' as const, message: messages[reason] ?? messages['network'] ?? '' };
      }
    }));
    return { ok: !signal?.aborted && checks.every((item) => item.state === 'ok'), message: signal?.aborted ? '检查已取消。' : checks.every((item) => item.state === 'ok') ? '团队连接检查通过。' : '部分团队服务不可用；可保存配置并继续本地工作，团队同步前需恢复连接。', checks };
  } finally { await team.close(); }
}

export async function readKnowledge(pool: RuntimePool, key: string, kind: 'claim' | 'dispute' | 'trace', query: string, offset: number, entities = true, activityOptions: ActivityPage = {}, filters: { status?: string; delivery?: string } = {}): Promise<KnowledgeView> {
  const config = pool.config(key, true);
  if (config === undefined || config.agentId === '') throw new JobError('connection', '请选择可用的知识身份。');
  // 浏览不启动 worker、同步或 Dream；只从当前已生效实体与任务账本读取。
  const knowledge = pool.isBase(key) ? pool.base : new AcnKnowledge(config, pool.ctx.logger);
  try {
    const context = knowledge.context();
    const values = !entities ? [] : kind === 'claim' ? await new ClaimStore(context).list() : kind === 'dispute' ? await new DisputeStore(context).list() : await new TraceStore(context).list();
    const pending = await new UploadStore(context).read();
    const pendingIds = new Set<string>([...pending.claims, ...pending.disputes].map((item) => item.id));
    const text = query.toLocaleLowerCase();
    const matching = values.filter((item) => ('holder' in item ? item.holder === context.agentId : 'agent' in item ? item.agent === context.agentId : item.reporter_agent_id === context.agentId)
      && JSON.stringify(item).toLocaleLowerCase().includes(text) && (!filters.status || 'status' in item && item.status === filters.status)
      && (!filters.delivery || filters.delivery === 'all' || (pendingIds.has(item.id) ? 'pending' : 'local') === filters.delivery)).sort((a, b) => a.id.localeCompare(b.id));
    const rows = await allActivities(knowledge, (kind) => pool.supportsJob(key, kind));
    const issues = rows.filter((item) => item.kind === 'delivery' && item.state === 'rejected' && item.requiresAttention).length;
    const attentionCount = pending.claims.length + pending.disputes.length + issues + rows.filter((item) => item.kind !== 'delivery' && item.requiresAttention).length;
    return { key, name: pool.choices().find((item) => item.key === key)?.name ?? key, items: matching.slice(offset, offset + 30).map((item) => ({ kind, id: item.id, name: item.name, status: 'status' in item ? String(item.status) : '', detail: JSON.stringify(item, null, 2), summary: ('statement' in item ? item.statement : 'summary' in item ? item.summary : item.task).slice(0, 500), updatedAt: ('updated_at' in item ? item.updated_at : undefined) ?? item.created_at, delivery: pendingIds.has(item.id) ? 'pending' : 'local' })), omitted: Math.max(0, matching.length - offset - 30), ...activityPage(rows, activityOptions), activityKinds: [...new Set(rows.map((item) => item.kind))], activitySources: [...new Set(rows.flatMap((item) => item.sessionId === undefined ? [] : [item.sessionId]))], attentionCount, runningCount: rows.filter((item) => item.kind !== 'delivery' && (item.state === 'queued' || item.state === 'running')).length, pendingClaims: pending.claims.length, pendingDisputes: pending.disputes.length };
  } finally { if (knowledge !== pool.base) await knowledge.team?.close(); }
}
export async function executeInteraction(ctx: Context, input: InteractionRequest, runtimePool?: RuntimePool, signal?: AbortSignal): Promise<InteractionResult> {
  const parsed = InteractionRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: '请求字段不合法，请重新加载页面。' };
  const request = parsed.data;
  const pool = runtimePool ?? ctx.get('acnRuntime');
  if (pool === undefined) return { ok: false, serviceAvailable: false, message: '知识组件尚未启用，聊天仍可继续。请在插件管理中启用 ACN 知识组件。' };
  try {
    if (request.action === 'check') return await checkTeamConnection(ctx, request.connection, teamCredentials(ctx), signal);
    if (request.action === 'probe') {
      if (!request.provider || !request.model) return { ok: true, message: '沿用会话模型；首次同步前请先选择聊天模型。' };
      const bounded = AbortSignal.any([AbortSignal.timeout(20_000), ...signal === undefined ? [] : [signal]]);
      bounded.throwIfAborted();
      const call = await ctx.llm.prepareCall({ provider: request.provider, model: request.model, maxTokens: 1024 }, bounded);
      const assembler = new BlockAssembler();
      for await (const chunk of call.stream({ ...call.config, system: 'Reply with OK.', messages: [createUserMessage({ content: [{ type: 'text', text: 'Connection check.' }], source: { kind: 'acn-formation' } })], signal: bounded })) assembler.push(chunk);
      bounded.throwIfAborted();
      if (assembler.finish.kind !== 'stop') return { ok: false, message: '模型未正常完成检查，保留原模型。请检查模型配置或重试。' };
      return { ok: true, message: '知识模型检查通过。' };
    }
    if (request.action === 'knowledge') return { ok: true, message: '', knowledge: await readKnowledge(pool, request.key, request.kind, request.query, request.offset, true, {}, request) };
    if (request.action === 'reference') {
      const config = pool.config(request.key, true);
      if (config === undefined || !config.agentId) throw new JobError('connection', '请选择可用的知识身份。');
      const knowledge = pool.isBase(request.key) ? pool.base : new AcnKnowledge(config, ctx.logger);
      try {
        const trace = request.id.startsWith('trace_');
        const entries = trace ? await new TraceStore(knowledge.context()).list() : await new ClaimStore(knowledge.context()).list();
        const item = entries.find((value) => value.id === request.id && ('holder' in value ? value.holder : value.agent) === knowledge.agentId);
        return { ok: true, message: '', reference: { key: request.key, id: request.id, ...(item === undefined ? {} : { item: { kind: trace ? 'trace' : 'claim', id: item.id, name: item.name, status: 'status' in item ? String(item.status) : '', detail: JSON.stringify(item, null, 2) } }) } };
      } finally { if (knowledge !== pool.base) await knowledge.team?.close(); }
    }
    if (request.action === 'activity') return { ok: true, message: '', knowledge: await readKnowledge(pool, request.key, 'claim', '', 0, false, request) };
    if (request.action === 'ack') {
      const config = pool.config(request.key, true);
      if (config === undefined || !config.agentId) throw new JobError('connection', '知识身份不可用。');
      const knowledge = pool.isBase(request.key) ? pool.base : new AcnKnowledge(config, ctx.logger);
      try { const job = await new JobQueue(knowledge.context()).read(request.id);
        const rejected = job === null ? (await allActivities(knowledge, (kind) => pool.supportsJob(request.key, kind))).find((item) => item.id === request.id && item.state === 'rejected') : undefined;
        if (rejected !== undefined && rejected.updatedAt === request.version) { await new PresentationStore(knowledge.context()).acknowledge(rejected.id, request.version); return { ok: true, message: '已标记知悉；该争议仍未成功投递。' }; }
        if (job === null || job.updatedAt !== request.version || !['succeeded', 'failed'].includes(job.state)) return { ok: false, message: '任务状态已变化，请重新读取。' }; await new PresentationStore(knowledge.context()).acknowledge(job.id, job.updatedAt); return { ok: true, message: '' }; }
      finally { if (knowledge !== pool.base) await knowledge.team?.close(); }
    }
    if (request.action === 'retry_delivery' || request.action === 'dream_again') {
      const config = pool.config(request.key);
      if (config === undefined) throw new JobError('connection', '连接已停用或删除，不能重试。');
      const knowledge = await pool.activate(request.key);
      if (request.action === 'dream_again') {
        const previous = await knowledge.jobs?.queue.read(request.id);
        if (previous?.kind !== 'dream' || previous.state !== 'succeeded') throw new JobError('validation', '请先等待当前 Dream 结束，再重新整理。');
        const dream = await pool.dreamService(request.key);
        if (dream === undefined) throw new JobError('handler_inactive', 'Dream 组件未启用，请在插件管理中启用后重试。');
        await dream.request(typeof previous.payload['workspace_root'] === 'string' ? previous.payload['workspace_root'] : undefined, previous.sessionId);
        return { ok: true, message: '已创建新的 Dream 请求，将重新读取当前知识。' };
      }
      if (knowledge.team === null) throw new JobError('connection', '单人配置不投递团队知识，请在设置中恢复团队连接。');
      const report = await new UploadDelivery(knowledge.context(), knowledge.team).deliver(signal);
      return { ok: report.warnings.length === 0, message: report.warnings.length > 0 ? '团队投递未全部完成，请查看活动中的具体原因。' : report.pendingClaims + report.pendingDisputes > 0 ? '仍有投递正在进行或等待依赖，待投记录已保留。' : '本轮团队投递已完成。' };
    }
    if (request.action === 'retry') {
      const config = pool.config(request.key);
      if (config === undefined) throw new JobError('connection', '连接已停用或删除，不能重试。');
      const knowledge = await pool.activate(request.key);
      const job = await knowledge.jobs?.queue.read(request.id);
      if (job !== null && job !== undefined && !knowledge.jobs?.supports(job.kind)) throw new JobError('handler_inactive', '对应后台组件未启用，请在插件管理中启用后重试。');
      if (job?.kind === 'dream' && job.payload['paused'] === true) { await knowledge.jobs?.queue.pauseDream(false); knowledge.jobs?.wake(true); }
      else await knowledge.jobs?.retry(request.id);
      return { ok: true, message: '任务已重新入队。' };
    }
    const id = SessionId(request.sessionId);
    let session = ctx.sessions.get(id);
    const controller = ctx.get('sessionController');
    if (session === undefined && request.action === 'session' && controller !== undefined) {
      const inspection = await controller.inspect(id);
      return { ok: true, message: '', session: await pool.sessionView(inspection.meta, inspection.events) };
    }
    if (session === undefined && controller !== undefined) {
      const resolved = await controller.resolveAgent(id);
      if ('agent' in resolved) session = resolved.agent.session;
    }
    if (session === undefined) return { ok: false, message: '会话不可用，请重新打开或新建会话。' };
    if (request.action === 'session') return { ok: true, message: '', session: await pool.sessionView(session.header) };
    if (request.action === 'select') return { ok: true, message: '', session: await pool.select(session.header, request.key) };
    if (request.action === 'cancel') { await pool.cancel(session.header); return { ok: true, message: '', session: await pool.sessionView(session.header) }; }
    if (request.action === 'sync') { await pool.sync(session.header); return { ok: true, message: '', session: await pool.sessionView(session.header) }; }
    const services = await pool.service(session.header);
    const job = await services.formation?.recap(session.id);
    return { ok: services.formation !== undefined, message: services.formation === undefined ? '知识形成组件未启用。' : job == null ? '没有可复盘的新增内容。' : '复盘已入队，可在处理活动中查看。' };
  } catch (error) {
    return { ok: false, message: error instanceof JobError ? error.message : '操作未完成。请检查连接、知识模型和本地存储后重试。', ...(error instanceof JobError ? { messageInfo: messageInfo(error.message, error.kind) } : {}) };
  }
}
