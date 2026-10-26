// 网页字段覆盖不能重置高级参数；认证只接受环境变量引用。
import { describe, expect, it } from 'vitest';
import { configurationValues, mergeConfiguration } from '../../src/configuration.js';

describe('web configuration values', () => {
  it('preserves advanced settings while changing the common fields', () => {
    const raw = { agentId: 'agent-a', llm: { timeoutMs: 81234, structuredRetries: 3 }, team: { retryCount: 7 }, dream: { evidenceCalibration: true }, memory: { safetyScan: false } };
    const values = { ...configurationValues(raw), agentId: 'agent-b', provider: 'example', model: 'example-model', mode: 'team' as const, routerEndpoint: 'http://127.0.0.1:8101', maintainerEndpoint: 'http://127.0.0.1:8102', keyEnv: 'EXAMPLE_TEAM_TOKEN' };
    expect(mergeConfiguration(raw, values)).toMatchObject({ ...raw, agentId: 'agent-b', llm: { timeoutMs: 81234, structuredRetries: 3, provider: 'example', model: 'example-model' }, team: { retryCount: 7, routerEndpoint: values.routerEndpoint, maintainerEndpoint: values.maintainerEndpoint, keyEnv: 'EXAMPLE_TEAM_TOKEN' } });
    expect(raw.agentId).toBe('agent-a');
  });
  it('clears team routes and credential references in solo mode', () => {
    const raw = { agentId: 'agent-a', team: { routerEndpoint: 'http://127.0.0.1:8101', maintainerEndpoint: 'http://127.0.0.1:8102', keyEnv: 'EXAMPLE_TEAM_TOKEN', retryCount: 2 } };
    expect(mergeConfiguration(raw, { ...configurationValues(raw), mode: 'solo' })).toMatchObject({ team: { routerEndpoint: '', maintainerEndpoint: '', keyEnv: '', retryCount: 2 } });
  });
  it.each([
    { agentId: '../escape' }, { home: '' }, { provider: 'example', model: '' },
    { mode: 'team', routerEndpoint: 'http://127.0.0.1:8101' },
    { mode: 'team', routerEndpoint: 'https://example.test/?credential=example', maintainerEndpoint: 'https://example.test' },
    { mode: 'team', keyEnv: 'not-a-variable-name' }, { timeoutMs: -1 },
  ])('reuses domain validation for %j', (override) => {
    expect(() => mergeConfiguration({}, { ...configurationValues({}), ...override } as ReturnType<typeof configurationValues>)).toThrow();
  });
});
