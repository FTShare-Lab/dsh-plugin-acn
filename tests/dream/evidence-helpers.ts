// 证据测试只使用独立临时工作区和插件真实读取回执。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Claim } from '../../src/protocol/claim.js';
import type { ClaimId } from '../../src/protocol/ids.js';
import { DraftGroupSchema, type Validation } from '../../src/dream/schema.js';
import { ReceiptSchema, evidenceBody, type Receipts } from '../../src/dream/evidence.js';
import { EvidenceStore } from '../../src/dream/evidence-store.js';
import { claims, dreamFixture, reviews } from './helpers.js';
import type { ConfigInput } from '../../src/config.js';
import type { StructuredBackend } from '../../src/llm/structured.js';
import type { DreamOptions } from '../../src/dream/service.js';

export const material = 'The verified rule applies only to read operations. Writes require a separate check.';
export function calibrationDraft(input: readonly Claim[], receipts: Receipts) {
  const ids = (claim: Claim) => Object.entries(receipts).filter(([, value]) => ReceiptSchema.parse(value).input.claim_ids?.includes(claim.id)).map(([id]) => id);
  return DraftGroupSchema.parse({ kind: 'evidence', reason: 'Calibrate the scope using direct versioned material.', evidence_ids: Object.keys(receipts), change_basis: input.map((claim) => ({ claim_id: claim.id, removed_or_changed: 'Correct the earlier broad scope.', added: material, justification: 'Direct material states the limitation.', evidence_ids: ids(claim) })), operations: input.map((claim) => ({ id: claim.id, action: 'update', changes: { statement: material, confidence: 'high', evidence_summary: `Historical evidence: ${claim.evidence_summary}\nNew versioned direct material limits this rule to reads; writes remain unverified.` } })) });
}
export function calibrationReviews(validation: Validation) {
  const result = reviews(validation);
  const proof = (id: ClaimId) => Object.entries(validation.input.evidence).filter(([, value]) => ReceiptSchema.parse(value).input.claim_ids?.includes(id)).map(([evidence_id, value]) => ({ evidence_id, quote: evidenceBody(ReceiptSchema.parse(value)) }));
  for (const item of result.self_review.preservation) {
    const output = validation.input.after.find((claim) => claim.id === item.before.claim_id);
    if (output && output[item.before.field] !== item.before.quote) { item.disposition = 'corrected'; item.evidence = proof(item.before.claim_id); }
    item.after = item.after.filter((quote) => quote.claim_id === item.before.claim_id);
  }
  for (const item of result.self_review.support) { item.before = item.before.filter((quote) => quote.claim_id === item.after.claim_id); if (!item.before.some((quote) => quote.quote === item.after.quote)) item.evidence = proof(item.after.claim_id); }
  for (const item of result.semantic.claims) { item.factual_correction = true; item.evidence_ids = proof(item.claim_id).map((quote) => quote.evidence_id); }
  return result;
}
export async function evidenceFixture(options: { input?: Claim[]; config?: ConfigInput; backend?: StructuredBackend; explore?: DreamOptions['explore'] } = {}) {
  const workspace = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'acn-evidence-workspace-'))); await fs.writeFile(join(workspace, 'source.txt'), material);
  const initial = options.input ?? claims(1);
  const f = await dreamFixture(options.backend ?? (() => { throw new Error('No model call expected.'); }), { ...options.config, dream: { evidenceCalibration: true, ...options.config?.dream } }, initial, { workspace: () => Promise.resolve(workspace), ...(options.explore === undefined ? {} : { explore: options.explore }) });
  const store = new EvidenceStore(f.knowledge.context(), 'evidence-job', 'group-a');
  await store.initialize(workspace, initial, f.knowledge.config.dream);
  return { ...f, workspace, initial, store, read: async (id = initial[0]?.id, path = 'source.txt') => { const raw = await store.execute('read', { path, claim_ids: [id] }, initial, new AbortController().signal); return raw as { evidence_id: string }; }, close: async () => { await f.close(); await fs.rm(workspace, { recursive: true, force: true }); } };
}
