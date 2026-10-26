// 动作专属参数与领域分发独立于宿主，禁止通过工具修订身份和来源。
import { z } from 'zod';
import { ClaimIdSchema, TraceIdSchema } from '../protocol/ids.js';
import { ClaimStatusSchema, ConfidenceSchema } from '../protocol/claim.js';
import type { AcnKnowledge } from '../knowledge/service.js';
import { KnowledgeError, RevisionConflict } from '../knowledge/errors.js';
import { ClaimUpdateSchema } from '../knowledge/types.js';

const text = z.string();
const id = text.describe('claim id for read/update, or trace id for read_trace');
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('list/traces result offset');
const limit = z.number().int().min(1).max(100).optional().describe('list/traces maximum results').meta({ default: 20 });
const editableText = text.optional().describe('update only');
export const ClaimToolArgsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), query: text.optional().describe('list only: case-insensitive substring search across name, scope, and statement'), include_deprecated: z.boolean().optional().describe('list only: include deprecated claims so they can be inspected or restored').meta({ default: false }), offset, limit }),
  z.strictObject({ action: z.literal('read'), id }),
  z.strictObject({ action: z.literal('update'), id, expected_revision: text.describe('Required for update; use the exact revision returned by read'), name: editableText, statement: editableText, scope: editableText, evidence_summary: editableText, confidence: ConfidenceSchema.optional().describe('update only'), status: ClaimStatusSchema.optional().describe('update only') }),
  z.strictObject({ action: z.literal('traces'), claim_id: text.optional().describe('traces only: return traces whose inputs or outputs reference this claim'), offset, limit }),
  z.strictObject({ action: z.literal('read_trace'), id, task_offset: offset.describe('read_trace only: character offset into task text'), task_limit: z.number().int().min(1).max(16_000).optional().describe('read_trace only: maximum task characters').meta({ default: 4000 }) }),
]);
export type ClaimToolArgs = z.infer<typeof ClaimToolArgsSchema>;
export const CLAIM_DESCRIPTION = "List, search, read, or CAS-update this agent's own claims, and inspect the original task traces connected to them. Updates require the revision returned by read and preserve claim identity, holder, creation time, and sources.";
const optionalFields = new Set(['query', 'include_deprecated', 'offset', 'limit', 'name', 'statement', 'scope', 'evidence_summary', 'confidence', 'status', 'claim_id', 'task_offset', 'task_limit']);

export async function executeClaim(knowledge: AcnKnowledge, input: unknown, signal?: AbortSignal) {
  try {
    signal?.throwIfAborted();
    // 可选字段的显式 null 沿用读取语义；未知字段仍交给动作专属 schema 拒绝。
    const normalized = typeof input === 'object' && input !== null && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).map(([key, value]: [string, unknown]) => [key, value === null && optionalFields.has(key) ? undefined : value]))
      : input;
    const args = ClaimToolArgsSchema.parse(normalized);
    switch (args.action) {
      case 'list': return await knowledge.listClaims({ ...(args.query === undefined ? {} : { query: args.query }), ...(args.include_deprecated === undefined ? {} : { includeDeprecated: args.include_deprecated }), ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }) });
      case 'read': return await knowledge.readClaim(ClaimIdSchema.parse(args.id));
      case 'update': {
        const update = ClaimUpdateSchema.parse(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'action')));
        return await knowledge.updateClaim(update, signal);
      }
      case 'traces': return await knowledge.listTraces({ ...(args.claim_id === undefined ? {} : { claimId: ClaimIdSchema.parse(args.claim_id) }), ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }) });
      case 'read_trace': return await knowledge.readTrace(TraceIdSchema.parse(args.id), { ...(args.task_offset === undefined ? {} : { taskOffset: args.task_offset }), ...(args.task_limit === undefined ? {} : { taskLimit: args.task_limit }) });
    }
  } catch (error) {
    if (error instanceof RevisionConflict) return { conflict: true as const, current_revision: error.currentRevision };
    if (error instanceof KnowledgeError) return { error: { kind: error.kind, message: error.message } };
    if (error instanceof z.ZodError) return { error: { kind: 'validation', message: 'Invalid claim action, fields, identifier or pagination.' } };
    throw error;
  }
}
