// 类型化 ID 与带随机盐的本地候选生成；最终占位由存储层负责。
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { timestampNanos } from './time.js';

export const AgentIdSchema = z.string().regex(/^[a-z0-9_-]+$/).brand<'AgentId'>();
export const ClaimIdSchema = z.string().regex(/^claim_[0-9a-f]{8}$/).brand<'ClaimId'>();
export const TraceIdSchema = z.string().regex(/^trace_[0-9a-f]{8}$/).brand<'TraceId'>();
export const DisputeIdSchema = z.string().regex(/^dispute_[0-9a-f]{8}$/).brand<'DisputeId'>();
export const PolicyIdSchema = z.string().regex(/^policy_[0-9a-f]{8}$/).brand<'PolicyId'>();
export const InboxIdSchema = z.string().regex(/^inbox_[0-9a-f]{8}$/).brand<'InboxId'>();
export const ResolutionIdSchema = z.string().regex(/^(resolution|arbitration)_[0-9a-f]{8}$/).brand<'ResolutionId'>();
export const SourceIdSchema = z.union([ClaimIdSchema, PolicyIdSchema]);
export type AgentId = z.infer<typeof AgentIdSchema>;
export type ClaimId = z.infer<typeof ClaimIdSchema>;
export type TraceId = z.infer<typeof TraceIdSchema>;
export type DisputeId = z.infer<typeof DisputeIdSchema>;
export type InboxId = z.infer<typeof InboxIdSchema>;
export type PolicyId = z.infer<typeof PolicyIdSchema>;
export type ResolutionId = z.infer<typeof ResolutionIdSchema>;
export type SourceId = z.infer<typeof SourceIdSchema>;

function derive(prefix: string, createdAt: string, fields: readonly string[], salt: string): string {
  if (!/^[0-9a-f]{4}$/.test(salt)) throw new Error('ID salt must be four lowercase hexadecimal digits.');
  const hash = createHash('sha256');
  // 长度前缀保留语义字段边界，避免不同输入分组产生同一字节序列。
  for (const field of [timestampNanos(createdAt).toString(), ...fields, salt]) hash.update(`${Buffer.byteLength(field)}:${field}`);
  return `${prefix}_${hash.digest('hex').slice(0, 8)}`;
}

export function deriveClaimId(createdAt: string, name: string, scope: string, salt = randomBytes(2).toString('hex')): ClaimId {
  return ClaimIdSchema.parse(derive('claim', createdAt, [name, scope], salt));
}
export function deriveTraceId(createdAt: string, name: string, inputs: readonly string[], outputs: readonly string[], salt = randomBytes(2).toString('hex')): TraceId {
  return TraceIdSchema.parse(derive('trace', createdAt, [name, inputs.join('\x1f'), '\x1e', outputs.join('\x1f')], salt));
}
export function deriveDisputeId(createdAt: string, name: string, claims: readonly string[], summary: string, salt = randomBytes(2).toString('hex')): DisputeId {
  return DisputeIdSchema.parse(derive('dispute', createdAt, [name, claims.join('\x1f'), '\x1e', summary], salt));
}
