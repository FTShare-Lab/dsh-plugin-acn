// Dream 使用宿主 AgentLoop；只暴露领域事务与有界读取，不继承前台工具或私有上下文。
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { DreamTools, isDreamTool } from '../dream/autonomous.js';
import { DreamValidationError } from '../dream/schema.js';
import type { AutonomousDreamRunner } from '../dream/service.js';
import { abortable } from '../llm/structured.js';
import { JobError } from '../worker/types.js';
import { toolParameters } from './tool-schema.js';

const descriptions: Record<keyof typeof DreamTools, string> = {
  dream_record_candidates: '登记具体待处理候选；按 candidate_progress.current 逐项处理，可继续发现新候选。',
  dream_stage_group: '暂存完整操作组，不写 Claim。纯 A 废弃可简写 id/action/reason；其他修改遵循 schema。group:null 撤回草稿但不撤销候选。',
  dream_validate: '校验当前草稿，返回 before/after、实际证据和 validation_id，随后逐 Claim 语义复核。',
  dream_apply_group: '提交当前 validation_id 与逐 Claim 语义复核；先持久记录再写 Claim，返回真实执行结果。',
  dream_keep_candidate: '明确保留当前候选，说明具体原因；不改变 Claim。',
  dream_read_draft: '查看已接受草稿、当前候选和剩余模型轮数。',
  dream_read_history: '分页读取本轮持久执行记录；回执不是独立事实证据。',
  dream_review_sync: '读取已有整合的同步依赖；确认后用同一 validation_id 和简洁语义 review 提交。',
  dream_finish: '提交 ABC 实际覆盖总结并结束；额度收尾时尚未完成的候选会标为未完成，不强求修改。',
  read_claim: '完整读取本轮自有 Claim；目录和摘要不授予修改权限。',
  read_trace: '分页读取已读 Claim 关联的自身 Trace，作为来源线索，不能单独证明事实。',
  file_read: '读取当前候选的工作区直接材料，绑定 claim_ids，返回插件生成的证据 ID 与文件版本。',
  file_glob: '在工作区按路径字面片段发现文件；只用于定位，再 file_read 才产生证据。',
  file_grep: '在工作区按字面内容搜索；只用于定位，再 file_read 才产生证据。',
};
export function dreamToolGuard(name: string, args: unknown): string | undefined {
  if (!isDreamTool(name)) return 'Dream 只能调用声明的领域工具与工作区只读工具。';
  const parsed = DreamTools[name].safeParse(args);
  if (parsed.success) return undefined;
  // 参数拒绝必须指出字段，否则模型只能反复猜测；反馈不包含字段正文。
  return `Dream 参数不合法，请按工具 schema 修复：${parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || '$'}: ${issue.code}${issue.code === 'unrecognized_keys' ? `；删除多余字段 ${JSON.stringify(issue.keys.slice(0, 8)).slice(0, 400)}` : issue.code === 'invalid_type' ? `；期望 ${issue.expected}` : ''}`).join('; ')}`;
}
export function autonomousDreamRunner(ctx: Context): AutonomousDreamRunner {
  return async ({ session, route, config, system, signal }) => {
    const timeout = AbortSignal.timeout(config.timeoutMs); const bounded = AbortSignal.any([signal, timeout]); let stepError: Error | undefined; let completed = false;
    const handle = await ctx.agents.create({ sessionId: SessionId(`acn-dream-${randomUUID()}`), meta: { cwd: session.workspace, origin: 'subagent', delegationDepth: 1, agentPreset: 'acn-dream' }, agentOptions: { ...route, maxTokens: config.maxOutputTokens }, signal: bounded, setup: (child) => {
      child.tools.restrict({ allow: [] }); child.tools.presentAs('native');
      child.tools.guard((execution) => dreamToolGuard(execution.name, execution.arguments));
      for (const name of Object.keys(DreamTools).filter(isDreamTool)) {
        const tool = defineTool({ name, description: descriptions[name], parameters: {}, output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] }, execute: async (args, execution) => {
          bounded.throwIfAborted(); execution.signal.throwIfAborted();
          try { return z.json().parse(await session.execute(name, args, AbortSignal.any([bounded, execution.signal]))); }
          catch (error) { bounded.throwIfAborted(); if (error instanceof DreamValidationError || error instanceof z.ZodError) return { error: error.message, executed: false }; throw error; }
        } });
        child.tools.register({ ...tool, parameters: toolParameters(DreamTools[name]) });
      }
      child.systemPrompt.suppressRuntimeContext();
      child.systemPrompt.section({ name: 'acn-dream-only', order: 0, text: system, interpolate: false, complete: true });
      // required context 在每次请求准入后刷新，同一步重试进入收尾时也能收到通知。
      const budgetContext = 'acn-dream-budget';
      child.systemPrompt.context({ name: budgetContext, order: 0, text: () => session.budgetNotice(), interpolate: false, required: true });
      const shadowed = new Set<string>();
      child.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        for (const context of assembly.contexts) if (context.name !== budgetContext && !shadowed.has(context.name)) { child.systemPrompt.context({ name: context.name, order: 0, text: '', interpolate: false }); shadowed.add(context.name); }
        return { ...assembly, contexts: assembly.contexts.filter((context) => context.name === budgetContext), variables: {}, tools: assembly.tools.filter((tool) => isDreamTool(tool.name)) };
      });
      child.on('agent/pre-step', async (_payload, next) => {
        // finish 后不再调用模型生成装饰性总结。
        if (session.finished) throw new JobError('dream_finished', 'Dream 已完成。');
        bounded.throwIfAborted(); return next();
      });
      child.on('agent/request', async (payload, next) => {
        // 每次实际请求（包括宿主同一步内重试）均预占额度。
        try { await session.admitStep(AbortSignal.any([bounded, payload.signal])); }
        catch (error) { stepError = error instanceof Error ? error : new JobError('dream_step', 'Dream 模型请求准入失败。'); throw stepError; }
        return next();
      });
      child.on('session/event', (_session, event) => { if (event.type === 'turn/end') completed = event.data.reason.kind === 'completed'; });
    } });
    const cancel = () => { handle.agent.cancel({ kind: 'parent' }); };
    bounded.addEventListener('abort', cancel, { once: true });
    const waitForTurn = async () => {
      await abortable(handle.agent.whenIdle(), bounded); bounded.throwIfAborted();
      // 宿主直接取消子会话不会中止父 signal；idle 本身不代表可以继续收尾或发布最终记录。
      if (!session.finished && !completed) throw stepError ?? new JobError('dream_incomplete', 'Dream 子会话未正常结束；已有进度和额度保留，可通过 /acn-status retry 重试。');
    };
    try {
      bounded.throwIfAborted();
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: JSON.stringify(await session.input()) }], source: { kind: 'acn-formation' } }));
      await waitForTurn();
      // 最后一次探索若只返回文本，仍让宿主开启一个有限收尾 Turn。
      if (!session.finished && session.exhausted && !session.wrappingUp) {
        completed = false;
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '探索额度已用尽，请完成本次 Dream 收尾并调用 dream_finish。' }], source: { kind: 'acn-formation' } }));
        await waitForTurn();
      }
      if (!session.finished && session.exhausted) await session.finishBudget(bounded);
      if (session.finished) return;
      if (stepError !== undefined) throw stepError;
      throw new JobError('dream_incomplete', 'Dream 未调用 dream_finish；已有进度已保留，可通过 /acn-status retry 重试。');
    } catch (error) { signal.throwIfAborted(); if (timeout.aborted) throw new JobError('dream_timeout', 'Dream 超时，子会话已停止，已用轮数和进度保留。', true); throw error; }
    finally { bounded.removeEventListener('abort', cancel); await handle.dispose(); }
  };
}
