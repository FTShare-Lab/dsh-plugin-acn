// 同步徽标绑定成功交付的精确版本，来源只读取真实持久关联而不启动 Agent。
import { expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import { flowHarness } from '../flow/harness.js';
import { ScriptAdapter } from '../flow/adapter.js';
import { teamServer } from '../team/helpers.js';
import { executeInteraction } from '../../src/dsh-adapter/interaction-service.js';
import { UploadDelivery } from '../../src/upload/deliver.js';
import { UploadStore } from '../../src/store/uploads.js';
import { ClaimStore } from '../../src/store/claims.js';
import { DeliveryStatusStore } from '../../src/store/delivery-status.js';
import { claimRevision } from '../../src/protocol/revision.js';
import { CheckpointSchema } from '../../src/formation/checkpoint.js';
import { writeYamlAtomic } from '../../src/store/yaml.js';
import { JobSchema } from '../../src/worker/types.js';

it('only shows synced for the exact acknowledged version and destination', async () => {
  let failed = true;
  const server = await teamServer((request) => ({ status: failed && request.path === '/claims/upload' ? 503 : 200 }));
  const f = await flowHarness(new ScriptAdapter([]), { config: { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } } });
  try {
    const context = f.knowledge.context(); const queue = new UploadStore(context); await queue.enqueue([f.claim], [], true);
    const deliver = new UploadDelivery(context, f.knowledge.team);
    await deliver.deliver();
    expect((await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal' })).knowledge?.items[0]?.delivery).toBe('pending');
    failed = false; await deliver.deliver();
    expect((await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal', delivery: 'synced' })).knowledge?.items.map((item) => item.id)).toEqual([f.claim.id]);
    await new ClaimStore(context).write({ ...f.claim, statement: 'A later local version.' });
    expect((await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal', delivery: 'synced' })).knowledge?.items).toEqual([]);
    await new ClaimStore(context).write(f.claim);
    await new DeliveryStatusStore(context).acknowledge('claim', f.claim.id, claimRevision(f.claim), 'https://maintainer.example.org');
    expect((await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal', delivery: 'synced' })).knowledge?.items).toEqual([]);
  } finally { await f.close(); await server.close(); }
});
it('keeps a recorded source after the latest checkpoint changes and inspects cold sources without resuming', async () => {
  const f = await flowHarness(new ScriptAdapter([]));
  try {
    const agent = await f.create('source-a'); const context = f.knowledge.context();
    const checkpoint = CheckpointSchema.parse({ schemaVersion: 1, sessionId: agent.session.id, jobId: 'recap-source', kind: 'recap', fromSeq: -1, untilSeq: 1, status: 'applied', analysisClaims: [], preparedClaims: [f.claim], appliedClaims: [f.claim], disputes: [], trace: null, warnings: [] });
    await writeYamlAtomic(context.paths.finalizeCheckpoint(agent.session.id), checkpoint, CheckpointSchema, context.logger);
    expect((await executeInteraction(f.ctx, { action: 'knowledge', key: 'personal' })).knowledge?.items[0]?.sources).toEqual([{ id: agent.session.id, available: true }]);
    await writeYamlAtomic(context.paths.job('recap-source'), { schemaVersion: 1, id: 'recap-source', kind: 'recap', sessionId: agent.session.id, payload: {}, state: 'succeeded', attempts: 1, createdAt: 1, updatedAt: 2, result: { entityIds: [f.claim.id] } }, JobSchema, context.logger);
    await writeYamlAtomic(context.paths.finalizeCheckpoint(agent.session.id), { ...checkpoint, appliedClaims: [], preparedClaims: [] }, CheckpointSchema, context.logger);
    expect((await executeInteraction(f.ctx, { action: 'reference', key: 'personal', id: f.claim.id })).reference?.item?.sources).toHaveLength(1);
    const inspect = vi.fn().mockResolvedValue({ meta: { ...agent.session.header, id: SessionId('cold-source') }, events: [] }); const resume = vi.fn();
    f.ctx.provide('sessionController', { inspect, resolveAgent: resume } as unknown as Context['sessionController']);
    expect(await executeInteraction(f.ctx, { action: 'source_session', sessionId: 'cold-source' })).toMatchObject({ ok: true, sourceSession: { available: true } });
    inspect.mockRejectedValueOnce(new Error('Missing session.'));
    expect(await executeInteraction(f.ctx, { action: 'source_session', sessionId: 'removed-source' })).toMatchObject({ ok: false, sourceSession: { available: false } });
    expect(resume).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
