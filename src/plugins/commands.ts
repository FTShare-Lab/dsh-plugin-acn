// 命令保持在交互面，不向模型提交用户命令或其输出。
import { sessionAllowed, sessionChanged, configurationBusy } from '../dsh-adapter/session-binding.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '../dsh-adapter/configuration-service.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-commands';
import { z } from 'zod';
import { claimCommand, commandDomainError } from '../commands/claim.js';
import { statusCommand } from '../commands/status.js';
import { importCommand, renderImportReport } from '../commands/import.js';
export { importCommand } from '../commands/import.js';
import { isSubagent } from '../tools/subagent.js';
import type {} from './knowledge.js';
import type {} from './formation.js';
import type {} from './inbox.js';
import type {} from './dream.js';
import { JobError } from '../worker/types.js';

export const name = 'acn-commands';
export const inject = ['acnKnowledge', 'commands', 'sessions'];
export function apply(ctx: Context): void {
  const knowledge = ctx.acnKnowledge;
  let applying = () => false;
  void ctx.inject(['acnConfiguration'], (child) => {
    const service = child.acnConfiguration; applying = () => service.pending > 0;
    child.effect(() => () => { applying = () => false; });
  });
  const denied = (agent: Agent) => {
    if (applying()) return configurationBusy;
    return sessionAllowed(ctx, knowledge.config, agent.session.header) ? undefined : sessionChanged;
  };
  ctx.commands.register({ name: 'acn-status', description: 'Show ACN status or retry a failed job.', input: { hint: '[retry <job_id>]' }, handler: async ({ agent, rawInput }) => {
    const reason = denied(agent); if (reason !== undefined) return { kind: 'error', text: reason };
    const parts = rawInput.trim().split(/\s+/);
    if (rawInput.trim() === '') return { kind: 'success', text: await statusCommand(knowledge) };
    if (parts.length !== 2 || parts[0] !== 'retry' || !/^[a-zA-Z0-9_-]+$/.test(parts[1] ?? '')) return { kind: 'error', text: '用法：/acn-status [retry <job_id>]' };
    if (isSubagent(agent.session.header)) return { kind: 'error', text: '子 agent 不能重试知识形成任务。' };
    const worker = knowledge.jobs;
    if (worker === null) return { kind: 'error', text: '请先配置 agentId。' };
    try { const job = await worker.retry(parts[1] ?? ''); return { kind: 'success', text: `任务已重新入队：${job.id}` }; }
    catch (error) { if (error instanceof JobError) return { kind: 'error', text: error.message }; throw error; }
  } });
  if (!knowledge.configured) return;
  ctx.commands.register({ name: 'acn-import', description: 'Import owned knowledge from a separate read-only agent directory.', input: { hint: '[--dry-run] [--without-memory] <acn_agent_home>' }, handler: async ({ agent, rawInput, signal }) => {
    const reason = denied(agent); if (reason !== undefined) return { kind: 'error', text: reason };
    try { return { kind: 'success', text: renderImportReport(await importCommand(knowledge, rawInput, isSubagent(agent.session.header), signal)) }; }
    catch (error) { const message = commandDomainError(error); if (message !== undefined) return { kind: 'error', text: message }; throw error; }
  } });
  void ctx.inject(['acnDream', 'commands'], (child) => {
    child.commands.register({ name: 'dream', description: 'Organize owned knowledge or stop at a recoverable boundary.', input: { hint: '[stop]' }, handler: async ({ agent, rawInput }) => {
      const reason = denied(agent); if (reason !== undefined) return { kind: 'error', text: reason };
      if (isSubagent(agent.session.header)) return { kind: 'error', text: '子 agent 不能触发或停止 Dream。' };
      if (rawInput.trim() === 'stop') return { kind: 'success', text: `已请求停止 ${await child.acnDream.stop()} 个 Dream 任务；正在提交的组会完成，草稿和进度保留。再次 /dream 或重启可继续。` };
      if (rawInput.trim() !== '') return { kind: 'error', text: '用法：/dream [stop]' };
      try { const job = await child.acnDream.request(agent.session.header.cwd); return { kind: 'success', text: `Dream 任务 ${job.id}；使用 /acn-status 查看状态，报告位于 dream/${job.id}/report.md。` }; }
      catch (error) { if (error instanceof JobError) return { kind: 'error', text: error.message }; throw error; }
    } });
  });
  void ctx.inject(['acnInbox', 'commands'], (child) => {
    child.commands.register({ name: 'inbox', description: 'Sync team Inbox and queue local internalization.', handler: async ({ agent, signal }) => {
      const reason = denied(agent); if (reason !== undefined) return { kind: 'error', text: reason };
      if (isSubagent(agent.session.header)) return { kind: 'error', text: '子 agent 不能触发 Inbox 内化。' };
      const report = await child.acnInbox.request(signal);
      return { kind: 'success', text: `${knowledge.mode === 'solo' ? '单人模式没有团队 inbox；处理本地 pending。\n' : ''}拉取 ${report.pulled}；持久化 ${report.accepted}；确认 ${report.acknowledged}；待内化 ${report.pending}。任务 ${report.jobId} 已入队。${report.warnings.length === 0 ? '' : `\n${report.warnings.join('\n')}`}` };
    } });
  });
  void ctx.inject(['acnFormation', 'commands'], (child) => {
    child.commands.register({ name: 'acn-finalize', description: 'Form knowledge from this session’s unprocessed transcript.', handler: async ({ agent }) => {
      const reason = denied(agent); if (reason !== undefined) return { kind: 'error', text: reason };
      if (isSubagent(agent.session.header)) return { kind: 'error', text: '子 agent 不能触发知识形成。' };
      const job = await child.acnFormation.finalize(agent.session.id);
      return { kind: 'success', text: `Finalize 已入队：${job.id}；使用 /acn-status 查看结果。` };
    } });
  });
  ctx.commands.register({
    name: 'claim', description: 'Browse, read or revise local Claims.', input: { hint: '[query] | show <id> | set <id> <field>=<value> ...' },
    handler: async ({ agent, rawInput, signal }) => {
      const reason = denied(agent); if (reason !== undefined) return { kind: 'error', text: reason };
      try { return { kind: 'success', text: await claimCommand(knowledge, rawInput, isSubagent(agent.session.header), signal) }; }
      catch (error) {
        const message = commandDomainError(error) ?? (error instanceof z.ZodError ? 'Invalid Claim identifier or editable fields.' : undefined);
        if (message === undefined) throw error;
        return { kind: 'error', text: message };
      }
    },
  });
}
export default { name, inject, apply };
