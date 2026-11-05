// 真实宿主串起模型错误、领域任务、持久状态及活动接口，错误正文始终留在边界外。
import { describe, expect, it, vi } from 'vitest';
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Job } from '../../src/worker/types.js';
import { executeInteraction } from '../../src/dsh-adapter/interaction-service.js';
import { ClaimStore } from '../../src/store/claims.js';
import { InboxStore } from '../../src/store/inbox.js';
import { waitJob } from '../formation/helpers.js';
import { inboxMessage, emptyInternalize } from '../team/helpers.js';
import { ScriptAdapter, textResponse, toolResponse } from './adapter.js';
import { flowHarness, turn } from './harness.js';

type Kind = 'recap' | 'finalize' | 'inbox' | 'dream';
const failedResponse = (failure: LlmFailure): StreamChunk[] => [{ type: 'finish', reason: { kind: 'error', failure } }];
const foreground = (kind: Kind) => ['recap', 'finalize'].includes(kind);

async function request(f: Awaited<ReturnType<typeof flowHarness>>, kind: Kind): Promise<Job> {
  if (kind === 'dream') return f.ctx.acnDream.request();
  if (kind === 'inbox') { await new InboxStore(f.knowledge.context()).acceptPulled(inboxMessage()); return f.ctx.acnInbox.enqueue(false); }
  const agent = await f.create(); await turn(agent);
  if (kind === 'recap') { const job = await f.ctx.acnFormation.recap(agent.session.id); if (!job) throw new Error('Missing Recap job.'); return job; }
  if (kind === 'finalize') return f.ctx.acnFormation.finalize(agent.session.id);
  return f.ctx.acnFormation.finalize(agent.session.id);

}

async function fixture(kind: Kind, script: StreamChunk[][]) {
  const adapter = new ScriptAdapter([...(foreground(kind) ? [textResponse('Verified the example contract.')] : []), ...script]);
  const flow = await flowHarness(adapter, { formation: kind === 'recap' || kind === 'finalize', inbox: kind === 'inbox', dream: kind === 'dream', config: { llm: { provider: 'mock', model: 'mock', structuredRetries: 2 }, formation: { idleRecap: false, finalizeOnDispose: false } } });
  return { flow, adapter };
}

