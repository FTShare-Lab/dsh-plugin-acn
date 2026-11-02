// 交互 API 读取领域台账，显式操作才发起同步或模型请求，错误不回传底层配置。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { SessionId } from '@deepseek-ai/dsh-session';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { AcnKnowledge } from '../knowledge/service.js';
import { InteractionRequestSchema } from '../interaction.js';
import type { InteractionRequest, InteractionResult, KnowledgeView, Activity } from '../interaction.js';
import { DisputeStore } from '../store/disputes.js';
import { TraceStore } from '../store/traces.js';
import { ClaimStore } from '../store/claims.js';
import { JobQueue } from '../worker/queue.js';
import { UploadStore } from '../store/uploads.js';
import { JobError } from '../worker/types.js';
import { TeamFacade } from '../team/service.js';
import { resolveConfig } from '../config.js';
import { PresentationStore } from '../store/presentation.js';
import type { RuntimePool } from './runtime-pool.js';

function summary(result: unknown): string {
  if (result === null || typeof result !== 'object') return '尚无处理结果';
  const values = result as Record<string, unknown>;
  if (values['skipped'] === true || typeof values['skipped'] === 'string') return '没有需要新增处理的内容';
  const labels: Record<string, string> = { claimCount: '更新 Claim', disputeCount: '形成争议', traceCount: '形成来源', applied: '更新 Claim', handled: '处理收件', uploadedClaims: '已投递 Claim', reportedDisputes: '已上报争议', modelSteps: '探索请求', wrapUpSteps: '收尾请求' };
  const counts = Object.entries(labels).flatMap(([key, label]) => typeof values[key] === 'number' ? [`${label}: ${values[key]}`] : []);
  if (Array.isArray(values['updatedClaimIds'])) counts.push(`更新 Claim: ${values['updatedClaimIds'].length}`);
  if (values['changed'] === false) counts.push('没有新增记忆');
  if (values['applied'] === true) counts.push('本地处理完成');
  return counts.join('；') || '处理完成，可能未产生新知识';
}
// 空收件同步已有操作回执；仍保留活动记录，但不再补弹一次没有变化的通知。
function emptyInbox(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const r = result as Record<string, unknown>;
  return ['pulled', 'accepted', 'acknowledged', 'applied', 'handled', 'uploadedClaims', 'reportedDisputes'].every((k) => r[k] === 0) && Array.isArray(r['warnings']) && r['warnings'].length === 0;
}
export async function readKnowledge(pool: RuntimePool, key: string, kind: 'claim' | 'dispute' | 'trace', query: string, offset: number, entities = true): Promise<KnowledgeView> {
  const config = pool.config(key, true);
  if (config === undefined || config.agentId === '') throw new JobError('connection', '请选择可用的知识身份。');
  // 浏览不启动 worker、同步或 Dream；只从当前已生效实体与任务账本读取。
  const knowledge = pool.isBase(key) ? pool.base : new AcnKnowledge(config, pool.ctx.logger);
  try {
    const context = knowledge.context();
    const values = !entities ? [] : kind === 'claim' ? await new ClaimStore(context).list() : kind === 'dispute' ? await new DisputeStore(context).list() : await new TraceStore(context).list();
    const text = query.toLocaleLowerCase();
    const matching = values.filter((item) => ('holder' in item ? item.holder === context.agentId : 'agent' in item ? item.agent === context.agentId : item.reporter_agent_id === context.agentId) && JSON.stringify(item).toLocaleLowerCase().includes(text)).sort((a, b) => a.id.localeCompare(b.id));
    const pending = await new UploadStore(context).read();
    const presentation = await new PresentationStore(context).read();
    const activities: Activity[] = (await new JobQueue(context).list()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map((job) => ({ id: job.id, kind: job.kind, state: job.payload['paused'] === true ? 'paused' : job.state, attempts: job.attempts, updatedAt: job.updatedAt, unseen: !(job.kind === 'inbox' && job.state === 'succeeded' && emptyInbox(job.result)) && presentation !== null && job.updatedAt >= presentation.baselineAt && presentation.seen[job.id] !== job.updatedAt, ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }), summary: summary(job.result), ...(job.lastError === undefined ? {} : { error: job.lastError }) }));
    return { key, name: pool.choices().find((item) => item.key === key)?.name ?? key, items: matching.slice(offset, offset + 30).map((item) => ({ kind, id: item.id, name: item.name, status: 'status' in item ? String(item.status) : '', detail: JSON.stringify(item, null, 2) })), omitted: Math.max(0, matching.length - offset - 30), activities, pendingClaims: pending.claims.length, pendingDisputes: pending.disputes.length };
  } finally { if (knowledge !== pool.base) await knowledge.team?.close(); }
}
export async function executeInteraction(ctx: Context, input: InteractionRequest, runtimePool?: RuntimePool): Promise<InteractionResult> {
  const parsed = InteractionRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: '请求字段不合法，请重新加载页面。' };
  const request = parsed.data;
  const pool = runtimePool ?? ctx.get('acnRuntime');
  if (pool === undefined) return { ok: false, message: '知识服务尚未启用，请检查插件配置。' };
  try {
    if (request.action === 'check') {
      const config = resolveConfig({ agentId: request.connection.agentId, team: { routerEndpoint: request.connection.routerEndpoint, maintainerEndpoint: request.connection.maintainerEndpoint, keyEnv: request.connection.keyEnv, timeoutMs: request.connection.timeoutMs, retryCount: 0 } });
      const team = new TeamFacade(config.team, request.connection.agentId, ctx.logger);
      try {
        const checks = await Promise.all((['maintainer', 'router'] as const).map(async (service) => {
          try { await team.request(service, async () => { const health = await team[service].health(AbortSignal.timeout(config.team.timeoutMs)); if (health.team_auth_enabled && health.auth_passed !== true) throw new JobError('auth', '认证未通过，请检查认证环境变量。'); if (service === 'router') await team.router.overview(AbortSignal.timeout(config.team.timeoutMs)); }); return { service, state: 'ok' as const, message: '连接与认证通过' }; }
          catch { return { service, state: 'failed' as const, message: '未通过，请检查地址、服务状态和认证环境变量。' }; }
        }));
        return { ok: checks.every((item) => item.state === 'ok'), message: checks.every((item) => item.state === 'ok') ? '团队连接检查通过。' : '部分服务不可用；可离线保存，使用前需恢复连接。', checks };
      } finally { await team.close(); }
    }
    if (request.action === 'probe') {
      if (!request.provider || !request.model) return { ok: true, message: '沿用会话模型；首次同步前请先选择聊天模型。' };
      const signal = AbortSignal.timeout(20_000);
      const call = await ctx.llm.prepareCall({ provider: request.provider, model: request.model, maxTokens: 1024 }, signal);
      const assembler = new BlockAssembler();
      for await (const chunk of call.stream({ ...call.config, system: 'Reply with OK.', messages: [createUserMessage({ content: [{ type: 'text', text: 'Connection check.' }], source: { kind: 'acn-formation' } })], signal })) assembler.push(chunk);
      if (assembler.finish.kind !== 'stop') return { ok: false, message: '模型未正常完成检查，保留原模型。请检查模型配置或重试。' };
      return { ok: true, message: '知识模型检查通过。' };
    }
    if (request.action === 'knowledge') return { ok: true, message: '', knowledge: await readKnowledge(pool, request.key, request.kind, request.query, request.offset) };
    if (request.action === 'activity') return { ok: true, message: '', knowledge: await readKnowledge(pool, request.key, 'claim', '', 0, false) };
    if (request.action === 'ack') {
      const config = pool.config(request.key, true);
      if (config === undefined || !config.agentId) throw new JobError('connection', '知识身份不可用。');
      const knowledge = pool.isBase(request.key) ? pool.base : new AcnKnowledge(config, ctx.logger);
      try { const job = await new JobQueue(knowledge.context()).read(request.id); if (job === null || job.updatedAt !== request.version || !['succeeded', 'failed'].includes(job.state)) return { ok: false, message: '任务状态已变化，请重新读取。' }; await new PresentationStore(knowledge.context()).acknowledge(job.id, job.updatedAt); return { ok: true, message: '' }; }
      finally { if (knowledge !== pool.base) await knowledge.team?.close(); }
    }
    if (request.action === 'retry') {
      const config = pool.config(request.key);
      if (config === undefined) throw new JobError('connection', '连接已停用或删除，不能重试。');
      const knowledge = await pool.activate(request.key);
      const job = await knowledge.jobs?.queue.read(request.id);
      if (job?.kind === 'dream' && job.payload['paused'] === true) { await knowledge.jobs?.queue.pauseDream(false); knowledge.jobs?.wake(true); }
      else await knowledge.jobs?.retry(request.id);
      return { ok: true, message: '任务已重新入队。' };
    }
    const id = SessionId(request.sessionId);
    let session = ctx.sessions.get(id);
    const controller = ctx.get('sessionController');
    if (session === undefined && request.action === 'session' && controller !== undefined) {
      const inspection = await controller.inspect(id);
      return { ok: true, message: '', session: pool.view(inspection.meta, inspection.events) };
    }
    if (session === undefined && controller !== undefined) {
      const resolved = await controller.resolveAgent(id);
      if ('agent' in resolved) session = resolved.agent.session;
    }
    if (session === undefined) return { ok: false, message: '会话不可用，请重新打开或新建会话。' };
    if (request.action === 'session') return { ok: true, message: '', session: pool.view(session.header) };
    if (request.action === 'select') return { ok: true, message: '', session: await pool.select(session.header, request.key) };
    if (request.action === 'cancel') { pool.cancel(session.header); return { ok: true, message: '', session: pool.view(session.header) }; }
    if (request.action === 'sync') { await pool.sync(session.header); return { ok: true, message: '', session: pool.view(session.header) }; }
    const services = await pool.service(session.header);
    const job = await services.formation?.recap(session.id);
    return { ok: services.formation !== undefined, message: services.formation === undefined ? '知识形成组件未启用。' : job == null ? '没有可复盘的新增内容。' : '复盘已入队，可在处理活动中查看。' };
  } catch (error) {
    return { ok: false, message: error instanceof JobError ? error.message : '操作未完成。请检查连接、知识模型和本地存储后重试。' };
  }
}
