// 传输重试与结构重试独立；失败文本、凭据提示和模型正文不进入任务或审计。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { formationFixture, emptyOutput, waitJob } from './helpers.js';

describe('auxiliary call transport policy', () => {
  it('retries a transient transport at most three calls per job attempt and uses durable backoff', async () => {
    let calls = 0;
    const fixture = await formationFixture(() => {
      calls += 1;
      if (calls <= 4) return Promise.reject(Object.assign(new Error('PRIVATE_FAILURE_MARKER'), { code: 'SERVER_ERROR', status: 503 }));
      return Promise.resolve({ text: JSON.stringify(emptyOutput()), usage: { inputTokens: 12, outputTokens: 5 } });
    });
    try {
      await fixture.formation.start(); fixture.formation.capture('session-a', { route: { provider: 'mock', model: 'mock' }, entry: { seq: 0, type: 'user', text: 'PRIVATE_INPUT_MARKER' } });
      const job = await fixture.formation.finalize('session-a'); expect(await waitJob(fixture.formation.worker.queue, job.id)).toMatchObject({ attempts: 2 }); expect(calls).toBe(5);
      const context = fixture.knowledge.context(); const file = (await fs.readdir(context.paths.llmCalls)).find((file) => file.endsWith('.jsonl'));
      const audit = await fs.readFile(join(context.paths.llmCalls, file ?? ''), 'utf8'); expect(audit.trim().split('\n')).toHaveLength(5); expect(audit).not.toContain('PRIVATE_'); expect(JSON.stringify(await fixture.formation.worker.queue.list())).not.toContain('PRIVATE_');
    } finally { await fixture.close(); }
  });
  it('does not retry missing credentials or expose the underlying provider failure', async () => {
    let calls = 0; const fixture = await formationFixture(() => { calls += 1; return Promise.reject(Object.assign(new Error('PRIVATE_FAILURE_MARKER'), { code: 'MISSING_CREDENTIAL' })); });
    try {
      await fixture.formation.start(); fixture.formation.capture('session-a', { route: { provider: 'mock', model: 'mock' }, entry: { seq: 0, type: 'user', text: 'Review the service contract.' } });
      const job = await fixture.formation.finalize('session-a'); const failed = await waitJob(fixture.formation.worker.queue, job.id, 'failed');
      expect(calls).toBe(1); expect(failed.lastError).toContain('凭据配置'); expect(failed.lastError).not.toContain('PRIVATE_');
    } finally { await fixture.close(); }
  });
  it('end-to-end timeout cancels the backend, persists retry exhaustion and unload aborts an in-flight call', async () => {
    let calls = 0; const aborted: number[] = [];
    const fixture = await formationFixture((_route, _system, _input, _max, signal) => new Promise((_resolve, reject) => {
      calls += 1; const call = calls;
      signal.addEventListener('abort', () => { aborted.push(call); reject(new Error('aborted')); }, { once: true });
    }), { llm: { timeoutMs: 10 } });
    try {
      await fixture.formation.start(); fixture.formation.capture('session-a', { route: { provider: 'mock', model: 'mock' }, entry: { seq: 0, type: 'user', text: 'Review the service contract.' } });
      const job = await fixture.formation.finalize('session-a'); const failed = await waitJob(fixture.formation.worker.queue, job.id, 'failed');
      expect(failed.attempts).toBe(5); expect(calls).toBe(15); expect(aborted).toHaveLength(15);
      await fixture.formation.worker.retry(job.id);
      await vi.waitFor(() => { expect(calls).toBeGreaterThan(15); }, { interval: 1 });
      await fixture.formation.close(); expect(aborted).toHaveLength(calls);
      expect((await fixture.formation.worker.queue.read(job.id))?.state).toBe('queued');
    } finally { await fixture.close(); }
  });
});
