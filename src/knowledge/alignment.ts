// 以完整内容核对分析快照与部分提交，避免恢复时覆盖外部修订。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { Claim } from '../protocol/claim.js';
import { canonicalJson } from '../protocol/revision.js';
import { hasCode } from '../store/errors.js';
import { JobError } from '../worker/types.js';

export const STALE_PLAN_WARNING = '恢复时 Claim 已变化或缺少分析快照，已放弃本批尚未执行的 Claim 修改及 Dispute；已执行结果保留。';
export class AnalysisChanged extends JobError { constructor() { super('analysis_changed', '分析期间知识已变化，原输入保留，将重新分析后再提交。', true); } }
export const sameClaim = (a: Claim, b: Claim): boolean => canonicalJson(a) === canonicalJson(b);
export function observeApplied(targets: readonly Claim[], current: readonly Claim[], applied: Claim[]): void {
  for (const target of targets) if (!applied.some((claim) => claim.id === target.id) && current.some((claim) => sameClaim(claim, target))) applied.push(structuredClone(target));
}
const fields = ['name', 'statement', 'scope', 'holder', 'confidence', 'status', 'created_at', 'updated_at', 'source_claim_ids', 'evidence_summary'] as const;
export function claimChanges(analysis: readonly Claim[] | null, targets: readonly Claim[], applied: readonly Claim[], current: readonly Claim[]) {
  const actual = new Map(current.map((claim) => [claim.id, claim]));
  const expected = new Map((analysis ?? []).map((claim) => [claim.id, claim as Claim | null]));
  for (const claim of targets) if (!expected.has(claim.id)) expected.set(claim.id, null);
  for (const claim of applied) if (targets.some((target) => sameClaim(target, claim))) expected.set(claim.id, claim);
  return [...expected].sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, before]) => {
    const current = actual.get(id) ?? null;
    if (before === null ? current === null : current !== null && sameClaim(before, current)) return [];
    return [{ id, before, current, changed_fields: before === null || current === null ? ['existence'] : fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(current[field])) }];
  });
}
export function analysisIsStale(analysis: readonly Claim[] | null, changes: readonly unknown[]): boolean { return analysis === null || changes.length > 0; }

// 普通读取跨越整理提交时拒绝快照；与后续整理模块共享磁盘边界。
export class KnowledgeBusy extends JobError { constructor() { super('knowledge_busy', '知识库忙碌：关联提交正在执行或等待恢复，请稍后重试。', true); } }
async function optionalBytes(path: string): Promise<Buffer | null> { try { return await fs.readFile(path); } catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; } }
export async function ensureKnowledgeReady(root: string): Promise<void> { if (await optionalBytes(join(root, 'runtime', 'supervisor', 'dream_pending.yaml')) !== null) throw new KnowledgeBusy(); }
export class AnalysisReadBoundary {
  private constructor(private readonly state: Buffer | null) {}
  static async begin(root: string): Promise<AnalysisReadBoundary> {
    const state = await optionalBytes(join(root, 'runtime', 'supervisor', 'dream_state.yaml'));
    await ensureKnowledgeReady(root); return new AnalysisReadBoundary(state);
  }
  async finish(root: string): Promise<void> {
    await ensureKnowledgeReady(root);
    const after = await optionalBytes(join(root, 'runtime', 'supervisor', 'dream_state.yaml'));
    if (this.state === null ? after !== null : after === null || !this.state.equals(after)) throw new KnowledgeBusy();
  }
}
