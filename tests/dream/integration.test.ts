// 通过共享持久 worker 验证完整整理、审计、修复、暂停与按组恢复。
import fs from 'node:fs/promises';
import { sep, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AcnDream } from '../../src/dream/service.js';
import { ValidationSchema, ProgressSchema, CheckpointSchema } from '../../src/dream/schema.js';
import { expandDraft, reviewInput } from '../../src/dream/plan.js';
import { versions } from '../../src/dream/candidates.js';
import { TraceIdSchema } from '../../src/protocol/ids.js';
import { nowSeconds } from '../../src/protocol/time.js';
import { JobSchema } from '../../src/worker/types.js';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { UploadStore } from '../../src/store/uploads.js';
import { writeYamlAtomic } from '../../src/store/yaml.js';
import { DreamStateSchema } from '../../src/dream/schema.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import type { StructuredBackend } from '../../src/llm/structured.js';
import { waitJob } from '../formation/helpers.js';
import { teamServer } from '../team/helpers.js';
import type { SyncValidation } from '../../src/dream/sync.js';
import type { Claim } from '../../src/protocol/claim.js';
import { claims, candidate, dreamFixture, phaseBackend, qualityDraft, consolidationDraft, reviews, reviewSummary, until, deferred } from './helpers.js';

describe('Dream through durable worker', () => {
  it('finishes a legacy prepared fixed target without applying the new draft rule retroactively', async () => {
    const input = claims(); const [carrier] = input; if (!carrier) throw new Error('Missing input.'); const draft = consolidationDraft(input); const operation = draft.operations[0]; if (!operation) throw new Error('Missing output.'); operation.changes.evidence_summary = carrier.evidence_summary;
    const group = expandDraft(draft, input); const validation = reviewInput('group-a', group, input); const review = reviews(validation); const jobId = 'legacy-prepared';
    const f = await dreamFixture(() => { throw new Error('Prepared recovery must not call the model.'); }, {}, input);
    try {
      const store = f.knowledge.dreamStore(); await store.saveOrigin(jobId, { snapshot_at: '2026-01-02T00:00:00Z', claims: input, coverage: { total: 2, included: 2 } });
      const after = group.updates.map((update) => { const original = input.find((claim) => claim.id === update.id); if (!original) throw new Error('Missing original.'); return { ...original, ...update, updated_at: '2026-01-02T00:00:00Z' }; });
      const checkpoint = CheckpointSchema.parse({ snapshot_at: '2026-01-02T00:00:00Z', input_versions: versions(input), coverage: { total: 2, included: 2 }, plan: { review: reviewSummary, groups: [group] }, receipts: {}, groups: [{ before: input, after, completed: false, skipped: false }], self_reviews: [{ validation, review: review.self_review }], trace_id: TraceIdSchema.parse('trace_00000001'), applied: false, success_at: null, self_versions: {}, operation: { job_id: jobId, group_id: 'group-a', validation_id: validation.validation_id, review: review.semantic, hard_validation_passed: true } });
      await writeYamlAtomic(f.knowledge.context().paths.dreamExecution(jobId, validation.validation_id), checkpoint, CheckpointSchema, f.knowledge.logger);
      await store.recover(); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(after); expect((await store.records(jobId))[0]?.checkpoint.applied).toBe(true);
      expect((await new ClaimStore(f.knowledge.context()).read(carrier.id)).evidence_summary).toBe(carrier.evidence_summary);
    } finally { await f.close(); }
  });
  it.each(['unregistered', 'future', 'paused'])('continues Dream while a higher-priority task is not runnable: %s', async (mode) => {
    const f = await dreamFixture(phaseBackend(claims())); let higherCalls = 0;
    const unregister = f.worker.register('inbox', () => { higherCalls += 1; return Promise.resolve({ done: true }); });
    try {
      const higher = await f.worker.queue.enqueue('inbox', { request_id: 'retained-task' }, 'session-a');
      if (mode === 'unregistered') unregister();
      if (mode === 'future') await f.worker.queue.settle(higher, 'queued', { nextRunAt: Date.now() + 60_000 });
      if (mode === 'paused') await writeYamlAtomic(f.knowledge.context().paths.job(higher.id), { ...higher, payload: { ...higher.payload, paused: true } }, JobSchema, f.knowledge.logger);
      await f.start(); const job = await f.dream.request(); expect(await waitJob(f.worker.queue, job.id)).toMatchObject({ attempts: 1 });
      expect(await f.worker.queue.read(higher.id)).toMatchObject({ state: 'queued', attempts: 0 }); expect(higherCalls).toBe(0);
      await f.worker.queue.settle(higher, 'queued');
      if (mode === 'paused') await writeYamlAtomic(f.knowledge.context().paths.job(higher.id), { ...higher, payload: { ...higher.payload, paused: false } }, JobSchema, f.knowledge.logger);
      if (mode === 'unregistered') f.worker.register('inbox', () => { higherCalls += 1; return Promise.resolve({ done: true }); });
      f.worker.wake(); await waitJob(f.worker.queue, higher.id); expect(higherCalls).toBe(1);
    } finally { unregister(); await f.close(); }
  });
  it('rejects a lossy evidence draft before any write, gives concrete feedback and commits the repaired summary', async () => {
    const input = claims(); const [carrier, source] = input; if (!carrier || !source) throw new Error('Missing inputs.');
    source.evidence_summary = '无法证明同一版本；只核对当前文件，生产环境未验证。'; let drafts = 0;
    const backend = phaseBackend(input, 'consolidation');
    const f = await dreamFixture(async (...args) => {
      const request = JSON.parse(args[2]) as { phase: string };
      if (request.phase === 'draft') {
        drafts += 1; const draft = consolidationDraft(input); const operation = draft.operations[0]; if (!operation) throw new Error('Missing operation.');
        if (drafts === 1) operation.changes.evidence_summary = carrier.evidence_summary;
        else { expect(args[1]).toContain(`${source.id} 的完整原证据摘要`); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(input); expect(await new TraceStore(f.knowledge.context()).list()).toEqual([]); }
        return { text: JSON.stringify({ action: 'stage', group: draft }) };
      }
      return backend(...args);
    }, {}, input);
    try {
      await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id); expect(drafts).toBe(2);
      const stored = await new ClaimStore(f.knowledge.context()).read(carrier.id); expect(stored.evidence_summary).toContain(source.evidence_summary);
      expect((await new ClaimStore(f.knowledge.context()).read(source.id)).evidence_summary).toBe(source.evidence_summary);
    } finally { await f.close(); }
  });
  it('invalidates a legacy unprepared draft and accepted review, then redrafts with durable preservation feedback', async () => {
    const input = claims(); const [carrier, source] = input; if (!carrier || !source) throw new Error('Missing inputs.');
    source.evidence_summary = 'The original source version cannot be proved; deployment is unverified.';
    const bad = consolidationDraft(input); const operation = bad.operations[0]; if (!operation) throw new Error('Missing operation.'); operation.changes.evidence_summary = carrier.evidence_summary;
    const group = expandDraft(bad, input); const validation = reviewInput('group-a', group, input); const phases: string[] = [];
    const backend = phaseBackend(input, 'consolidation'); const f = await dreamFixture((...args) => {
      const request = JSON.parse(args[2]) as { phase: string; prior_feedback?: string }; phases.push(request.phase);
      if (request.phase === 'draft') expect(request.prior_feedback).toContain(`${source.id} 的完整原证据摘要`);
      return backend(...args);
    }, {}, input);
    try {
      const job = await f.dream.request(); const store = f.knowledge.dreamStore();
      await store.saveOrigin(job.id, { snapshot_at: nowSeconds(), claims: input, coverage: { total: 2, included: 2 } });
      await store.saveProgress(job.id, ProgressSchema.parse({ schemaVersion: 1, discovery: { review: reviewSummary, candidates: [candidate(input, 'consolidation')], sync_candidates: [] }, entries: [{ candidate: candidate(input, 'consolidation'), status: 'pending', reason: '', draft: group, validation, review: { decision: 'apply', reason: 'Confidence remains medium.', reason_kind: 'useful_knowledge', ...reviews(validation) } }], syncCompleted: [], finished: false, summary: null }));
      await f.start(); await waitJob(f.worker.queue, job.id); expect(phases).toEqual(['draft', 'review']);
      expect((await new ClaimStore(f.knowledge.context()).read(carrier.id)).evidence_summary).toContain(source.evidence_summary);
    } finally { await f.close(); }
  });
  it('denies direct commit of an old lossy validation without preparing records or writing knowledge', async () => {
    const input = claims(); const [carrier] = input; if (!carrier) throw new Error('Missing input.'); const draft = consolidationDraft(input); const operation = draft.operations[0]; if (!operation) throw new Error('Missing output.'); operation.changes.evidence_summary = carrier.evidence_summary;
    const group = expandDraft(draft, input); const validation = reviewInput('group-a', group, input); const review = reviews(validation); let prepared = false;
    const f = await dreamFixture(phaseBackend(input), {}, input);
    try {
      await expect(f.knowledge.dreamStore().commitGroup('old-validation', 'group-a', group, validation, review.semantic, review.self_review, { signal: new AbortController().signal, prepared: () => { prepared = true; } })).rejects.toThrow(/原证据摘要/);
      expect(prepared).toBe(false); expect(await f.knowledge.dreamStore().records('old-validation')).toEqual([]); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(input); expect(await new TraceStore(f.knowledge.context()).list()).toEqual([]);
    } finally { await f.close(); }
  });
  it('repairs misplaced operation reasons and preserves inherited references to retired inputs', async () => {
    const input = claims(); const [survivor, retired] = input; if (!survivor || !retired) throw new Error('Missing inputs.');
    survivor.source_claim_ids = [retired.id]; let draftCalls = 0;
    const f = await dreamFixture((_route, system, text) => {
      const request = JSON.parse(text) as { phase: string; validation?: unknown };
      if (request.phase === 'candidates') return Promise.resolve({ text: JSON.stringify({ review: reviewSummary, candidates: [candidate(input, 'consolidation')], sync_candidates: [] }) });
      if (request.phase === 'draft') {
        draftCalls += 1; expect(system).toContain('必须省略此字段'); const group = consolidationDraft(input); const operation = group.operations[0]; if (!operation) throw new Error('Missing survivor operation.');
        if (draftCalls === 1) operation.reason = 'A general explanation attached to an update.';
        if (draftCalls === 2) { expect(system).toContain(`${survivor.id} 的 operation.reason 不是通用备注`); operation.changes.source_claim_ids = []; }
        if (draftCalls === 3) expect(system).toContain(`保留 ${survivor.id} 的既有来源：${retired.id}`);
        return Promise.resolve({ text: JSON.stringify({ action: 'stage', group }) });
      }
      return Promise.resolve({ text: JSON.stringify({ decision: 'apply', reason: 'All original references and fields are retained.', reason_kind: 'useful_knowledge', ...reviews(ValidationSchema.parse(request.validation)) }) });
    }, { llm: { structuredRetries: 3 } }, input);
    try {
      await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id); expect(draftCalls).toBe(3);
      expect(await new ClaimStore(f.knowledge.context()).read(survivor.id)).toMatchObject({ source_claim_ids: [retired.id], status: 'active' });
      expect(await new ClaimStore(f.knowledge.context()).read(retired.id)).toMatchObject({ status: 'deprecated' });
      expect(await new TraceStore(f.knowledge.context()).list()).toHaveLength(2);
    } finally { await f.close(); }
  });
  it('runs a sync candidate through the model, rebinds delivery and leaves Claim bodies unchanged', async () => {
    const [source, oldCarrier] = claims(); if (!source || !oldCarrier) throw new Error('Missing source.'); const retired: Claim = { ...source, status: 'deprecated', updated_at: '2026-02-01T00:00:00Z' }; const carrier: Claim = { ...oldCarrier, statement: `${source.statement} ${oldCarrier.statement}`, evidence_summary: `${oldCarrier.evidence_summary} ${source.evidence_summary}`, updated_at: '2026-02-02T00:00:00Z' }; const phases: string[] = [];
    const server = await teamServer(() => ({})); const f = await dreamFixture((_route, _system, text) => {
      const r = JSON.parse(text) as { phase: string; validation: SyncValidation }; phases.push(r.phase);
      if (r.phase === 'candidates') return Promise.resolve({ text: JSON.stringify({ review: reviewSummary, candidates: [], sync_candidates: [{ source_id: source.id, carrier_ids: [carrier.id], reason: 'Recheck the current complete carrier.' }] }) });
      expect(r.phase).toBe('sync_review'); expect(r.validation.input.carriers).toEqual([carrier]); return Promise.resolve({ text: JSON.stringify({ claims: [{ claim_id: source.id, final_name: retired.name, name_reason: 'Retired history retains its original name.', information_preserved: 'All source conditions are in the current carrier.', removal_or_correction: 'Delivery dependency only.', factual_correction: false, output_ids: [carrier.id], evidence_ids: [] }], scope_and_certainty: 'No new facts or confidence increase.' }) });
    }, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } }, [retired, carrier]);
    try {
      const queue = new UploadStore(f.knowledge.context()); await queue.enqueue([retired, oldCarrier], [], true, [{ before: source, retired, carriers: [oldCarrier] }]); await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id); expect(phases).toEqual(['candidates', 'sync_review']); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([retired, carrier]); expect((await f.knowledge.dreamStore().progress(job.id))?.syncCompleted).toEqual([source.id]); expect((await queue.read()).claims).toEqual([]); expect(server.requests.map((request) => (request.body as { data: Claim }).data.id)).toEqual([carrier.id, source.id]);
    } finally { await f.close(); await server.close(); }
  });
  it('retains earlier committed groups when a later review is missing, then resumes only pending work', async () => {
    const input = claims(); let repaired = false; let firstReviews = 0;
    const f = await dreamFixture((_route, _system, text) => {
      const r = JSON.parse(text) as { phase: string; candidate?: { group_id: string; claim_ids: string[] }; validation?: unknown };
      if (r.phase === 'candidates') return Promise.resolve({ text: JSON.stringify({ review: reviewSummary, candidates: input.map((claim, index) => candidate([claim], 'quality', `group-${index}`)), sync_candidates: [] }) });
      if (r.phase === 'draft') return Promise.resolve({ text: JSON.stringify({ action: 'stage', group: qualityDraft(input.filter((claim) => r.candidate?.claim_ids.includes(claim.id))) }) });
      if (r.candidate?.group_id === 'group-0') firstReviews += 1;
      return Promise.resolve({ text: JSON.stringify({ decision: 'apply', reason: 'Reviewed.', reason_kind: 'useful_knowledge', ...r.candidate?.group_id === 'group-1' && !repaired ? { semantic: null, self_review: null } : reviews(ValidationSchema.parse(r.validation)) }) });
    });
    try { await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id, 'failed'); expect((await new ClaimStore(f.knowledge.context()).list()).filter((claim) => claim.status === 'deprecated')).toHaveLength(1); expect((await f.knowledge.dreamStore().progress(job.id))?.entries[1]?.status).toBe('pending'); expect((await f.knowledge.dreamStore().state()).last_success_at).toBeNull(); repaired = true; await f.worker.retry(job.id); await waitJob(f.worker.queue, job.id); expect(firstReviews).toBe(1); }
    finally { await f.close(); }
  });
  it('unloading during prepared finishes this group, pauses further work and can resume after reload', async () => {
    const input = claims(); const f = await dreamFixture(phaseBackend(input)); const ready = deferred(); const release = deferred(); let paused = false;
    const rename = fs.rename.bind(fs); const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => { await rename(source, target); if (!paused && String(target).includes(`${sep}executions${sep}`) && String(target).endsWith('.yaml')) { paused = true; ready.resolve(); await release.promise; } });
    try { await f.start(); const job = await f.dream.request(); await ready.promise; const closing = f.dream.close(); release.resolve(); await closing; await until(async () => (await f.worker.queue.read(job.id))?.state === 'queued'); expect((await f.knowledge.dreamStore().records(job.id))[0]?.checkpoint.applied).toBe(true); expect((await f.knowledge.dreamStore().state()).last_success_at).toBeNull(); const reloaded = new AcnDream(f.knowledge, () => { throw new Error('Applied groups cannot rerun the model.'); }, await loadPromptRenderer()); try { await reloaded.start(); expect((await reloaded.request()).id).toBe(job.id); await waitJob(f.worker.queue, job.id); } finally { await reloaded.close(); } }
    finally { release.resolve(); spy.mockRestore(); await f.close(); }
  });
  it('checks at four-hour intervals using successful cooling rather than mere invocation time', async () => {
    const f = await dreamFixture(phaseBackend(claims()), { dream: { minChangedClaims: 1 } });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const now = Date.now(); const state = { last_success_at: new Date(now - 20 * 3_600_000).toISOString(), last_input_snapshot_at: null, known_versions: {} }; await writeYamlAtomic(f.knowledge.context().paths.dreamState, state, DreamStateSchema, f.knowledge.logger);
      await f.dream.start(); expect(await f.worker.queue.list()).toEqual([]); vi.advanceTimersByTime(4 * 3_600_000); await f.dream.flush(); const queued = await f.worker.queue.list(); expect(queued).toHaveLength(1); expect(queued[0]).toMatchObject({ kind: 'dream', payload: { manual: false } }); expect(typeof queued[0]?.payload['workspace_root']).toBe('string');
    } finally { vi.useRealTimers(); await f.close(); }
  });
  it('never reads private Memory, USER, session transcript or Dispute material into Dream', async () => {
    const input = claims(); const backend = phaseBackend(input); let calls = 0;
    const f = await dreamFixture((...args) => { calls += 1; expect(args[1] + args[2]).not.toContain('PRIVATE_CONTENT_MARKER'); return backend(...args); });
    try { const paths = f.knowledge.context().paths; for (const directory of [join(paths.root, 'memories'), paths.sessions, paths.disputes]) await fs.mkdir(directory, { recursive: true }); for (const path of [join(paths.root, 'memories', 'MEMORY.md'), join(paths.root, 'memories', 'USER.md'), join(paths.sessions, 'private-transcript.txt'), join(paths.disputes, 'private-fixture.txt')]) await fs.writeFile(path, 'PRIVATE_CONTENT_MARKER'); await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id); expect(calls).toBe(3); }
    finally { await f.close(); }
  });
  it.each(['quality', 'consolidation'] as const)('commits %s, reports full scope and leaves solo mode without a team queue', async (kind) => {
    const input = claims(); const phases: string[] = []; const backend = phaseBackend(input, kind);
    const f = await dreamFixture((...args) => { phases.push((JSON.parse(args[2]) as { phase: string }).phase); return backend(...args); });
    try {
      await f.start(); const job = await f.dream.request(); const done = await waitJob(f.worker.queue, job.id);
      expect(phases).toEqual(['candidates', 'draft', 'review']); expect(done.result).toMatchObject({ updatedClaimIds: input.map((claim) => claim.id) });
      const local = await new ClaimStore(f.knowledge.context()).list(); expect(local.filter((claim) => claim.status === 'deprecated')).toHaveLength(kind === 'quality' ? 2 : 1);
      expect((await f.knowledge.dreamStore().state()).last_success_at).not.toBeNull(); expect(await new TraceStore(f.knowledge.context()).list()).toHaveLength(2);
      expect((await f.knowledge.dreamStore().records(job.id))[0]?.checkpoint).toMatchObject({ applied: true, operation: { hard_validation_passed: true } });
      const report = await fs.readFile(join(f.knowledge.context().paths.dreamJob(job.id), 'report.md'), 'utf8'); expect(report).toContain('group-a'); expect(report).toContain('included');
      const executions = await fs.readdir(join(f.knowledge.context().paths.dreamJob(job.id), 'executions')); expect(executions.filter((name) => name.endsWith('.md'))).toHaveLength(2);
      expect((await new UploadStore(f.knowledge.context()).read()).claims).toEqual([]); await expect(fs.stat(f.knowledge.context().paths.pendingUploads)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.close(); }
  });
  it('allows zero changes and explicitly kept candidates without a quota', async () => {
    for (const hasCandidate of [false, true]) {
      const f = await dreamFixture((_route, _system, text) => Promise.resolve({ text: JSON.stringify((JSON.parse(text) as { phase: string }).phase === 'candidates' ? { review: reviewSummary, candidates: hasCandidate ? [candidate(claims())] : [], sync_candidates: [] } : { action: 'keep', reason_kind: 'uncertain_preservation', reason: 'No safe change was identified.' }) }));
      try { await f.start(); const job = await f.dream.request(); const done = await waitJob(f.worker.queue, job.id); expect(done.result).toMatchObject({ updatedClaimIds: [] }); expect((await new ClaimStore(f.knowledge.context()).list()).every((claim) => claim.status === 'active')).toBe(true); expect((await f.knowledge.dreamStore().state()).last_success_at).not.toBeNull(); expect((await f.knowledge.dreamStore().progress(job.id))?.entries.every((entry) => entry.status === 'kept')).toBe(true); }
      finally { await f.close(); }
    }
  });
  it('repairs in the same candidate context and persists both drafts and feedback', async () => {
    const input = claims(1); let drafts = 0; let reviewCalls = 0; const backend = phaseBackend(input);
    const f = await dreamFixture((...args) => {
      const request = JSON.parse(args[2]) as { phase: string; before: unknown; prior_feedback: string };
      if (request.phase === 'draft') { drafts += 1; if (drafts === 2) { expect(request.before).toEqual(input); expect(request.prior_feedback).toBe('Recheck the one-time classification.'); } }
      if (request.phase === 'review' && ++reviewCalls === 1) return Promise.resolve({ text: JSON.stringify({ decision: 'repair', reason: 'Recheck the one-time classification.', reason_kind: 'uncertain_preservation', semantic: null, self_review: null }) });
      return backend(...args);
    }, {}, input);
    try { await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id); expect([drafts, reviewCalls]).toEqual([2, 2]); expect(await fs.readdir(join(f.knowledge.context().paths.dreamJob(job.id), 'history'))).toEqual(expect.arrayContaining(['group-a-draft-0.json', 'group-a-draft-1.json'])); }
    finally { await f.close(); }
  });
  it('returns actionable schema feedback, rejects factual corrections and can retain the original', async () => {
    let calls = 0; const f = await dreamFixture((_route, system, text) => {
      const request = JSON.parse(text) as { phase: string; validation: unknown };
      if (request.phase === 'candidates') return Promise.resolve({ text: JSON.stringify({ review: reviewSummary, candidates: [candidate(claims())], sync_candidates: [] }) });
      if (request.phase === 'draft') return Promise.resolve({ text: JSON.stringify({ action: 'stage', group: qualityDraft(claims()) }) });
      calls += 1;
      if (calls === 1) { const review = reviews(ValidationSchema.parse(request.validation)); const first = review.semantic.claims[0]; if (first) first.factual_correction = true; return Promise.resolve({ text: JSON.stringify({ decision: 'apply', reason: 'Proposed correction.', reason_kind: 'useful_knowledge', ...review }) }); }
      expect(system).toContain('不允许事实纠正'); return Promise.resolve({ text: JSON.stringify({ decision: 'keep', reason: 'No independent evidence; keep the useful original.', reason_kind: 'insufficient_evidence', semantic: null, self_review: null }) });
    });
    try { await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id); expect(calls).toBe(2); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(claims()); }
    finally { await f.close(); }
  });
  it('abandons a stale plan with a recorded reason and preserves the foreground revision', async () => {
    const input = claims(); const backend = phaseBackend(input); let changed = false;
    const f = await dreamFixture(async (...args) => {
      if ((JSON.parse(args[2]) as { phase: string }).phase === 'review' && !changed) { changed = true; const first = input[0]; if (!first) throw new Error('Missing input.'); const current = await f.knowledge.readClaim(first.id); await f.knowledge.updateClaim({ id: first.id, expected_revision: current.revision, statement: 'A newer user-reviewed condition.' }); }
      return backend(...args);
    });
    try { await f.start(); const job = await f.dream.request(); const result = await waitJob(f.worker.queue, job.id); expect(result.result).toMatchObject({ skipped: ['group-a'] }); const local = await new ClaimStore(f.knowledge.context()).list(); expect(local[0]?.statement).toBe('A newer user-reviewed condition.'); expect(local.every((claim) => claim.status === 'active')).toBe(true); expect((await f.knowledge.dreamStore().progress(job.id))?.entries[0]?.reason).toContain('外部版本'); }
    finally { await f.close(); }
  });
  it('blocks all effects on an audit failure, then resumes the prepared group without model replay', async () => {
    const input = claims(); const backend = phaseBackend(input); let blockedPath = ''; let calls = 0;
    const f = await dreamFixture(async (...args) => { calls += 1; const request = JSON.parse(args[2]) as { phase: string; validation: unknown }; if (request.phase === 'review') { const validation = ValidationSchema.parse(request.validation); const jobs = await f.worker.queue.list(); const job = jobs.find((value) => value.kind === 'dream'); if (!job) throw new Error('Missing job.'); blockedPath = join(f.knowledge.context().paths.dreamJob(job.id), 'executions', `${validation.validation_id}.md`); await fs.mkdir(blockedPath, { recursive: true }); } return backend(...args); });
    try {
      await f.start(); const job = await f.dream.request(); await until(async () => (await f.knowledge.dreamStore().records(job.id)).length === 1, 'prepared receipt');
      // prepared 文件可先于审计失败可见；确认原执行已退回队列后再解除故障。
      await until(async () => { const saved = await f.worker.queue.read(job.id); return saved?.state === 'queued' && saved.lastErrorKind === 'storage'; }, 'audit failure persisted');
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(input); expect(await new TraceStore(f.knowledge.context()).list()).toEqual([]);
      await fs.rm(blockedPath, { recursive: true }); await f.knowledge.dreamStore().recover(); await waitJob(f.worker.queue, job.id); expect(calls).toBe(3); expect((await f.knowledge.dreamStore().progress(job.id))?.entries[0]?.status).toBe('executed');
    } finally { await f.close(); }
  });
  it('stops an in-flight provider, keeps a staged candidate and resumes below automatic thresholds', async () => {
    const input = claims(); const backend = phaseBackend(input); let reviewCalls = 0; const ready = deferred();
    const f = await dreamFixture((...args) => { if ((JSON.parse(args[2]) as { phase: string }).phase === 'review' && ++reviewCalls === 1) { ready.resolve(); return new Promise(() => {}); } return backend(...args); });
    try {
      await f.start(); const job = await f.dream.request(); await ready.promise; expect(await f.dream.stop()).toBe(1); await until(async () => (await f.worker.queue.read(job.id))?.state === 'queued');
      expect(await f.worker.queue.read(job.id)).toMatchObject({ attempts: 0, payload: { paused: true } }); const progress = await f.knowledge.dreamStore().progress(job.id); expect(progress?.entries[0]).toMatchObject({ status: 'pending', draft: { kind: 'quality' }, validation: { input: { group_id: 'group-a' } } });
      expect((await f.knowledge.dreamStore().state()).last_success_at).toBeNull(); expect((await f.dream.request()).id).toBe(job.id); await waitJob(f.worker.queue, job.id); expect(reviewCalls).toBe(2);
    } finally { await f.close(); }
  });
  it('keeps already committed groups when stopping the next group and does not replay them', async () => {
    const input = claims(); const ready = deferred(); let second = 0; let firstCalls = 0;
    const backend: StructuredBackend = (_route, _system, text) => { const r = JSON.parse(text) as { phase: string; candidate?: { group_id: string; claim_ids: string[] }; validation?: unknown }; const selected = input.filter((claim) => r.candidate?.claim_ids.includes(claim.id));
      if (r.phase === 'candidates') return Promise.resolve({ text: JSON.stringify({ review: reviewSummary, candidates: input.map((claim, index) => candidate([claim], 'quality', `group-${index}`)), sync_candidates: [] }) });
      if (r.candidate?.group_id === 'group-0') firstCalls += 1;
      if (r.phase === 'draft' && r.candidate?.group_id === 'group-1' && ++second === 1) { ready.resolve(); return new Promise(() => {}); }
      return Promise.resolve({ text: JSON.stringify(r.phase === 'draft' ? { action: 'stage', group: qualityDraft(selected) } : { decision: 'apply', reason: 'Reviewed', reason_kind: 'useful_knowledge', ...reviews(ValidationSchema.parse(r.validation)) }) }); };
    const f = await dreamFixture(backend);
    try { await f.start(); const job = await f.dream.request(); await ready.promise; await f.dream.stop(); await until(async () => (await f.worker.queue.read(job.id))?.state === 'queued'); expect((await new ClaimStore(f.knowledge.context()).list()).filter((claim) => claim.status === 'deprecated')).toHaveLength(1); expect((await f.knowledge.dreamStore().state()).last_success_at).toBeNull(); await f.dream.request(); await waitJob(f.worker.queue, job.id); expect(firstCalls).toBe(2); expect((await f.knowledge.dreamStore().records(job.id))).toHaveLength(2); }
    finally { await f.close(); }
  });
  it('isolates prompt failures from foreground reads and honors disabled Dream', async () => {
    const f = await dreamFixture(() => { throw new Error('Model must not run.'); });
    try { await f.dream.close(); const broken = new AcnDream(f.knowledge, () => { throw new Error('Model must not run.'); }, () => { throw new Error('Template missing.'); }); await f.knowledge.jobs?.start(); try { const job = await broken.request(); await waitJob(f.worker.queue, job.id, 'failed'); expect((await f.knowledge.snapshot()).claims).toHaveLength(2); } finally { await broken.close(); } }
    finally { await f.close(); }
    const disabled = await dreamFixture(phaseBackend(claims()), { dream: { enabled: false } }); try { await disabled.start(); await expect(disabled.dream.request()).rejects.toMatchObject({ kind: 'disabled' }); expect(await disabled.worker.queue.list()).toEqual([]); } finally { await disabled.close(); }
  });
});
