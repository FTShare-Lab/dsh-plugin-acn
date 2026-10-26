// Trace 的输入允许 Claim 与 Policy，输出只能是 Claim。
import { z } from 'zod';
import { AgentIdSchema, ClaimIdSchema, SourceIdSchema, TraceIdSchema } from './ids.js';
import { TextSchema } from './schema.js';
import { TimestampSchema } from './time.js';

export const TraceSchema = z.object({
  id: TraceIdSchema, name: TextSchema, task: TextSchema, agent: AgentIdSchema,
  input_claims: z.array(SourceIdSchema).default([]),
  output_claims: z.array(ClaimIdSchema).default([]),
  created_at: TimestampSchema,
});
export type Trace = z.infer<typeof TraceSchema>;
