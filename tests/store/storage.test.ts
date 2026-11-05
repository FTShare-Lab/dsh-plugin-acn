// 真实临时文件验证实体、队列、台账和编辑恢复的持久化语义。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimSchema, claimRevision, DisputeSchema, InboxMessageSchema, TraceSchema } from '../../src/protocol/index.js';
import { AgentPaths, agentHomePath, ClaimEditStore, ClaimStore, cleanupAtomicTemps, decodeYaml, DisputeStore, encodeYaml, JobStore, PendingClaimEditSchema, PendingUploadsSchema, readYaml, ReportedSetStore, reportedClaimSetKey, SessionStateStore, TraceStore, UploadStore, writeTextAtomic, writeYamlAtomic } from '../../src/store/index.js';
import { context, fixture, logger } from '../helpers.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'acn-store-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });

describe('entity I/O', () => {
  it('writes and lists Claims, Traces and Disputes and reads absent lists as empty', async () => {
    const ctx = context(root);
    const claims = new ClaimStore(ctx);
    expect(await claims.list()).toEqual([]);
    const claim = await fixture('claim-nanos', ClaimSchema);
    await claims.write(claim);
    expect(await claims.read(claim.id)).toEqual(claim);
    expect(await claims.list()).toEqual([claim]);
    const trace = await fixture('trace', TraceSchema);
    const traces = new TraceStore(ctx); await traces.write(trace); expect(await traces.read(trace.id)).toEqual(trace);
    const dispute = await fixture('dispute-open', DisputeSchema);
    const disputes = new DisputeStore(ctx); await disputes.write(dispute); expect(await disputes.read(dispute.id)).toEqual(dispute);
  });
  it('skips corrupt YAML and temporary files but keeps I/O errors observable', async () => {
    const ctx = { ...context(root), logger: { warn: vi.fn(), debug: vi.fn() } };
    const claims = new ClaimStore(ctx);
    const claim = await fixture('claim-seconds', ClaimSchema);
    await claims.write(claim);
    await fs.writeFile(join(ctx.paths.claims, 'claim_00000009.yaml'), 'id: [broken');
    await fs.writeFile(join(ctx.paths.claims, 'claim_00000002.yaml.tmp.1.example'), 'unfinished');
    expect(await claims.list()).toEqual([claim]);
    expect(ctx.logger.warn).toHaveBeenCalledOnce();
    await fs.mkdir(ctx.paths.claim('claim_00000003'));
    await expect(claims.read('claim_00000003')).rejects.toMatchObject({ kind: 'io' });
    await expect(claims.read('claim_00000004')).rejects.toMatchObject({ kind: 'io' });
  });
  it('holder_must_be_self and stored IDs must agree with filenames', async () => {
    const ctx = context(root);
    const claim = await fixture('claim-seconds', ClaimSchema);
    const claims = new ClaimStore(ctx);
    await expect(claims.write({ ...claim, holder: 'agent-b' })).rejects.toMatchObject({ kind: 'ownership' });
    await writeYamlAtomic(ctx.paths.claim('claim_00000002'), claim, ClaimSchema, logger);
    await expect(claims.read('claim_00000002')).rejects.toMatchObject({ kind: 'decode' });
    expect(() => ctx.paths.claim('../claim_00000001')).toThrow();
  });
  it('reserves IDs exclusively, retries collisions, and stops after eight collisions', async () => {
    const claims = new ClaimStore(context(root));
    const claim = await fixture('claim-seconds', ClaimSchema);
    await claims.write(claim);
    let attempt = 0;
    const created = await claims.create(() => attempt++ === 0 ? claim.id : 'claim_00000002', (id) => ClaimSchema.parse({ ...claim, id }));
    expect(created.id).toBe('claim_00000002');
    expect(await claims.read(claim.id)).toEqual(claim);
    await expect(claims.create(() => claim.id, (id) => ClaimSchema.parse({ ...claim, id }))).rejects.toMatchObject({ kind: 'conflict' });
  });
  it('does not leave a reserved empty file when value validation fails', async () => {
    const claims = new ClaimStore(context(root));
    await expect(claims.create(() => 'claim_00000001', () => { throw new Error('validation failed'); })).rejects.toThrow('validation failed');
    expect(await claims.list()).toEqual([]);
    expect(await fs.readdir(new AgentPaths(root).claims)).toEqual([]);
  });
  it('reads the directory produced by the Rust exporter', async () => {
    await fs.cp(new URL('../fixtures/acn-home/', import.meta.url), root, { recursive: true });
    const ctx = context(root, 'team');
    expect((await new ClaimStore(ctx).list()).length).toBe(1);
    expect((await new TraceStore(ctx).list()).length).toBe(1);
    expect((await new DisputeStore(ctx).list()).length).toBe(1);
    expect((await readYaml(ctx.paths.pendingInbox('inbox_00000001'), InboxMessageSchema)).id).toBe('inbox_00000001');
    expect((await new UploadStore(ctx).read()).claims).toHaveLength(2);
    expect(Object.keys((await new ReportedSetStore(ctx).read()).reported_claim_sets)).toHaveLength(1);
    expect((await readYaml(ctx.paths.claimEditPending, PendingClaimEditSchema)).target.id).toBe('claim_00000001');
  });
});

