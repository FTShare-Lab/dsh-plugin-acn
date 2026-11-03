// 凭据写入使用独立请求，配置快照和响应中只有引用名与可用状态。
import { z } from 'zod';
import { MessageInfoSchema } from './interaction-messages.js';
import { TeamConnectionInputSchema, ConnectionChecksSchema } from './interaction.js';
const secret = z.string().min(1).max(16_384).refine((value) => value.trim().length > 0);
export const CredentialRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('describe'), reference: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
  z.strictObject({ action: z.literal('store'), reference: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: secret }),
  z.strictObject({ action: z.literal('discard'), reference: z.string().regex(/^ACN_TEAM_[0-9A-F]{32}$/) }),
  z.strictObject({ action: z.literal('check'), connection: TeamConnectionInputSchema, value: secret }),
]);
export type CredentialRequest = z.input<typeof CredentialRequestSchema>;
export const CredentialResultSchema = z.strictObject({ ok: z.boolean(), message: z.string(), messageInfo: MessageInfoSchema.optional(), configured: z.boolean().optional(), writable: z.boolean().optional(), checks: ConnectionChecksSchema.optional() });
export type CredentialResult = z.infer<typeof CredentialResultSchema>;
