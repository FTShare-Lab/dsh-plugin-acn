// 推理封装适配不搜索任意 JSON 片段，不改动 JSON 正文或接受歧义尾段。
import { describe, expect, it } from 'vitest';
import { structuredResponseText } from '../../src/llm/response.js';
describe('explicit reasoning envelopes', () => {
  it.each(['<think>Analysis.</think>{"ops":[]}', 'Analysis with {"an":"example"}. </think>{"ops":[]}', '<think>Analysis.</think>\n```json\n{"ops":[]}\n```'])('accepts only a complete object after an explicit boundary: %s', (text) => {
    expect(structuredResponseText(text)).toBe('{"ops":[]}');
  });
  it('preserves a literal boundary inside the final JSON field', () => {
    expect(structuredResponseText('Analysis.</think>{"text":"</think> is data"}')).toBe('{"text":"</think> is data"}');
  });
  it.each(['{"text":"</think> is data"}', '```json\n{"text":"</think> is data"}\n```', 'Ordinary explanation: {"ops":[]}', 'Reasoning </think>{"ops":[]} trailing text', 'Reasoning </think>{"ops":', 'Reasoning </think>[]', 'Reasoning </think>null', 'Reasoning </think>{"ops":[]} </think>{"ops":[]}'])('preserves literal bodies, absent boundaries and invalid/ambiguous tails: %s', (text) => {
    expect(structuredResponseText(text)).toBe(text);
  });
});
