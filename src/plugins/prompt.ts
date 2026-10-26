// 静态知识段落与目录保持稳定，变化通过当前步骤的持久消息追加。
import { sessionAllowed } from '../dsh-adapter/session-binding.js';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-agent';
import { KnowledgeSessions } from '../knowledge/sessions.js';
import type { ChangeAdmission } from '../knowledge/sessions.js';
import { loadPromptRenderer } from '../prompt/render.js';
import type {} from './knowledge.js';
import { isEvidenceAgent } from '../tools/subagent.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'acn-claim-changes': { kind: 'acn-claim-changes' } }
}
export const name = 'acn-prompt';
export const inject = ['acnKnowledge', 'systemPrompt', 'agents', 'sessions'];
export async function apply(ctx: Context): Promise<void> {
  const knowledge = ctx.acnKnowledge;
  if (!knowledge.configured) return;
  const render = await loadPromptRenderer();
  const sessions = new KnowledgeSessions(knowledge);
  const pending = new Map<string, { sessionId: string; notice: ChangeAdmission }>();
  // 基线 persona 为 0、policy 为 500/600、首个工具段为 800，700/710 位于其间。
  ctx.systemPrompt.section({ name: 'acn:knowledge', order: 700, interpolate: false, text: render('knowledge.j2', { agent_id: knowledge.agentId, team: knowledge.mode === 'team' }) });
  ctx.systemPrompt.section({ name: 'acn:claim-catalog', order: 710, interpolate: false, text: ({ agent }) => agent === undefined ? '' : sessions.catalog(agent.session.id) });
  ctx.on('agent/created', async ({ agent, source }) => {
    if (!sessionAllowed(ctx, knowledge.config, agent.session.header) || isEvidenceAgent(agent.session.header)) return;
    await sessions.freeze(agent.session.id, source, agent.session.header.parentSession);
  });
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (isEvidenceAgent(agent.session.header)) return next();
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    signal.throwIfAborted();
    const notice = await sessions.prepare(agent.session.id);
    signal.throwIfAborted();
    if (notice === null) return decision;
    const message = createUserMessage({ content: [{ type: 'text', text: notice.text }], source: { kind: 'acn-claim-changes' } });
    pending.set(message.id, { sessionId: agent.session.id, notice });
    return { ...decision, messages: [...decision.messages, message] };
  });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'acn-claim-changes') return;
    const admission = pending.get(event.data.id);
    if (admission?.sessionId !== session.id) return;
    pending.delete(event.data.id);
    sessions.admitted(session.id, admission.notice);
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') for (const [id, admission] of pending) if (admission.sessionId === agent.session.id) pending.delete(id);
  });
  ctx.on('agent/disposed', ({ agent }) => { void sessions.forget(agent.session.id).catch(() => { knowledge.logger.warn('Could not finish session Claim state cleanup.'); }); });
  for (const agent of ctx.agents.list()) if (sessionAllowed(ctx, knowledge.config, agent.session.header) && !isEvidenceAgent(agent.session.header)) await sessions.freeze(agent.session.id, 'resume', agent.session.header.parentSession);
  ctx.effect(() => () => sessions.flush());
}
export default { name, inject, apply };
