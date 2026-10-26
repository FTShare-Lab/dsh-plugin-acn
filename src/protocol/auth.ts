// 鉴权信封拒绝未知字段；调用者只在请求时填充凭据。
import { z } from 'zod';
import { AgentIdSchema } from './ids.js';
import { TextSchema } from './schema.js';

export const AuthEnvelopeSchema = z.strictObject({ agent_id: AgentIdSchema, acn_key: TextSchema });
export const authRequestSchema = <T extends z.ZodType>(data: T) => z.strictObject({ auth: AuthEnvelopeSchema, data });
export const HealthRequestSchema = z.strictObject({ auth: AuthEnvelopeSchema.nullish(), data: z.strictObject({}).default({}) });
export const HealthResponseSchema = z.object({ status: z.string(), team_auth_enabled: z.boolean(), auth_passed: z.boolean().optional() });
export type AuthEnvelope = z.infer<typeof AuthEnvelopeSchema>;
export interface AuthRequest<T> { auth: AuthEnvelope; data: T }
export type HealthRequest = z.infer<typeof HealthRequestSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
