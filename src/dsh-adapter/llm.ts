// 后台模型调用通过宿主准备能力与标准流组装器，不写入会话或伪造内置 purpose。
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { StructuredBackend } from '../llm/structured.js';
import { JobError } from '../worker/types.js';
import { structuredResponseText } from '../llm/response.js';
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'acn-formation': { kind: 'acn-formation' } } }

export function structuredBackend(ctx: Context): StructuredBackend {
  return async (route, system, input, maxTokens, signal) => {
    signal.throwIfAborted();
    const call = await ctx.llm.prepareCall({ ...route, maxTokens }, signal);
    const assembler = new BlockAssembler();
    for await (const chunk of call.stream({ ...call.config, messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'acn-formation' } })], system, signal })) { signal.throwIfAborted(); assembler.push(chunk); }
    signal.throwIfAborted();
    const finish = assembler.finish;
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const error = new Error('Auxiliary model stream failed.') as Error & { code: string; status?: number };
      error.code = finish.failure.code;
      if (finish.failure.status !== undefined) error.status = finish.failure.status;
      throw error;
    }
    if (finish.kind !== 'stop') throw new JobError('structured_output', '后台模型输出未完整结束；请检查输出 token 上限并重试任务。');
    const blocks = assembler.blocks();
    if (blocks.some((block) => block.type === 'tool-call' || block.type === 'image')) throw new JobError('structured_output', '后台模型应返回 JSON 文本，不应调用工具或返回附件。');
    return { text: structuredResponseText(blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')), ...(assembler.usage === undefined ? {} : { usage: assembler.usage }) };
  };
}
