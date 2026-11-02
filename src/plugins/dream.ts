// Dream 插件适配会话触发和模型路由，领域进度与 worker 的所有权归知识服务。
import { sessionAllowed } from '../dsh-adapter/session-binding.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from './knowledge.js';
import { AcnDream } from '../dream/service.js';
import { structuredBackend } from '../dsh-adapter/llm.js';
import { autonomousDreamRunner } from '../dsh-adapter/dream-agent.js';
import { z } from 'zod';
import { readYamlOr } from '../store/yaml.js';
import { projectEvent } from '../dsh-adapter/formation.js';
import { loadPromptRenderer } from '../prompt/render.js';
import { isSubagent } from '../tools/subagent.js';
import { withFileLock } from '../store/lock.js';
import { writeYamlAtomic } from '../store/yaml.js';
import { RouteSchema } from '../formation/transcript.js';

declare module '@deepseek-ai/cordis' { interface Context { acnDream: AcnDream } }
export const name = 'acn-dream';
export const inject = ['acnKnowledge', 'acnRuntime', 'agents', 'sessions', 'llm', 'tools', 'systemPrompt'];
export async function apply(ctx: Context): Promise<void> {
  const knowledge = ctx.acnKnowledge; if (!knowledge.configured) return;
  ctx.effect(() => ctx.acnRuntime.component('dream'));
  let pending = Promise.resolve();
  const render = await loadPromptRenderer();
  const service = new AcnDream(knowledge, structuredBackend(ctx), render, () => pending, { workspace: async () => { await pending; return readYamlOr(knowledge.context().paths.dreamWorkspace, z.string(), () => process.cwd()); }, run: autonomousDreamRunner(ctx) }); ctx.provide('acnDream', service);
  if (!knowledge.active) { ctx.effect(() => () => service.close()); return; }
  ctx.on('session/event', (session, event) => {
    if (!sessionAllowed(ctx, knowledge.config, session.header) || isSubagent(session.header)) return;
    const route = projectEvent(event).route;
    if (route !== undefined) pending = pending.then(() => withFileLock(`${knowledge.context().paths.lastRoute}.lock`, () => writeYamlAtomic(knowledge.context().paths.lastRoute, route, RouteSchema, knowledge.logger))).catch(() => { ctx.logger.warn('Could not persist the background Dream route.'); });
  });
  ctx.on('agent/created', ({ agent }) => {
    if (!sessionAllowed(ctx, knowledge.config, agent.session.header) || isSubagent(agent.session.header)) return;
    const cwd = agent.session.header.cwd;
    if (cwd !== undefined) pending = pending.then(() => withFileLock(`${knowledge.context().paths.dreamWorkspace}.lock`, () => writeYamlAtomic(knowledge.context().paths.dreamWorkspace, cwd, z.string(), knowledge.logger))).catch(() => { ctx.logger.warn('Could not persist the background Dream workspace.'); });
    service.trigger();
  });
  ctx.effect(() => async () => { await service.close(); await pending; }); await service.start();
}
export default { name, inject, apply };
