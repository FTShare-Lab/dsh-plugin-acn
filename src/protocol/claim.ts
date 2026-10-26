// Claim 的字段顺序就是跨语言 revision 的序列化顺序。
import { z } from 'zod';
import { AgentIdSchema, ClaimIdSchema, SourceIdSchema } from './ids.js';
import { TextSchema, optional } from './schema.js';
import { TimestampSchema } from './time.js';

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const ClaimStatusSchema = z.enum(['active', 'stale', 'deprecated']);
export const ClaimSchema = z.object({
  id: ClaimIdSchema,
  name: TextSchema,
  statement: TextSchema,
  scope: TextSchema,
  holder: AgentIdSchema,
  confidence: ConfidenceSchema,
  status: ClaimStatusSchema,
  created_at: TimestampSchema,
  updated_at: optional(TimestampSchema),
  source_claim_ids: z.array(SourceIdSchema).default([]),
  evidence_summary: TextSchema,
});
export type Claim = z.infer<typeof ClaimSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;
export const effectiveUpdatedAt = (claim: Claim): string => claim.updated_at ?? claim.created_at;
