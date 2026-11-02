// 网页仅编辑常用配置；高级字段保留在原配置中，由同一领域校验器检查。
import { z } from 'zod';
import { resolveConfig, ConnectionSchema } from './config.js';

export const ConfigurationValuesSchema = z.strictObject({
  agentId: z.string().trim(), home: z.string().trim(),
  provider: z.string().trim(), model: z.string().trim(),
  mode: z.enum(['solo', 'team']),
  routerEndpoint: z.string().trim(), maintainerEndpoint: z.string().trim(), keyEnv: z.string().trim(),
  timeoutMs: z.number(),
  legacyEnabled: z.boolean().optional(), connections: z.array(ConnectionSchema).optional(), defaultConnection: z.string().optional(), showCompletion: z.boolean().optional(),
});
export type ConfigurationValues = z.infer<typeof ConfigurationValuesSchema>;
export const ModelChoiceSchema = z.strictObject({ provider: z.string(), providerName: z.string(), id: z.string(), name: z.string() });
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
export const ConfigurationSnapshotSchema = z.strictObject({
  revision: z.string(), values: ConfigurationValuesSchema, models: z.array(ModelChoiceSchema),
  active: z.boolean(), dataDirectory: z.string(),
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
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function mergeConfiguration(raw: Record<string, unknown>, values: ConfigurationValues): Record<string, unknown> {
  const next = {
    ...raw, agentId: values.agentId, home: values.home,
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
  resolveConfig(next);
  return next;
}
