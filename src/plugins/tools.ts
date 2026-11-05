// 将 Claim 注册到宿主，并以可撤销策略和最终门禁阻止子代理写入。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { claimTool, consultRouterTool } from '../dsh-adapter/tools.js';
import { runningConfiguration } from '../dsh-adapter/session-binding.js';
import { isSubagent } from '../tools/subagent.js';
import type {} from './knowledge.js';

export const name = 'acn-tools';
export const inject = ['acnKnowledge', 'acnRuntime', 'tools'];
export function apply(ctx: Context): void {
  if (!ctx.acnKnowledge.configured && ctx.acnKnowledge.config.upstreams === undefined) return;
  const denied = (exec: Readonly<ToolExecution>): string | undefined => {
    const args = exec.arguments;
    const writing = (exec.name === 'claim' && typeof args === 'object' && args !== null && 'action' in args && args.action === 'update');
    return writing && exec.agent !== undefined && isSubagent(exec.agent.session.header) ? 'Subagents cannot modify ACN knowledge.' : undefined;
  };
  ctx.on('tools/pre-execute', (exec, next) => {
    const reason = denied(exec);
    return reason === undefined ? next() : Promise.resolve({ kind: 'deny', reason });
  });
  ctx.tools.guard(denied);
  ctx.tools.register(claimTool(ctx.acnKnowledge, (header) => ctx.acnRuntime.knowledge(header)));
  if ((ctx.get('agents')?.list().some((agent) => Boolean(runningConfiguration(agent.session.header)?.team.routerEndpoint)) ?? false) || Object.values(ctx.acnKnowledge.config.upstreams ?? {}).some((item) => item.enabled && item.routerEndpoint) || ctx.acnKnowledge.team !== null || ctx.acnKnowledge.config.connections.some((connection) => connection.enabled)) ctx.tools.register(consultRouterTool(ctx.acnKnowledge, (header) => ctx.acnRuntime.knowledge(header)));
}
export default { name, inject, apply };
