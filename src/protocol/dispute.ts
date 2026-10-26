// 读取历史争议保留原有宽度；上报时单独校验 Maintainer 所有的生命周期。
import { z } from 'zod';
import { AgentIdSchema, ClaimIdSchema, DisputeIdSchema } from './ids.js';
import { TextSchema, optional } from './schema.js';
import { TimestampSchema } from './time.js';

export const DisputeSchema = z.object({
  id: DisputeIdSchema, name: TextSchema,
  reporter_agent_id: AgentIdSchema.default(AgentIdSchema.parse('legacy-agent')),
  claims: z.array(ClaimIdSchema), summary: TextSchema,
  status: z.enum(['open', 'resolved']), created_at: TimestampSchema,
  resolved_at: optional(TimestampSchema),
});
export type Dispute = z.infer<typeof DisputeSchema>;
export type DisputeStatus = Dispute['status'];
export function validateAgentReport(value: unknown): Dispute {
  const dispute = DisputeSchema.parse(value);
  if (dispute.status !== 'open' || dispute.resolved_at !== undefined) throw new Error('An agent report must be open without resolved_at.');
  return dispute;
}
