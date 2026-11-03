// 网页交互仅传递连接参数、公开知识与任务摘要，不传递私有记忆或凭据正文。
import { z } from 'zod';
import { MessageInfoSchema } from './interaction-messages.js';
import { ConnectionSchema, UpstreamSchema } from './config.js';
import { ClaimIdSchema } from './protocol/ids.js';

export const RuntimeChoiceSchema = z.object({ key: z.string(), name: z.string(), agentId: z.string(), enabled: z.boolean(), mode: z.enum(['solo', 'team']) });
export const SessionViewSchema = z.object({
  sessionId: z.string(), key: z.string(), name: z.string(), locked: z.boolean(), available: z.boolean(),
  phase: z.enum(['ready', 'syncing', 'failed', 'blocked']), message: z.string(), messageInfo: MessageInfoSchema.optional(), defaultConnection: z.string(),
  needsPreparation: z.boolean().default(false), explicitSelection: z.boolean().default(false),
  activeMode: z.enum(['solo', 'team']).optional(), configurationChanged: z.boolean().optional(),
  choices: z.array(RuntimeChoiceSchema), showCompletion: z.boolean(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;
export const KnowledgeItemSchema = z.object({ kind: z.enum(['claim', 'dispute', 'trace']), id: z.string(), name: z.string(), status: z.string(), detail: z.string() });
export const ActivitySchema = z.object({
  id: z.string(), kind: z.string(), state: z.string(), attempts: z.number(), updatedAt: z.number(), unseen: z.boolean().default(false), sessionId: z.string().optional(), summary: z.string(), error: z.string().optional(),
  summaryInfo: MessageInfoSchema.optional(), errorInfo: MessageInfoSchema.optional(), counts: z.record(z.string(), z.number()).optional(),
  warnings: z.array(z.string()).optional(), budgetLimited: z.boolean().optional(), requiresAttention: z.boolean().optional(),
  incompleteCandidates: z.array(z.object({ groupId: z.string(), claimIds: z.array(ClaimIdSchema), reason: z.string() })).optional(),
  entityId: z.string().optional(), retryable: z.boolean().optional(), acknowledged: z.boolean().optional(),
});
export type Activity = z.infer<typeof ActivitySchema>;
export const KnowledgeViewSchema = z.object({ key: z.string(), name: z.string(), items: z.array(KnowledgeItemSchema), omitted: z.number(), activities: z.array(ActivitySchema), activitiesOmitted: z.number().nonnegative().optional(), attentionCount: z.number().nonnegative().optional(), pendingClaims: z.number(), pendingDisputes: z.number() });
export type KnowledgeView = z.infer<typeof KnowledgeViewSchema>;
export const KnowledgeReferenceSchema = z.object({ key: z.string(), id: ClaimIdSchema, item: KnowledgeItemSchema.optional() });
export type KnowledgeReference = z.infer<typeof KnowledgeReferenceSchema>;
export const TeamConnectionInputSchema = z.union([ConnectionSchema, UpstreamSchema.safeExtend({ id: z.string().optional() })]);
export const ConnectionChecksSchema = z.array(z.object({ service: z.enum(['router', 'maintainer']), state: z.enum(['ok', 'failed']), message: z.string() }));
export const InteractionRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('session'), sessionId: z.string() }),
  z.object({ action: z.literal('select'), sessionId: z.string(), key: z.string() }),
  z.object({ action: z.literal('cancel'), sessionId: z.string() }),
  z.object({ action: z.literal('sync'), sessionId: z.string() }),
  z.object({ action: z.literal('knowledge'), key: z.string(), query: z.string().max(500).default(''), kind: z.enum(['claim', 'dispute', 'trace']).default('claim'), offset: z.number().int().nonnegative().default(0) }),
  z.object({ action: z.literal('activity'), key: z.string(), attentionOnly: z.boolean().default(false), sourceSession: z.string().default(''), offset: z.number().int().nonnegative().default(0) }),
  z.object({ action: z.literal('reference'), key: z.string(), id: ClaimIdSchema }),
  z.object({ action: z.literal('retry_delivery'), key: z.string() }),
  z.object({ action: z.literal('dream_again'), key: z.string(), id: z.string() }),
  z.object({ action: z.literal('retry'), key: z.string(), id: z.string() }),
  z.object({ action: z.literal('ack'), key: z.string(), id: z.string(), version: z.number().int().nonnegative() }),
  z.object({ action: z.literal('recap'), sessionId: z.string() }),
  z.object({ action: z.literal('check'), connection: TeamConnectionInputSchema }),
  z.object({ action: z.literal('probe'), provider: z.string(), model: z.string() }),
]);
export type InteractionRequest = z.input<typeof InteractionRequestSchema>;
export const InteractionResultSchema = z.object({
  ok: z.boolean(), message: z.string(), messageInfo: MessageInfoSchema.optional(), serviceAvailable: z.boolean().optional(), session: SessionViewSchema.optional(), knowledge: KnowledgeViewSchema.optional(),
  reference: KnowledgeReferenceSchema.optional(),
  checks: ConnectionChecksSchema.optional(),
});
export type InteractionResult = z.infer<typeof InteractionResultSchema>;
