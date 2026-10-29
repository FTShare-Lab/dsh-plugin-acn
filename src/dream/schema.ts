// 整理的计划、双向复核与可恢复提交协议；持久字段沿用知识整理记录格式。
import { z } from 'zod';
import { ClaimSchema, ClaimStatusSchema, ConfidenceSchema } from '../protocol/claim.js';
import { ClaimIdSchema, SourceIdSchema, TraceIdSchema } from '../protocol/ids.js';
import { TimestampSchema } from '../protocol/time.js';
import { FormationValidationError } from '../formation/schema.js';

export class DreamValidationError extends FormationValidationError {}
export const text = z.string().min(1).refine((value) => value.trim() !== '', 'Text cannot be blank.');
export const KeySchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
export const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const KindSchema = z.enum(['quality', 'evidence', 'consolidation']);
export const ReviewSummarySchema = z.strictObject({ quality: text, evidence: text, consolidation: text });
export const BasisSchema = z.strictObject({ claim_id: ClaimIdSchema, removed_or_changed: text, added: z.string(), justification: text, evidence_ids: z.array(z.string()) });
export const CoverageSchema = z.strictObject({ input_id: ClaimIdSchema, output_ids: z.array(ClaimIdSchema), note: text });
export const UpdateSchema = ClaimSchema.pick({ id: true, name: true, statement: true, scope: true, confidence: true, status: true, source_claim_ids: true, evidence_summary: true }).strict();
export const GroupSchema = z.strictObject({ kind: KindSchema, reason: text, evidence_ids: z.array(z.string()), coverage: z.array(CoverageSchema), change_basis: z.array(BasisSchema).default([]), updates: z.array(UpdateSchema) });
export const PlanSchema = z.object({ review: ReviewSummarySchema, groups: z.array(GroupSchema) });
const changes = z.strictObject({ name: z.string().optional(), statement: z.string().optional(), scope: z.string().optional(), confidence: ConfidenceSchema.optional(), status: ClaimStatusSchema.optional(), source_claim_ids: z.array(SourceIdSchema).describe('继承已有来源。来源指向被整合或将废弃的输入时仍保留；仅来源等于存续 ID 自身时移除该自引用。').optional(), evidence_summary: z.string().optional() });
export const OperationSchema = z.strictObject({ id: ClaimIdSchema, action: z.enum(['keep', 'update', 'deprecate']), changes: changes.default({}), reason: z.string().describe('仅供 quality/deprecate 且 changes 为空、无对应 change_basis 时简写依据。update、keep 及 evidence/consolidation 的所有 operation 必须省略此字段，修改依据放 group.change_basis.justification。').optional() });
export const DraftGroupSchema = z.strictObject({ kind: KindSchema, reason: text, evidence_ids: z.array(z.string()).default([]), coverage: z.array(CoverageSchema).default([]), change_basis: z.array(BasisSchema).default([]), operations: z.array(OperationSchema).min(1) });
export const CandidateSchema = z.strictObject({ group_id: KeySchema, claim_ids: z.array(ClaimIdSchema).min(1), kind: KindSchema, reason: text });
export const KeepReasonSchema = z.enum(['insufficient_evidence', 'useful_knowledge', 'uncertain_preservation', 'no_consolidation_benefit', 'external_change']);
export const DraftResponseSchema = z.discriminatedUnion('action', [z.strictObject({ action: z.literal('stage'), group: DraftGroupSchema }), z.strictObject({ action: z.literal('keep'), reason_kind: KeepReasonSchema, reason: text })]);
export const DiscoverySchema = z.strictObject({ review: ReviewSummarySchema, candidates: z.array(CandidateSchema), sync_candidates: z.array(z.strictObject({ source_id: ClaimIdSchema, carrier_ids: z.array(ClaimIdSchema).min(1), reason: text })) });
export const QuoteSchema = z.strictObject({ claim_id: ClaimIdSchema, field: z.enum(['name', 'statement', 'scope', 'evidence_summary']), quote: text });
const evidenceQuote = z.strictObject({ evidence_id: z.string(), quote: text });
export const SelfReviewSchema = z.strictObject({ group_id: KeySchema, validation_id: HashSchema, preservation: z.array(z.strictObject({ before: QuoteSchema, after: z.array(QuoteSchema), disposition: z.enum(['preserved', 'episodic', 'corrected']), reason: text, evidence: z.array(evidenceQuote) })), support: z.array(z.strictObject({ after: QuoteSchema, before: z.array(QuoteSchema), evidence: z.array(evidenceQuote), reason: text })), scope_and_certainty: text });
export const SemanticReviewSchema = z.strictObject({ claims: z.array(z.strictObject({ claim_id: ClaimIdSchema, final_name: z.string().default(''), name_reason: z.string().default(''), information_preserved: text, removal_or_correction: text, factual_correction: z.boolean(), output_ids: z.array(ClaimIdSchema), evidence_ids: z.array(z.string()) })), scope_and_certainty: text });
export const ReviewInputSchema = z.strictObject({ group_id: KeySchema, kind: KindSchema, reason: text, before: z.array(ClaimSchema), after: z.array(UpdateSchema), changes: z.array(OperationSchema), coverage: z.array(CoverageSchema), change_basis: z.array(BasisSchema), unversioned_evidence_omitted: z.array(z.string()).default([]), evidence: z.record(z.string(), z.json()) });
export const ValidationSchema = z.strictObject({ validation_id: HashSchema, input: ReviewInputSchema });
export const ReviewRecordSchema = z.strictObject({ validation: ValidationSchema, review: SelfReviewSchema });
export const ReviewResponseSchema = z.strictObject({ decision: z.enum(['apply', 'repair', 'keep']), reason: text, reason_kind: KeepReasonSchema, semantic: SemanticReviewSchema.nullable(), self_review: SelfReviewSchema.nullable() });
export const PreparedGroupSchema = z.object({ before: z.array(ClaimSchema), after: z.array(ClaimSchema), completed: z.boolean().default(false), skipped: z.boolean().default(false) });
export const CheckpointSchema = z.object({ team_authorized: z.boolean().optional(), snapshot_at: TimestampSchema, input_versions: z.record(ClaimIdSchema, z.string()), coverage: z.json(), plan: PlanSchema, receipts: z.record(z.string(), z.json()), exploration_receipts: z.number().int().nonnegative().optional(), groups: z.array(PreparedGroupSchema), safety_reviews: z.array(z.json()).default([]), self_reviews: z.array(ReviewRecordSchema).default([]), trace_id: TraceIdSchema, applied: z.boolean().default(false), success_at: TimestampSchema.nullable().optional(), self_versions: z.record(ClaimIdSchema, z.string()).default({}), operation: z.object({ job_id: KeySchema, group_id: KeySchema, validation_id: HashSchema, review: SemanticReviewSchema, hard_validation_passed: z.boolean() }).nullable().optional() });
export const DreamStateSchema = z.object({ last_success_at: TimestampSchema.nullable().default(null), last_input_snapshot_at: TimestampSchema.nullable().default(null), known_versions: z.record(ClaimIdSchema, z.string()).default({}) });
export const OriginSchema = z.strictObject({ snapshot_at: TimestampSchema, claims: z.array(ClaimSchema), coverage: z.json(), workspace_root: z.string().optional() });
export const ProgressSchema = z.strictObject({ schemaVersion: z.literal(1), discovery: DiscoverySchema, entries: z.array(z.strictObject({ candidate: CandidateSchema, status: z.enum(['pending', 'executed', 'kept', 'skipped']), reason: z.string(), draft: GroupSchema.nullable(), validation: ValidationSchema.nullable(), review: ReviewResponseSchema.nullable() })), syncCompleted: z.array(ClaimIdSchema), finished: z.boolean(), finish_reminder_sent: z.boolean().default(false), proposal_attempted: z.boolean().default(false), exploration_receipts: z.number().int().nonnegative().default(0), summary: z.strictObject({ checked: z.string(), findings: z.string(), uncertainties: z.string(), next_steps: z.string() }).nullable(), compactedThrough: z.number().int().nonnegative().default(0), autonomy: z.strictObject({ steps: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(), limit: z.number().int().positive(), read_ids: z.array(ClaimIdSchema), wrap_up: z.strictObject({ steps: z.number().int().nonnegative(), limit: z.number().int().positive() }).optional() }).optional() });
export type Group = z.infer<typeof GroupSchema>;
export type DraftGroup = z.infer<typeof DraftGroupSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type Validation = z.infer<typeof ValidationSchema>;
export type SemanticReview = z.infer<typeof SemanticReviewSchema>;
export type SelfReview = z.infer<typeof SelfReviewSchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
export type PreparedGroup = z.infer<typeof PreparedGroupSchema>;
export function requireDream(condition: boolean, message: string): asserts condition { if (!condition) throw new DreamValidationError(message); }
