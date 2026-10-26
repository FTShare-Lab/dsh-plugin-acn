// 整合依赖按精确正文和递归承接判定；HTTP 故障、版本漂移与重绑均保留未交付弃用。
import { describe, expect, it } from 'vitest';
import { consolidationReady, pruneDeliveries } from '../../src/upload/consolidation.js';
import type { ConsolidationDelivery } from '../../src/upload/consolidation.js';
import { UploadDelivery } from '../../src/upload/deliver.js';
import { UploadStore } from '../../src/store/uploads.js';
import { ClaimStore } from '../../src/store/claims.js';
import { DreamSync } from '../../src/dream/sync.js';
import { SyncValidationSchema } from '../../src/dream/sync.js';
import { valueHash } from '../../src/dream/plan.js';
import { writeYamlAtomic, readYaml } from '../../src/store/yaml.js';
import { join } from 'node:path';
import { z } from 'zod';
import { SourceIdSchema } from '../../src/protocol/ids.js';
import type { Claim } from '../../src/protocol/claim.js';
import type { SemanticReview } from '../../src/dream/schema.js';
import { teamServer, inboxFixture } from '../team/helpers.js';
import { claims, deferred } from './helpers.js';

function chain() {
  const [source, middle, carrier] = claims(3); if (!source || !middle || !carrier) throw new Error('Missing fixture input.');
  middle.evidence_summary += ` ${source.evidence_summary}`; carrier.evidence_summary += ` ${middle.evidence_summary}`;
  const retired = { ...source, status: 'deprecated' as const, updated_at: '2026-01-02T00:00:00Z' }; const middleRetired = { ...middle, status: 'deprecated' as const, updated_at: '2026-01-03T00:00:00Z' };
  const groups: ConsolidationDelivery[] = [{ before: source, retired, carriers: [middle] }, { before: middle, retired: middleRetired, carriers: [carrier] }]; return { source, middle, carrier, retired, middleRetired, groups };
}
function syncReview(before: Claim, carrier: Claim): SemanticReview { return { claims: [{ claim_id: before.id, final_name: before.name, name_reason: 'Retired history keeps its reviewed name.', information_preserved: 'The complete input is represented by the current carrier.', removal_or_correction: 'Only delivery dependency is rebound.', factual_correction: false, output_ids: [carrier.id], evidence_ids: [] }], scope_and_certainty: 'No facts or certainty changed.' }; }
describe('consolidation delivery readiness', () => {
  it('requires current exact carrier acknowledgements and follows only an explicit retirement chain', () => {
    const c = chain(); expect(consolidationReady(c.retired, [c.groups[0] as ConsolidationDelivery], [], [c.retired, c.middle])).toBe(false);
    expect(consolidationReady(c.retired, [c.groups[0] as ConsolidationDelivery], [c.middle], [c.retired, c.middle])).toBe(true);
    expect(consolidationReady(c.retired, [c.groups[0] as ConsolidationDelivery], [c.middle], [c.retired, c.middleRetired])).toBe(false);
    expect(consolidationReady(c.retired, c.groups, [c.carrier], [c.retired, c.middleRetired, c.carrier])).toBe(true);
    expect(consolidationReady(c.retired, c.groups, [{ ...c.carrier, statement: 'Old acknowledgement' }], [c.retired, c.middleRetired, c.carrier])).toBe(false);
  });
  it('rejects dependency cycles, empty carrier sets and implicit replacements', () => {
    const c = chain(); const cycle = [c.groups[0], { before: c.middle, retired: c.middleRetired, carriers: [c.source] }].filter((value): value is ConsolidationDelivery => value !== undefined);
    expect(consolidationReady(c.retired, cycle, [c.middle, c.source], [c.retired, c.middleRetired])).toBe(false);
    expect(consolidationReady(c.retired, [{ before: c.source, retired: c.retired, carriers: [] }], [], [c.retired])).toBe(false);
  });
  it('keeps transitive groups and related latest acknowledgements until all retirements are delivered', () => {
    const c = chain(); const p = pruneDeliveries(c.groups, [c.carrier, ...claims(4).slice(3)], [c.retired]); expect(p.consolidations).toEqual(c.groups); expect(p.acknowledgements).toEqual([c.carrier]); expect(pruneDeliveries(c.groups, [c.carrier], [])).toEqual({ consolidations: [], acknowledgements: [] });
  });
});
describe('consolidation delivery and reviewed rebinding', () => {
  it('blocks an existing team carrier retired by solo consolidation until an explicit reviewed rebind', async () => {
    const c = chain(); const server = await teamServer(() => ({}));
    const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } });
    try {
      const ctx = f.knowledge.context(); const queue = new UploadStore(ctx);
      for (const value of [c.retired, c.middle]) await new ClaimStore(ctx).write(value);
      await queue.enqueue([c.retired, c.middle], [], true, c.groups.slice(0, 1)); const previous = await queue.read();
      const solo = { ...ctx, mode: 'solo' as const };
      for (const value of [c.middleRetired, c.carrier]) await new ClaimStore(solo).write(value);
      await new UploadStore(solo).enqueue([c.middleRetired, c.carrier], [], true, c.groups.slice(1));
      expect(await new UploadDelivery(ctx, f.knowledge.team).deliver()).toMatchObject({ deliveredClaims: 0, pendingClaims: 2 });
      expect(server.requests).toEqual([]); expect(await queue.read()).toEqual(previous);
      const sync = new DreamSync(ctx); const validation = await sync.prepare(c.source.id, [c.carrier.id]);
      await sync.apply('reviewed-solo-carrier', validation, syncReview(c.retired, c.carrier), new AbortController().signal);
      expect(await new UploadDelivery(ctx, f.knowledge.team).deliver()).toMatchObject({ deliveredClaims: 2, pendingClaims: 1 });
      expect(server.requests.map((request) => (request.body as { data: Claim }).data.id)).toEqual([c.carrier.id, c.source.id]);
      expect((await queue.read()).claims).toEqual([c.middle]);
    } finally { await f.close(); await server.close(); }
  });
  it('does not publish an unreviewed solo consolidation by refreshing an older pending source', async () => {
    const c = chain(); const server = await teamServer(() => ({}));
    const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } });
    try {
      const ctx = f.knowledge.context(); const queue = new UploadStore(ctx);
      await new ClaimStore(ctx).write(c.source); await queue.enqueue([c.source], [], true);
      const solo = { ...ctx, mode: 'solo' as const };
      for (const value of [c.retired, c.middle]) await new ClaimStore(solo).write(value);
      await new UploadStore(solo).enqueue([c.retired, c.middle], [], true, c.groups.slice(0, 1));
      expect((await queue.read()).claims).toEqual([c.source]); expect((await queue.read()).consolidations).toBeUndefined();
      expect(await new UploadDelivery(ctx, f.knowledge.team).deliver()).toMatchObject({ deliveredClaims: 0, pendingClaims: 1 });
      expect(server.requests).toEqual([]); expect((await queue.read()).claims).toEqual([c.source]);
    } finally { await f.close(); await server.close(); }
  });
  it('abandons a legacy pending sync authorization whose current carrier lost original evidence', async () => {
    const c = chain(); c.middle.evidence_summary = 'Only the carrier evidence remains; source version limits were omitted.';
    const group = c.groups[0]; if (!group) throw new Error('Missing dependency.'); group.carriers = [c.middle];
    const f = await inboxFixture(undefined, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1' } });
    try {
      const ctx = f.knowledge.context(); for (const claim of [c.retired, c.middle]) await new ClaimStore(ctx).write(claim); const queue = new UploadStore(ctx); await queue.enqueue([c.retired, c.middle], [], true, [group]); const before = await queue.read();
      const input = { before: c.source, carriers: [c.middle], previous_dependency: group, current_source: c.retired }; const validation = SyncValidationSchema.parse({ validation_id: valueHash(input), input }); const path = join(ctx.paths.dreamJob('legacy-sync'), 'sync_reviews', `${validation.validation_id}.yaml`);
      await writeYamlAtomic(path, { validation, review: syncReview(c.retired, c.middle), applied: false }, z.unknown(), ctx.logger);
      expect(await new DreamSync(ctx).resume('legacy-sync', c.source.id, new AbortController().signal)).toBe(false);
      expect(await readYaml(path, z.object({ abandoned: z.boolean() }))).toEqual({ abandoned: true }); expect(await queue.read()).toEqual(before); expect(await new ClaimStore(ctx).list()).toEqual([c.retired, c.middle]);
    } finally { await f.close(); }
  });
  it('refuses a current carrier that lost the source version limit before requesting a sync review', async () => {
    const c = chain(); c.source.evidence_summary += ' The original file version cannot be proved.';
    const group = c.groups[0]; if (!group) throw new Error('Missing dependency.'); group.before = c.source;
    const f = await inboxFixture(undefined, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1' } });
    try {
      const ctx = f.knowledge.context(); for (const claim of [c.retired, c.middle]) await new ClaimStore(ctx).write(claim);
      const queue = new UploadStore(ctx); await queue.enqueue([c.retired, c.middle], [], true, [group]); const before = await queue.read();
      await expect(new DreamSync(ctx).prepare(c.source.id, [c.middle.id])).rejects.toThrow(/原证据摘要/);
      expect(await queue.read()).toEqual(before);
    } finally { await f.close(); }
  });
  it('keeps a concurrent carrier revision queued and blocks retirement after an old HTTP acknowledgement', async () => {
    const c = chain(); const received = deferred(); const release = deferred(); let requests = 0;
    const server = await teamServer(async () => { requests += 1; if (requests === 1) { received.resolve(); await release.promise; } return {}; });
    const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const ctx = f.knowledge.context(); for (const claim of [c.retired, c.middle]) await new ClaimStore(ctx).write(claim); const queue = new UploadStore(ctx); await queue.enqueue([c.retired, c.middle], [], true, c.groups.slice(0, 1));
      const pending = new UploadDelivery(ctx, f.knowledge.team).deliver(); await received.promise; const revised = { ...c.middle, statement: 'A concurrently revised information carrier.', updated_at: '2026-02-01T00:00:00Z' }; await new ClaimStore(ctx).write(revised); await queue.enqueue([revised], [], true); release.resolve(); expect((await pending).pendingClaims).toBe(2); expect(server.requests).toHaveLength(1); expect((await queue.read()).claims.find((claim) => claim.id === revised.id)).toEqual(revised);
      expect((await new UploadDelivery(ctx, f.knowledge.team).deliver()).pendingClaims).toBe(1); expect(server.requests.every((request) => (request.body as { data: Claim }).data.status !== 'deprecated')).toBe(true);
    } finally { release.resolve(); await f.close(); await server.close(); }
  });
  it('delivers the live carrier before either retired input and drains transitive bookkeeping', async () => {
    const c = chain(); const server = await teamServer(() => ({})); const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try { const ctx = f.knowledge.context(); for (const claim of [c.retired, c.middleRetired, c.carrier]) await new ClaimStore(ctx).write(claim); const queue = new UploadStore(ctx); await queue.enqueue([c.retired, c.middleRetired, c.carrier], [], true, c.groups); const result = await new UploadDelivery(ctx, f.knowledge.team).deliver(); expect(result).toMatchObject({ deliveredClaims: 3, pendingClaims: 0 }); const sent = server.requests.map((request) => (request.body as { data: Claim }).data.id); expect(sent[0]).toBe(c.carrier.id); expect(new Set(sent).size).toBe(3); expect((await queue.read()).consolidations).toBeUndefined(); expect((await queue.read()).acknowledgements).toBeUndefined(); }
    finally { await f.close(); await server.close(); }
  });
  it('retains all dependent retirements on carrier failure, then resumes from disk', async () => {
    const c = chain(); let available = false; const server = await teamServer(() => ({ status: available ? 200 : 503 })); const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try { const ctx = f.knowledge.context(); for (const claim of [c.retired, c.middleRetired, c.carrier]) await new ClaimStore(ctx).write(claim); const queue = new UploadStore(ctx); await queue.enqueue([c.retired, c.middleRetired, c.carrier], [], true, c.groups); expect((await new UploadDelivery(ctx, f.knowledge.team).deliver()).pendingClaims).toBe(3); expect(server.requests).toHaveLength(1); available = true; expect((await new UploadDelivery(ctx, f.knowledge.team).deliver()).pendingClaims).toBe(0); expect((server.requests[1]?.body as { data: Claim }).data.id).toBe(c.carrier.id); }
    finally { await f.close(); await server.close(); }
  });
  it('blocks retirement after a carrier revision and only a bound reviewed sync releases it without changing claims', async () => {
    const c = chain(); const server = await teamServer(() => ({})); const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try { const ctx = f.knowledge.context(); const changed = { ...c.middle, statement: `${c.middle.statement} ${c.source.statement}`, updated_at: '2026-01-04T00:00:00Z' }; for (const claim of [c.retired, changed]) await new ClaimStore(ctx).write(claim); const queue = new UploadStore(ctx); await queue.enqueue([c.retired, c.middle], [], true, c.groups.slice(0, 1)); const delivery = new UploadDelivery(ctx, f.knowledge.team); expect((await delivery.deliver()).pendingClaims).toBe(2); expect(server.requests).toEqual([]);
      const before = await new ClaimStore(ctx).list(); const sync = new DreamSync(ctx); const validation = await sync.prepare(c.source.id, [changed.id]); await sync.apply('sync-job', validation, syncReview(c.retired, changed), new AbortController().signal); expect(await new ClaimStore(ctx).list()).toEqual(before); expect((await queue.read()).consolidations?.[0]?.carriers).toEqual([changed]); expect((await delivery.deliver()).pendingClaims).toBe(0); expect(server.requests.findIndex((request) => (request.body as { data: Claim }).data.status === 'deprecated')).toBeGreaterThan(0); expect(await sync.resume('sync-job', c.source.id, new AbortController().signal)).toBe(true); }
    finally { await f.close(); await server.close(); }
  });
  it.each(['version', 'fact', 'destination', 'name', 'provenance'])('rejects invalid sync %s without releasing the dependency', async (mode) => {
    const c = chain(); if (mode === 'provenance') { c.source.source_claim_ids = [SourceIdSchema.parse('policy_00000001')]; const group = c.groups[0]; if (group) group.before = c.source; }
    const server = await teamServer(() => ({})); const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } });
    try { const ctx = f.knowledge.context(); for (const claim of [c.retired, c.middle]) await new ClaimStore(ctx).write(claim); const queue = new UploadStore(ctx); await queue.enqueue([c.retired, c.middle], [], true, c.groups.slice(0, 1)); const sync = new DreamSync(ctx); const validation = await sync.prepare(c.source.id, [c.middle.id]); const review = syncReview(c.retired, c.middle); const item = review.claims[0]; if (!item) throw new Error('Missing review.'); if (mode === 'version') await new ClaimStore(ctx).write({ ...c.middle, statement: 'Concurrent edit.', updated_at: '2026-01-05T00:00:00Z' }); if (mode === 'fact') item.factual_correction = true; if (mode === 'destination') item.output_ids = []; if (mode === 'name') item.final_name = 'Different name'; await expect(sync.apply('sync-job', validation, review, new AbortController().signal)).rejects.toThrow(); expect((await queue.read()).consolidations).toEqual(c.groups.slice(0, 1)); expect(server.requests).toEqual([]); }
    finally { await f.close(); await server.close(); }
  });
  it('ordinary reactivation cancels only the retired source dependency', async () => {
    const c = chain(); const server = await teamServer(() => ({})); const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } });
    try { const queue = new UploadStore(f.knowledge.context()); await queue.enqueue([c.retired, c.middleRetired, c.carrier], [], true, c.groups); const active = { ...c.source, updated_at: '2026-02-01T00:00:00Z' }; await queue.enqueue([active], [], true); expect((await queue.read()).consolidations?.map((group) => group.retired.id)).toEqual([c.middle.id]); expect((await queue.read()).claims.find((claim) => claim.id === active.id)).toEqual(active); }
    finally { await f.close(); await server.close(); }
  });
});
