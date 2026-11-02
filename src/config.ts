// 配置只保存非敏感参数和环境变量名；领域层不依赖宿主配置运行时。
import { z } from 'zod';
import { AgentIdSchema } from './protocol/ids.js';

const positive = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const endpoint = z.string().refine((value) => {
  if (value === '') return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
});

export const ConnectionSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine((id) => !['personal', 'legacy'].includes(id)),
  name: z.string().trim().min(1).max(80), enabled: z.boolean().default(true), agentId: AgentIdSchema,
  routerEndpoint: endpoint.refine(Boolean), maintainerEndpoint: endpoint.refine(Boolean),
  keyEnv: z.string().regex(/^(?:[A-Za-z_][A-Za-z0-9_]*)?$/).default(''), timeoutMs: positive().default(15_000),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ConfigSchema = z.strictObject({
  agentId: z.union([z.literal(''), AgentIdSchema]).default(''),
  home: z.string().trim().min(1).default('~/.acn-dsh'),
  sessionEpoch: nonnegative().default(0),
  connections: z.array(ConnectionSchema).max(50).default([]),
  defaultConnection: z.string().default(''), legacyEnabled: z.boolean().default(true), showCompletion: z.boolean().default(true),
  team: z.strictObject({
    routerEndpoint: endpoint.default(''), maintainerEndpoint: endpoint.default(''),
    keyEnv: z.string().regex(/^(?:[A-Za-z_][A-Za-z0-9_]*)?$/).default(''),
    timeoutMs: positive().default(15_000), retryCount: nonnegative().default(3),
    retryBaseDelayMs: positive().default(500), retryMaxDelayMs: positive().default(8000),
  }).prefault({}),
  llm: z.strictObject({
    provider: z.string().default(''), model: z.string().default(''),
    maxOutputTokens: positive().default(32_768), timeoutMs: positive().default(600_000),
    structuredRetries: positive().default(5),
  }).prefault({}),
  catalog: z.strictObject({ maxClaims: positive().default(20), maxChars: positive().default(24_000) }).prefault({}),
  formation: z.strictObject({
    recapOnCompaction: z.boolean().default(true), idleRecap: z.boolean().default(true),
    recapMinTurns: positive().default(10), recapMinTokens: positive().default(100_000),
    recapBatchIdleMinutes: positive().default(5), recapTailIdleMinutes: positive().default(60), recapScanSeconds: positive().default(30),
    finalizeIdleMinutes: nonnegative().default(0), finalizeOnDispose: z.boolean().default(false),
  }).prefault({}),
  inbox: z.strictObject({ pullOnSessionStart: z.boolean().default(true), processingStaleAfterSecs: positive().default(600) }).prefault({}),
  dream: z.strictObject({
    enabled: z.boolean().default(true), minIntervalHours: positive().default(24),
    minChangedClaims: positive().default(5), checkIntervalHours: positive().default(4),
    evidenceCalibration: z.boolean().default(false), maxModelSteps: positive().max(128).default(24), maxWrapUpSteps: positive().max(8).default(3),
    evidenceMaxCalls: positive().max(256).default(32), evidenceMaxSteps: positive().max(128).default(24),
    evidenceMaxBytes: positive().max(16_777_216).default(1_048_576),
    evidenceMaxChars: positive().max(64_000).default(16_000), evidenceMaxFiles: positive().max(4096).default(256),
  }).prefault({}),
  memory: z.strictObject({
    enabled: z.boolean().default(true), memoryCharLimit: positive().default(1600), userCharLimit: positive().default(1000),
    safetyScan: z.boolean().default(true),
    review: z.strictObject({ enabled: z.boolean().default(true), intervalTurns: positive().default(10), maxTranscriptChars: positive().max(128_000).default(32_000) }).prefault({}),
  }).prefault({}),
}).superRefine((config, ctx) => {
  if (new Set(config.connections.map((item) => item.id)).size !== config.connections.length) ctx.addIssue({ code: 'custom', path: ['connections'], message: 'Connection identifiers must be unique.' });
  if (config.defaultConnection !== '' && config.defaultConnection !== 'legacy' && !config.connections.some((item) => item.id === config.defaultConnection && item.enabled)) ctx.addIssue({ code: 'custom', path: ['defaultConnection'], message: 'Default connection must be enabled.' });
  if (Boolean(config.team.routerEndpoint) !== Boolean(config.team.maintainerEndpoint)) ctx.addIssue({ code: 'custom', path: ['team'], message: 'Configure both team endpoints or neither.' });
  if (Boolean(config.llm.provider.trim()) !== Boolean(config.llm.model.trim())) ctx.addIssue({ code: 'custom', path: ['llm'], message: 'Configure both provider and model or neither.' });
  if (config.team.retryMaxDelayMs < config.team.retryBaseDelayMs) ctx.addIssue({ code: 'custom', path: ['team', 'retryMaxDelayMs'], message: 'Maximum retry delay must not be smaller than the base delay.' });
});
export type ResolvedConfig = z.output<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export class ConfigError extends Error {
  readonly kind = 'config';
  constructor(readonly fields: readonly string[]) { super(`Invalid ACN configuration: ${fields.join(', ')}`); this.name = 'ConfigError'; }
}
export function resolveConfig(input: unknown): ResolvedConfig {
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError([...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'config'))]);
  return parsed.data;
}
