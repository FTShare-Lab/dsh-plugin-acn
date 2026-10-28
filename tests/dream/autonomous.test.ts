// 自主会话的恢复以持久状态为准，预算、候选权限和实际提交不能由模型重置。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DreamSession } from '../../src/dream/autonomous.js';
import { EvidenceStore } from '../../src/dream/evidence-store.js';
import { DraftGroupSchema, ValidationSchema } from '../../src/dream/schema.js';
import { nowSeconds } from '../../src/protocol/time.js';
import { ClaimStore } from '../../src/store/claims.js';
import { candidate, claims, consolidationDraft, dreamFixture, qualityDraft, reviews, reviewSummary } from './helpers.js';
import { calibrationDraft, calibrationReviews, material } from './evidence-helpers.js';
import { z } from 'zod';

async function fixture(options: { limit?: number; wrapUp?: number; high?: boolean } = {}) {
  const initial = claims(3).map((claim) => ({ ...claim, confidence: options.high ? 'high' as const : 'medium' as const }));
  const f = await dreamFixture(() => Promise.reject(new Error('No fixed-stage model expected.')), { dream: { maxModelSteps: options.limit ?? 24, maxWrapUpSteps: options.wrapUp ?? 3, evidenceCalibration: true } }, initial);
  const workspace = await fs.mkdtemp(join(tmpdir(), 'acn-autonomous-workspace-')); await fs.writeFile(join(workspace, 'source.txt'), material);
  const job = await f.worker.queue.enqueue('dream', { manual: true, workspace_root: workspace });
  await f.knowledge.dreamStore().saveOrigin(job.id, { snapshot_at: nowSeconds(), claims: initial, coverage: { included: 3 }, workspace_root: await fs.realpath(workspace) });
  const restore = () => DreamSession.create(f.knowledge, job, { signal: new AbortController().signal, prepared: () => {} }, () => Promise.resolve());
  return { ...f, initial, workspace, job, restore, session: await restore(), close: async () => { await f.close(); await fs.rm(workspace, { recursive: true, force: true }); } };
}
async function apply(session: DreamSession, groupId: string) {
  const validation = ValidationSchema.parse(await session.execute('dream_validate', { group_id: groupId }));
  return session.execute('dream_apply_group', { group_id: groupId, validation_id: validation.validation_id, review: reviews(validation).semantic });
}
describe('autonomous Dream transactions', () => {
  it.each(['file_read', 'file_glob', 'file_grep'] as const)('revokes %s access when restoring with evidence calibration disabled', async (tool) => {
    const f = await fixture();
    try {
      const inputs = f.initial.slice(0, 1); const ids = inputs.map((claim) => claim.id);
      await f.session.execute('file_glob', { query: 'source' });
      await f.session.execute('dream_record_candidates', { candidates: [candidate(inputs, 'evidence')] });
      await f.session.execute('file_read', { path: 'source.txt', claim_ids: ids });
      await fs.writeFile(join(f.workspace, 'new.txt'), 'NEW_EVIDENCE_AFTER_PERMISSION_CHANGE');
      const store = new EvidenceStore(f.knowledge.context(), f.job.id, tool === 'file_read' ? 'group-a' : '_discovery');
      const before = await store.read(); f.knowledge.config.dream.evidenceCalibration = false;
      const restored = await f.restore(); const args = tool === 'file_read' ? { path: 'new.txt', claim_ids: ids } : { query: tool === 'file_glob' ? 'new' : 'NEW_EVIDENCE_AFTER_PERMISSION_CHANGE' };
      await expect(restored.execute(tool, args)).rejects.toThrow('证据校准未启用');
      expect(await store.read()).toEqual(before); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(f.initial);
      f.knowledge.config.dream.evidenceCalibration = true;
      await expect(restored.execute(tool, args)).resolves.toBeDefined();
    } finally { await f.close(); }
  });
  it('persists closing limits across restart and terminates without renewing the old task', async () => {
    const f = await fixture({ limit: 1, wrapUp: 1 });
    try {
      await f.session.admitStep(); await f.session.execute('dream_stage_group', { group_id: 'a', group: qualityDraft(f.initial.slice(0, 1)) });
      const restored = await f.restore(); await restored.admitStep();
      expect(restored.progress.autonomy).toMatchObject({ steps: 1, limit: 1, wrap_up: { steps: 1, limit: 1 } });
      await expect(restored.execute('file_glob', { query: 'source' })).rejects.toThrow('有限收尾');
      await expect(restored.execute('dream_record_candidates', { candidates: [candidate(f.initial.slice(1))] })).rejects.toThrow('有限收尾');
      await expect(restored.execute('dream_stage_group', { group_id: 'new', group: qualityDraft(f.initial.slice(1, 2)) })).rejects.toThrow('不能新增');
      await f.worker.queue.pauseDream(true); await f.dream.request();
      const closing = await f.restore(); await expect(closing.admitStep()).rejects.toThrow('收尾结束');
      expect(closing.finished).toBe(true); expect(closing.progress.entries[0]).toMatchObject({ status: 'skipped', draft: null, validation: null });
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(f.initial);
      expect((await f.restore()).finished).toBe(true);
      await f.worker.queue.settle(f.job, 'succeeded'); const next = await f.dream.request(); expect(next.id).not.toBe(f.job.id);
    } finally { await f.close(); }
  });
  it('lets closing finish an existing draft but cannot bypass concurrent versions', async () => {
    const f = await fixture({ limit: 1 });
    try {
      await f.session.admitStep(); await f.session.execute('dream_stage_group', { group_id: 'a', group: qualityDraft(f.initial.slice(0, 1)) });
      await f.session.admitStep(); const first = f.initial[0]; if (!first) throw new Error('Missing Claim.');
      const changed = { ...first, statement: 'A newer foreground fact.' }; await new ClaimStore(f.knowledge.context()).write(changed);
      expect(await apply(f.session, 'a')).toMatchObject({ executed: false });
      await f.session.execute('dream_finish', { review: reviewSummary });
      expect(f.session.finished).toBe(true); expect(await new ClaimStore(f.knowledge.context()).read(first.id)).toEqual(changed);
    } finally { await f.close(); }
  });
  it('records unfinished candidates separately when the model closes after its limit', async () => {
    const f = await fixture({ limit: 1 });
    try {
      await f.session.execute('dream_record_candidates', { candidates: [candidate(f.initial)] }); await f.session.admitStep(); await f.session.admitStep();
      await f.session.execute('dream_finish', { review: reviewSummary });
      expect(f.session.progress.entries[0]).toMatchObject({ status: 'skipped', draft: null });
      expect(f.session.progress.entries[0]?.reason).toContain('未完成'); expect(f.session.finished).toBe(true);
    } finally { await f.close(); }
  });
  it('continues discovery after an immediate commit and recovers without reapplying it', async () => {
    const f = await fixture();
    try {
      const first = f.initial.slice(0, 1); await f.session.execute('dream_stage_group', { group_id: 'a', group: qualityDraft(first) }); await apply(f.session, 'a');
      // 模拟 Claim 已提交但候选进度尚未落盘的崩溃窗口。
      const entry = f.session.progress.entries[0]; if (!entry) throw new Error('Missing entry.'); entry.status = 'pending'; await f.knowledge.dreamStore().saveProgress(f.job.id, f.session.progress);
      const restored = await f.restore(); expect(restored.progress.entries[0]?.status).toBe('executed');
      await expect(restored.execute('dream_stage_group', { group_id: 'a', group: qualityDraft(first) })).rejects.toThrow();
      await restored.execute('dream_record_candidates', { candidates: [candidate(f.initial.slice(1), 'consolidation', 'c')] });
      await expect(restored.execute('dream_finish', { review: reviewSummary })).rejects.toThrow('待处理');
      const draft = consolidationDraft(f.initial.slice(1)); const output = draft.operations[0]; if (!output) throw new Error('Missing output.');
      // 与原版一致：语义复核负责信息保留，无须逐字复印两份完整摘要。
      output.changes.evidence_summary = 'Checked example limitations 2 and 3; no broader guarantees were tested.';
      await restored.execute('dream_stage_group', { group_id: 'c', group: draft }); await apply(restored, 'c'); await restored.execute('dream_finish', { review: reviewSummary });
      expect(restored.finished).toBe(true); expect(await f.knowledge.dreamStore().records(f.job.id)).toHaveLength(2);
      expect((await new ClaimStore(f.knowledge.context()).list()).filter((claim) => claim.status === 'deprecated')).toHaveLength(2);
      const done = await f.restore(); expect(done.finished).toBe(true);
    } finally { await f.close(); }
  });
  it('rejects concurrent Claim changes and stale validation IDs without overwriting them', async () => {
    const f = await fixture();
    try {
      await f.session.execute('dream_stage_group', { group_id: 'a', group: qualityDraft(f.initial.slice(0, 1)) });
      const validation = ValidationSchema.parse(await f.session.execute('dream_validate', { group_id: 'a' }));
      const first = f.initial[0]; if (!first) throw new Error('Missing first Claim.');
      const changed = { ...first, statement: 'A concurrent foreground correction.' }; await new ClaimStore(f.knowledge.context()).write(changed);
      await expect(f.session.execute('dream_apply_group', { group_id: 'a', validation_id: '0'.repeat(64), review: reviews(validation).semantic })).rejects.toThrow();
      expect(await f.session.execute('dream_apply_group', { group_id: 'a', validation_id: validation.validation_id, review: reviews(validation).semantic })).toMatchObject({ executed: false });
      expect(await new ClaimStore(f.knowledge.context()).read(first.id)).toEqual(changed);
    } finally { await f.close(); }
  });
  it('retains private path protection and rechecks evidence after staging', async () => {
    const f = await fixture();
    try {
      expect(JSON.stringify(await f.session.execute('file_glob', { query: 'source' }))).toContain('source.txt');
      await expect(f.session.execute('file_read', { path: 'source.txt', claim_ids: f.initial.map((claim) => claim.id) })).rejects.toThrow();
      const inputs = f.initial.slice(0, 1); await f.session.execute('dream_record_candidates', { candidates: [candidate(inputs, 'evidence')] });
      await fs.writeFile(join(f.workspace, 'USER.md'), 'PRIVATE_TEST_MARKER');
      await expect(f.session.execute('file_read', { path: 'USER.md', claim_ids: inputs.map((claim) => claim.id) })).rejects.toThrow();
      await expect(f.session.execute('file_read', { path: '../outside.txt', claim_ids: inputs.map((claim) => claim.id) })).rejects.toThrow();
      const receipt = z.object({ evidence_id: z.string() }).passthrough().parse(await f.session.execute('file_read', { path: 'source.txt', claim_ids: inputs.map((claim) => claim.id) }));
      const receipts = z.record(z.string(), z.json()).parse({ [receipt.evidence_id]: receipt });
      await f.session.execute('dream_stage_group', { group_id: 'group-a', group: calibrationDraft(inputs, receipts) });
      const validation = ValidationSchema.parse(await f.session.execute('dream_validate', { group_id: 'group-a' }));
      await fs.writeFile(join(f.workspace, 'source.txt'), 'Changed version.');
      expect(await f.session.execute('dream_apply_group', { group_id: 'group-a', validation_id: validation.validation_id, review: calibrationReviews(validation).semantic })).toMatchObject({ executed: false });
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(f.initial);
    } finally { await f.close(); }
  });
  it('does not let a high Claim become eligible by first lowering confidence in A', async () => {
    const f = await fixture({ high: true });
    try {
      const first = f.initial[0]; if (!first) throw new Error('Missing Claim.');
      const group = DraftGroupSchema.parse({ kind: 'quality', reason: 'Keep the same rule with a conservative rating.', operations: [{ id: first.id, action: 'update', changes: { confidence: 'medium' } }], change_basis: [{ claim_id: first.id, removed_or_changed: 'Rating only.', added: '', justification: 'Preserve the same facts.', evidence_ids: [] }] });
      await f.session.execute('dream_stage_group', { group_id: 'a', group }); await apply(f.session, 'a');
      await f.session.execute('dream_record_candidates', { candidates: [candidate([first], 'evidence', 'b')] });
      await expect(f.session.execute('file_read', { path: 'source.txt', claim_ids: [first.id] })).rejects.toThrow();
    } finally { await f.close(); }
  });
});
