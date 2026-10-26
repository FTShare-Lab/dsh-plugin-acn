// Router 的候选正文、争议关联与聚合快照 DTO。
import { z } from 'zod';
import { ClaimSchema } from './claim.js';
import { ClaimIdSchema, DisputeIdSchema } from './ids.js';
import { TextSchema, optional } from './schema.js';
import { TimestampSchema } from './time.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AgentQuerySchema = z.object({ scope: TextSchema, semantic_query: TextSchema.nullable().default(null) });
export const CandidateClaimSchema = ClaimSchema.extend({ open_dispute_ids: z.array(DisputeIdSchema).default([]), resolved_dispute_ids: z.array(DisputeIdSchema).default([]) });
export const DisputeRefSchema = z.object({ id: DisputeIdSchema, name: TextSchema, claim_ids: z.array(ClaimIdSchema), summary: TextSchema, status: z.enum(['open', 'resolved']) });
const retrievalDebug = z.object({
  mode: TextSchema, failed_paths: z.array(TextSchema).default([]), error_summaries: z.array(TextSchema).default([]),
  lexical_hits: count.default(0), vector_hits: count.default(0), rerank_fallback: z.boolean().default(false),
  candidates: z.array(z.object({ claim_id: TextSchema, hit_sources: TextSchema, lexical_score: count.default(0), vector_score: count.default(0), rank_before_rerank: count.default(0), rank_after_rerank: count.default(0), vector_status: TextSchema })).default([]),
});
export const RouterQueryResultSchema = z.object({ candidate_claims: z.array(CandidateClaimSchema), disputes: z.array(DisputeRefSchema), retrieval_debug: optional(retrievalDebug) });
export const ScopeOverviewItemSchema = z.strictObject({ scope: TextSchema, active_claims: count, stale_claims: count, open_disputes: count, resolved_disputes: count, latest_claim_created_at: TimestampSchema });
export const ScopesOverviewSnapshotSchema = z.strictObject({ scopes: z.array(ScopeOverviewItemSchema).default([]) });
export type RouterQueryResult = z.infer<typeof RouterQueryResultSchema>;
export type AgentQuery = z.infer<typeof AgentQuerySchema>;
export type CandidateClaim = z.infer<typeof CandidateClaimSchema>;
export type DisputeRef = z.infer<typeof DisputeRefSchema>;
export type ScopeOverviewItem = z.infer<typeof ScopeOverviewItemSchema>;
export type ScopesOverviewSnapshot = z.infer<typeof ScopesOverviewSnapshotSchema>;
