// Inbox 插件只编排宿主事件；无会话任务从显式配置或持久的最近请求路由调用模型。
import { sessionAllowed } from '../dsh-adapter/session-binding.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from './knowledge.js';
import { AcnInbox } from '../inbox/service.js';
import { structuredBackend } from '../dsh-adapter/llm.js';
import { projectEvent } from '../dsh-adapter/formation.js';
import { loadPromptRenderer } from '../prompt/render.js';
import { isSubagent } from '../tools/subagent.js';
import { withFileLock } from '../store/lock.js';
import { writeYamlAtomic } from '../store/yaml.js';
import { RouteSchema } from '../formation/transcript.js';

declare module '@deepseek-ai/cordis' { interface Context { acnInbox: AcnInbox } }
export const name = 'acn-inbox';
export const inject = ['acnKnowledge', 'acnRuntime', 'agents', 'sessions', 'llm'];
export async function apply(ctx: Context): Promise<void> {
  const knowledge = ctx.acnKnowledge;
  if (!knowledge.configured) return;
  ctx.effect(() => ctx.acnRuntime.component('inbox'));
  const service = new AcnInbox(knowledge, structuredBackend(ctx), await loadPromptRenderer());
  ctx.provide('acnInbox', service);
  if (!knowledge.active) { ctx.effect(() => () => service.close()); return; }
  let pending = Promise.resolve();
  const schedule = (action: () => Promise<unknown>) => {
    pending = pending.then(action).then(() => undefined).catch(() => { ctx.logger.warn('Could not persist an Inbox trigger or background model route.'); });
  };
  ctx.on('session/event', (session, event) => {
    if (!sessionAllowed(ctx, knowledge.config, session.header) || isSubagent(session.header)) return;
    const route = projectEvent(event).route;
    if (route !== undefined) schedule(() => withFileLock(`${knowledge.context().paths.lastRoute}.lock`, () => writeYamlAtomic(knowledge.context().paths.lastRoute, route, RouteSchema, knowledge.logger)));
  });
  ctx.on('agent/created', ({ agent, source }) => {
    if (sessionAllowed(ctx, knowledge.config, agent.session.header) && !isSubagent(agent.session.header) && knowledge.config.inbox.pullOnSessionStart && (source === 'startup' || source === 'resume')) schedule(() => service.enqueue(true, agent.session.id));
  });
  ctx.effect(() => async () => { await service.close(); await pending; });
  await service.start();
}
export default { name, inject, apply };
