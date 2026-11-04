// 高级参数经过同一配置事务保存；界面草稿不能暗中改写其他连接或高级字段。
import { describe, expect, it } from 'vitest';
import { advancedConfiguration, AdvancedConfigurationSchema } from '../../src/advanced-configuration.js';
import { configurationValues, mergeConfiguration } from '../../src/configuration.js';
import { resolveConfig } from '../../src/config.js';
describe('advanced configuration', () => {
  const raw = { upstream: 'team-a', upstreams: { 'team-a': { agentId: 'agent-a', timeoutMs: 5500 }, 'team-b': { agentId: 'agent-b', timeoutMs: 7000 } }, team: { timeoutMs: 15000, retryCount: 4 }, llm: { timeoutMs: 12345 } };
  it('projects plugin defaults and preserves decimal seconds without using UI-specific defaults', () => {
    expect(advancedConfiguration({})).toMatchObject({ inboxProcessingStaleAfterSecs: 600, routerQueryTimeoutSecs: 50, httpTimeoutSecs: 15, httpRetryCount: 3, httpRetryBaseDelayMs: 500, httpRetryMaxDelayMs: 8000 });
    expect(advancedConfiguration({ team: { timeoutMs: 5500 } }).httpTimeoutSecs).toBe(5.5);
  });
  it('updates six existing settings and applies an explicit global HTTP timeout change to all profiles', () => {
    const values = configurationValues(raw); const advanced = { ...advancedConfiguration(raw), inboxProcessingStaleAfterSecs: 900, routerQueryTimeoutSecs: 12.5, httpTimeoutSecs: 9, httpRetryCount: 0, httpRetryBaseDelayMs: 300, httpRetryMaxDelayMs: 4000 };
    const result = resolveConfig(mergeConfiguration(raw, { ...values, advanced }));
    expect(result.team).toMatchObject({ timeoutMs: 9000, routerTimeoutMs: 12500, retryCount: 0, retryBaseDelayMs: 300, retryMaxDelayMs: 4000 });
    expect(result.inbox.processingStaleAfterSecs).toBe(900); expect(result.llm.timeoutMs).toBe(12345);
    expect(result.upstreams?.['team-a']?.timeoutMs).toBe(9000); expect(result.upstreams?.['team-b']?.timeoutMs).toBe(9000);
  });
  it('keeps per-profile timeouts when saving another preference and accepts legacy common-field edits', () => {
    const values = configurationValues(raw);
    expect(resolveConfig(mergeConfiguration(raw, { ...values, showCompletion: false })).upstreams).toEqual(resolveConfig(raw).upstreams);
    expect(resolveConfig(mergeConfiguration(raw, { ...values, advanced: { ...advancedConfiguration(raw), httpRetryCount: 0 } })).upstreams?.['team-a']?.timeoutMs).toBe(5500);
    expect(resolveConfig(mergeConfiguration({}, { ...configurationValues({}), timeoutMs: 4321 })).team.timeoutMs).toBe(4321);
  });
  it('rejects empty, negative and inconsistent retry settings without mutating the old configuration', () => {
    const defaults = advancedConfiguration({});
    for (const advanced of [{ ...defaults, httpRetryCount: -1 }, { ...defaults, httpTimeoutSecs: 0 }, { ...defaults, httpRetryBaseDelayMs: 5000, httpRetryMaxDelayMs: 1000 }]) expect(AdvancedConfigurationSchema.safeParse(advanced).success).toBe(false);
    expect(raw.team.retryCount).toBe(4);
  });
  it('also updates legacy connection timeouts when the global timeout is explicitly changed', () => {
    const legacy = { connections: [{ id: 'example', name: 'Example', agentId: 'agent-a', routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org', timeoutMs: 4000 }] };
    const values = configurationValues(legacy);
    const result = resolveConfig(mergeConfiguration(legacy, { ...values, advanced: { ...advancedConfiguration(legacy), httpTimeoutSecs: 6 } }));
    expect(result.connections[0]?.timeoutMs).toBe(6000);
  });
});
