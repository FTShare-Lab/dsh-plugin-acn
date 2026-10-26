// 独立证据必须来自带完整文件版本的真实读取；引用验证不推断文本本身是否可信。
import { z } from 'zod';
import type { ClaimId } from '../protocol/ids.js';
import { ClaimIdSchema } from '../protocol/ids.js';
import { requireDream } from './schema.js';

export const ReceiptSchema = z.object({
  tool: z.literal('file_read'),
  input: z.object({ path: z.string(), claim_ids: z.array(ClaimIdSchema).optional(), show_linenos: z.boolean().optional() }).passthrough(),
  output: z.object({
    content: z.string(),
    page: z.object({ returned_start: z.number().int().positive(), returned_end: z.number().int().nonnegative() }).passthrough().optional(),
    file_version: z.object({ path: z.string(), revision: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), byte_len: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }) }),
  }).passthrough(),
}).passthrough();
export type Receipt = z.infer<typeof ReceiptSchema>;
export type Receipts = Record<string, z.infer<ReturnType<typeof z.json>>>;
export function independentReceipt(receipts: Receipts, id: string): Receipt | null {
  const parsed = ReceiptSchema.safeParse(receipts[id]); return parsed.success ? parsed.data : null;
}
export function directEvidence(receipts: Receipts, ids: readonly string[], claimId: ClaimId): string[] {
  return ids.filter((id) => { const receipt = independentReceipt(receipts, id); return receipt !== null && (receipt.input.claim_ids === undefined || receipt.input.claim_ids.includes(claimId)); });
}
// 仅当整页连续行号与回执页码完全对应时去掉显示前缀，真实正文中的“数字|”保持原样。
export function evidenceBody(receipt: Receipt): string {
  const { content, page } = receipt.output;
  if (receipt.input.show_linenos === false || page === undefined) return content;
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []; let next = page.returned_start;
  const body: string[] = [];
  for (const line of lines) { const prefix = `${next}|`; if (!line.startsWith(prefix)) return content; body.push(line.slice(prefix.length)); next += 1; }
  return next - 1 === page.returned_end ? body.join('') : content;
}
export function requireEvidenceIds(ids: readonly string[], available: readonly string[], message: string): void {
  requireDream(new Set(ids).size === ids.length && ids.every((id) => available.includes(id)), message);
}
