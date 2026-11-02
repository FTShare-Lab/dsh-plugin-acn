// 网页交互仅传递连接参数、公开知识与任务摘要，不传递私有记忆或凭据正文。
import { z } from 'zod';
import { ConnectionSchema } from './config.js';

export const RuntimeChoiceSchema = z.object({ key: z.string(), name: z.string(), agentId: z.string(), enabled: z.boolean(), mode: z.enum(['solo', 'team']) });
export const SessionViewSchema = z.object({
  sessionId: z.string(), key: z.string(), name: z.string(), locked: z.boolean(), available: z.boolean(),
  phase: z.enum(['ready', 'syncing', 'failed', 'blocked']), message: z.string(), defaultConnection: z.string(),
  needsPreparation: z.boolean().default(false), explicitSelection: z.boolean().default(false),
  choices: z.array(RuntimeChoiceSchema), showCompletion: z.boolean(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;
export const KnowledgeItemSchema = z.object({ kind: z.enum(['claim', 'dispute', 'trace']), id: z.string(), name: z.string(), status: z.string(), detail: z.string() });
export const ActivitySchema = z.object({ id: z.string(), kind: z.string(), state: z.string(), attempts: z.number(), updatedAt: z.number(), unseen: z.boolean().default(false), sessionId: z.string().optional(), summary: z.string(), error: z.string().optional() });
export type Activity = z.infer<typeof ActivitySchema>;
export const KnowledgeViewSchema = z.object({ key: z.string(), name: z.string(), items: z.array(KnowledgeItemSchema), omitted: z.number(), activities: z.array(ActivitySchema), pendingClaims: z.number(), pendingDisputes: z.number() });
export type KnowledgeView = z.infer<typeof KnowledgeViewSchema>;
export const InteractionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('session'), sessionId: z.string() }),
  z.object({ action: z.literal('select'), sessionId: z.string(), key: z.string() }),
  z.object({ action: z.literal('cancel'), sessionId: z.string() }),
  z.object({ action: z.literal('sync'), sessionId: z.string() }),
  z.object({ action: z.literal('knowledge'), key: z.string(), query: z.string().max(500).default(''), kind: z.enum(['claim', 'dispute', 'trace']).default('claim'), offset: z.number().int().nonnegative().default(0) }),
  z.object({ action: z.literal('activity'), key: z.string() }),
  z.object({ action: z.literal('retry'), key: z.string(), id: z.string() }),
  z.object({ action: z.literal('ack'), key: z.string(), id: z.string(), version: z.number().int().nonnegative() }),
  z.object({ action: z.literal('recap'), sessionId: z.string() }),
  z.object({ action: z.literal('check'), connection: ConnectionSchema }),
  z.object({ action: z.literal('probe'), provider: z.string(), model: z.string() }),
]);
export type InteractionRequest = z.input<typeof InteractionRequestSchema>;
export const InteractionResultSchema = z.object({
  ok: z.boolean(), message: z.string(), session: SessionViewSchema.optional(), knowledge: KnowledgeViewSchema.optional(),
  checks: z.array(z.object({ service: z.enum(['router', 'maintainer']), state: z.enum(['ok', 'failed']), message: z.string() })).optional(),
});
export type InteractionResult = z.infer<typeof InteractionResultSchema>;
