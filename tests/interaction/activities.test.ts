// 用真实任务台账验证历史故障可见性、额度结果投影和模型检查取消。
import { expect, it, vi } from 'vitest';
import { allActivities, activityPage, activityDetails } from '../../src/activities.js';
import { ProgressSchema } from '../../src/dream/schema.js';
import { JobQueue } from '../../src/worker/queue.js';
import { statusCommand } from '../../src/commands/status.js';
import { displayMessage, messageInfo } from '../../src/interaction-messages.js';
import { executeInteraction } from '../../src/dsh-adapter/interaction-service.js';
import { flowHarness } from '../flow/harness.js';
import { ScriptAdapter, textResponse } from '../flow/adapter.js';

it('filters all durable activities before paging so old failures remain reachable', async () => {
  const f = await flowHarness(new ScriptAdapter([]));
  try {
    const queue = new JobQueue(f.knowledge.context());
    const failure = await queue.enqueue('recap', {}, 'old-session');
    await queue.settle(failure, 'failed', { lastError: '后台模型响应无效。', lastErrorKind: 'model_response' });
    for (let index = 0; index < 105; index += 1) { const job = await queue.enqueue('recap', { index }); await queue.settle(job, 'succeeded', { result: { claimCount: 0 } }); }
    const rows = await allActivities(f.knowledge);
    expect(activityPage(rows).activities).toHaveLength(30); expect(activityPage(rows).activitiesOmitted).toBe(76);
    expect(activityPage(rows, { attentionOnly: true }).activities.map((row) => row.id)).toEqual([failure.id]);
    expect(activityPage(rows, { sourceSession: 'old-session' }).activities).toHaveLength(1);
    expect(activityPage(rows, { offset: 90 }).activities).toHaveLength(16);
    expect(await statusCommand(f.knowledge)).toContain(failure.id);
    expect(await statusCommand(f.knowledge, { failed: true })).toContain(failure.id);
    const error = rows.find((row) => row.id === failure.id); expect(error?.errorInfo?.code).toBe('task.model_response');
    expect(displayMessage(error?.error ?? '', (_zh, en) => en, error?.errorInfo)).toContain('response format');
  } finally { await f.close(); }
});
it('exposes warnings and incomplete candidate IDs without serializing private result fields', () => {
  const result = activityDetails({ claimCount: 1, warnings: ['团队投递未完成。'], budgetLimited: true, incompleteCandidates: [{ groupId: 'group-a', claimIds: ['claim_00000001'], reason: '额度收尾' }], privateMemory: 'private-data', report: '/private/example/report.md' });
  expect(result).toMatchObject({ counts: { claimCount: 1 }, warnings: ['团队投递未完成。'], budgetLimited: true, incompleteCandidates: [{ groupId: 'group-a', claimIds: ['claim_00000001'] }] });
  expect(JSON.stringify(result)).not.toContain('private-data'); expect(JSON.stringify(result)).not.toContain('/private/');
});
it('propagates caller cancellation to the actual model stream instead of only hiding the check UI', async () => {
  let seen: AbortSignal | undefined;
  const adapter = new ScriptAdapter([async (request) => {
    seen = request.signal;
    await new Promise<void>((resolve) => { request.signal?.addEventListener('abort', () => { resolve(); }, { once: true }); });
    return textResponse('OK');
  }]);
  const f = await flowHarness(adapter); const controller = new AbortController();
  try {
    const pending = executeInteraction(f.ctx, { action: 'probe', provider: 'mock', model: 'mock' }, undefined, controller.signal);
    await vi.waitFor(() => { expect(seen).toBeDefined(); }); controller.abort();
    expect((await pending).ok).toBe(false); expect(seen?.aborted).toBe(true); expect(adapter.requests).toHaveLength(1);
    expect((await executeInteraction(f.ctx, { action: 'probe', provider: 'mock', model: 'mock' }, undefined, controller.signal)).ok).toBe(false);
    expect(adapter.requests).toHaveLength(1);
  } finally { controller.abort(); await f.close(); }
});
it.each(['handler_inactive', 'dream_tool_json', 'transport', 'model_auth', 'storage'])('renders a classified %s failure in English without leaking legacy Chinese', (kind) => {
  const text = displayMessage('内部活动失败，请检查后重试。', (_zh, en) => en, messageInfo('内部活动失败，请检查后重试。', kind));
  expect(text).not.toMatch(/[\u4e00-\u9fff]/); expect(text.length).toBeGreaterThan(25);
});

it('recovers unfinished groups from legacy successful Dream progress without treating it as a resumable job', async () => {
  const f = await flowHarness(new ScriptAdapter([]));
  try {
    const queue = new JobQueue(f.knowledge.context()); const job = await queue.enqueue('dream', {});
    const candidate = { group_id: 'unfinished-a', claim_ids: [f.claim.id], kind: 'quality', reason: 'Review candidate.' };
    await f.knowledge.dreamStore().saveProgress(job.id, ProgressSchema.parse({ schemaVersion: 1, discovery: { review: { quality: 'Checked.', evidence: 'No evidence.', consolidation: 'None.' }, candidates: [candidate], sync_candidates: [] }, entries: [{ candidate, status: 'skipped', reason: 'Budget closure.', draft: null, validation: null, review: null }], syncCompleted: [], finished: true, summary: null }));
    await queue.settle(job, 'succeeded', { result: { budgetLimited: true, modelSteps: 1 } });
    expect((await allActivities(f.knowledge))[0]).toMatchObject({ state: 'succeeded', budgetLimited: true, requiresAttention: true, incompleteCandidates: [{ groupId: 'unfinished-a', claimIds: [f.claim.id] }] });
    expect((await queue.read(job.id))?.state).toBe('succeeded');
  } finally { await f.close(); }
});

it('shows inactive queued handlers as paused and preserves their persistent queued state', async () => {
  const f = await flowHarness(new ScriptAdapter([]));
  try {
    const queue = new JobQueue(f.knowledge.context()); const job = await queue.enqueue('recap', {});
    const rows = await allActivities(f.knowledge, () => false);
    expect(activityPage(rows, { attentionOnly: true }).activities[0]).toMatchObject({ id: job.id, state: 'paused', requiresAttention: true, errorInfo: { code: 'task.handler_inactive' } });
    expect((await queue.read(job.id))?.state).toBe('queued');
    expect(await statusCommand(f.knowledge, { failed: true })).toContain(job.id);
    expect((await allActivities(f.knowledge, () => true))[0]?.state).toBe('queued');
  } finally { await f.close(); }
});

it('projects valid public result links and omits malformed IDs', () => {
  expect(activityDetails({ entityIds: ['claim_00000001', 'dispute_00000001', 'trace_00000001'], updatedClaimIds: ['claim_00000001'], privateData: 'hidden' }).entityIds).toEqual(['claim_00000001', 'dispute_00000001', 'trace_00000001']);
  expect(activityDetails({ entityIds: ['not-an-id'] }).entityIds).toEqual([]);
});
