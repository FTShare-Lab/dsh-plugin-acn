// 筛选在分页前执行，投递标签只反映本地台账，不把没有待投记录说成已同步。
import { expect, it } from 'vitest';
import { ClaimIdSchema } from '../../src/protocol/ids.js';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { DisputeStore } from '../../src/store/disputes.js';
import { DisputeSchema } from '../../src/protocol/dispute.js';
import { TraceSchema } from '../../src/protocol/trace.js';
import { UploadStore } from '../../src/store/uploads.js';
import { executeInteraction } from '../../src/dsh-adapter/interaction-service.js';
import { activityPage } from '../../src/activities.js';
import { flowHarness } from '../flow/harness.js';
import { ScriptAdapter } from '../flow/adapter.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { teamServer } from '../team/helpers.js';
it('finds a pending stale claim beyond the first page without any team request', async () => {
  const server = await teamServer(() => ({}));
  const f = await flowHarness(new ScriptAdapter([]), { config: { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } } });
  try {
    const store = new ClaimStore(f.knowledge.context());
    for (let i = 2; i <= 32; i += 1) await store.write(sampleClaim({ id: ClaimIdSchema.parse(`claim_${i.toString(16).padStart(8, '0')}`) }));
    const stale = sampleClaim({ id: ClaimIdSchema.parse('claim_00000021'), status: 'stale' }); await store.write(stale); await new UploadStore(f.knowledge.context()).enqueue([stale], [], true);
    const beforeRead = server.requests.length;
    const result = await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal', status: 'stale', delivery: 'pending' });
    expect(result.ok).toBe(true); expect(result.knowledge?.items).toHaveLength(1);
    expect(result.knowledge?.items[0]).toMatchObject({ id: stale.id, delivery: 'pending', status: 'stale', summary: stale.statement });
    const local = await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal', delivery: 'local' });
    expect(local.knowledge?.items.every((item) => item.delivery === 'local')).toBe(true); expect(local.knowledge?.items.some((item) => item.id === stale.id)).toBe(false);
    expect(server.requests).toHaveLength(beforeRead);
  } finally { await f.close(); await server.close(); }
});
it('applies activity kind, state and source together before pagination', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: String(i), kind: i === 44 ? 'dream' : 'recap', state: i === 44 ? 'failed' : 'succeeded', sessionId: i === 44 ? 'source-a' : 'source-b', attempts: 1, updatedAt: i, unseen: false, summary: '' }));
  expect(activityPage(rows, { kind: 'dream', state: 'failed', sourceSession: 'source-a' }).activities.map((item) => item.id)).toEqual(['44']);
});
it('opens a local Trace by exact ID and excludes traces owned by another agent', async () => {
  const f = await flowHarness(new ScriptAdapter([]));
  try {
    const store = new TraceStore(f.knowledge.context());
    for (const [id, agent] of [['trace_00000001', 'agent-a'], ['trace_00000002', 'agent-b']]) await store.write(TraceSchema.parse({ id, agent, name: 'example_trace', task: 'Example public task.', created_at: '2026-01-01T00:00:00Z' }));
    const local = await executeInteraction(f.ctx, { action: 'reference', key: 'personal', id: 'trace_00000001' });
    expect(local).toMatchObject({ ok: true, reference: { id: 'trace_00000001', item: { kind: 'trace', name: 'example_trace' } } });
    const foreign = await executeInteraction(f.ctx, { action: 'reference', key: 'personal', id: 'trace_00000002' });
    expect(foreign.ok).toBe(true); expect(foreign.reference?.item).toBeUndefined();
  } finally { await f.close(); }
});
it('orders knowledge by status and recent change before paging, with matching displayed times', async () => {
  const f = await flowHarness(new ScriptAdapter([]));
  try {
    const context = f.knowledge.context(); const claims = new ClaimStore(context);
    for (let i = 1; i <= 32; i += 1) await claims.write(sampleClaim({
      id: ClaimIdSchema.parse(`claim_${i.toString(16).padStart(8, '0')}`),
      created_at: `2026-01-01T00:${String(Math.min(i, 31)).padStart(2, '0')}:00Z`,
      updated_at: i <= 3 ? '2026-02-01T00:00:00Z' : undefined,
      status: i === 2 ? 'stale' : i === 3 ? 'deprecated' : 'active',
    }));
    const first = await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal' });
    expect(first.ok).toBe(true); expect(first.knowledge?.items).toHaveLength(30); expect(first.knowledge?.omitted).toBe(2);
    expect(first.knowledge?.items.slice(0, 3).map((row) => row.id)).toEqual(['claim_00000001', 'claim_0000001f', 'claim_00000020']);
    expect(first.knowledge?.items[0]?.updatedAt).toBe('2026-02-01T00:00:00Z');
    const next = await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal', offset: 30 });
    expect(next.knowledge?.items.map((row) => row.id)).toEqual(['claim_00000002', 'claim_00000003']);
    const disputes = new DisputeStore(context);
    for (const [id, created_at, resolved_at] of [
      ['dispute_00000001', '2026-01-01T00:00:00Z', undefined],
      ['dispute_00000002', '2026-01-02T00:00:00Z', undefined],
      ['dispute_00000003', '2026-01-03T00:00:00Z', '2026-03-01T00:00:00Z'],
      ['dispute_00000004', '2026-01-04T00:00:00Z', '2026-04-01T00:00:00Z'],
    ]) await disputes.write(DisputeSchema.parse({ id, name: 'example', summary: 'Public example.', reporter_agent_id: context.agentId, claims: [], status: resolved_at ? 'resolved' : 'open', created_at, resolved_at }));
    const disputePage = await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal', kind: 'dispute' });
    expect(disputePage.knowledge?.items.map((row) => row.id)).toEqual(['dispute_00000002', 'dispute_00000001', 'dispute_00000004', 'dispute_00000003']);
    expect(disputePage.knowledge?.items[2]?.updatedAt).toBe('2026-04-01T00:00:00Z');
    const traces = new TraceStore(context);
    for (const [id, created_at] of [['trace_00000001', '2026-01-01T00:00:00Z'], ['trace_00000002', '2026-02-01T00:00:00.000000002Z'], ['trace_00000003', '2026-02-01T00:00:00.000000001Z']]) await traces.write(TraceSchema.parse({ id, name: 'example', task: 'Public example.', agent: context.agentId, created_at }));
    const tracePage = await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal', kind: 'trace' });
    expect(tracePage.knowledge?.items.map((row) => row.id)).toEqual(['trace_00000002', 'trace_00000003', 'trace_00000001']);
  } finally { await f.close(); }
});
