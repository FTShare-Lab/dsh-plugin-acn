// 真实账号目录验证跨配置隔离、历史投影与原位置续写，不迁移凭据或运行旧任务。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { prepareLibraryDirectory, syncLibraryIndex } from '../../src/store/library-directory.js';
import { historicalKnowledge } from '../../src/store/history.js';
import { resolveConfig } from '../../src/config.js';
import { resolveUpstream } from '../../src/upstreams.js';
import { AcnKnowledge } from '../../src/knowledge/service.js';
import { ClaimSchema } from '../../src/protocol/claim.js';
import { TraceSchema } from '../../src/protocol/trace.js';
import { DisputeSchema } from '../../src/protocol/dispute.js';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { DisputeStore } from '../../src/store/disputes.js';
import { agentHomePath } from '../../src/store/paths.js';
import { allActivities } from '../../src/activities.js';
import { knowledgeSources } from '../../src/knowledge/sources.js';
import { readKnowledge } from '../../src/dsh-adapter/interaction-service.js';
import { identityOf } from '../../src/dsh-adapter/session-binding.js';
import type { RuntimePool } from '../../src/dsh-adapter/runtime-pool.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
const connectionRevision = '55555555-5555-4555-8555-555555555555';
const logger = { warn: () => {}, debug: () => {} };
const roots: string[] = []; const services: AcnKnowledge[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(async (service) => { await service.jobs?.close(); await service.team?.close(); })); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(segments: readonly string[] = []) {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'acn-library-')); roots.push(temporary);
  const root = join(temporary, ...segments); await fs.mkdir(root, { recursive: true });
  const claim = ClaimSchema.parse({ id: 'claim_00000001', name: 'example_rule', statement: 'Keep the checked date in the example report.', scope: 'example/report', holder: 'agent-a', confidence: 'medium', status: 'active', created_at: '2026-01-01T00:00:00Z', evidence_summary: 'A checked example.', source_claim_ids: [] });
  const trace = TraceSchema.parse({ id: 'trace_00000001', name: 'example source', task: 'Checked the report.', agent: 'agent-a', output_claims: [claim.id], created_at: '2026-01-01T00:00:00.123Z' });
  const index = { schemaVersion: 1, upstreams: [first, second].map((id) => ({ summary: { id, name: id === first ? 'Example team' : 'Other team', agentId: 'agent-a', enabled: true, routerEndpoint: 'http://127.0.0.1:8101', maintainerEndpoint: 'http://127.0.0.1:8102' }, key: 'not-imported', maintainerRevision: connectionRevision })), preferences: { defaultUpstream: first }, knowledgeModel: { provider: 'old-provider', model: 'old-model' } };
  await fs.writeFile(join(root, 'settings.json'), JSON.stringify(index));
  const directory = join(root, 'upstreams', first, 'agents', createHash('sha256').update('agent\0agent-a').digest('hex'));
  const write = async (relative: string, value: unknown) => { const path = join(root, relative); await fs.mkdir(join(path, '..'), { recursive: true }); await fs.writeFile(path, stringify(value)); };
  const relative = (path: string) => path.slice(root.length + 1);
  await write(relative(join(directory, 'claims', `${claim.id}.yaml`)), claim);
  await write(relative(join(directory, 'traces', `${trace.id}.yaml`)), trace);
  const application = { schema_version: 1, state: 'applied', application: { id: applicationId, agent: 'agent-a', knowledge: { claims: [claim], disputes: [] }, trace } };
  await write(relative(join(directory, 'applications', `${applicationId}.yaml`)), application);
  await write(`upstreams/${first}/supervisor/journals/example.yaml`, { schemaVersion: 1, scope: { upstreamId: first, sessionId: 'old-session' }, jobs: [{ id: jobId, applicationId, work: { agentId: 'agent-a' }, trigger: 'manual', attempts: 1, queuedAtMicros: 1767225600000000 }], presentationTimes: { [jobId]: 1767225601000000 } });
  const ledger = { schemaVersion: 1, scope: { upstream: first, agent: 'agent-a' }, batches: [{ applicationId, owner: { sourceSession: 'old-session' }, items: [{ entity: { kind: 'claim', value: claim }, state: 'delivered', lastConnectionRevision: connectionRevision, presentationAtMicros: 1767225602000000 }] }] };
  await write(relative(join(directory, 'maintainer_uploads', 'ledger.yaml')), ledger);
  const config = resolveConfig(await prepareLibraryDirectory({}, { home: root }));
  const selected = resolveUpstream(config, first); if (selected === undefined) throw new Error('Missing fixture upstream.');
  const knowledge = new AcnKnowledge(selected, logger); services.push(knowledge);
  return { root, directory, claim, trace, index, application, ledger, config, selected, knowledge, write, relative };
}

