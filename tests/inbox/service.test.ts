// 同步失败不阻断本地处理，批次边界、路由、重试和知识锁均通过实际 worker 验证。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { AcnInbox } from '../../src/inbox/service.js';
import { syncInbox } from '../../src/inbox/sync.js';
import { InboxStore } from '../../src/store/inbox.js';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { DisputeStore } from '../../src/store/disputes.js';
import { AgentIdSchema, ClaimIdSchema } from '../../src/protocol/ids.js';
import { ReportedSetStore } from '../../src/store/reported-sets.js';
import { InboxMessageSchema } from '../../src/protocol/inbox.js';
import { writeYamlAtomic, readYaml } from '../../src/store/yaml.js';
import { RouteSchema } from '../../src/formation/transcript.js';
import { withFileLock } from '../../src/store/lock.js';
import { InboxEffectSchema } from '../../src/inbox/effects.js';
import { UploadStore } from '../../src/store/uploads.js';
import { UploadDelivery } from '../../src/upload/deliver.js';
import { TeamHttp } from '../../src/team/http.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { newDraft, waitJob } from '../formation/helpers.js';
import { inboxFixture, inboxMessage, arbitrationMessage, emptyInternalize, teamServer } from '../team/helpers.js';

describe('Inbox sync and worker', () => {
  it.each(['syntax', 'ownership'] as const)('keeps an ACKed notification recoverable after %s failure and applies exactly once after retry', async (failure) => {
    const message = arbitrationMessage(); let received = false; let fixed = false; let calls = 0;
    const foreign = sampleClaim({ id: ClaimIdSchema.parse('claim_00000002'), holder: AgentIdSchema.parse('agent-b') });
    const server = await teamServer((request) => {
      if (request.path === '/inbox/pull') return { body: received ? [] : [message] };
      if (request.path === '/inbox/ack') received = true;
      return {};
    });
    const fixture = await inboxFixture(() => {
      calls += 1;
      if (!fixed && failure === 'syntax') return Promise.resolve({ text: '{"new_claims":[' });
      if (!fixed) return Promise.resolve({ text: JSON.stringify({ ...emptyInternalize(), updated_claims: [{ ...newDraft(), id: foreign.id, status: 'deprecated', source_claim_ids: [message.policy.id] }] }) });
      return Promise.resolve({ text: JSON.stringify({ ...emptyInternalize(), new_claims: [{ ...newDraft(), source_claim_ids: [message.policy.id] }] }) });
    }, { llm: { structuredRetries: 2 }, team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); const worker = fixture.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      const local = sampleClaim(); await new ClaimStore(context).write(local); await worker.start();
      const job = await fixture.inbox.enqueue(); const failed = await waitJob(worker.queue, job.id, 'failed');
      expect(received).toBe(true); expect(calls).toBe(2); expect(failed.lastError).toContain('连续 2 次');
      expect((await new InboxStore(context).listPending()).map((m) => m.id)).toEqual([message.id]);
      expect(await new ClaimStore(context).list()).toEqual([local]); expect(await new TraceStore(context).list()).toEqual([]);
      expect((await new UploadStore(context).read()).claims).toEqual([]);
      fixed = true; await worker.retry(job.id); const completed = await waitJob(worker.queue, job.id);
      expect(completed.result).toMatchObject({ accepted: 0, handled: 1, applied: 1 }); expect(calls).toBe(3);
      expect(await new InboxStore(context).hasUnfinished()).toBe(false); expect(await new TraceStore(context).list()).toHaveLength(1);
      expect(await new ClaimStore(context).read(local.id)).toEqual(local); expect((await new ClaimStore(context).list()).every((c) => c.holder === 'agent-a')).toBe(true);
      await waitJob(worker.queue, (await fixture.inbox.enqueue()).id); expect(calls).toBe(3);
      expect(server.requests.filter((request) => request.path === '/inbox/ack')).toHaveLength(1);
    } finally { await fixture.close(); await server.close(); }
  });
  it('reuploads an already-deprecated Policy dependent without a model call, new revision or Trace', async () => {
    const server = await teamServer(() => ({}));
    const fixture = await inboxFixture(() => Promise.reject(new Error('Policy withdrawal must be deterministic.')), { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); const message = inboxMessage(); message.policy.status = 'deprecated';
      const local = sampleClaim({ status: 'deprecated', source_claim_ids: [message.policy.id] });
      await new ClaimStore(context).write(local); await new InboxStore(context).acceptPulled(message);
      const jobs = fixture.knowledge.jobs; if (!jobs) throw new Error('Missing worker.'); await jobs.start();
      const result = await waitJob(jobs.queue, (await fixture.inbox.enqueue(false)).id);
      expect(result.result).toMatchObject({ handled: 1, applied: 0, uploadedClaims: 1 });
      expect(server.requests.filter((request) => request.path === '/claims/upload').map((request) => request.body)).toMatchObject([{ data: local }]);
      expect(await new ClaimStore(context).read(local.id)).toEqual(local); expect(await new TraceStore(context).list()).toEqual([]);
    } finally { await fixture.close(); await server.close(); }
  });
  it('reanalyses the original inbox batch after a concurrent edit before any effect or done marker', async () => {
    const local = sampleClaim(); let calls = 0; let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await inboxFixture(async (_route, _system, input) => {
      calls += 1;
      if (calls === 1) await gate;
      else { expect(input).toContain('Concurrent revised scope.'); expect(input).toContain('policy_00000001'); }
      return { text: JSON.stringify({ ...emptyInternalize(), new_claims: [newDraft()] }) };
    });
    try {
      const context = fixture.knowledge.context(); const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.');
      await new ClaimStore(context).write(local); const store = new InboxStore(context); await store.acceptPulled(inboxMessage());
      await jobs.start(); const job = await fixture.inbox.enqueue(false); await vi.waitFor(() => { expect(calls).toBe(1); });
      const before = await fixture.knowledge.readClaim(local.id);
      await fixture.knowledge.updateClaim({ id: local.id, expected_revision: before.revision, statement: 'Concurrent revised scope.' });
      release?.(); const result = await waitJob(jobs.queue, job.id);
      expect(result.attempts).toBe(2); expect(result.result).toMatchObject({ handled: 1, applied: 1 }); expect(calls).toBe(2);
      expect((await fixture.knowledge.readClaim(local.id)).claim.statement).toBe('Concurrent revised scope.');
      expect(await new ClaimStore(context).list()).toHaveLength(2); expect(await store.hasUnfinished()).toBe(false);
      expect(await new TraceStore(context).list()).toHaveLength(1);
    } finally { release?.(); await fixture.close(); }
  });
  it('activation queues orphan processing messages and the sole worker reclaims them immediately', async () => {
    const fixture = await inboxFixture();
    try {
      const store = new InboxStore(fixture.knowledge.context()); await store.acceptPulled(inboxMessage()); expect(await store.claimPending()).toHaveLength(1); expect(await store.listPending()).toEqual([]);
      await fixture.inbox.start(); const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); const job = (await jobs.queue.list())[0]; if (job === undefined) throw new Error('No recovery job.');
      await jobs.start(); await waitJob(jobs.queue, job.id); expect(await store.hasUnfinished()).toBe(false);
    } finally { await fixture.close(); }
  });
  it.each([503, 404])('receipt ACK %i leaves durable messages available for successful local internalization', async (status) => {
    const message = inboxMessage(); const server = await teamServer((request) => request.path === '/inbox/pull' ? { body: [message] } : request.path === '/inbox/ack' ? { status } : {});
    const fixture = await inboxFixture(() => Promise.resolve({ text: JSON.stringify({ ...emptyInternalize(), new_claims: [{ ...newDraft(), source_claim_ids: [message.policy.id] }] }) }), { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); await jobs.start();
      const job = await fixture.inbox.enqueue(); const result = await waitJob(jobs.queue, job.id);
      expect(result.result).toMatchObject({ accepted: 1, acknowledged: 0, handled: 1, applied: 1 });
      expect(await new InboxStore(fixture.knowledge.context()).listPending()).toEqual([]);
      expect((await fixture.knowledge.snapshot()).claims[0]?.source_claim_ids).toEqual([message.policy.id]);
      expect(server.requests.some((request) => request.path === '/claims/upload')).toBe(true);
    } finally { await fixture.close(); await server.close(); }
  });
  it('ACKs the successfully persisted prefix when a later snapshot write fails', async () => {
    const message = inboxMessage(); const next = InboxMessageSchema.parse({ ...message, id: 'inbox_00000002' });
    const server = await teamServer((request) => request.path === '/inbox/pull' ? { body: [message, next] } : {});
    const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    const original = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => { if (String(target) === fixture.knowledge.context().paths.pendingInbox(next.id)) throw new Error('Injected disk failure.'); await original(source, target); });
    try {
      const report = await syncInbox(fixture.knowledge.context(), fixture.knowledge.team); expect(report).toMatchObject({ pulled: 2, accepted: 1, acknowledged: 1 });
      expect(server.requests.find((request) => request.path === '/inbox/ack')?.body).toMatchObject({ data: { inbox_ids: [message.id] } });
      expect(await new InboxStore(fixture.knowledge.context()).listPending()).toEqual([message]);
    } finally { spy.mockRestore(); await fixture.close(); await server.close(); }
  });
  it('an upload auth failure never replays the applied arbitration or its model call', async () => {
    let calls = 0; let authorized = false; const message = arbitrationMessage();
    const server = await teamServer((request) => request.path === '/inbox/pull' ? { body: [message] } : request.path === '/claims/upload' && !authorized ? { status: 401 } : {});
    const fixture = await inboxFixture(() => { calls += 1; return Promise.resolve({ text: JSON.stringify({ ...emptyInternalize(), new_claims: [newDraft()] }) }); }, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); await jobs.start(); const job = await fixture.inbox.enqueue(); await waitJob(jobs.queue, job.id); expect(calls).toBe(1); expect((await new UploadStore(fixture.knowledge.context()).read()).claims).toHaveLength(1);
      authorized = true; await new UploadDelivery(fixture.knowledge.context(), fixture.knowledge.team).deliver();
      const repeated = await fixture.inbox.enqueue(); await waitJob(jobs.queue, repeated.id); expect(calls).toBe(1); expect((await new UploadStore(fixture.knowledge.context()).read()).claims).toEqual([]);
    } finally { await fixture.close(); await server.close(); }
  });
  it('processes local pending data even when pull is unavailable, and keeps Router/Maintainer states separate', async () => {
    const server = await teamServer((request) => request.path.startsWith('/inbox/') ? { status: 503 } : { body: { scopes: [] } });
    const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      await new InboxStore(fixture.knowledge.context()).acceptPulled(inboxMessage()); const jobs = fixture.knowledge.jobs; if (jobs === null || fixture.knowledge.team === null) throw new Error('No worker.');
      await jobs.start(); const job = await fixture.inbox.enqueue(); expect((await waitJob(jobs.queue, job.id)).result).toMatchObject({ pulled: 0, handled: 1 });
      await fixture.knowledge.team.request('router', () => fixture.knowledge.team?.router.overview() ?? Promise.reject(new Error('No Router.')));
      expect(fixture.knowledge.teamStatus()).toMatchObject({ router: { state: 'ok' }, maintainer: { state: 'failed' } });
    } finally { await fixture.close(); await server.close(); }
  });
  it('handles a large consecutive CAU batch in one model call and persists a canonical plan plus refs', async () => {
    let calls = 0;
    const fixture = await inboxFixture((_route, _system, input) => {
      calls += 1; expect(z.object({ claim_attribute_updates: z.array(z.unknown()) }).parse(JSON.parse(input) as unknown).claim_attribute_updates).toHaveLength(70);
      return Promise.resolve({ text: JSON.stringify({ ...emptyInternalize(), new_claims: [{ ...newDraft(), source_claim_ids: ['policy_00000001'] }] }) });
    });
    try {
      const store = new InboxStore(fixture.knowledge.context());
      for (let index = 1; index <= 70; index += 1) await store.acceptPulled(InboxMessageSchema.parse({ ...arbitrationMessage(), id: `inbox_${index.toString(16).padStart(8, '0')}` }));
      const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); await jobs.start(); const job = await fixture.inbox.enqueue(); await waitJob(jobs.queue, job.id);
      expect(calls).toBe(1); expect((await fixture.knowledge.snapshot()).claims).toHaveLength(1);
      expect((await readYaml(fixture.knowledge.context().paths.inboxEffect('inbox_00000001'), InboxEffectSchema)).members).toHaveLength(70);
      expect((await fs.readdir(fixture.knowledge.context().paths.inbox)).filter((name) => name.endsWith('.done.yaml'))).toHaveLength(70);
    } finally { await fixture.close(); }
  });
  it('flushes the previous kind before deterministic deprecation and then plans against the new local state', async () => {
    let calls = 0; const observed: string[] = [];
    const fixture = await inboxFixture((_route, _system, input) => { calls += 1; observed.push(input); return Promise.resolve({ text: JSON.stringify({ ...emptyInternalize(), ...(calls === 1 ? { new_claims: [{ ...newDraft(), source_claim_ids: ['policy_00000001'] }] } : {}) }) }); });
    try {
      const base = inboxMessage(); const store = new InboxStore(fixture.knowledge.context());
      await store.acceptPulled(base);
      await store.acceptPulled(InboxMessageSchema.parse({ ...base, id: 'inbox_00000002', policy: { ...base.policy, status: 'deprecated', updated_at: '2026-01-03T00:00:00Z' } }));
      await store.acceptPulled(InboxMessageSchema.parse({ ...arbitrationMessage(), id: 'inbox_00000003', policy: { ...base.policy, id: 'policy_00000002', message_type: 'claim_attribute_update', created_at: '2026-01-04T00:00:00Z' } }));
      const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); await jobs.start(); const job = await fixture.inbox.enqueue(); await waitJob(jobs.queue, job.id);
      expect(calls).toBe(2); expect(z.object({ local_claims: z.array(z.unknown()) }).parse(JSON.parse(observed[1] ?? '{}') as unknown).local_claims).toEqual([]);
      expect((await fixture.knowledge.snapshot()).claims[0]?.status).toBe('deprecated'); expect(await new TraceStore(fixture.knowledge.context()).list()).toHaveLength(2);
    } finally { await fixture.close(); }
  });
  it('business validation consumes the configured budget with the same input and releases pending leases on failure', async () => {
    const inputs: string[] = []; const fixture = await inboxFixture((_route, _system, input) => { inputs.push(input); return Promise.resolve({ text: JSON.stringify({ ...emptyInternalize(), updated_claims: [{ ...newDraft(), id: 'claim_ffffffff', status: 'active' }] }) }); }, { llm: { structuredRetries: 2 } });
    try {
      const store = new InboxStore(fixture.knowledge.context()); await store.acceptPulled(inboxMessage()); const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.');
      await jobs.start(); const job = await fixture.inbox.enqueue(); await waitJob(jobs.queue, job.id, 'failed');
      expect(inputs).toHaveLength(2); expect(inputs[0]).toBe(inputs[1]); expect(await store.listPending()).toHaveLength(1);
      expect(await new ClaimStore(fixture.knowledge.context()).list()).toEqual([]); await expect(fs.access(fixture.knowledge.context().paths.inboxEffect('inbox_00000001'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fixture.close(); }
  });
  it('uses the persisted global route without reading Memory, USER or transcript', async () => {
    let called = false;
    const fixture = await inboxFixture((route, _system, input) => { called = true; expect(route).toEqual({ provider: 'remembered', model: 'example' }); expect(input).not.toContain('PRIVATE_MARKER'); return Promise.resolve({ text: JSON.stringify(emptyInternalize()) }); }, { llm: { provider: '', model: '' } });
    try {
      const context = fixture.knowledge.context(); await fs.mkdir(join(context.paths.root, 'memories'), { recursive: true }); await fs.writeFile(join(context.paths.root, 'memories', 'MEMORY.md'), 'PRIVATE_MARKER'); await fs.writeFile(join(context.paths.root, 'memories', 'USER.md'), 'PRIVATE_MARKER');
      await writeYamlAtomic(context.paths.lastRoute, { provider: 'remembered', model: 'example' }, RouteSchema, context.logger);
      await new InboxStore(context).acceptPulled(inboxMessage()); const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); await jobs.start(); const job = await fixture.inbox.enqueue(); await waitJob(jobs.queue, job.id); expect(called).toBe(true);
    } finally { await fixture.close(); }
  });
  it('awaits the knowledge lock for local apply while keeping it free during the model call', async () => {
    const fixture = await inboxFixture(async () => { await withFileLock(fixture.knowledge.context().paths.knowledgeLock, async () => {} , { timeoutMs: 0 }); return { text: JSON.stringify({ ...emptyInternalize(), new_claims: [newDraft()] }) }; });
    try {
      await new InboxStore(fixture.knowledge.context()).acceptPulled(inboxMessage()); const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); await jobs.start(); const job = await fixture.inbox.enqueue(); await waitJob(jobs.queue, job.id); expect((await fixture.knowledge.snapshot()).claims).toHaveLength(1);
    } finally { await fixture.close(); }
  });
  it('single mode uses zero HTTP calls, creates no upload queue and never records local Disputes as reported', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); const transport = vi.spyOn(TeamHttp.prototype, 'post'); const local = sampleClaim();
    const fixture = await inboxFixture(() => Promise.resolve({ text: JSON.stringify({ ...emptyInternalize(), new_claims: [newDraft()], new_disputes: [{ id: '$new_dispute_0$', name: 'scope_conflict', summary: 'Incompatible evidence.', claims: [local.id, '$new_claim_0$'] }] }) }));
    try {
      const context = fixture.knowledge.context(); await new ClaimStore(context).write(local); await new InboxStore(context).acceptPulled(inboxMessage()); const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); await jobs.start(); const job = await fixture.inbox.enqueue(); await waitJob(jobs.queue, job.id);
      expect(fetch).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled(); expect(await new DisputeStore(context).list()).toHaveLength(1); expect((await new ReportedSetStore(context).read()).reported_claim_sets).toEqual({}); await expect(fs.access(context.paths.uploads)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { fetch.mockRestore(); transport.mockRestore(); await fixture.close(); }
  });
  it('defers Inbox without consuming messages while a Dream commit needs recovery', async () => {
    const fixture = await inboxFixture();
    try {
      const context = fixture.knowledge.context(); await new InboxStore(context).acceptPulled(inboxMessage()); await fs.mkdir(join(context.paths.root, 'runtime', 'supervisor'), { recursive: true }); await fs.writeFile(join(context.paths.root, 'runtime', 'supervisor', 'dream_pending.yaml'), '{}');
      const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); await jobs.start(); const job = await fixture.inbox.enqueue();
      await vi.waitFor(async () => { const current = await jobs.queue.read(job.id); expect(current?.state).toBe('queued'); expect(current?.attempts).toBe(0); expect(fixture.warnings.length).toBeGreaterThan(0); }); expect(await new InboxStore(context).listPending()).toHaveLength(1);
    } finally { await fixture.close(); }
  });
  it('supports removing only the Inbox handler while other durable job kinds remain registered', async () => {
    const fixture = await inboxFixture();
    try {
      await fixture.inbox.close(); const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); jobs.register('recap', () => Promise.resolve({ ok: true })); await jobs.start();
      const inbox = new AcnInbox(fixture.knowledge, () => Promise.resolve({ text: JSON.stringify(emptyInternalize()) }), () => ''); await inbox.close(); const job = await jobs.enqueue('recap', {}); expect((await waitJob(jobs.queue, job.id)).result).toEqual({ ok: true });
    } finally { await fixture.close(); }
  });
});
