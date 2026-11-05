// 此套件必须面对真实团队服务；结构校验和 holder/receipt 边界不使用 HTTP stub。
import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { TeamFacade } from '../../src/team/service.js';
import { resolveConfig } from '../../src/config.js';
import { ClaimIdSchema, AgentIdSchema } from '../../src/protocol/ids.js';
import { DisputeSchema } from '../../src/protocol/dispute.js';
import { PolicySchema } from '../../src/protocol/policy.js';
import { ClaimStore } from '../../src/store/claims.js';
import { UploadStore } from '../../src/store/uploads.js';
import { InboxStore } from '../../src/store/inbox.js';
import { ReportedSetStore } from '../../src/store/reported-sets.js';
import { UploadDelivery } from '../../src/upload/deliver.js';
import { UploadScheduler } from '../../src/upload/scheduler.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { inboxFixture, teamServer } from '../team/helpers.js';
import { newDraft, waitJob } from '../formation/helpers.js';
import { dreamFixture, phaseBackend } from '../dream/helpers.js';
import type { Claim } from '../../src/protocol/claim.js';
import { ClaimSchema } from '../../src/protocol/claim.js';
import { InboxMessageSchema } from '../../src/protocol/inbox.js';
import { TraceStore } from '../../src/store/traces.js';
import { DisputeStore } from '../../src/store/disputes.js';
import { candidate, reviewSummary } from '../dream/helpers.js';
import { calibrationDraft, calibrationReviews, evidenceFixture, material } from '../dream/evidence-helpers.js';
import type { Receipts } from '../../src/dream/evidence.js';
import type { Validation } from '../../src/dream/schema.js';

