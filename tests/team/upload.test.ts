// 投递使用真实 HTTP 与本地锁验证故障保留、精确版本清理、去重和空闲恢复。
import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { UploadDelivery } from '../../src/upload/deliver.js';
import { UploadScheduler } from '../../src/upload/scheduler.js';
import { UploadStore } from '../../src/store/uploads.js';
import { ClaimStore } from '../../src/store/claims.js';
import { AcnKnowledge } from '../../src/knowledge/service.js';
import { resolveConfig } from '../../src/config.js';
import { ReportedSetStore } from '../../src/store/reported-sets.js';
import { RejectedDisputeStore } from '../../src/store/rejected-disputes.js';
import { withFileLock } from '../../src/store/lock.js';
import { ClaimIdSchema, PolicyIdSchema } from '../../src/protocol/ids.js';
import { DisputeSchema } from '../../src/protocol/dispute.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { inboxFixture, teamServer } from './helpers.js';

const claim = sampleClaim(); const other = sampleClaim({ id: ClaimIdSchema.parse('claim_00000002') });
const dispute = (id = 'dispute_00000001') => DisputeSchema.parse({ id, name: 'retry_conflict', claims: [claim.id, other.id], summary: 'Different service evidence.', reporter_agent_id: 'agent-a', status: 'open', created_at: '2026-01-02T00:00:00Z' });
describe('upload delivery', () => {
  it('reports an existing-mirror Dispute even while its Claim update endpoint is failing', async () => {
    const server = await teamServer((request) => ({ status: request.path === '/claims/upload' ? 503 : 200 }));
    const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); for (const value of [claim, other]) await new ClaimStore(context).write(value);
      const queue = new UploadStore(context); await queue.enqueue([claim], [dispute()], true);
      expect(await new UploadDelivery(context, fixture.knowledge.team).deliver()).toMatchObject({ deliveredClaims: 0, deliveredDisputes: 1, pendingClaims: 1, pendingDisputes: 0 });
      expect(server.requests.map((request) => request.path)).toEqual(['/claims/upload', '/disputes/report']);
      expect(await new ReportedSetStore(context).contains(dispute().claims)).toBe(true);
    } finally { await fixture.close(); await server.close(); }
  });
  it('persists a 409 before queue removal and leaves a different report eligible', async () => {
    const server = await teamServer(() => ({ status: 409 }));
    const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = f.knowledge.context(); const queue = new UploadStore(context); const rejected = dispute();
      await queue.enqueue([], [rejected]);
      const spy = vi.spyOn(UploadStore.prototype, 'removeDeliveredDisputes').mockRejectedValueOnce(new Error('Interrupted after rejection.'));
      try { await expect(new UploadDelivery(context, f.knowledge.team).deliver()).rejects.toThrow('Interrupted'); } finally { spy.mockRestore(); }
      expect(await new RejectedDisputeStore(context).contains(rejected)).toBe(true);
      await new UploadDelivery(context, f.knowledge.team).deliver(); expect((await queue.read()).disputes).toEqual([]); expect(server.requests).toHaveLength(1);
      await queue.enqueue([], [rejected]); expect((await queue.read()).disputes).toEqual([]);
      const fresh = dispute('dispute_00000002'); await queue.enqueue([], [fresh]); expect((await queue.read()).disputes).toEqual([fresh]);
      const revised = { ...rejected, summary: 'New independently confirmed conflict.' }; expect(await new RejectedDisputeStore(context).contains(revised)).toBe(false);
    } finally { await f.close(); await server.close(); }
  });
  it('logs the Dispute identity when automatic delivery terminates a 409', async () => {
    const server = await teamServer(() => ({ status: 409 }));
    const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    const scheduler = new UploadScheduler(f.knowledge);
    try {
      await new UploadStore(f.knowledge.context()).enqueue([], [dispute()]); scheduler.start(); await scheduler.flush();
      expect(f.warnings.some((warning) => warning.includes(dispute().id) && warning.includes('已停止自动重试'))).toBe(true);
    } finally { await scheduler.close(); await f.close(); await server.close(); }
  });
  it('stops retrying a terminal Dispute 409 without blocking other disputes or marking it delivered', async () => {
    const rejected = dispute(); const accepted = { ...dispute('dispute_00000002'), claims: [ClaimIdSchema.parse('claim_00000003'), ClaimIdSchema.parse('claim_00000004')] };
    const server = await teamServer((request) => ({ status: request.path === '/disputes/report' && JSON.stringify(request.body).includes(rejected.id) ? 409 : 200 }));
    const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = f.knowledge.context(); const queue = new UploadStore(context); const delivery = new UploadDelivery(context, f.knowledge.team);
      await queue.enqueue([], [rejected, accepted], true);
      const result = await delivery.deliver(); expect(result).toMatchObject({ deliveredDisputes: 1, pendingDisputes: 0 }); expect(result.warnings.join('')).toContain('已停止自动重试');
      expect(await new ReportedSetStore(context).contains(rejected.claims)).toBe(false); expect(await new ReportedSetStore(context).contains(accepted.claims)).toBe(true);
      await delivery.deliver(); expect(server.requests).toHaveLength(2);
    } finally { await f.close(); await server.close(); }
  });
  it('blocks stale team versions after solo edits but reports disputes without uploading private changes', async () => {
    const server = await teamServer(() => ({}));
    const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); const queue = new UploadStore(context);
      await new ClaimStore(context).write(claim); await queue.enqueue([claim], [dispute()], true);
      const solo = new AcnKnowledge(resolveConfig({ ...fixture.knowledge.config, team: {} }), fixture.knowledge.logger);
      const before = await solo.readClaim(claim.id);
      await solo.updateClaim({ id: claim.id, expected_revision: before.revision, status: 'deprecated' });
      await new ClaimStore(solo.context()).write(other);
      expect((await new UploadStore(solo.context()).read()).claims).toEqual([]);
      expect((await queue.read()).claims).toEqual([claim]); expect(server.requests).toEqual([]);
      const result = await new UploadDelivery(context, fixture.knowledge.team).deliver();
      expect(result).toMatchObject({ deliveredClaims: 0, deliveredDisputes: 1, pendingClaims: 1, pendingDisputes: 0 });
      expect(result.warnings.join(' ')).toContain(claim.id); expect(server.requests.map((request) => request.path)).toEqual(['/disputes/report']);
      expect((await queue.read()).claims).toEqual([claim]);
      const current = await fixture.knowledge.readClaim(claim.id);
      const confirmed = await fixture.knowledge.updateClaim({ id: claim.id, expected_revision: current.revision, evidence_summary: 'Team review confirms this claim should be retired.' });
      expect((await new UploadDelivery(context, fixture.knowledge.team).deliver()).deliveredClaims).toBe(1);
      expect(server.requests[1]?.body).toMatchObject({ data: confirmed.claim });
      expect((await queue.read()).claims).toEqual([]);
    } finally { await fixture.close(); await server.close(); }
  });
  it.each([401, 403, 503])('retains claims and dependent Disputes after HTTP %i and delivers after recovery', async (status) => {
    let available = false; const server = await teamServer(() => ({ status: available ? 200 : status }));
    const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); const store = new UploadStore(context); const delivery = new UploadDelivery(context, fixture.knowledge.team);
      for (const value of [claim, other]) await new ClaimStore(context).write(value);
      await store.enqueue([claim, other], [dispute()], true); expect((await delivery.deliver()).pendingClaims).toBe(2); expect((await store.read()).disputes).toHaveLength(1); expect(await new ReportedSetStore(context).contains(dispute().claims)).toBe(false);
      available = true; const result = await delivery.deliver(); expect(result).toMatchObject({ deliveredClaims: 2, deliveredDisputes: 1, pendingClaims: 0, pendingDisputes: 0 }); await expect(fs.access(context.paths.pendingUploads)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(server.requests.filter((item) => item.path === '/disputes/report')).toHaveLength(2);
    } finally { await fixture.close(); await server.close(); }
  });
  it('a service recovers during the idle timer and the existing durable queue is delivered automatically', async () => {
    let available = false; const server = await teamServer(() => ({ status: available ? 200 : 503 })); const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } }); const scheduler = new UploadScheduler(fixture.knowledge, 20);
    try {
      const store = new UploadStore(fixture.knowledge.context()); await new ClaimStore(fixture.knowledge.context()).write(claim); await store.enqueue([claim], [], true); scheduler.start(); await scheduler.flush(); expect((await store.read()).claims).toHaveLength(1);
      available = true; await vi.waitFor(async () => { expect((await store.read()).claims).toEqual([]); });
    } finally { await scheduler.close(); await fixture.close(); await server.close(); }
  });
  it('keeps data through connection refusal and automatically reconnects when the listener restarts', async () => {
    const first = await teamServer(() => ({})); const endpoint = first.endpoint; const port = Number(new URL(endpoint).port); await first.close();
    const fixture = await inboxFixture(undefined, { team: { routerEndpoint: endpoint, maintainerEndpoint: endpoint, retryCount: 0, timeoutMs: 100 } }); const scheduler = new UploadScheduler(fixture.knowledge, 20); let resumed: Awaited<ReturnType<typeof teamServer>> | undefined;
    try {
      const store = new UploadStore(fixture.knowledge.context()); await new ClaimStore(fixture.knowledge.context()).write(claim); await store.enqueue([claim], [dispute()], true); scheduler.start(); await scheduler.flush(); expect((await store.read()).claims).toHaveLength(1);
      resumed = await teamServer(() => ({}), port); await vi.waitFor(async () => { expect((await store.read()).claims).toEqual([]); expect((await store.read()).disputes).toEqual([]); }); expect(resumed.requests.map((request) => request.path)).toEqual(['/claims/upload', '/disputes/report']);
    } finally { await scheduler.close(); await resumed?.close(); await fixture.close(); }
  });
  it('keeps a newer revision queued during delivery and never holds knowledge/pending locks during HTTP', async () => {
    let release: (() => void) | undefined; const gate = new Promise<void>((resolve) => { release = resolve; }); let received = false;
    const server = await teamServer(async () => { received = true; await gate; return {}; }); const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); const queue = new UploadStore(context); await new ClaimStore(context).write(claim); await queue.enqueue([claim], [], true);
      const delivery = new UploadDelivery(context, fixture.knowledge.team); const pending = delivery.deliver(); await vi.waitFor(() => { expect(received).toBe(true); });
      await withFileLock(context.paths.knowledgeLock, async () => {}, { timeoutMs: 0 }); const newer = { ...claim, statement: 'Newer committed evidence.', updated_at: '2026-01-03T00:00:00Z' }; await new ClaimStore(context).write(newer); await queue.enqueue([newer], [], true);
      const concurrent = await new UploadDelivery(context, fixture.knowledge.team).deliver(); expect(concurrent.deliveredClaims).toBe(0); expect(server.requests).toHaveLength(1);
      release?.(); expect((await pending).pendingClaims).toBe(1); expect((await queue.read()).claims).toEqual([newer]);
      expect((await delivery.deliver()).pendingClaims).toBe(0); expect(server.requests).toHaveLength(2);
    } finally { release?.(); await fixture.close(); await server.close(); }
  });
  it('deduplicates the unordered Claim set after success and preserves its first report', async () => {
    const server = await teamServer(() => ({})); const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); const queue = new UploadStore(context); const first = dispute(); const duplicate = { ...dispute('dispute_00000002'), claims: [...first.claims].reverse() };
      await queue.enqueue([], [first, duplicate]); await new UploadDelivery(context, fixture.knowledge.team).deliver(); expect(server.requests.filter((item) => item.path === '/disputes/report')).toHaveLength(1);
      const ledger = await new ReportedSetStore(context).read(); expect(Object.values(ledger.reported_claim_sets)[0]?.first_dispute_id).toBe(first.id); expect((await queue.read()).disputes).toEqual([]);
      await queue.enqueue([], [duplicate]); await new UploadDelivery(context, fixture.knowledge.team).deliver(); expect(server.requests).toHaveLength(1);
    } finally { await fixture.close(); await server.close(); }
  });
  it('replays the same Dispute ID after a failed ledger commit and drains without another report after a failed queue removal', async () => {
    const server = await teamServer(() => ({})); const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); const queue = new UploadStore(context); await queue.enqueue([], [dispute()]);
      const original = fs.rename.bind(fs); let failed = false;
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => { if (String(target) === context.paths.reportedSets && !failed) { failed = true; throw new Error('Ledger storage failed.'); } await original(source, target); });
      await expect(new UploadDelivery(context, fixture.knowledge.team).deliver()).rejects.toThrow(); spy.mockRestore(); expect((await queue.read()).disputes).toHaveLength(1);
      const remove = vi.spyOn(UploadStore.prototype, 'removeDeliveredDisputes').mockRejectedValueOnce(new Error('Queue cleanup failed.'));
      await expect(new UploadDelivery(context, fixture.knowledge.team).deliver()).rejects.toThrow(); remove.mockRestore(); expect(server.requests).toHaveLength(2); expect(server.requests[0]?.body).toEqual(server.requests[1]?.body);
      await new UploadDelivery(context, fixture.knowledge.team).deliver(); expect(server.requests).toHaveLength(2); expect((await queue.read()).disputes).toEqual([]);
    } finally { vi.restoreAllMocks(); await fixture.close(); await server.close(); }
  });
  it('withdrawal removes obsolete carrier dependencies while retaining ordinary durable edits and delivering retirements', async () => {
    const server = await teamServer(() => ({})); const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); const queue = new UploadStore(context); const policy = PolicyIdSchema.parse('policy_00000001'); const before = { ...claim, source_claim_ids: [policy] }; const retired = { ...before, status: 'deprecated' as const, updated_at: '2026-01-03T00:00:00Z' };
      const carrier = { ...other, source_claim_ids: [claim.id] }; const ordinary = sampleClaim({ id: ClaimIdSchema.parse('claim_00000003') });
      for (const value of [retired, carrier, ordinary]) await new ClaimStore(context).write(value);
      await queue.save({ claims: [retired, carrier, ordinary], disputes: [], durable_claim_ids: [ordinary.id], consolidations: [{ before, retired, carriers: [carrier] }] });
      await queue.withdrawPolicy(policy); expect((await queue.read()).consolidations).toBeUndefined(); expect((await queue.read()).claims.map((value) => value.id)).toEqual([retired.id, ordinary.id]);
      expect((await new UploadDelivery(context, fixture.knowledge.team).deliver()).deliveredClaims).toBe(2);
    } finally { await fixture.close(); await server.close(); }
  });
  it('retains retirement dependencies without a current acknowledged carrier and preserves acknowledgement-only data', async () => {
    const server = await teamServer(() => ({})); const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = fixture.knowledge.context(); const queue = new UploadStore(context); const retired = { ...claim, status: 'deprecated' as const };
      await queue.save({ claims: [retired], disputes: [], consolidations: [{ before: claim, retired, carriers: [other] }] }); expect((await new UploadDelivery(context, fixture.knowledge.team).deliver()).deliveredClaims).toBe(0); expect(server.requests).toEqual([]);
      await queue.save({ claims: [], disputes: [], acknowledgements: [claim] }); await expect(fs.access(context.paths.pendingUploads)).resolves.toBeUndefined(); expect((await queue.read()).acknowledgements).toEqual([claim]);
    } finally { await fixture.close(); await server.close(); }
  });
});
