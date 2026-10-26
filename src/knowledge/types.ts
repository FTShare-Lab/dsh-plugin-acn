// Claim 浏览与修订的领域 DTO；分页与字符计数沿用持久协议约定。
import { z } from 'zod';
import { ClaimStatusSchema, ConfidenceSchema } from '../protocol/claim.js';
import type { Claim, Confidence, ClaimStatus } from '../protocol/claim.js';
import { ClaimIdSchema } from '../protocol/ids.js';
import type { ClaimId, TraceId, AgentId, SourceId } from '../protocol/ids.js';
import { TextSchema } from '../protocol/schema.js';

export const DEFAULT_CLAIM_LIST_LIMIT = 20;
export const MAX_CLAIM_PAGE_LIMIT = 100;
export const DEFAULT_TRACE_TASK_PAGE_LIMIT = 4000;
export const MAX_TRACE_TASK_PAGE_LIMIT = 16_000;
export const ClaimUpdateSchema = z.strictObject({
  id: ClaimIdSchema, expected_revision: z.string(),
  name: TextSchema.optional(), statement: TextSchema.optional(), scope: TextSchema.optional(), evidence_summary: TextSchema.optional(),
  confidence: ConfidenceSchema.optional(), status: ClaimStatusSchema.optional(),
});
export type ClaimUpdate = z.infer<typeof ClaimUpdateSchema>;
export interface BoundedText { text: string; truncated: boolean }
export interface ClaimSummary { id: ClaimId; name: BoundedText; scope: BoundedText; confidence: Confidence; status: ClaimStatus; updated_at: string }
export interface Page<T> { items: T[]; offset: number; limit: number; omitted: number; next_offset: number | null }
export type ClaimListPage = Page<ClaimSummary>;
export interface ClaimDetail { claim: Claim; revision: string }
export interface ClaimUpdateResult extends ClaimDetail { sync_warning?: string; sync_pending: boolean }
export interface TraceSummary { id: TraceId; name: string; created_at: string; input_claims: SourceId[]; output_claims: ClaimId[] }
export type TraceListPage = Page<TraceSummary>;
export interface TraceDetail extends TraceSummary { agent: AgentId; task: string; task_offset: number; task_limit: number; task_omitted: number; next_task_offset: number | null }
export interface ClaimListQuery { query?: string; includeDeprecated?: boolean; offset?: number; limit?: number }
export interface TraceListQuery { claimId?: ClaimId; offset?: number; limit?: number }
export interface KnowledgeVersion { claimsDigest: string }
