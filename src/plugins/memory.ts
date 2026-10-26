// 私有 Memory 独立拥有工具、冻结段落和 review；子会话不获得私有快照或写入权限。
import { sessionAllowed } from '../dsh-adapter/session-binding.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from './knowledge.js';
import { AcnMemory } from '../memory/service.js';
import { MemorySessions } from '../memory/sessions.js';
import { MemoryReview } from '../memory/review.js';
import { memoryTool } from '../dsh-adapter/memory.js';
import { structuredBackend } from '../dsh-adapter/llm.js';
import { projectEvent } from '../dsh-adapter/formation.js';
import { loadPromptRenderer } from '../prompt/render.js';
import { isSubagent } from '../tools/subagent.js';

declare module '@deepseek-ai/cordis' { interface Context { acnMemory: AcnMemory } }
export const name = 'acn-memory';
export const inject = ['acnKnowledge', 'agents', 'sessions', 'tools', 'systemPrompt', 'llm'];
export async function apply(ctx: Context): Promise<void> {
  const knowledge = ctx.acnKnowledge; if (!knowledge.configured || !knowledge.config.memory.enabled) return;
  const memory = new AcnMemory(knowledge); const render = await loadPromptRenderer(); const sessions = new MemorySessions(memory, render); const review = new MemoryReview(memory, structuredBackend(ctx), render);
  ctx.provide('acnMemory', memory); ctx.tools.register(memoryTool(memory));
  const denied = (execution: { name: string; agent?: { session: { header: { origin?: string; delegationDepth?: number } } } }) => execution.name === 'memory' && (execution.agent === undefined || isSubagent(execution.agent.session.header)) ? 'Subagents cannot access private Memory.' : undefined;
  ctx.tools.guard(denied);
  ctx.systemPrompt.section({ name: 'acn:memory', order: 720, interpolate: false, text: ({ agent }) => agent === undefined || isSubagent(agent.session.header) ? '' : sessions.text(agent.session.id) });
  ctx.on('agent/created', async ({ agent, source }) => { if (!sessionAllowed(ctx, knowledge.config, agent.session.header) || isSubagent(agent.session.header)) return; await sessions.freeze(agent.session.id, source, agent.session.header.parentSession); await review.attach(agent.session.id, source); });
  ctx.on('session/event', (session, event) => {
    if (!sessionAllowed(ctx, knowledge.config, session.header) || isSubagent(session.header)) return;
    const user = event.type === 'user/message' && event.data.source.kind === 'user';
    const projection = event.type === 'user/message' && !user ? {} : projectEvent(event);
    review.capture(session.id, { seq: event.seq, projection, user, completed: event.type === 'turn/end' && event.data.reason.kind === 'completed', ended: event.type === 'turn/end' });
  });
  ctx.on('agent/disposed', ({ agent }) => { sessions.forget(agent.session.id); });
  for (const agent of ctx.agents.list()) if (sessionAllowed(ctx, knowledge.config, agent.session.header) && !isSubagent(agent.session.header)) { await sessions.freeze(agent.session.id, 'resume', agent.session.header.parentSession); await review.attach(agent.session.id, 'resume'); }
  ctx.effect(() => () => review.close()); await review.start();
}
export default { name, inject, apply };
