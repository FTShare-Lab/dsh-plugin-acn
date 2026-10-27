// 检查领域与宿主两层默认值，避免宿主补全旧值覆盖领域配置。
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.js';
import { Config as HostConfig } from '../../src/plugins/knowledge.js';

describe('background model output budget', () => {
  it.each([{}, { llm: { provider: 'mock', model: 'mock' } }])('defaults to 32768 through both configuration paths: %j', (input) => {
    expect(resolveConfig(input).llm.maxOutputTokens).toBe(32_768);
    expect(resolveConfig(HostConfig(input)).llm.maxOutputTokens).toBe(32_768);
  });

  it('preserves an explicitly configured smaller budget', () => {
    const input = { llm: { maxOutputTokens: 8192 } };
    expect(resolveConfig(input).llm.maxOutputTokens).toBe(8192);
    expect(resolveConfig(HostConfig(input)).llm.maxOutputTokens).toBe(8192);
  });
});