describe('existing account libraries', () => {
  it('keeps bindings and credentials when the same directory is selected through an alias', async () => {
    const f = await fixture(); const alias = join(f.root, 'directory-alias');
    await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const current = { ...f.config, upstreams: { ...f.config.upstreams, [first]: { ...f.config.upstreams?.[first], keyEnv: 'CURRENT_TEAM_REFERENCE' } } };
    const saved = resolveConfig(await prepareLibraryDirectory(current, { ...current, home: alias }));
    expect(saved.home).toBe(f.config.home); expect(saved.upstreams?.[first]?.keyEnv).toBe('CURRENT_TEAM_REFERENCE');
    const selected = resolveUpstream(saved, first); if (selected === undefined) throw new Error('Missing upstream.');
    expect(identityOf(selected)).toBe(identityOf(f.selected));
  });

  it('persists new profiles in the account index and restores them without host credential references', async () => {
    const temporary = await fs.mkdtemp(join(tmpdir(), 'acn-new-account-')); roots.push(temporary);
    const config = resolveConfig({ home: temporary, upstream: first, upstreams: { [first]: { name: 'Example', agentId: 'agent-a', keyEnv: 'EXAMPLE_TEAM_REFERENCE' } }, llm: { provider: 'host-provider', model: 'host-model' } });
    await syncLibraryIndex(config, logger);
    const text = await fs.readFile(join(temporary, 'settings.json'), 'utf8');
    expect(text).not.toContain('EXAMPLE_TEAM_REFERENCE'); expect(text).not.toContain('host-provider');
    const renamed = resolveConfig({ ...config, upstreams: { ...config.upstreams, [first]: { ...config.upstreams?.[first], name: 'Renamed profile' }, [second]: { name: 'Other', agentId: 'agent-a' } } });
    await syncLibraryIndex(renamed, logger);
    const restored = resolveConfig(await prepareLibraryDirectory({ home: temporary }, { home: temporary }));
    expect(Object.keys(restored.upstreams ?? {})).toEqual([first, second]);
    expect(restored.upstreams?.[first]?.name).toBe('Renamed profile'); expect(restored.upstreams?.[first]?.keyEnv).toBe('');
    expect(restored.upstream).toBe(first);
    const pendingEdit = { ...restored, upstreams: { ...restored.upstreams, [first]: { ...restored.upstreams?.[first], name: 'Pending edit' } } };
    expect((await prepareLibraryDirectory({ home: temporary }, pendingEdit)).upstreams).toEqual(pendingEdit.upstreams);
  });

  it('leaves an unchanged index intact and invalidates historical receipts when its team target changes', async () => {
    const f = await fixture(); const original = await fs.readFile(join(f.root, 'settings.json'), 'utf8');
    const ledgerPath = join(f.directory, 'maintainer_uploads', 'ledger.yaml'); const ledger = await fs.readFile(ledgerPath, 'utf8');
    await syncLibraryIndex(f.config, logger);
    expect(await fs.readFile(join(f.root, 'settings.json'), 'utf8')).toBe(original);
    const changed = resolveConfig({ ...f.config, upstreams: { ...f.config.upstreams, [first]: { ...f.config.upstreams?.[first], name: 'Changed team', maintainerEndpoint: 'http://127.0.0.1:8202' } } });
    await syncLibraryIndex(changed, logger);
    expect((await historicalKnowledge(f.knowledge.context())).deliveries).toEqual([]);
    const current: unknown = JSON.parse(await fs.readFile(join(f.root, 'settings.json'), 'utf8'));
    expect(current).toMatchObject({ knowledgeModel: f.index.knowledgeModel });
    expect(await fs.readFile(ledgerPath, 'utf8')).toBe(ledger);
    await syncLibraryIndex(f.config, logger);
    expect((await historicalKnowledge(f.knowledge.context())).deliveries).toEqual([]);
  });

  it('keeps the same entity IDs separate across upstreams and Agent identities', async () => {
    const f = await fixture();
    const otherConfig = resolveUpstream(f.config, second); if (otherConfig === undefined) throw new Error('Missing upstream.');
    const other = new AcnKnowledge(otherConfig, logger); services.push(other);
    await new ClaimStore(other.context()).write({ ...f.claim, statement: 'A separate upstream rule.' });
    const changed = resolveConfig({ ...f.config, upstreams: { ...f.config.upstreams, [first]: { ...f.config.upstreams?.[first], agentId: 'agent-b' } } });
    const changedConfig = resolveUpstream(changed, first); if (changedConfig === undefined) throw new Error('Missing identity.');
    const changedIdentity = new AcnKnowledge(changedConfig, logger); services.push(changedIdentity);
    expect((await changedIdentity.listClaims()).items).toEqual([]);
    await new ClaimStore(changedIdentity.context()).write({ ...f.claim, holder: 'agent-b', statement: 'A separate Agent rule.' });
    expect((await f.knowledge.readClaim(f.claim.id)).claim.statement).toBe(f.claim.statement);
    expect((await other.readClaim(f.claim.id)).claim.statement).toBe('A separate upstream rule.');
    expect((await changedIdentity.readClaim(f.claim.id)).claim.statement).toBe('A separate Agent rule.');
    expect(new Set([f.selected, otherConfig, changedConfig].map(identityOf)).size).toBe(3);
  });

  it('reads and revises an account library under a long directory with spaces and Unicode', async () => {
    const f = await fixture(['知识目录 示例', ...Array.from({ length: 4 }, (_, index) => `segment-${index}-${'x'.repeat(50)}`)]);
    expect(join(f.directory, 'claims', `${f.claim.id}.yaml`).length).toBeGreaterThan(260);
    await f.knowledge.initialize();
    const detail = await f.knowledge.readClaim(f.claim.id);
    await f.knowledge.updateClaim({ id: f.claim.id, expected_revision: detail.revision, statement: 'Updated in the selected account directory.' });
    expect((await f.knowledge.readClaim(f.claim.id)).claim.statement).toBe('Updated in the selected account directory.');
    expect(await fs.readFile(join(f.root, 'settings.json'), 'utf8')).toBe(JSON.stringify(f.index));
  });

  it('uses a portable digest for identities that would be reserved as plain Windows directory names', () => {
    const root = join(tmpdir(), 'example-account');
    expect(agentHomePath(root, 'con', first)).toBe(join(root, 'upstreams', first, 'agents', createHash('sha256').update('agent\0con').digest('hex')));
    if (process.platform === 'win32') expect(() => agentHomePath(root, 'agent-a', 'con')).toThrow('Windows reserved');
  });

  it('ignores host extensions in entities, indexes and historical records without changing their files on read', async () => {
    const f = await fixture();
    const extension = { hostContext: { modelRoute: 'obsolete-route', windowId: 'old-window' }, presentationOnly: true };
    const claimPath = join(f.directory, 'claims', `${f.claim.id}.yaml`);
    const tracePath = join(f.directory, 'traces', `${f.trace.id}.yaml`);
    const dispute = DisputeSchema.parse({ id: 'dispute_00000001', name: 'example_conflict', reporter_agent_id: 'agent-a', claims: [f.claim.id], summary: 'Check the competing example rule.', status: 'open', created_at: f.claim.created_at });
    const disputePath = join(f.directory, 'disputes', `${dispute.id}.yaml`);
    await f.write(f.relative(claimPath), { ...f.claim, ...extension });
    await f.write(f.relative(tracePath), { ...f.trace, ...extension });
    await f.write(f.relative(disputePath), { ...dispute, ...extension });
    await fs.writeFile(join(f.root, 'settings.json'), JSON.stringify({ ...f.index, ...extension, explicitModelProbe: jobId, completionNotBeforeMicros: 1 }));
    await f.write(f.relative(join(f.directory, 'applications', `${applicationId}.yaml`)), { ...f.application, ...extension, application: { ...f.application.application, ...extension, knowledge: { claims: [{ ...f.claim, ...extension }], disputes: [{ ...dispute, ...extension }] }, trace: { ...f.trace, ...extension } } });
    const before = await Promise.all([claimPath, tracePath, disputePath].map((path) => fs.readFile(path, 'utf8')));
    const imported = await prepareLibraryDirectory({}, { home: f.root });
    expect(imported).not.toHaveProperty('hostContext'); expect(imported).not.toHaveProperty('knowledgeModel'); expect(imported).not.toHaveProperty('explicitModelProbe');
    expect(await new ClaimStore(f.knowledge.context()).read(f.claim.id)).toEqual(f.claim);
    expect(await new TraceStore(f.knowledge.context()).read(f.trace.id)).toEqual(f.trace);
    expect(await new DisputeStore(f.knowledge.context()).read(dispute.id)).toEqual(dispute);
    expect((await historicalKnowledge(f.knowledge.context())).applications[0]).toMatchObject({ claimCount: 1, disputeCount: 1, traceCount: 1 });
    expect(await Promise.all([claimPath, tracePath, disputePath].map((path) => fs.readFile(path, 'utf8')))).toEqual(before);
    const detail = await f.knowledge.readClaim(f.claim.id);
    await f.knowledge.updateClaim({ id: f.claim.id, expected_revision: detail.revision, name: 'updated_rule' });
    expect(await fs.readFile(claimPath, 'utf8')).not.toContain('hostContext');
    expect(await fs.readFile(tracePath, 'utf8')).toBe(before[1]);
    expect(await fs.readFile(disputePath, 'utf8')).toBe(before[2]);
  });

  it('retains other acknowledgements when an old ledger item has no connection revision', async () => {
    const f = await fixture();
    const ledger = structuredClone(f.ledger);
    const batch = ledger.batches[0]; const item = batch?.items[0];
    if (batch === undefined || item === undefined) throw new Error('Missing delivery fixture.');
    await f.write(f.relative(join(f.directory, 'maintainer_uploads', 'ledger.yaml')), { ...ledger, batches: [{ ...batch, items: [item, { ...item, lastConnectionRevision: null }] }] });
    expect((await historicalKnowledge(f.knowledge.context())).deliveries).toHaveLength(1);
  });

  it('loads every upstream from a selected account root without borrowing credentials or model routes', async () => {
    const f = await fixture();
    expect(Object.keys(f.config.upstreams ?? {})).toEqual([first, second]); expect(f.config.upstream).toBe(first);
    expect(f.config.upstreams?.[first]?.keyEnv).toBe(''); expect(f.config.llm.provider).toBe('');
    expect(f.knowledge.context().paths.root).toBe(f.directory);
    expect(resolveUpstream(f.config, second)?.upstream).not.toBe(f.selected.upstream);
    const other = resolveUpstream(f.config, second); if (other === undefined) throw new Error('Missing second upstream.');
    const separate = new AcnKnowledge(other, logger); services.push(separate);
    expect((await separate.listClaims()).items).toEqual([]);
    expect((await f.knowledge.listClaims()).items.map((item) => item.id)).toEqual([f.claim.id]);
  });

  it('retains original entities and history while revising knowledge in place', async () => {
    const f = await fixture(); const before = await fs.readFile(join(f.directory, 'claims', `${f.claim.id}.yaml`), 'utf8');
    await f.knowledge.initialize(); expect(await fs.readFile(join(f.directory, 'claims', `${f.claim.id}.yaml`), 'utf8')).toBe(before);
    const detail = await f.knowledge.readClaim(f.claim.id);
    const revised = await f.knowledge.updateClaim({ id: f.claim.id, expected_revision: detail.revision, name: 'revised_rule' });
    expect(revised.claim.holder).toBe(f.claim.holder); expect(revised.claim.created_at).toBe(f.claim.created_at); expect(revised.claim.updated_at).toBeDefined();
    expect(await fs.readFile(join(f.directory, 'claims', `${f.claim.id}.yaml`), 'utf8')).toContain('revised_rule');
    expect(await fs.readFile(join(f.directory, 'applications', `${applicationId}.yaml`), 'utf8')).toContain('example_rule');
    expect((await f.knowledge.listTraces()).items).toHaveLength(1);
  });

  it('shows historical activities and unavailable source sessions without enqueueing old work', async () => {
    const f = await fixture(); const rows = await allActivities(f.knowledge);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: `history-application-${applicationId}`, state: 'succeeded', attempts: 1, sessionId: 'old-session', retryable: false })]));
    expect((await knowledgeSources(f.knowledge.context(), [f.claim.id])).get(f.claim.id)).toEqual(['old-session']);
    expect(await f.knowledge.jobs?.queue.list()).toEqual([]);
    const ctx = { logger, sessions: { get: () => undefined }, get: () => undefined } as unknown as Context;
    const pool = { ctx, config: () => f.selected, isBase: () => true, base: f.knowledge, supportsJob: () => false, choices: () => [] } as unknown as RuntimePool;
    const page = await readKnowledge(pool, first, 'claim', '', 0);
    expect(page.items[0]?.sources).toEqual([{ id: 'old-session', available: false }]);
    expect(page.items[0]?.delivery).toBe('synced');
    f.knowledge.config.team.maintainerEndpoint = 'http://127.0.0.1:8202';
    expect((await readKnowledge(pool, first, 'claim', '', 0)).items[0]?.delivery).toBe('local');
  });

  it('does not treat an acknowledgement for a different version or connection revision as current', async () => {
    const f = await fixture(); const item = f.ledger.batches[0]?.items[0]; if (item === undefined) throw new Error('Missing delivery.');
    item.lastConnectionRevision = '66666666-6666-4666-8666-666666666666';
    await f.write(f.relative(join(f.directory, 'maintainer_uploads', 'ledger.yaml')), f.ledger);
    expect((await historicalKnowledge(f.knowledge.context())).deliveries).toEqual([]);
  });

  it('preserves edits on subsequent saves and uses the same layout for a fresh directory', async () => {
    const f = await fixture(); const changed = { ...f.config, upstreams: { ...f.config.upstreams, [first]: { ...f.config.upstreams?.[first], name: 'Renamed team' } } };
    expect((await prepareLibraryDirectory(f.config, changed)).upstreams).toEqual(changed.upstreams);
    const next = resolveConfig(await prepareLibraryDirectory(f.config, { ...f.config, home: join(f.root, 'fresh') }));
    expect(agentHomePath(next.home, 'agent-a', first)).toBe(join(f.root, 'fresh', 'upstreams', first, 'agents', createHash('sha256').update('agent\0agent-a').digest('hex')));
  });

  it('rejects invalid or duplicate configuration indexes without changing the source', async () => {
    const f = await fixture(); const duplicate = f.index.upstreams[0]; if (duplicate === undefined) throw new Error('Missing upstream.'); f.index.upstreams.push(duplicate);
    const text = JSON.stringify(f.index); await fs.writeFile(join(f.root, 'settings.json'), text);
    await expect(prepareLibraryDirectory({}, { home: f.root })).rejects.toMatchObject({ fields: ['libraryIndex'] });
    expect(await fs.readFile(join(f.root, 'settings.json'), 'utf8')).toBe(text);
  });

  it('keeps interrupted applications visible but refuses to start a new writer over them', async () => {
    const f = await fixture(); f.application.state = 'prepared';
    await f.write(f.relative(join(f.directory, 'applications', `${applicationId}.yaml`)), f.application);
    expect((await allActivities(f.knowledge)).find((item) => item.id === `history-application-${applicationId}`)).toMatchObject({ state: 'paused', retryable: false });
    await expect(f.knowledge.initialize()).rejects.toThrow('历史提交');
    expect(await f.knowledge.jobs?.queue.list()).toEqual([]);
  });
});
