// 校准从真实文件回执贯通草稿、复核与固定目标提交；缺少证据和版本变化均保留原样。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { UploadStore } from '../../src/store/uploads.js';
import { EvidenceStore } from '../../src/dream/evidence-store.js';
import { expandDraft, reviewInput } from '../../src/dream/plan.js';
import type { StructuredBackend } from '../../src/llm/structured.js';
import type { Validation } from '../../src/dream/schema.js';
import { candidate, claims, reviewSummary, until } from './helpers.js';
import { calibrationDraft, calibrationReviews, evidenceFixture, material } from './evidence-helpers.js';
import { waitJob } from '../formation/helpers.js';

describe('Dream calibration pipeline', () => {
  it.each(['valid', 'no-evidence', 'changed-after-read', 'changed-after-review', 'kept-for-uncertainty'])('integrates calibration with the shared worker: %s', async (mode) => {
    const input = claims(1); let workspace = ''; let explored = 0;
    const backend: StructuredBackend = async (_route, _system, text) => {
      const request = JSON.parse(text) as { phase: string; evidence?: Record<string, z.infer<ReturnType<typeof z.json>>>; validation: Validation };
      if (request.phase === 'candidates') return { text: JSON.stringify({ review: reviewSummary, candidates: [candidate(input, 'evidence')], sync_candidates: [] }) };
      if (request.phase === 'draft') {
        if (mode === 'no-evidence' || mode === 'kept-for-uncertainty') return { text: JSON.stringify({ action: 'keep', reason_kind: 'insufficient_evidence', reason: 'No supported correction; the useful hypothesis remains.' }) };
        return { text: JSON.stringify({ action: 'stage', group: calibrationDraft(input, request.evidence ?? {}) }) };
      }
      if (mode === 'changed-after-review') await fs.writeFile(join(workspace, 'source.txt'), 'A newer evidence version.');
      return { text: JSON.stringify({ decision: 'apply', reason: 'Direct file evidence bounds the revised rule.', reason_kind: 'useful_knowledge', ...calibrationReviews(request.validation) }) };
    };
    const f = await evidenceFixture({ input, backend, explore: async ({ store, claims, signal }) => { explored += 1; if (mode !== 'no-evidence') await store.execute('read', { path: 'source.txt', claim_ids: claims.map((claim) => claim.id) }, claims, signal); if (mode === 'changed-after-read') await fs.writeFile(join(workspace, 'source.txt'), 'Changed before drafting.'); } }); workspace = f.workspace;
    try {
      await f.start(); const job = await f.dream.request(f.workspace); await waitJob(f.worker.queue, job.id);
      const result = await new ClaimStore(f.knowledge.context()).list();
      if (mode === 'valid') { expect(result[0]).toMatchObject({ statement: material, confidence: 'high' }); const records = await f.knowledge.dreamStore().records(job.id); expect(Object.keys(records[0]?.checkpoint.receipts ?? {})).toHaveLength(1); expect((await new TraceStore(f.knowledge.context()).list()).some((trace) => trace.task.includes('file_version'))).toBe(true); }
      else expect(result).toEqual(input);
      expect(explored).toBe(1); expect(await new UploadStore(f.knowledge.context()).read()).toMatchObject({ claims: [], disputes: [] });
      expect((await f.worker.queue.list()).filter((job) => job.kind !== 'dream')).toEqual([]);
    } finally { await f.close(); }
  });
  it('refuses fabricated proof at the commit boundary even with a valid model review hash', async () => {
    const f = await evidenceFixture();
    try {
      await f.read(); await f.store.complete(new AbortController().signal); const receipts = z.record(z.string(), z.json()).parse((await f.store.read())?.receipts); const group = expandDraft(calibrationDraft(f.initial, receipts), f.initial); const validation = reviewInput('group-a', group, f.initial, receipts); const review = calibrationReviews(validation);
      const raw = Object.values(validation.input.evidence)[0]; if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Missing receipt.'); raw['forged'] = true;
      await f.knowledge.dreamStore().saveOrigin('evidence-job', { claims: f.initial, snapshot_at: '2026-01-01T00:00:00Z', coverage: {}, workspace_root: f.workspace });
      await expect(f.knowledge.applyDreamGroup('evidence-job', 'group-a', group, validation, review.semantic, review.self_review, { signal: new AbortController().signal, prepared() {} })).rejects.toThrow('真实查证');
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(f.initial);
    } finally { await f.close(); }
  });
  it('blocks recovery on actual evidence I/O failure and does not start another job attempt', async () => {
    const f = await evidenceFixture();
    try {
      await f.read(); await f.store.complete(new AbortController().signal); const receipts = z.record(z.string(), z.json()).parse((await f.store.read())?.receipts); const group = expandDraft(calibrationDraft(f.initial, receipts), f.initial); const validation = reviewInput('group-a', group, f.initial, receipts); const review = calibrationReviews(validation);
      await f.knowledge.dreamStore().saveOrigin('evidence-job', { claims: f.initial, snapshot_at: '2026-01-01T00:00:00Z', coverage: {}, workspace_root: f.workspace });
      const rename = fs.rename.bind(fs); const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => { await rename(source, target); if (target === f.knowledge.context().paths.dreamExecution('evidence-job', validation.validation_id)) throw new Error('Stop after prepared.'); });
      await expect(f.knowledge.applyDreamGroup('evidence-job', 'group-a', group, validation, review.semantic, review.self_review, { signal: new AbortController().signal, prepared() {} })).rejects.toThrow(); spy.mockRestore();
      const open = fs.open.bind(fs); const failed = vi.spyOn(fs, 'open').mockImplementation((path, ...args) => path === join(f.workspace, 'source.txt') ? Promise.reject(Object.assign(new Error('Unavailable.'), { code: 'EIO' })) : open(path, ...args));
      await expect(f.knowledge.dreamStore().recover()).rejects.toMatchObject({ code: 'EIO' }); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(f.initial);
      const queued = await f.worker.queue.enqueue('dream', { manual: true }); await f.worker.start(); await until(() => Promise.resolve(f.warnings.length > 0)); expect((await f.worker.queue.read(queued.id))?.attempts).toBe(0); await f.worker.close();
      failed.mockRestore(); await f.knowledge.dreamStore().recover(); expect((await new ClaimStore(f.knowledge.context()).list())[0]?.confidence).toBe('high');
    } finally { vi.restoreAllMocks(); await f.close(); }
  });
  it('reuses a completed manifest on retry without running the explorer or changing the frozen workspace', async () => {
    const input = claims(1); let calls = 0; let fail = true;
    const backend: StructuredBackend = (_route, _system, text) => { const request = JSON.parse(text) as { phase: string }; if (request.phase === 'candidates') return Promise.resolve({ text: JSON.stringify({ review: reviewSummary, candidates: [candidate(input, 'evidence')], sync_candidates: [] }) }); if (fail) throw new Error('Invalid route.'); return Promise.resolve({ text: JSON.stringify({ action: 'keep', reason_kind: 'insufficient_evidence', reason: 'Evidence is not sufficient to correct this rule.' }) }); };
    const f = await evidenceFixture({ input, backend, explore: async ({ store, claims, signal }) => { calls += 1; await store.execute('read', { path: 'source.txt', claim_ids: claims.map((claim) => claim.id) }, claims, signal); } });
    try { await f.start(); const job = await f.dream.request(f.workspace); await waitJob(f.worker.queue, job.id, 'failed'); fail = false; await f.worker.retry(job.id); await waitJob(f.worker.queue, job.id); expect(calls).toBe(1); const manifest = await new EvidenceStore(f.knowledge.context(), job.id, 'group-a').read(); expect(manifest?.workspace_root).toBe(f.workspace); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(input); }
    finally { await f.close(); }
  });
});
