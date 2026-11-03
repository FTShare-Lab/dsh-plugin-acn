// Dream 使用宿主 AgentLoop；只暴露领域事务与有界读取，不继承前台工具或私有上下文。
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { DreamTools, isDreamTool } from '../dream/autonomous.js';
import { DreamValidationError } from '../dream/schema.js';
import type { AutonomousDreamRunner } from '../dream/service.js';
import { abortable, transportError } from '../llm/structured.js';
import { JobError } from '../worker/types.js';
import { toolParameters } from './tool-schema.js';

const descriptions: Record<keyof typeof DreamTools, string> = {
  dream_record_candidates: '整批验证后登记候选；按 candidate_progress.current 逐项处理。当前组可保留原目标并扩展或调整种类，不能与其他待处理组重叠。',
  dream_stage_group: '暂存完整操作组，不写 Claim。纯 A 废弃可简写 id/action/reason；其他修改遵循 schema。group:null 撤回草稿但不撤销候选。',
  dream_validate: '校验当前草稿，返回 before/after、实际证据和 validation_id，随后逐 Claim 语义复核。',
  dream_apply_group: '提交当前 validation_id 与逐 Claim 语义复核；先持久记录再写 Claim，返回真实执行结果。',
  dream_keep_candidate: '明确保留当前候选，说明具体原因；不改变 Claim。',
  dream_read_draft: '查看已接受草稿、当前候选和剩余模型轮数。',
  dream_read_history: '分页读取本轮持久执行记录；回执不是独立事实证据。',
  dream_review_sync: '读取已有整合的同步依赖；确认后用同一 validation_id 和简洁语义 review 提交。',
  dream_finish: '提交 ABC 实际覆盖总结并结束；额度收尾时尚未完成的候选会标为未完成，不强求修改。',
  read_claim: '完整读取本轮自有 Claim；目录和摘要不授予修改权限。',
  read_trace: '先用 claim_id 分页查找已读自有 Claim 的关联 Trace（offset/limit 按条，默认 20、最多 100），再提供 claim_id 和 trace_id 分页读正文（offset/limit 按字符，默认 4000、最多 8000）。旧 id 仍可单独读取。Trace 是来源线索，不能单独证明事实。',
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
    const requestDeadline = new AbortController(); const bounded = AbortSignal.any([signal, requestDeadline.signal]); let stepError: Error | undefined; let completed = false;
    let clearRequestTimeout = () => {}; let toolJsonRetries = 0; let toolJsonFeedback = '';
    const binding = ctx.get('acnRuntime')?.backgroundSelection(session.knowledge.config);
    const handle = await ctx.agents.create({ sessionId: SessionId(`acn-dream-${randomUUID()}`), meta: { cwd: session.workspace, origin: 'subagent', delegationDepth: 1, agentPreset: 'acn-dream' }, agentOptions: { ...route, maxTokens: config.maxOutputTokens }, signal: bounded, setup: (child, agent) => {
      if (binding !== undefined) appendPluginRecord(agent.session, 'plugin:acn/team-selection', binding);
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
      const toolErrorContext = 'acn-dream-tool-error';
      child.systemPrompt.context({ name: toolErrorContext, order: 1, text: () => toolJsonFeedback, interpolate: false, required: true });
      const allowedContexts = new Set([budgetContext, toolErrorContext]);
      const shadowed = new Set<string>();
      child.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        for (const context of assembly.contexts) if (!allowedContexts.has(context.name) && !shadowed.has(context.name)) { child.systemPrompt.context({ name: context.name, order: 0, text: '', interpolate: false }); shadowed.add(context.name); }
        return { ...assembly, contexts: assembly.contexts.filter((context) => allowedContexts.has(context.name)), variables: {}, tools: assembly.tools.filter((tool) => isDreamTool(tool.name)) };
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
        clearRequestTimeout();
        const timeout = AbortSignal.timeout(config.timeoutMs);
        const expire = () => { requestDeadline.abort(timeout.reason); };
        timeout.addEventListener('abort', expire, { once: true });
        clearRequestTimeout = () => { timeout.removeEventListener('abort', expire); };
        return next();
      });
      // 一次模型尝试结束即解除其期限；工具执行和后续请求不累计到前一次调用。
      child.on('agent/assistant-stream', ({ frame }) => {
        if (frame.type !== 'end') return;
        clearRequestTimeout();
        if (frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message') toolJsonFeedback = '';
      });
      child.on('agent/request-error', async (payload, next) => {
        clearRequestTimeout();
        // 仅接管适配器明确报告的工具输入 JSON 语法错误；同一步重试仍经过 request 额度准入。
        if (payload.failure.code !== 'MALFORMED_RESPONSE' || !/(?:^|: )tool input is invalid JSON$/u.test(payload.failure.message)) return next();
        bounded.throwIfAborted(); payload.signal.throwIfAborted();
        if (toolJsonRetries < 2) {
          toolJsonRetries += 1;
          // 宿主未接纳失败响应，不能构造无对应调用的 tool result；通过公开 context 在重试前回喂安全原因。
          toolJsonFeedback = '工具参数 JSON 解析失败（MALFORMED_RESPONSE）。上一条模型响应未被接纳，该响应中的工具调用均未执行。请重新发出需要的工具调用，参数必须是完整合法的 JSON 对象，正确闭合并使用双引号和转义，同时遵守工具 schema。不要只输出解释或将失败调用视为已执行。已接受的进度保留，修复请求仍计入现有探索与收尾额度；按当前阶段和剩余额度行动。';
          return { kind: 'retry' };
        }
        stepError = new JobError('dream_tool_json', '模型返回的工具参数格式无效（MALFORMED_RESPONSE），自动重试两次后仍失败；进度和已用额度已保留，可稍后重试或更换知识模型。');
        // 达到本次上限后不再委托其他重试监听器，防止叠加宿主重试次数。
        return undefined;
      }, { prepend: true });
      child.on('session/event', (_session, event) => {
        if (event.type !== 'turn/end') return;
        clearRequestTimeout(); const reason = event.data.reason; completed = reason.kind === 'completed';
        if (stepError !== undefined) return;
        // 宿主已决定终止本轮；保存安全分类，不再叠加 worker 的模型自动重试。
        if (reason.kind === 'error') { const failure = transportError(reason.error); stepError = new JobError(failure.kind, `Dream 模型调用失败：${failure.message} 已有进度和已用额度保留。`); }
        if (reason.kind === 'max-tokens') stepError = new JobError('dream_output_limit', 'Dream 模型输出达到 token 上限（MAX_TOKENS）；进度和已用额度保留，请精简整理范围或调整输出上限后重试。');
      });
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
      // 普通文本不是协议收尾：沿用当前上下文给两次修复机会，每次仍经过额度准入。
      for (let repairs = 0; !session.finished && !session.exhausted && repairs < 2; repairs += 1) {
        completed = false;
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '上一条总结没有完成 Dream。不要重复普通文本收尾。继续使用工具修复；逐组 dream_validate、dream_apply_group，然后 dream_finish。无变化也必须调用 dream_finish；已经接受的草稿和复核仍保留。' }], source: { kind: 'acn-formation' } }));
        await waitForTurn();
      }
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
    } catch (error) { signal.throwIfAborted(); if (requestDeadline.signal.aborted) throw new JobError('dream_timeout', 'Dream 单次模型请求超时，子会话已停止，已用轮数和进度保留。', true); throw error; }
    finally { clearRequestTimeout(); bounded.removeEventListener('abort', cancel); await handle.dispose(); }
  };
}
