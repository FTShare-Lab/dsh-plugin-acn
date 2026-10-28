// 从真实宿主工具反馈构造下一步模型响应，避免在测试中伪造验证版本与证据回执。
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { ValidationSchema } from '../../src/dream/schema.js';
import { toolResponse } from '../flow/adapter.js';
import { reviews, reviewSummary } from './helpers.js';

export function lastJson(request: GenerateOptions): unknown {
  for (const message of [...request.messages].reverse()) for (const block of [...message.content].reverse()) if (block.type === 'text') {
    try { return JSON.parse(block.text) as unknown; } catch { /* 工具正文之前可能有宿主包装。 */ }
  }
  throw new Error('No JSON tool response.');
}
export const applyValidated = (request: GenerateOptions) => {
  const validation = ValidationSchema.parse(lastJson(request));
  return toolResponse('apply', 'dream_apply_group', { group_id: validation.input.group_id, validation_id: validation.validation_id, review: reviews(validation).semantic });
};
export const finishDream = () => toolResponse('finish', 'dream_finish', { review: reviewSummary });
export const readReceipt = (request: GenerateOptions) => z.object({ evidence_id: z.string() }).passthrough().parse(lastJson(request));
