// 使用真实队列与磁盘贯通结构化重试、无路由失败、恢复补做及增量形成。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { UploadStore } from '../../src/store/uploads.js';
import { DisputeStore } from '../../src/store/disputes.js';
import { statusCommand } from '../../src/commands/status.js';
import { AcnFormation } from '../../src/formation/service.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { emptyOutput, formationFixture, newDraft, waitJob } from './helpers.js';

describe('durable knowledge formation', () => {
  it('invalid JSON twice then a third valid result produces one Claim and Trace, with safe audit metadata', async () => {
    const responses = ['broken', JSON.stringify({ ...emptyOutput(), new_claims: [{ ...newDraft(), extra: true }] }), `\n\x60\x60\x60json\n${JSON.stringify({ ...emptyOutput(), new_claims: [newDraft()] })}\n\x60\x60\x60\n`];
    const systems: string[] = []; const inputs: string[] = [];
    const fixture = await formationFixture((_route, system, input) => { systems.push(system); inputs.push(input); return Promise.resolve({ text: responses.shift() ?? '' }); });
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('Solo formation must not contact team services.')));
    try {
      const privateFiles = fixture.knowledge.context().paths;
      await fs.mkdir(privateFiles.memories, { recursive: true }); await fs.writeFile(privateFiles.user, 'PRIVATE_USER_MARKER'); await fs.writeFile(privateFiles.memory, 'PRIVATE_MEMORY_MARKER');
      await fixture.formation.start();
      fixture.formation.capture('session-a', { route: { provider: 'mock', model: 'mock' }, entry: { seq: 1, type: 'user', text: 'Check the retry invariant using the current service contract.' } });
      const job = await fixture.formation.finalize('session-a'); await waitJob(fixture.formation.worker.queue, job.id);
      expect(systems).toHaveLength(3); expect(systems[1]).toContain('上次响应未通过'); expect(systems[2]).toContain('unrecognized_keys');
      const context = fixture.knowledge.context();
      expect(await new ClaimStore(context).list()).toHaveLength(1); expect(await new TraceStore(context).list()).toHaveLength(1);
      const files = await fs.readdir(context.paths.llmCalls); const metadata = await fs.readFile(join(context.paths.llmCalls, files.find((file) => file.endsWith('.jsonl')) ?? ''), 'utf8');
      expect(metadata.trim().split('\n')).toHaveLength(3); expect(metadata).toContain(job.id); expect(metadata).not.toContain('Check the retry'); expect(metadata).not.toContain('bounded_retry');
      expect(inputs.every((input) => !input.includes('MEMORY.md') && !input.includes('USER.md'))).toBe(true);
      expect(JSON.stringify({ systems, inputs })).not.toContain('PRIVATE_USER_MARKER'); expect(JSON.stringify({ systems, inputs })).not.toContain('PRIVATE_MEMORY_MARKER'); expect(network).not.toHaveBeenCalled();
      await expect(fs.access(context.paths.uploads)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { network.mockRestore(); await fixture.close(); }
  });
  it('five invalid responses fail visibly and the same persistent job can be retried', async () => {
    let calls = 0;
    const fixture = await formationFixture(() => Promise.resolve({ text: ++calls <= 5 ? 'invalid' : JSON.stringify({ ...emptyOutput(), new_claims: [newDraft()] }) }));
    try {
      await fixture.formation.start(); fixture.formation.capture('session-a', { route: { provider: 'mock', model: 'mock' }, entry: { seq: 0, type: 'user', text: 'Verify the service contract.' } });
      const job = await fixture.formation.finalize('session-a'); const failed = await waitJob(fixture.formation.worker.queue, job.id, 'failed');
      expect(calls).toBe(5); expect(failed.attempts).toBe(1);
      expect(await statusCommand(fixture.knowledge)).toContain(job.id); expect(await statusCommand(fixture.knowledge)).toContain('连续 5 次');
      await fixture.formation.worker.retry(job.id); await waitJob(fixture.formation.worker.queue, job.id); expect(calls).toBe(6);
      expect((await new ClaimStore(fixture.knowledge.context()).list())).toHaveLength(1);
    } finally { await fixture.close(); }
  });
  it('missing session route fails without a call or global fallback, then retries after a logged route', async () => {
    let calls = 0; const fixture = await formationFixture(() => { calls += 1; return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); });
    try {
      await fixture.formation.start();
      fixture.formation.capture('other-session', { route: { provider: 'other', model: 'other' } });
      fixture.formation.capture('session-a', { entry: { seq: 0, type: 'user', text: 'Review the contract.' } });
      const job = await fixture.formation.finalize('session-a'); await waitJob(fixture.formation.worker.queue, job.id, 'failed');
      expect(calls).toBe(0); expect(await statusCommand(fixture.knowledge)).toContain('llm.provider');
      fixture.formation.capture('session-a', { route: { provider: 'mock', model: 'mock' } }); await fixture.formation.flush();
      await fixture.formation.worker.retry(job.id); await waitJob(fixture.formation.worker.queue, job.id); expect(calls).toBe(1);
    } finally { await fixture.close(); }
  });
  it('explicit route works before the first ordinary request; local disputes persist while solo has no upload queue', async () => {
    const local = sampleClaim(); const output = { ...emptyOutput(), new_claims: [newDraft()], used_claim_ids: [local.id, 'claim_deadbeef'], new_disputes: [{ id: '$new_dispute_0$', name: 'retry_conflict', summary: 'Incompatible bounds in the example contracts.', claims: [local.id, '$new_claim_0$'] }] };
    const route = vi.fn((route: object) => { expect(route).toEqual({ provider: 'configured', model: 'example-model' }); return Promise.resolve({ text: JSON.stringify(output) }); });
    const fixture = await formationFixture(route, { llm: { provider: 'configured', model: 'example-model' } });
    try {
      await new ClaimStore(fixture.knowledge.context()).write(local); await fixture.formation.start();
      fixture.formation.capture('session-a', { entry: { seq: 0, type: 'user', text: 'Compare the conflicting retry bounds.' } });
      await waitJob(fixture.formation.worker.queue, (await fixture.formation.finalize('session-a')).id);
      expect(route.mock.calls[0]?.[0]).toEqual({ provider: 'configured', model: 'example-model' });
      expect(fixture.warnings.some((warning) => warning.includes('used_claim_ids'))).toBe(true);
      expect(await new DisputeStore(fixture.knowledge.context()).list()).toHaveLength(1);
      expect((await new TraceStore(fixture.knowledge.context()).list())[0]?.input_claims).toEqual([local.id]);
      expect(await new UploadStore(fixture.knowledge.context()).read()).toEqual({ claims: [], disputes: [] });
      await expect(fs.access(fixture.knowledge.context().paths.uploads)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fixture.close(); }
  });
  it('startup preserves an idle deadline, and repeated Finalize only processes new sequences', async () => {
    const calls: string[] = []; const backend = (_route: object, _system: string, input: string) => { calls.push(input); return Promise.resolve({ text: JSON.stringify(emptyOutput()) }); };
    const fixture = await formationFixture(backend);
    let resumed: AcnFormation | undefined;
    try {
      await fixture.formation.transcript.record('session-a', { route: { provider: 'mock', model: 'mock' }, entry: { seq: 2, type: 'user', text: 'First segment.' } });
      resumed = new AcnFormation(fixture.knowledge, backend, await loadPromptRenderer(), { pollMs: 10 }); await resumed.start();
      expect(calls).toHaveLength(0); expect(await resumed.worker.queue.list()).toEqual([]);
      const activity = (await resumed.transcript.state('session-a')).activityAt;
      await resumed.scan(activity + 3_600_000);
      await vi.waitFor(() => { expect(calls).toHaveLength(1); });
      const tail = (await resumed.worker.queue.list())[0]; if (!tail) throw new Error('Missing recovered tail Recap');
      await waitJob(resumed.worker.queue, tail.id);
      await waitJob(resumed.worker.queue, (await resumed.finalize('session-a')).id); expect(calls).toHaveLength(1);
      resumed.capture('session-a', { entry: { seq: 8, type: 'user', text: 'Second segment.' } });
      await waitJob(resumed.worker.queue, (await resumed.finalize('session-a')).id);
      expect(calls).toHaveLength(2); expect(calls[1]).not.toContain('First segment'); expect(calls[1]).toContain('Second segment');
    } finally { await resumed?.close(); await fixture.close(); }
  });
  it('Finalize preempts an unprepared running Recap and consumes the interval once', async () => {
    let started: (() => void) | undefined; const entered = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const fixture = await formationFixture((_route, _system, _input, _max, signal) => {
      calls += 1;
      if (calls === 1) { started?.(); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true }); }); }
      return Promise.resolve({ text: JSON.stringify({ ...emptyOutput(), new_claims: [newDraft()] }) });
    });
    try {
      await fixture.formation.start(); fixture.formation.capture('session-a', { entry: { seq: 0, type: 'user', text: 'Verify the retry boundary.' }, route: { provider: 'mock', model: 'mock' } }, 0);
      await entered;
      const job = await fixture.formation.finalize('session-a'); await waitJob(fixture.formation.worker.queue, job.id);
      const recap = (await fixture.formation.worker.queue.list()).find((candidate) => candidate.kind === 'recap');
      expect(recap).toMatchObject({ state: 'succeeded', result: { skipped: 'superseded' } }); expect(calls).toBe(2);
      expect(await new ClaimStore(fixture.knowledge.context()).list()).toHaveLength(1);
      expect(await new TraceStore(fixture.knowledge.context()).list()).toHaveLength(1);
    } finally { await fixture.close(); }
  });
});
