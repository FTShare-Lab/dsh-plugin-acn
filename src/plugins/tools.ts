// 将 Claim 注册到宿主，并以可撤销策略和最终门禁阻止子代理写入。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { claimTool, consultRouterTool } from '../dsh-adapter/tools.js';
import { isSubagent } from '../tools/subagent.js';
import type {} from './knowledge.js';

export const name = 'acn-tools';
export const inject = ['acnKnowledge', 'acnRuntime', 'tools'];
export function apply(ctx: Context): void {
  if (!ctx.acnKnowledge.configured) return;
  const denied = (exec: Readonly<ToolExecution>): string | undefined => {
    const args = exec.arguments;
    const writing = exec.name === 'memory' || (exec.name === 'claim' && typeof args === 'object' && args !== null && 'action' in args && args.action === 'update');
    return writing && exec.agent !== undefined && isSubagent(exec.agent.session.header) ? 'Subagents cannot modify ACN knowledge.' : undefined;
  };
  ctx.on('tools/pre-execute', (exec, next) => {
    const reason = denied(exec);
    return reason === undefined ? next() : Promise.resolve({ kind: 'deny', reason });
  });
  ctx.tools.guard(denied);
  ctx.tools.register(claimTool(ctx.acnKnowledge, (header) => ctx.acnRuntime.knowledge(header)));
  if (ctx.acnKnowledge.team !== null || ctx.acnKnowledge.config.connections.some((connection) => connection.enabled)) ctx.tools.register(consultRouterTool(ctx.acnKnowledge, (header) => ctx.acnRuntime.knowledge(header)));
}
export default { name, inject, apply };