describe('queue and idempotency ledger', () => {
  it('retains newer versions, sorts entries, and removes only the delivered revision', async () => {
    const queue = new UploadStore(context(root, 'team'));
    const claim = await fixture('claim-seconds', ClaimSchema);
    const newer = ClaimSchema.parse({ ...claim, updated_at: '2026-10-21T01:00:00Z', statement: 'new version' });
    await queue.enqueue([newer], [], true);
    await queue.enqueue([claim], []);
    expect((await queue.read()).claims).toEqual([newer]);
    await queue.removeDeliveredClaims([claim]);
    expect((await queue.read()).claims).toEqual([newer]);
    await queue.removeDeliveredClaims([newer]);
    expect((await queue.read()).claims).toEqual([]);
    await expect(fs.access(new AgentPaths(root).pendingUploads)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains pending data when a queue operation fails validation', async () => {
    const queue = new UploadStore(context(root, 'team'));
    const claim = await fixture('claim-seconds', ClaimSchema);
    await queue.enqueue([claim], []);
    await expect(queue.save({ claims: [{ invalid: true }] })).rejects.toThrow();
    expect((await queue.read()).claims).toEqual([claim]);
  });
  it('retains the latest Dispute and preserves retirement dependencies across edits', async () => {
    const queue = new UploadStore(context(root, 'team'));
    const pending = await fixture('uploads', PendingUploadsSchema); await queue.save(pending);
    const group = pending.consolidations?.[0]; if (group === undefined) throw new Error('Expected a consolidation.');
    const revised = ClaimSchema.parse({ ...group.retired, statement: 'revised deprecated source', updated_at: '2026-10-21T02:00:00Z' });
    const dispute = await fixture('dispute-open', DisputeSchema);
    await queue.enqueue([revised], [{ ...dispute, summary: 'newer dispute', created_at: '2026-10-21T02:00:00Z' }]);
    await queue.enqueue([], [dispute]);
    expect((await queue.read()).consolidations?.[0]?.retired).toEqual(revised);
    expect((await queue.read()).disputes[0]?.summary).toBe('newer dispute');
    await queue.enqueue([ClaimSchema.parse({ ...revised, status: 'active', updated_at: '2026-10-21T03:00:00Z' })], []);
    expect((await queue.read()).consolidations).toBeUndefined();
  });
  it('solo_mode_zero_network: neither initializes nor consumes a team upload queue', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const ctx = context(root);
    const queue = new UploadStore(ctx);
    const claim = await fixture('claim-seconds', ClaimSchema);
    await new ClaimStore(ctx).write(claim);
    await queue.enqueue([claim], [], true);
    await queue.save(await fixture('uploads', PendingUploadsSchema));
    await queue.removeDeliveredClaims([claim]);
    expect(await new ClaimEditStore(ctx).recover()).toBe('none');
    expect((await queue.read()).claims).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(fs.access(ctx.paths.uploads)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('normalizes Claim sets and keeps the first Dispute record', async () => {
    const store = new ReportedSetStore(context(root));
    const ids = ['claim_00000002', 'claim_00000001', 'claim_00000001'];
    expect(reportedClaimSetKey(ids)).toBe('claim_00000001 | claim_00000002');
    await store.record(ids, 'dispute_00000001', '2026-10-21T00:00:00Z');
    await store.record(ids.slice().reverse(), 'dispute_00000002', '2026-10-21T01:00:00Z');
    expect(await store.contains(ids)).toBe(true);
    expect((await store.read()).reported_claim_sets[reportedClaimSetKey(ids)]?.first_dispute_id).toBe('dispute_00000001');
  });
  it('serializes concurrent ledger writers without dropping distinct sets', async () => {
    const stores = Array.from({ length: 10 }, () => new ReportedSetStore(context(root)));
    await Promise.all(stores.map((store, index) => store.record([`claim_${index.toString(16).padStart(8, '0')}`], 'dispute_00000001', '2026-10-21T00:00:00Z')));
    expect(Object.keys((await new ReportedSetStore(context(root)).read()).reported_claim_sets)).toHaveLength(10);
  });
});

describe('pending Claim edit recovery', () => {
  it.each(['unwritten', 'landed', 'superseded'])('recovers %s edits without replaying stale content', async (stage) => {
    const ctx = context(root, 'team');
    const claims = new ClaimStore(ctx);
    const original = await fixture('claim-seconds', ClaimSchema);
    const target = ClaimSchema.parse({ ...original, statement: 'target', updated_at: '2026-10-21T01:00:00Z' });
    const superseded = ClaimSchema.parse({ ...target, statement: 'newer same-second version' });
    await claims.write(stage === 'unwritten' ? original : stage === 'landed' ? target : superseded);
    const edits = new ClaimEditStore(ctx);
    await edits.write({ expected_revision: claimRevision(original), target });
    expect(await edits.recover()).toBe(stage === 'landed' ? 'queued' : 'discarded');
    const current = await claims.read(original.id);
    expect(current).toEqual(stage === 'unwritten' ? original : stage === 'landed' ? target : superseded);
    const queue = await new UploadStore(ctx).read();
    expect(queue.claims).toEqual(stage === 'landed' ? [current] : []);
    if (stage === 'landed') expect(queue.durable_claim_ids).toEqual([original.id]);
    expect(await edits.recover()).toBe('none');
  });
  it('preserves a team journal while in solo mode, then recovers on return', async () => {
    const team = context(root, 'team');
    const claim = await fixture('claim-seconds', ClaimSchema);
    await new ClaimStore(team).write(claim);
    await new ClaimEditStore(team).write({ expected_revision: claimRevision(claim), target: { ...claim, statement: 'unfinished' } });
    expect(await new ClaimEditStore(context(root)).recover()).toBe('none');
    await fs.access(team.paths.claimEditPending);
    expect(await new ClaimEditStore(team).recover()).toBe('discarded');
  });
  it('does not authorize a solo retirement from a leftover team edit journal', async () => {
    const team = context(root, 'team'); const solo = context(root);
    const original = await fixture('claim-seconds', ClaimSchema);
    const target = ClaimSchema.parse({ ...original, statement: 'Team revision before shutdown.', updated_at: '2026-10-21T01:00:00Z' });
    await new ClaimEditStore(team).write({ expected_revision: claimRevision(original), target });
    await new ClaimStore(team).write(target); await new UploadStore(team).enqueue([target], [], true);
    expect(await new ClaimEditStore(solo).recover()).toBe('none');
    const retired = ClaimSchema.parse({ ...target, status: 'deprecated', updated_at: '2026-10-21T02:00:00Z', evidence_summary: 'Consolidated locally in solo mode.' });
    await new ClaimStore(solo).write(retired);
    expect(await new ClaimEditStore(team).recover()).toBe('discarded');
    expect((await new UploadStore(team).read()).claims).toEqual([target]);
    expect(await new ClaimStore(team).read(original.id)).toEqual(retired);
    expect(await new ClaimEditStore(team).recover()).toBe('none');
  });
  it('rejects a null pending journal instead of treating it as a missing record', async () => {
    const ctx = context(root, 'team');
    await fs.writeFile(ctx.paths.claimEditPending, 'null\n');
    await expect(new ClaimEditStore(ctx).recover()).rejects.toMatchObject({ kind: 'decode' });
    expect(await fs.readFile(ctx.paths.claimEditPending, 'utf8')).toBe('null\n');
  });
});

describe('private files and atomic primitives', () => {
  it('writes versioned session and job documents and rejects unsupported versions', async () => {
    const ctx = context(root);
    const states = new SessionStateStore(ctx); const jobs = new JobStore(ctx);
    expect(await states.read('example-session')).toBeNull();
    await states.write('example-session', { schemaVersion: 1, seenSourceIds: ['claim_00000001'] });
    expect(await states.read('example-session')).toEqual({ schemaVersion: 1, seenSourceIds: ['claim_00000001'] });
    await jobs.write('example-job', { schemaVersion: 1, state: 'queued' });
    expect((await jobs.read('example-job'))?.state).toBe('queued');
    await expect(jobs.write('example-job', { schemaVersion: 2 })).rejects.toMatchObject({ kind: 'encode' });
    expect(() => ctx.paths.session('../../outside')).toThrow();
    expect(agentHomePath(root, 'agent-a')).toBe(join(root, 'agents', 'agent-a'));
    expect(ctx.paths.workerLock).toBe(join(root, 'jobs', 'worker.lock'));
  });
  it('rejects a null versioned document instead of silently recreating state', async () => {
    const ctx = context(root); const states = new SessionStateStore(ctx);
    await fs.mkdir(ctx.paths.session('example-session'), { recursive: true });
    await fs.writeFile(ctx.paths.sessionState('example-session'), 'null\n');
    await expect(states.read('example-session')).rejects.toMatchObject({ kind: 'decode' });
  });
  it('overwrites text atomically and cleans only old temporary files', async () => {
    const path = join(root, 'nested', 'state.txt');
    await writeTextAtomic(path, 'before', logger); await writeTextAtomic(path, 'after', logger);
    expect(await fs.readFile(path, 'utf8')).toBe('after');
    const old = `${path}.tmp.1.old`; const fresh = `${path}.tmp.1.fresh`;
    await fs.writeFile(old, 'old'); await fs.writeFile(fresh, 'fresh');
    const past = new Date(Date.now() - 7_200_000); await fs.utimes(old, past, past);
    expect(await cleanupAtomicTemps(root, logger)).toBe(1);
    await fs.access(fresh); expect(await fs.readFile(path, 'utf8')).toBe('after');
  });
  it('exclusive temporary creation preserves a preexisting symlink and its target', async () => {
    const target = join(root, 'protected.txt'); const output = join(root, 'output.txt');
    await fs.writeFile(target, 'protected');
    const originalOpen = fs.open.bind(fs);
    let injected: string | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (injected === undefined && typeof path === 'string' && path.includes('.tmp.')) { injected = path; await fs.symlink(target, path); }
      return originalOpen(path, flags, mode);
    });
    await writeTextAtomic(output, 'new output', logger);
    expect(await fs.readFile(target, 'utf8')).toBe('protected');
    expect(await fs.readFile(output, 'utf8')).toBe('new output');
    if (injected === undefined) throw new Error('Expected a colliding temporary path.');
    expect((await fs.lstat(injected)).isSymbolicLink()).toBe(true);
  });
  it('does not include malformed YAML contents in decode errors', () => {
    const marker = 'private-content-' + Math.random().toString(36);
    let error: unknown;
    try { decodeYaml(ClaimSchema, `id: [${marker}`); } catch (caught) { error = caught; }
    expect(String(error)).not.toContain(marker);
    expect(() => encodeYaml(ClaimSchema, { statement: marker })).toThrow('Cannot encode YAML value.');
  });
});
