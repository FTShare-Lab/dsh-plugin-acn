// Policy 的缺省消息类型与定向字段沿用持久化兼容规则。
import { z } from 'zod';
import { AgentIdSchema, PolicyIdSchema } from './ids.js';
import { TextSchema, optional } from './schema.js';
import { TimestampSchema } from './time.js';

export const PolicySchema = z.object({
  id: PolicyIdSchema,
  message_type: z.enum(['policy_update', 'claim_attribute_update']).default('policy_update'),
  name: TextSchema, statement: TextSchema, scope: TextSchema,
  status: z.enum(['active', 'deprecated']), created_at: TimestampSchema,
  updated_at: optional(TimestampSchema), target_agents: optional(z.array(AgentIdSchema)),
});
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyMessageType = Policy['message_type'];
export type PolicyStatus = Policy['status'];
