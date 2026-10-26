// 移植参考模块全部测试，并细化 existence 与逐字段变化的恢复判定。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnalysisReadBoundary, KnowledgeBusy, analysisIsStale, claimChanges, observeApplied } from '../../src/knowledge/alignment.js';
import { sampleClaim } from '../knowledge-fixtures.js';

describe('analysis alignment', () => {
  it('ordinary_read_detects_pending_and_a_commit_completed_during_read', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-alignment-'));
    try {
      const before = await AnalysisReadBoundary.begin(root);
      const dir = join(root, 'runtime', 'supervisor'); await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'dream_state.yaml'), 'known_versions: {}\n');
      await expect(before.finish(root)).rejects.toBeInstanceOf(KnowledgeBusy);
      await (await AnalysisReadBoundary.begin(root)).finish(root);
      const during = await AnalysisReadBoundary.begin(root);
      await fs.writeFile(join(dir, 'dream_pending.yaml'), 'pending\n');
      await expect(AnalysisReadBoundary.begin(root)).rejects.toBeInstanceOf(KnowledgeBusy);
      await expect(during.finish(root)).rejects.toBeInstanceOf(KnowledgeBusy);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('alignment_compares_content_and_recognizes_partial_writes_without_hiding_external_edits', () => {
    const before = sampleClaim(); const target = { ...before, statement: 'Retry idempotent operations within the budget.' };
    const applied: typeof target[] = [];
    observeApplied([target], [target], applied);
    expect(analysisIsStale([before], claimChanges([before], [target], applied, [target]))).toBe(false);
    const external = { ...target, scope: 'service / imports / isolated' };
    const changes = claimChanges([before], [target], applied, [external]);
    expect(changes).toMatchObject([{ changed_fields: ['scope'], before: target, current: external }]);
    expect(analysisIsStale([before], changes)).toBe(true);
    expect(claimChanges([external], [], applied, [external])).toEqual([]);
    expect(analysisIsStale(null, [])).toBe(true);
  });
  it('distinguishes deletion, new target collisions and incomplete writes', () => {
    const before = sampleClaim(); const target = { ...before, statement: 'planned' };
    expect(claimChanges([before], [target], [], [])).toMatchObject([{ changed_fields: ['existence'], current: null }]);
    expect(claimChanges([], [target], [], [before])).toMatchObject([{ changed_fields: ['existence'], before: null }]);
    const applied: typeof before[] = [];
    observeApplied([target], [before], applied); expect(applied).toEqual([]);
    expect(claimChanges([before], [target], applied, [before])).toEqual([]);
  });
});
