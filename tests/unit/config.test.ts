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

describe('Recap trigger defaults', () => {
  it('defaults to a twenty-entry catalog without overriding an explicit larger catalog', () => {
    expect(resolveConfig({}).catalog.maxClaims).toBe(20); expect(resolveConfig(HostConfig({})).catalog.maxClaims).toBe(20);
    expect(resolveConfig({ catalog: { maxClaims: 200 } }).catalog.maxClaims).toBe(200);
  });
  it('keeps domain and host defaults aligned, with legacy Finalize triggers opt-in', () => {
    const expected = { recapOnCompaction: true, idleRecap: true, recapMinTurns: 10, recapMinTokens: 100_000, recapBatchIdleMinutes: 5, recapTailIdleMinutes: 60, recapScanSeconds: 30, finalizeIdleMinutes: 0, finalizeOnDispose: false };
    expect(resolveConfig({}).formation).toEqual(expected);
    expect(resolveConfig(HostConfig({})).formation).toEqual(expected);
  });
  it.each(['recapMinTurns', 'recapMinTokens', 'recapBatchIdleMinutes', 'recapTailIdleMinutes', 'recapScanSeconds'])('rejects zero and fractional values for %s', (field) => {
    for (const value of [0, -1, 0.5]) expect(() => resolveConfig({ formation: { [field]: value } })).toThrow();
  });
});
