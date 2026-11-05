// 插件设置编辑工作配置与高级偏好；未展示的字段保留，由同一领域校验器检查。
import { z } from 'zod';
import { resolveConfig, ConnectionSchema, UpstreamSchema, UpstreamNameSchema } from './config.js';
import { ConfigError } from './config.js';
import { upstreamsOf } from './upstreams.js';
import { AdvancedConfigurationSchema, advancedConfiguration } from './advanced-configuration.js';

export const ConfigurationValuesSchema = z.strictObject({
  agentId: z.string().trim(), home: z.string().trim(),
  provider: z.string().trim(), model: z.string().trim(),
  mode: z.enum(['solo', 'team']),
  routerEndpoint: z.string().trim(), maintainerEndpoint: z.string().trim(), keyEnv: z.string().trim(),
  timeoutMs: z.number(),
  legacyEnabled: z.boolean().optional(), connections: z.array(ConnectionSchema).optional(), defaultConnection: z.string().optional(), showCompletion: z.boolean().optional(),
  upstream: z.string().optional(), upstreams: z.record(UpstreamNameSchema, UpstreamSchema).optional(),
  advanced: AdvancedConfigurationSchema.optional(),
});
export type ConfigurationValues = z.infer<typeof ConfigurationValuesSchema>;
export const ModelChoiceSchema = z.strictObject({ provider: z.string(), providerName: z.string(), id: z.string(), name: z.string() });
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
export const ConfigurationSnapshotSchema = z.strictObject({
  revision: z.string(), values: ConfigurationValuesSchema, models: z.array(ModelChoiceSchema),
  active: z.boolean(), dataDirectory: z.string(),
  upstreamPending: z.record(z.string(), z.number().int().nonnegative().nullable()).optional(),
});
export type ConfigurationSnapshot = z.infer<typeof ConfigurationSnapshotSchema>;
export const SaveConfigurationSchema = z.strictObject({ revision: z.string(), values: ConfigurationValuesSchema });
export type SaveConfiguration = z.infer<typeof SaveConfigurationSchema>;
export const ConfigurationResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), snapshot: ConfigurationSnapshotSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid', 'conflict', 'unavailable', 'persistence', 'inactive', 'busy']), fields: z.array(z.string()) }),
]);
export type ConfigurationResult = z.infer<typeof ConfigurationResultSchema>;

export function configurationValues(raw: unknown): ConfigurationValues {
  const config = resolveConfig(raw);
  return {
    agentId: config.agentId, home: config.home, provider: config.llm.provider, model: config.llm.model,
    mode: config.team.routerEndpoint === '' ? 'solo' : 'team',
    routerEndpoint: config.team.routerEndpoint, maintainerEndpoint: config.team.maintainerEndpoint,
    keyEnv: config.team.keyEnv, timeoutMs: config.team.timeoutMs,
    legacyEnabled: config.legacyEnabled, connections: config.connections, defaultConnection: config.defaultConnection, showCompletion: config.showCompletion,
    advanced: advancedConfiguration(config),
    ...(config.upstreams === undefined ? {} : { upstreams: config.upstreams, upstream: config.upstream }),
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function mergeConfiguration(raw: Record<string, unknown>, values: ConfigurationValues): Record<string, unknown> {
  if (values.upstreams !== undefined) {
    const previous = upstreamsOf(resolveConfig(raw));
    for (const [key, value] of Object.entries(values.upstreams)) {
      if (value.legacyStorage !== previous[key]?.legacyStorage || value.legacyKey !== previous[key]?.legacyKey) throw new ConfigError(['upstreams', key, 'legacyStorage']);
    }
  }
  const next: Record<string, unknown> = {
    ...raw, agentId: values.agentId, home: values.home,
    ...(values.upstreams === undefined ? {} : { upstreams: values.upstreams, upstream: values.upstream ?? '' }),
    ...(values.legacyEnabled === undefined ? {} : { legacyEnabled: values.legacyEnabled }),
    ...(values.connections === undefined ? {} : { connections: values.connections }),
    ...(values.defaultConnection === undefined ? {} : { defaultConnection: values.defaultConnection }),
    ...(values.showCompletion === undefined ? {} : { showCompletion: values.showCompletion }),
    llm: { ...record(raw.llm), provider: values.provider, model: values.model },
    team: {
      ...record(raw.team), timeoutMs: values.timeoutMs,
      routerEndpoint: values.mode === 'team' ? values.routerEndpoint : '',
      maintainerEndpoint: values.mode === 'team' ? values.maintainerEndpoint : '',
      keyEnv: values.mode === 'team' ? values.keyEnv : '',
    },
  };
  delete next['projectUpstreams']; delete next['memory'];
  const advanced = values.advanced;
  if (advanced !== undefined) {
    next['inbox'] = { ...record(raw.inbox), processingStaleAfterSecs: advanced.inboxProcessingStaleAfterSecs };
    const previousTeam = resolveConfig(raw).team;
    const httpChanged = advanced.httpTimeoutSecs !== previousTeam.timeoutMs / 1000;
    const timeoutMs = httpChanged ? Math.round(advanced.httpTimeoutSecs * 1000) : values.timeoutMs;
    const routerTimeoutMs = advanced.routerQueryTimeoutSecs === previousTeam.routerTimeoutMs / 1000 ? previousTeam.routerTimeoutMs : Math.round(advanced.routerQueryTimeoutSecs * 1000);
    next['team'] = { ...record(next['team']), timeoutMs, routerTimeoutMs, retryCount: advanced.httpRetryCount, retryBaseDelayMs: advanced.httpRetryBaseDelayMs, retryMaxDelayMs: advanced.httpRetryMaxDelayMs };
    // 仅显式修改全局 HTTP 超时才统一现有配置，其他偏好保存保留各连接的原值。
    if (httpChanged && values.upstreams !== undefined) next['upstreams'] = Object.fromEntries(Object.entries(values.upstreams).map(([key, value]) => [key, { ...value, timeoutMs }]));
    if (httpChanged && values.connections !== undefined) next['connections'] = values.connections.map((value) => ({ ...value, timeoutMs }));
  }
  resolveConfig(next);
  return next;
}
