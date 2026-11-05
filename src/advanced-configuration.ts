// 界面中的高级参数使用现有团队与收件配置，秒与毫秒只在边界换算。
import { z } from 'zod';
import { resolveConfig } from './config.js';
const seconds = z.number().min(0.001).max(Number.MAX_SAFE_INTEGER / 1000);
const milliseconds = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const AdvancedConfigurationSchema = z.strictObject({
  inboxProcessingStaleAfterSecs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  routerQueryTimeoutSecs: seconds, httpTimeoutSecs: seconds,
  httpRetryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  httpRetryBaseDelayMs: milliseconds, httpRetryMaxDelayMs: milliseconds,
}).superRefine((value, ctx) => {
  if (value.httpRetryMaxDelayMs < value.httpRetryBaseDelayMs) ctx.addIssue({ code: 'custom', path: ['httpRetryMaxDelayMs'], message: 'Maximum retry delay must not be smaller than the base delay.' });
});
export type AdvancedConfiguration = z.infer<typeof AdvancedConfigurationSchema>;
export function advancedConfiguration(raw: unknown): AdvancedConfiguration {
  const config = resolveConfig(raw);
  return { inboxProcessingStaleAfterSecs: config.inbox.processingStaleAfterSecs, routerQueryTimeoutSecs: config.team.routerTimeoutMs / 1000,
    httpTimeoutSecs: config.team.timeoutMs / 1000, httpRetryCount: config.team.retryCount,
    httpRetryBaseDelayMs: config.team.retryBaseDelayMs, httpRetryMaxDelayMs: config.team.retryMaxDelayMs };
}