describe('background model failure visibility and recovery', () => {
  it.each((['recap', 'finalize', 'inbox', 'dream'] as const).flatMap((kind) => ['AUTH', 'MALFORMED_RESPONSE'].map((code) => ({ kind, code }))))('preserves $code for $kind in the task and activity API without applying model output', async ({ kind, code }) => {
    const { flow: f, adapter } = await fixture(kind, [failedResponse({ code, message: 'PRIVATE_PROVIDER_FAILURE_MARKER', ...(code === 'AUTH' ? { status: 401 } : {}) })]);
    try {
      const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      const job = await request(f, kind); const failed = await waitJob(worker.queue, job.id, 'failed');
      expect(failed.attempts).toBe(1); expect(failed.lastError).toContain(code); expect(failed.lastError).not.toContain('PRIVATE_PROVIDER_FAILURE_MARKER');
      expect(failed.lastError).not.toContain('子会话未正常结束'); expect(adapter.requests).toHaveLength(foreground(kind) ? 2 : 1);
      const view = await executeInteraction(f.ctx, { action: 'activity', key: 'personal' });
      expect(view.ok).toBe(true); expect(view.knowledge?.activities.find((activity) => activity.id === job.id)?.error).toBe(failed.lastError);
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
      if (kind === 'inbox') expect(await new InboxStore(f.knowledge.context()).listPending()).toHaveLength(1);
      if (kind === 'dream') expect((await f.knowledge.dreamStore().progress(job.id))?.autonomy?.steps).toBe(1);
    } finally { await f.close(); }
  });
  it.each((['inbox'] as const).flatMap((kind) => [false, true].map((recover) => ({ kind, recover }))))('handles malformed JSON for $kind with bounded structural correction (recover=$recover)', async ({ kind, recover }) => {
    const valid = emptyInternalize();
    const { flow: f, adapter } = await fixture(kind, [textResponse('{'), textResponse(recover ? JSON.stringify(valid) : '{')]);
    try {
      const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      const job = await request(f, kind); const result = await waitJob(worker.queue, job.id, recover ? 'succeeded' : 'failed');
      expect(adapter.requests).toHaveLength(kind === 'inbox' ? 2 : 3); expect(result.attempts).toBe(1);
      expect(adapter.requests.at(-1)?.system).toContain('JSON 解析失败');
      if (!recover) expect(result.lastError).toContain('JSON 语法');
      if (kind === 'inbox') expect(await new InboxStore(f.knowledge.context()).listPending()).toHaveLength(recover ? 0 : 1);
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
    } finally { await f.close(); }
  });
  it.each(['tokens', 'tool'] as const)('distinguishes repeated structured %s output failures', async (mode) => {
    const response: StreamChunk[] = mode === 'tokens' ? textResponse('{').map((chunk) => chunk.type === 'finish' ? { type: 'finish', reason: { kind: 'max-tokens' } } : chunk) : toolResponse('unexpected', 'claim', { action: 'list' });
    const { flow: f, adapter } = await fixture('finalize', [response, response]);
    try {
      const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      const job = await request(f, 'finalize'); const result = await waitJob(worker.queue, job.id, 'failed');
      expect(result.lastError).toContain(mode === 'tokens' ? 'MAX_TOKENS' : '工具调用'); expect(adapter.requests).toHaveLength(3);
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
    } finally { await f.close(); }
  });
  it.each([
    { code: 'QUOTA', label: 'QUOTA' }, { code: 'CONTEXT_WINDOW_EXCEEDED', label: 'CONTEXT_WINDOW_EXCEEDED' }, { code: 'EMPTY_RESPONSE', label: 'EMPTY_RESPONSE' },
  ])('keeps the terminal Dream $code category without stacking worker retries', async ({ code, label }) => {
    const { flow: f, adapter } = await fixture('dream', [failedResponse({ code, message: 'PRIVATE_PROVIDER_FAILURE_MARKER' })]);
    try {
      const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      const result = await waitJob(worker.queue, (await request(f, 'dream')).id, 'failed');
      expect(result.lastError).toContain(label); expect(result.lastError).not.toContain('PRIVATE_'); expect(result.attempts).toBe(1); expect(adapter.requests).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('reports the Dream output ceiling separately and keeps the unfinished progress', async () => {
    const { flow: f } = await fixture('dream', [[{ type: 'finish', reason: { kind: 'max-tokens' } }]]);
    try {
      const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      const job = await request(f, 'dream'); expect((await waitJob(worker.queue, job.id, 'failed')).lastError).toContain('MAX_TOKENS');
      expect((await f.knowledge.dreamStore().progress(job.id))?.finished).toBe(false);
    } finally { await f.close(); }
  });
  it('retains the cause when Dream fails before the model stream starts', async () => {
    const adapter = new ScriptAdapter([]);
    const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'unregistered', model: 'example-model' } } });
    try {
      const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      const job = await f.ctx.acnDream.request();
      expect((await waitJob(worker.queue, job.id, 'failed')).lastError).toContain('NO_ADAPTER'); expect(adapter.requests).toHaveLength(0);
    } finally { await f.close(); }
  });
  it('persists Retry-After instead of immediately exhausting structured request retries', async () => {
    const { flow: f, adapter } = await fixture('finalize', [failedResponse({ code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 60_000, message: 'PRIVATE_PROVIDER_FAILURE_MARKER' })]);
    try {
      const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      const earliest = Date.now() + 60_000; const job = await request(f, 'finalize');
      await vi.waitFor(async () => { const current = await worker.queue.read(job.id); expect(current?.state).toBe('queued'); expect(current?.nextRunAt).toBeGreaterThanOrEqual(earliest); });
      expect(adapter.requests).toHaveLength(2); expect((await worker.queue.read(job.id))?.attempts).toBe(1);
      expect((await worker.queue.read(job.id))?.lastError).toContain('至少等待 60 秒');
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
    } finally { await f.close(); }
  });
});
