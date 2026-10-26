// Inbox 的判别标签与租约无关，handled_at 仅表示本地处理完成。
import { z } from 'zod';
import { ArbitrationResolutionContextSchema } from './arbitration.js';
import { AgentIdSchema, InboxIdSchema } from './ids.js';
import { PolicySchema } from './policy.js';
import { optional, withAliases } from './schema.js';
import { TimestampSchema } from './time.js';

export const InboxMessageSchema = withAliases(z.discriminatedUnion('message_type', [
  z.object({ id: InboxIdSchema, message_type: z.literal('policy_update'), policy: PolicySchema, handled_at: optional(TimestampSchema) }),
  z.object({ id: InboxIdSchema, message_type: z.literal('claim_attribute_update'), policy: PolicySchema, arbitration_resolution: optional(ArbitrationResolutionContextSchema), handled_at: optional(TimestampSchema) }),
]), { arbitration_decision: 'arbitration_resolution' });
export type InboxMessage = z.infer<typeof InboxMessageSchema>;
export const InboxAckRequestSchema = z.object({ agent_id: AgentIdSchema, inbox_ids: z.array(InboxIdSchema) });
export const InboxPullRequestSchema = z.object({ agent_id: AgentIdSchema });
export type InboxAckRequest = z.infer<typeof InboxAckRequestSchema>;
export type InboxPullRequest = z.infer<typeof InboxPullRequestSchema>;
export const inboxEventAt = (message: InboxMessage): string => message.policy.updated_at ?? message.policy.created_at;
