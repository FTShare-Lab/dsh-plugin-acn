// 形成插件把宿主事件投影到本地服务，emit 监听通过受管理队列收敛异步写入。
import { sessionAllowed } from '../dsh-adapter/session-binding.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from './knowledge.js';
import { AcnFormation } from '../formation/service.js';
import { loadPromptRenderer } from '../prompt/render.js';
import { structuredBackend } from '../dsh-adapter/llm.js';
import { compactionEnd, projectEvent } from '../dsh-adapter/formation.js';
import { isSubagent } from '../tools/subagent.js';

declare module '@deepseek-ai/cordis' { interface Context { acnFormation: AcnFormation } }
export const name = 'acn-formation';
export const inject = ['acnKnowledge', 'agents', 'sessions', 'llm'];
export async function apply(ctx: Context): Promise<void> {
  if (!ctx.acnKnowledge.configured) return;
  const knowledge = ctx.acnKnowledge;
  const worker = knowledge.jobs;
  if (worker === null) return;
  const service = new AcnFormation(ctx.acnKnowledge, structuredBackend(ctx), await loadPromptRenderer(), {}, worker);
  ctx.provide('acnFormation', service);
  ctx.on('session/event', (session, event) => {
    if (sessionAllowed(ctx, knowledge.config, session.header) && !isSubagent(session.header)) {
      const projection = projectEvent(event); const until = compactionEnd(event);
      if (Object.keys(projection).length > 0 || until !== undefined) service.capture(session.id, projection, until);
    }
  });
  ctx.on('agent/created', ({ agent }) => { if (sessionAllowed(ctx, knowledge.config, agent.session.header) && !isSubagent(agent.session.header)) service.attach(agent.session.id); return undefined; });
  ctx.on('agent/status', ({ agent, status }) => { if (sessionAllowed(ctx, knowledge.config, agent.session.header) && !isSubagent(agent.session.header)) { if (status === 'running') service.running(agent.session.id); else service.idle(agent.session.id); } });
  ctx.on('agent/disposed', ({ agent }) => { if (sessionAllowed(ctx, knowledge.config, agent.session.header) && !isSubagent(agent.session.header)) service.disposed(agent.session.id); });
  ctx.effect(() => () => service.close());
  for (const agent of ctx.agents.list()) if (sessionAllowed(ctx, knowledge.config, agent.session.header) && !isSubagent(agent.session.header)) { service.attach(agent.session.id); if (agent.status === 'running') service.running(agent.session.id); }
  await service.start();
}
export default { name, inject, apply };
