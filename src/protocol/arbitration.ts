// 仲裁上下文按扁平协议读取，保留扩展字段并兼容旧字段名称。
import { z } from 'zod';
import { ClaimSchema, ClaimStatusSchema } from './claim.js';
import { DisputeSchema } from './dispute.js';
import { ClaimIdSchema, DisputeIdSchema, ResolutionIdSchema } from './ids.js';
import { TextSchema, optional, withAliases } from './schema.js';
import { TimestampSchema } from './time.js';

export const ClaimAssessmentSchema = z.object({
  claim_id: ClaimIdSchema, recommended_status: ClaimStatusSchema, assessment: TextSchema,
  recommended_scope: optional(TextSchema), recommended_statement: optional(TextSchema), reason: TextSchema,
});
const resolutionFields = {
  resolution_id: ResolutionIdSchema,
  resolved_by: z.enum(['automatic', 'human']), resolved_at: TimestampSchema,
  resolution_type: optional(z.enum(['coexist', 'lifecycle_update', 'conflict_resolved', 'unresolved'])),
  resolution_basis: optional(z.enum(['direct_analysis', 'prior_resolution', 'policy', 'evidence', 'insufficient_evidence'])),
  conclusion: TextSchema,
  claim_assessments: z.array(ClaimAssessmentSchema).default([]).transform((value) => value.length === 0 ? undefined : value),
  rejection_reason: optional(TextSchema),
};
const aliases = { decision_id: 'resolution_id', decided_by: 'resolved_by', decided_at: 'resolved_at', snapshot_source_decision_id: 'snapshot_source_resolution_id' };
export const DisputeResolutionSchema = withAliases(z.object(resolutionFields), aliases);
export const ArbitrationResolutionContextSchema = withAliases(z.object({
  dispute_id: DisputeIdSchema, ...resolutionFields,
  context_snapshot_hash: optional(TextSchema), dispute_snapshot: DisputeSchema,
  direct_claim_snapshots: z.array(ClaimSchema), snapshot_source_resolution_id: optional(ResolutionIdSchema),
}).passthrough(), aliases);
export type ArbitrationResolutionContext = z.infer<typeof ArbitrationResolutionContextSchema>;
export type ClaimAssessment = z.infer<typeof ClaimAssessmentSchema>;
export type DisputeResolution = z.infer<typeof DisputeResolutionSchema>;
export type ResolutionType = NonNullable<DisputeResolution['resolution_type']>;
export type ResolutionBasis = NonNullable<DisputeResolution['resolution_basis']>;
export type ResolvedBy = DisputeResolution['resolved_by'];
