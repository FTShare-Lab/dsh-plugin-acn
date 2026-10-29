// 单人留存不能阻断新的团队投递；两条形成入口共用台账与恢复边界。
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { FormationStore } from '../../src/formation/checkpoint.js';
import { InboxEffectStore } from '../../src/inbox/effects.js';
import type { PreparedFormation } from '../../src/formation/prepare.js';
import type { StoreContext } from '../../src/store/context.js';
import { ClaimStore } from '../../src/store/claims.js';
import { DisputeStore } from '../../src/store/disputes.js';
import { InboxStore } from '../../src/store/inbox.js';
import { ReportedSetStore } from '../../src/store/reported-sets.js';
import { UploadStore } from '../../src/store/uploads.js';
import { UploadDelivery } from '../../src/upload/deliver.js';
import { DisputeSchema } from '../../src/protocol/dispute.js';
import { InboxMessageSchema } from '../../src/protocol/inbox.js';
import { ClaimIdSchema, InboxIdSchema } from '../../src/protocol/ids.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { inboxFixture, inboxMessage, teamServer } from './helpers.js';

const claims = [sampleClaim(), sampleClaim({ id: ClaimIdSchema.parse('claim_00000002') })];
const proposal = (id: string): PreparedFormation => ({ claims: [], disputes: [DisputeSchema.parse({ id, name: 'scope_conflict', claims: claims.map((claim) => claim.id), summary: 'Conflicting current retry budgets.', reporter_agent_id: 'agent-a', status: 'open', created_at: '2026-01-02T00:00:00Z' })], usedClaimIds: [], warnings: [] });
const control = () => ({ signal: new AbortController().signal, prepared() {} });
async function commit(context: StoreContext, kind: 'formation' | 'inbox', index: number, prepared: PreparedFormation) {
  if (kind === 'inbox') {
    const message = InboxMessageSchema.parse({ ...inboxMessage(), id: `inbox_${String(index).padStart(8, '0')}` });
    await new InboxStore(context).acceptPulled(message);
    return new InboxEffectStore(context).commit([message], claims, prepared, control());
  }
  const store = new FormationStore(context); const id = `session-${index}`;
  await store.transcript.record(id, { entry: { seq: 0, type: 'user', text: 'Check the current scope conflict.' } });
  return store.commit({ sessionId: id, jobId: `job-${index}`, kind: 'recap', fromSeq: -1, untilSeq: 0, analysisClaims: claims, prepared, task: 'Check the current scope conflict.' }, control());
}
describe('Dispute local history and team delivery', () => {
  it.each(['formation', 'inbox'] as const)('%s never uploads a solo or unknown-origin prepared transaction after switching to team', async (kind) => {
    for (const legacy of [false, true]) {
      const f = await inboxFixture(undefined, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1' } });
      try {
        const context = f.knowledge.context(); for (const claim of claims) await new ClaimStore(context).write(claim);
        const prepared = { ...proposal('dispute_00000001'), claims: [{ ...sampleClaim(), statement: 'A privately clarified local condition.' }] };
        const spy = vi.spyOn(DisputeStore.prototype, 'write').mockRejectedValueOnce(new Error('Interrupted after prepared.'));
        try { await expect(commit({ ...context, mode: 'solo' }, kind, 1, prepared)).rejects.toThrow('Interrupted'); } finally { spy.mockRestore(); }
        if (legacy) {
          const path = kind === 'formation' ? context.paths.finalizeCheckpoint('session-1') : context.paths.inboxEffect(InboxIdSchema.parse('inbox_00000001'));
          const raw = parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>; delete raw.teamAuthorized; await fs.writeFile(path, stringify(raw));
        }
        await f.knowledge.initialize(); await f.knowledge.initialize();
        expect((await new ClaimStore(context).list())[0]?.statement).toBe('A privately clarified local condition.');
        expect(await new DisputeStore(context).list()).toHaveLength(1);
        expect((await new UploadStore(context).read()).claims).toEqual([]); expect((await new UploadStore(context).read()).disputes).toEqual([]);
        await expect(fs.access(context.paths.uploads)).rejects.toMatchObject({ code: 'ENOENT' });
        if (legacy) expect(f.warnings.join('')).toContain('缺少团队共享授权');
      } finally { await f.close(); }
    }
  });
  it.each(['formation', 'inbox'] as const)('%s recovery does not resurrect a terminally rejected prepared Dispute', async (kind) => {
    const server = await teamServer(() => ({ status: 409 }));
    const f = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      const context = f.knowledge.context(); for (const claim of claims) await new ClaimStore(context).write(claim);
      const queue = new UploadStore(context); const original = queue.enqueue.bind(queue);
      const spy = vi.spyOn(UploadStore.prototype, 'enqueue').mockImplementationOnce(async (...args) => {
        await original(...args); await new UploadDelivery(context, f.knowledge.team).deliver(); throw new Error('Interrupted before applied.');
      });
      try { await expect(commit(context, kind, 1, proposal('dispute_00000001'))).rejects.toThrow('Interrupted'); } finally { spy.mockRestore(); }
      await f.knowledge.initialize(); await f.knowledge.initialize(); await new UploadDelivery(context, f.knowledge.team).deliver();
      expect((await new UploadStore(context).read()).disputes).toEqual([]); expect(server.requests).toHaveLength(1);
      expect(await new ReportedSetStore(context).contains(claims.map((claim) => claim.id))).toBe(false);
    } finally { await f.close(); await server.close(); }
  });
  it.each(['formation', 'inbox'] as const)('%s reports a newly rediscovered team conflict after solo history, and deduplicates pending and acknowledged reports', async (kind) => {
    const f = await inboxFixture(undefined, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1' } });
    try {
      const context = f.knowledge.context(); const solo = { ...context, mode: 'solo' as const }; const queue = new UploadStore(context);
      for (const claim of claims) await new ClaimStore(context).write(claim);
      await commit(solo, 'formation', 1, proposal('dispute_00000001'));
      expect((await new DisputeStore(context).list())).toHaveLength(1); expect((await queue.read()).disputes).toEqual([]);
      // 切换本身不补传，只有团队模式这次明确提出的争议入队。
      await f.knowledge.initialize(); expect((await queue.read()).disputes).toEqual([]);
      await commit(context, kind, 2, proposal('dispute_00000002'));
      const pending = (await queue.read()).disputes; expect(pending.map((value) => value.id)).toEqual(['dispute_00000002']);
      await commit(context, kind, 3, proposal('dispute_00000003')); expect((await queue.read()).disputes).toEqual(pending);
      await new ReportedSetStore(context).record(claims.map((claim) => claim.id), 'dispute_00000002', '2026-01-02T00:00:00Z');
      await queue.removeDeliveredDisputes(pending);
      await commit(context, kind, 4, proposal('dispute_00000004'));
      expect((await queue.read()).disputes).toEqual([]); expect((await new DisputeStore(context).list())).toHaveLength(2);
    } finally { await f.close(); }
  });
  it.each(['formation', 'inbox'] as const)('%s recovers team enqueue after a local Dispute was saved', async (kind) => {
    const f = await inboxFixture(undefined, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1' } });
    try {
      const context = f.knowledge.context(); for (const claim of claims) await new ClaimStore(context).write(claim);
      await commit({ ...context, mode: 'solo' }, 'formation', 1, proposal('dispute_00000001'));
      const spy = vi.spyOn(UploadStore.prototype, 'enqueue').mockRejectedValueOnce(new Error('Interrupted before queue persistence.'));
      try { await expect(commit(context, kind, 2, proposal('dispute_00000002'))).rejects.toThrow('Interrupted'); } finally { spy.mockRestore(); }
      expect((await new DisputeStore(context).list())).toHaveLength(2);
      await f.knowledge.initialize(); await f.knowledge.initialize();
      expect((await new UploadStore(context).read()).disputes.map((value) => value.id)).toEqual(['dispute_00000002']);
    } finally { await f.close(); }
  });
});
