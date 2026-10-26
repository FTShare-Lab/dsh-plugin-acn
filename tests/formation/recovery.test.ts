// 并发编辑与 prepared 恢复必须核对分析版本，保留已落地结果并放弃剩余旧方案。
import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { DisputeStore } from '../../src/store/disputes.js';
import { ClaimIdSchema, deriveTraceId } from '../../src/protocol/ids.js';
import { nowSeconds } from '../../src/protocol/time.js';
import { CheckpointSchema, FormationStore } from '../../src/formation/checkpoint.js';
import { writeYamlAtomic, readYaml } from '../../src/store/yaml.js';
import { STALE_PLAN_WARNING } from '../../src/knowledge/alignment.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { emptyOutput, formationFixture, newDraft, waitJob } from './helpers.js';

describe('formation recovery alignment', () => {
  it('refuses a checkpoint belonging to another session directory', async () => {
    const fixture = await formationFixture(() => Promise.reject(new Error('No model call is expected.')));
    try {
      const context = fixture.knowledge.context();
      await writeYamlAtomic(context.paths.finalizeCheckpoint('session-a'), { schemaVersion: 1, sessionId: 'session-b', jobId: 'job-a', kind: 'finalize', fromSeq: -1, untilSeq: 0, status: 'prepared', analysisClaims: [], preparedClaims: [], appliedClaims: [], disputes: [], trace: null, warnings: [] }, CheckpointSchema, context.logger);
      await expect(new FormationStore(context).read('session-a')).rejects.toMatchObject({ kind: 'decode' });
    } finally { await fixture.close(); }
  });
  it('does not hold the knowledge lock during a model call or overwrite an edit committed meanwhile', async () => {
    const local = sampleClaim(); let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; }); let calls = 0;
    const fixture = await formationFixture(async (_route, _system, input) => {
      calls += 1;
      if (calls === 1) { await gate; return { text: JSON.stringify({ ...emptyOutput(), updated_claims: [{ ...newDraft(), id: local.id, status: 'active' }] }) }; }
      expect(input).toContain('User revised the current service boundary.');
      expect(input).toContain('Check the retry invariant.');
      return { text: JSON.stringify({ ...emptyOutput(), new_claims: [newDraft()] }) };
    });
    try {
      await new ClaimStore(fixture.knowledge.context()).write(local); await fixture.formation.start();
      fixture.formation.capture('session-a', { route: { provider: 'mock', model: 'mock' }, entry: { seq: 0, type: 'user', text: 'Check the retry invariant.' } });
      const job = await fixture.formation.finalize('session-a'); await vi.waitFor(() => { expect(calls).toBe(1); });
      const before = await fixture.knowledge.readClaim(local.id);
      await fixture.knowledge.updateClaim({ id: local.id, expected_revision: before.revision, statement: 'User revised the current service boundary.' });
      release?.(); await waitJob(fixture.formation.worker.queue, job.id);
      expect((await fixture.knowledge.readClaim(local.id)).claim.statement).toBe('User revised the current service boundary.');
      expect(calls).toBe(2);
      expect((await fixture.formation.worker.queue.read(job.id))?.attempts).toBe(2);
      expect((await new ClaimStore(fixture.knowledge.context()).list())).toHaveLength(2);
      expect((await new TraceStore(fixture.knowledge.context()).list())[0]?.output_claims).toHaveLength(1);
    } finally { release?.(); await fixture.close(); }
  });
  it.each([false, true])('recovery preserves exact partial writes and external edits, with missing analysis=%s', async (missing) => {
    const fixture = await formationFixture(() => Promise.reject(new Error('Recovery must never invoke the model.')));
    try {
      const context = fixture.knowledge.context(); const local = sampleClaim();
      const applied = sampleClaim({ id: ClaimIdSchema.parse('claim_11111111'), statement: 'Exactly persisted partial result.' });
      const remaining = { ...local, statement: 'Old planned replacement.' };
      const external = { ...local, scope: 'service / externally-revised' };
      await new ClaimStore(context).write(external); await new ClaimStore(context).write(applied);
      await fixture.formation.transcript.record('session-a', { entry: { seq: 1, type: 'user', text: 'Review service boundaries.' } });
      const checkpoint = CheckpointSchema.parse({ schemaVersion: 1, sessionId: 'session-a', jobId: 'job-a', kind: 'finalize', fromSeq: -1, untilSeq: 1, status: 'prepared', analysisClaims: missing ? null : [local], preparedClaims: [applied, remaining], appliedClaims: [], disputes: [], warnings: [], trace: { id: deriveTraceId(nowSeconds(), 'review', [local.id], [applied.id]), name: 'review', task: 'Review service boundaries.', agent: context.agentId, input_claims: [local.id], output_claims: [applied.id, local.id], created_at: nowSeconds() } });
      await writeYamlAtomic(context.paths.finalizeCheckpoint('session-a'), checkpoint, CheckpointSchema, context.logger);
      await fixture.knowledge.initialize(); await fixture.knowledge.initialize();
      expect(await new ClaimStore(context).read(local.id)).toEqual(external);
      const restored = await new FormationStore(context).read('session-a'); expect(restored).toMatchObject({ status: 'applied', preparedClaims: [], appliedClaims: [applied], warnings: [STALE_PLAN_WARNING] });
      expect((await new TraceStore(context).list())[0]?.output_claims).toEqual([applied.id]); expect(await new DisputeStore(context).list()).toEqual([]);
    } finally { await fixture.close(); }
  });
  it('a prepared Recap completes its local effects when Finalize arrives and leaves only the later interval', async () => {
    let calls = 0;
    const fixture = await formationFixture(() => { calls += 1; return Promise.resolve({ text: JSON.stringify({ ...emptyOutput(), new_claims: [newDraft()] }) }); });
    let release: (() => void) | undefined; let ready: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { ready = resolve; });
    const rename = fs.rename.bind(fs); let intercepted = false;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      await rename(source, target);
      if (String(target) === fixture.knowledge.context().paths.finalizeCheckpoint('session-a') && !intercepted) {
        const checkpoint = await readYaml(String(target), CheckpointSchema);
        if (checkpoint.status === 'prepared') { intercepted = true; ready?.(); await gate; }
      }
    });
    try {
      await fixture.formation.start(); fixture.formation.capture('session-a', { route: { provider: 'mock', model: 'mock' }, entry: { seq: 0, type: 'user', text: 'First interval.' } }, 0); await entered;
      fixture.formation.capture('session-a', { entry: { seq: 1, type: 'user', text: 'Later interval.' } });
      const final = await fixture.formation.finalize('session-a'); release?.(); await waitJob(fixture.formation.worker.queue, final.id);
      expect(calls).toBe(2); expect((await fixture.formation.worker.queue.list()).every((job) => job.state === 'succeeded')).toBe(true);
      const traces = await new TraceStore(fixture.knowledge.context()).list(); expect(traces).toHaveLength(2);
      expect(traces.map((trace) => trace.task).sort()).toEqual(['First interval.', 'Later interval.']);
    } finally { release?.(); spy.mockRestore(); await fixture.close(); }
  });
});
