// 复盘输出与协议 schema 对齐；占位符、归属与引用在 prepare 阶段统一校验。
import { z } from 'zod';
import { ClaimStatusSchema, ConfidenceSchema } from '../protocol/claim.js';

const draft = { id: z.string(), name: z.string(), statement: z.string(), scope: z.string(), confidence: ConfidenceSchema, evidence_summary: z.string(), source_claim_ids: z.array(z.string()) };
export const RecapOutputSchema = z.strictObject({
  new_claims: z.array(z.strictObject(draft)),
  updated_claims: z.array(z.strictObject({ ...draft, status: ClaimStatusSchema })),
  used_claim_ids: z.array(z.string()),
  new_disputes: z.array(z.strictObject({ id: z.string(), name: z.string(), claims: z.array(z.string()).min(2), summary: z.string() })),
});
export type RecapOutput = z.infer<typeof RecapOutputSchema>;
export class FormationValidationError extends Error { readonly kind = 'formation_validation'; }