const routerEndpoint = process.env['ACN_CONTRACT_ROUTER']; const maintainerEndpoint = process.env['ACN_CONTRACT_MAINTAINER'];
if (!routerEndpoint || !maintainerEndpoint || !process.env['ACN_TEST_TEAM_CREDENTIAL']) throw new Error('Run through scripts/contract-up.sh.');
const config = resolveConfig({ team: { routerEndpoint, maintainerEndpoint, keyEnv: 'ACN_TEST_TEAM_CREDENTIAL', retryCount: 0, timeoutMs: 2000 } });
async function admin(path: string, data?: unknown): Promise<unknown> {
  const password = process.env['ACN_TEST_ADMIN_CREDENTIAL']; if (!password) throw new Error('No admin credential.');
  const response = await fetch(`${maintainerEndpoint}${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`user:${password}`).toString('base64')}` }, ...data === undefined ? {} : { body: JSON.stringify(data) } });
  if (!response.ok) throw new Error(`Admin contract request failed: ${response.status}.`);
  return response.status === 204 ? undefined : response.json();
}
describe('ACN 0.3.3 live contract', () => {
  it('delivers frozen arbitration to both holders, separates receipt from internalization, and reuploads each own revision once', async () => {
    const input = [
      sampleClaim({ id: ClaimIdSchema.parse('claim_00000040'), scope: 'contract/arbitration', created_at: new Date().toISOString() }),
      sampleClaim({ id: ClaimIdSchema.parse('claim_00000041'), holder: AgentIdSchema.parse('agent-b'), scope: 'contract/arbitration', created_at: new Date().toISOString() }),
    ];
    const calls = [0, 0];
    const fixtures = await Promise.all(input.map((claim, index) => inboxFixture((_route, _system, text) => {
      calls[index] = (calls[index] ?? 0) + 1;
      const request = z.object({ local_claims: z.array(ClaimSchema), claim_attribute_updates: z.array(z.object({ claim_attribute_update: InboxMessageSchema })) }).parse(JSON.parse(text) as unknown);
      expect(request.local_claims.map((item) => item.id)).toEqual([claim.id]);
      const message = request.claim_attribute_updates[0]?.claim_attribute_update;
      if (message?.message_type !== 'claim_attribute_update' || !message.arbitration_resolution) throw new Error('Missing frozen resolution.');
      expect(message.arbitration_resolution.direct_claim_snapshots.map((item) => item.id).sort()).toEqual(input.map((item) => item.id));
      const draft = ClaimSchema.omit({ holder: true, created_at: true, updated_at: true }).parse(claim);
      return Promise.resolve({ text: JSON.stringify({ new_claims: [], updated_claims: [{ ...draft, status: index === 0 ? 'deprecated' : 'active', statement: 'Use the current bounded contract.', source_claim_ids: [message.policy.id] }], new_disputes: [] }) });
    }, { ...config, agentId: claim.holder, llm: { provider: 'mock', model: 'mock' }, team: { ...config.team, keyEnv: index === 0 ? 'ACN_TEST_TEAM_CREDENTIAL' : 'ACN_TEST_OTHER_CREDENTIAL' } })));
    try {
      for (const [index, f] of fixtures.entries()) {
        const claim = input[index]; if (!claim || !f.knowledge.team) throw new Error('Missing holder fixture.');
        await new ClaimStore(f.knowledge.context()).write(claim); await new UploadStore(f.knowledge.context()).enqueue([claim], [], true);
        expect((await new UploadDelivery(f.knowledge.context(), f.knowledge.team).deliver()).deliveredClaims).toBe(1);
      }
      const first = fixtures[0]; if (!first?.knowledge.team) throw new Error('Missing reporter.');
      const dispute = DisputeSchema.parse({ id: 'dispute_00000040', name: 'bounded_contract_conflict', claims: input.map((c) => c.id), summary: 'Retire an obsolete contract after checking both versions.', reporter_agent_id: 'agent-a', status: 'open', created_at: new Date().toISOString() });
      await first.knowledge.team.maintainer.report(dispute);
      await admin(`/disputes/${dispute.id}/resolve`, { resolve_note: 'The checked current contract supersedes the earlier rule.', notify_affected_agents: true, resolution_type: 'lifecycle_update', resolution_basis: 'direct_analysis', claim_assessments: input.map((c, index) => ({ claim_id: c.id, recommended_status: index === 0 ? 'deprecated' : 'active', assessment: 'Checked direct evidence.', reason: 'Use the current bounded contract.' })) });
      for (const [index, f] of fixtures.entries()) {
        const own = input[index]; if (!own || !f.knowledge.team) throw new Error('Missing holder.');
        // 服务只发建议；ACK 前后都不能绕过模型直接改变本地知识。
        expect((await new ClaimStore(f.knowledge.context()).read(own.id)).status).toBe('active');
        const pulled = await f.knowledge.team.maintainer.pull(); expect(pulled).toHaveLength(1);
        expect(pulled[0]).toMatchObject({ message_type: 'claim_attribute_update', arbitration_resolution: { dispute_id: dispute.id, resolved_by: 'human' } });
      }
      const requests = await Promise.all(fixtures.map((f) => f.inbox.request()));
      expect(calls).toEqual([0, 0]);
      for (const [index, f] of fixtures.entries()) {
        expect(requests[index]).toMatchObject({ accepted: 1, acknowledged: 1 });
        expect(await f.knowledge.team?.maintainer.pull()).toEqual([]);
        expect((await new ClaimStore(f.knowledge.context()).list())[0]?.status).toBe('active');
      }
      await Promise.all(fixtures.map(async (f, index) => {
        const worker = f.knowledge.jobs; const job = requests[index]; if (!worker || !job) throw new Error('Missing internalization.');
        await worker.start(); expect((await waitJob(worker.queue, job.jobId)).result).toMatchObject({ handled: 1, applied: 1, uploadedClaims: 1 });
        const local = await new ClaimStore(f.knowledge.context()).list(); expect(local).toHaveLength(1); expect(local[0]?.holder).toBe(input[index]?.holder);
        expect(local[0]?.status).toBe(index === 0 ? 'deprecated' : 'active'); expect(local[0]?.source_claim_ids[0]).toMatch(/^policy_/);
        await waitJob(worker.queue, (await f.inbox.enqueue()).id);
        expect(await new TraceStore(f.knowledge.context()).list()).toHaveLength(1); expect(await new DisputeStore(f.knowledge.context()).list()).toEqual([]);
        expect((await new UploadStore(f.knowledge.context()).read()).claims).toEqual([]);
      }));
      expect(calls).toEqual([1, 1]);
      await vi.waitFor(async () => {
        const result = await first.knowledge.team?.router.query({ scope: 'contract/arbitration', semantic_query: null });
        expect(result?.candidate_claims.some((c) => c.id === input[0]?.id)).toBe(false);
        expect(result?.candidate_claims.find((c) => c.id === input[1]?.id)?.statement).toBe('Use the current bounded contract.');
      }, { timeout: 5000 });
    } finally { await Promise.all(fixtures.map((f) => f.close())); }
  });
  it('uploads a calibrated Claim through the real Maintainer and retrieves the exact revised confidence from Router', async () => {
    const input = [sampleClaim({ id: ClaimIdSchema.parse('claim_00000030'), confidence: 'low', scope: 'evidence/example', created_at: new Date().toISOString() })];
    const f = await evidenceFixture({ input, config: { ...config, llm: { provider: 'mock', model: 'mock' }, dream: { ...config.dream, evidenceCalibration: true } }, backend: (_route, _system, text) => { const request = JSON.parse(text) as { phase: string; evidence: Receipts; validation: Validation }; const response = request.phase === 'candidates' ? { review: reviewSummary, candidates: [candidate(input, 'evidence')], sync_candidates: [] } : request.phase === 'draft' ? { action: 'stage', group: calibrationDraft(input, request.evidence) } : { decision: 'apply', reason: 'Versioned direct material supports the bounded claim.', reason_kind: 'useful_knowledge', ...calibrationReviews(request.validation) }; return Promise.resolve({ text: JSON.stringify(response) }); }, explore: async ({ store, claims, signal }) => { await store.execute('read', { path: 'source.txt', claim_ids: claims.map((claim) => claim.id) }, claims, signal); } });
    try {
      await f.start(); const job = await f.dream.request(f.workspace); await waitJob(f.worker.queue, job.id); const team = f.knowledge.team; if (!team) throw new Error('Missing real team.');
      expect((await new UploadStore(f.knowledge.context()).read()).claims).toEqual([]);
      await vi.waitFor(async () => { const result = await team.router.query({ scope: 'evidence/example', semantic_query: null }); expect(result.candidate_claims.find((claim) => claim.id === input[0]?.id)).toMatchObject({ statement: material, confidence: 'high' }); }, { timeout: 5000 });
    } finally { await f.close(); }
  });
  it('Dream delivers current information carriers before retirements through the real Maintainer and Router', async () => {
    let failCarrier = true; const delivered: { id: string; status: string; http: number }[] = [];
    const proxy = await teamServer(async (request) => {
      const claim = (request.body as { data: Claim }).data;
      if (request.path === '/claims/upload' && claim.status !== 'deprecated' && failCarrier) return { status: 503 };
      const response = await fetch(`${maintainerEndpoint}${request.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) });
      delivered.push({ id: claim.id, status: claim.status, http: response.status }); return { status: response.status, raw: await response.text() };
    });
    const input = [20, 21].map((index) => sampleClaim({ id: ClaimIdSchema.parse(`claim_${String(index).padStart(8, '0')}`), name: `example_condition_${index}`, statement: `Preserve contract condition ${index} for safe retries.`, scope: 'dream/example', created_at: new Date().toISOString() }));
    const f = await dreamFixture(phaseBackend(input, 'consolidation'), { ...config, llm: { provider: 'mock', model: 'mock' }, team: { ...config.team, maintainerEndpoint: proxy.endpoint } }, input);
    try {
      await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id); const queue = new UploadStore(f.knowledge.context()); expect((await queue.read()).claims).toHaveLength(2); expect(delivered).toEqual([]);
      failCarrier = false; expect((await new UploadDelivery(f.knowledge.context(), f.knowledge.team).deliver()).pendingClaims).toBe(0); expect(delivered).toEqual([{ id: input[0]?.id, status: 'active', http: 200 }, { id: input[1]?.id, status: 'deprecated', http: 200 }]);
      const team = f.knowledge.team; if (!team) throw new Error('Missing team.');
      await vi.waitFor(async () => { const result = await team.router.query({ scope: 'dream/example', semantic_query: null }); const carriers = result.candidate_claims.filter((claim) => input.some((source) => source.id === claim.id)); expect(carriers.map((claim) => claim.id)).toEqual([input[0]?.id]); expect(carriers[0]?.statement).toContain('condition 20'); expect(carriers[0]?.statement).toContain('condition 21'); }, { timeout: 5000 });
      expect((await queue.read()).consolidations).toBeUndefined(); expect((await f.knowledge.dreamStore().state()).last_success_at).not.toBeNull();
    } finally { await f.close(); await proxy.close(); }
  });
  it('health, upload, Router query, policy pull/ACK, internalize/re-upload, withdrawal and Dispute form a real end-to-end flow', async () => {
    let policyId = '';
    const fixture = await inboxFixture(() => Promise.resolve({ text: JSON.stringify({ new_claims: [{ ...newDraft(), source_claim_ids: [policyId] }], updated_claims: [], new_disputes: [] }) }), { ...config, llm: { provider: 'mock', model: 'mock' } });
    const team = fixture.knowledge.team; const jobs = fixture.knowledge.jobs;
    if (team === null || jobs === null) throw new Error('No team services.');
    try {
      await team.health(); expect(team.status()).toMatchObject({ router: { state: 'ok' }, maintainer: { state: 'ok' } });
      const claim = sampleClaim({ created_at: new Date().toISOString() }); const other = sampleClaim({ id: ClaimIdSchema.parse('claim_00000002'), holder: AgentIdSchema.parse('agent-b'), statement: 'A second checked example.', created_at: new Date().toISOString() });
      await new ClaimStore(fixture.knowledge.context()).write(claim);
      await new UploadStore(fixture.knowledge.context()).enqueue([claim], [], true);
      const delivered = await new UploadDelivery(fixture.knowledge.context(), team).deliver(); expect(delivered.deliveredClaims).toBe(1);
      const uploaderB = new TeamFacade({ ...config.team, keyEnv: 'ACN_TEST_OTHER_CREDENTIAL' }, AgentIdSchema.parse('agent-b'), { warn() {}, debug() {} });
      try { await uploaderB.maintainer.upload(other); } finally { await uploaderB.close(); }
      let candidates: Awaited<ReturnType<typeof team.router.query>>['candidate_claims'] = [];
      for (let attempt = 0; attempt < 60; attempt += 1) { candidates = (await team.router.query({ scope: 'example/scope', semantic_query: null })).candidate_claims.filter((item) => item.id === claim.id || item.id === other.id); if (candidates.length === 2) break; await delay(100); }
      expect(candidates.map((item) => item.id).sort()).toEqual([claim.id, other.id]);
      expect((await team.router.overview()).scopes.some((item) => item.scope === claim.scope)).toBe(true);
      const policy = PolicySchema.parse(await admin('/policies/policy-update', { name: 'bounded_retry', statement: 'Use bounded retries for idempotent requests.', scope: 'service / retries', target_agents: ['agent-a'] })); policyId = policy.id;
      const messages = await team.maintainer.pull(); expect(messages.some((message) => message.policy.id === policy.id)).toBe(true);
      const otherHolder = new TeamFacade({ ...config.team, keyEnv: 'ACN_TEST_OTHER_CREDENTIAL' }, AgentIdSchema.parse('agent-b'), { warn() {}, debug() {} });
      try { await expect(otherHolder.maintainer.ack(messages.map((message) => message.id))).rejects.toMatchObject({ kind: 'client', status: 403 }); }
      finally { await otherHolder.close(); }
      await jobs.start(); const requested = await fixture.inbox.request(); expect(requested.accepted).toBeGreaterThan(0); expect(requested.acknowledged).toBe(requested.accepted);
      await waitJob(jobs.queue, requested.jobId); expect(await team.maintainer.pull()).toEqual([]); expect(await new InboxStore(fixture.knowledge.context()).listPending()).toEqual([]);
      const internalized = (await fixture.knowledge.snapshot()).claims.find((item) => item.source_claim_ids.includes(policy.id)); expect(internalized).toBeDefined();
      expect((await new UploadStore(fixture.knowledge.context()).read()).claims).toEqual([]);
      const suggestion = PolicySchema.parse(await admin('/policies/claim-update-suggestion', { statement: 'Keep retry budgets scoped to the service.', target_agents: ['agent-a'] })); policyId = suggestion.id;
      const cau = await fixture.inbox.request(); await waitJob(jobs.queue, cau.jobId);
      expect((await fixture.knowledge.snapshot()).claims.some((item) => item.source_claim_ids.includes(suggestion.id))).toBe(true);
      const dispute = DisputeSchema.parse({ id: 'dispute_00000002', name: 'retry_conflict', claims: [claim.id, other.id], summary: 'Two checked retry contracts differ.', reporter_agent_id: 'agent-a', status: 'open', created_at: new Date().toISOString() });
      await new UploadStore(fixture.knowledge.context()).enqueue([], [dispute]);
      expect((await new UploadDelivery(fixture.knowledge.context(), team).deliver()).deliveredDisputes).toBe(1);
      expect(await new ReportedSetStore(fixture.knowledge.context()).contains(dispute.claims)).toBe(true);
      await expect(team.maintainer.report(dispute)).resolves.toBeUndefined();
      await expect(team.maintainer.report({ ...dispute, summary: 'A different payload cannot reuse the same entity ID.' })).rejects.toMatchObject({ kind: 'client', status: 409 });
      const recorded = await admin(`/api/disputes/${dispute.id}`); expect(JSON.stringify(recorded)).toContain(dispute.id);
      await admin('/policies/policy-deprecation', { policy_id: policy.id });
      const withdrawal = await fixture.inbox.request(); await waitJob(jobs.queue, withdrawal.jobId);
      expect((await fixture.knowledge.snapshot()).claims.find((item) => item.id === internalized?.id)?.status).toBe('deprecated');
      expect((await new UploadStore(fixture.knowledge.context()).read()).claims).toEqual([]);
    } finally { await fixture.close(); }
  });
  it('Router rejects unknown identity as auth; Maintainer distinguishes ownership 403 from auth 401', async () => {
    const warnings: string[] = []; const team = new TeamFacade(config.team, AgentIdSchema.parse('agent-a'), { debug() {}, warn: (text) => { warnings.push(text); } });
    const invalid = randomBytes(32).toString('hex'); process.env['ACN_TEST_INVALID_CREDENTIAL'] = invalid;
    const bad = new TeamFacade({ ...config.team, keyEnv: 'ACN_TEST_INVALID_CREDENTIAL' }, AgentIdSchema.parse('agent-a'), { debug() {}, warn: (text) => { warnings.push(text); } });
    try {
      await expect(team.maintainer.upload(sampleClaim({ holder: AgentIdSchema.parse('agent-b') }))).rejects.toMatchObject({ kind: 'client', status: 403 });
      await expect(bad.request('router', () => bad.router.overview())).rejects.toMatchObject({ kind: 'auth', status: 401 });
      await expect(bad.request('maintainer', () => bad.maintainer.pull())).rejects.toMatchObject({ kind: 'auth', status: 401 });
      expect(warnings).toHaveLength(1); expect(warnings.join('\n')).not.toContain(invalid);
      const wrongIdentity = new TeamFacade(config.team, AgentIdSchema.parse('agent-b'), { warn() {}, debug() {} });
      try { await expect(wrongIdentity.router.overview()).rejects.toMatchObject({ kind: 'auth', status: 401 }); } finally { await wrongIdentity.close(); }
    } finally { delete process.env['ACN_TEST_INVALID_CREDENTIAL']; await team.close(); await bad.close(); }
  });
  it('retains the queue through injected HTTP 500 and listener loss, then automatically delivers to the real Maintainer', async () => {
    let failure = true;
    const forward = async (request: { path: string; body: unknown }) => {
      if (failure) return { status: 500 };
      const response = await fetch(`${maintainerEndpoint}${request.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) });
      return { status: response.status, raw: await response.text() };
    };
    let proxy = await teamServer(forward); const endpoint = proxy.endpoint; const port = Number(new URL(endpoint).port);
    const fixture = await inboxFixture(undefined, { ...config, team: { ...config.team, maintainerEndpoint: endpoint } }); const scheduler = new UploadScheduler(fixture.knowledge, 20);
    try {
      const queue = new UploadStore(fixture.knowledge.context()); const claim = sampleClaim({ id: ClaimIdSchema.parse('claim_00000003'), created_at: new Date().toISOString() }); await new ClaimStore(fixture.knowledge.context()).write(claim); await queue.enqueue([claim], [], true);
      scheduler.start(); await scheduler.flush(); expect((await queue.read()).claims).toHaveLength(1);
      await proxy.close(); scheduler.kick(); await scheduler.flush(); expect((await queue.read()).claims).toHaveLength(1);
      failure = false; proxy = await teamServer(forward, port);
      await vi.waitFor(async () => { expect((await queue.read()).claims).toEqual([]); });
      const team = fixture.knowledge.team; if (team === null) throw new Error('No team.');
      await vi.waitFor(async () => { expect((await team.router.query({ scope: claim.scope, semantic_query: null })).candidate_claims.some((item) => item.id === claim.id)).toBe(true); }, { timeout: 5000 });
    } finally { await scheduler.close(); await fixture.close(); await proxy.close(); }
  });
});
