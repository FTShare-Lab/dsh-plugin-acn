// 通过真实 HTTP 适配器和宿主子会话验证坏 JSON 的有限恢复，不绕过领域校验。
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DeepSeekAdapter as MessagesAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import type { DeepSeekAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { describe, expect, it } from 'vitest';
import { ClaimStore } from '../../src/store/claims.js';
import { qualityDraft, reviewSummary } from '../dream/helpers.js';
import { waitJob } from '../formation/helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { ScriptAdapter } from './adapter.js';
import { flowHarness } from './harness.js';

type Reply = { name: string; args: string };
const badQuote: Reply = { name: 'dream_stage_group', args: '{"group_id":"bad-quote","group":{"reason":"PRIVATE_BODY_MARKER"oops"}}' };
const unclosed: Reply = { name: 'dream_stage_group', args: '{"group_id":"unclosed","group":{' };
const read: Reply = { name: 'read_claim', args: JSON.stringify({ id: sampleClaim().id }) };
const finish: Reply = { name: 'dream_finish', args: JSON.stringify({ review: reviewSummary }) };
function currentRuntimeContext(request: string | undefined): string | undefined {
  if (request === undefined) throw new Error('Missing model request.');
  const body = JSON.parse(request) as { messages: { content: { type: string; text?: string }[] }[] };
  return body.messages.flatMap((message) => message.content).filter((block) => block.type === 'text' && block.text?.startsWith('Current runtime context.')).at(-1)?.text;
}

async function modelServer(script: Reply[]) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => { parts.push(part); });
    request.on('end', () => {
      requests.push(Buffer.concat(parts).toString());
      const reply = script[requests.length - 1];
      if (reply === undefined) { response.writeHead(500); response.end('Test script exhausted.'); return; }
      const frames = [
        { type: 'message_start', message: { id: `message-${requests.length}`, type: 'message', role: 'assistant', model: 'example-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call-${requests.length}`, name: reply.name, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: reply.args } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing model server address.');
  const adapter = new MessagesAdapter({
    options: () => resolveAdapterOptions({ baseURL: `http://127.0.0.1:${address.port}/v1`, thinking: 'disabled' }),
    resolveAuth: () => Promise.resolve({ headers: {} }),
    resolveUserId: () => randomUUID() as ReturnType<DeepSeekAdapterOptions['resolveUserId']>,
    prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  });
  return { adapter, requests, close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); server.closeAllConnections(); }) };
}

describe('Dream tool JSON recovery in the production host', () => {
  it('retries broken quotes and unclosed input, then continues through the original tool guards', async () => {
    const model = await modelServer([badQuote, unclosed, read, { name: 'dream_stage_group', args: JSON.stringify({ group_id: 'schema-invalid', group: { kind: 'quality', operations: [] } }) }, finish]);
    const f = await flowHarness(new ScriptAdapter([]), { dream: true, config: { llm: { provider: 'http-model', model: 'example-model' } } });
    try {
      f.ctx.llm.registerAdapter(['http-model'], model.adapter);
      f.ctx.systemPrompt.context({ name: 'private-example', order: 0, text: 'PRIVATE_CONTEXT_MARKER', required: true });
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      expect((await waitJob(worker.queue, job.id)).result).toMatchObject({ modelSteps: 5, wrapUpSteps: 0 });
      expect(model.requests).toHaveLength(5);
      for (const request of model.requests.slice(1, 3)) {
        expect(request).toContain('工具参数 JSON 解析失败');
        expect(request).toContain('工具调用均未执行');
        expect(request).toContain('重新发出');
        expect(request).toContain('完整合法的 JSON 对象');
        expect(request).not.toContain('PRIVATE_BODY_MARKER');
        // 解析失败的响应没有成为宿主工具调用，不能伪造不配对的工具结果。
        expect(request).not.toContain('call-1'); expect(request).not.toContain('call-2');
      }
      expect(model.requests[4]).toContain('group.reason: invalid_type');
      expect(currentRuntimeContext(model.requests[3])).not.toContain('工具参数 JSON 解析失败');
      expect(currentRuntimeContext(model.requests[4])).not.toContain('工具参数 JSON 解析失败');
      expect(model.requests.join('')).not.toContain('PRIVATE_CONTEXT_MARKER');
      expect(model.requests.slice(2).join('')).not.toContain('PRIVATE_BODY_MARKER');
      const progress = await f.knowledge.dreamStore().progress(job.id);
      expect(progress?.entries).toEqual([]); expect(progress?.autonomy?.read_ids).toEqual([f.claim.id]);
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
    } finally { await f.close(); await model.close(); }
  });
  it('keeps the two-retry cap across successful tool calls between malformed responses', async () => {
    const model = await modelServer([badQuote, read, unclosed, read, badQuote, finish]);
    const f = await flowHarness(new ScriptAdapter([]), { dream: true, config: { llm: { provider: 'http-model', model: 'example-model' } } });
    try {
      f.ctx.llm.registerAdapter(['http-model'], model.adapter);
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      expect((await waitJob(worker.queue, job.id, 'failed')).lastError).toContain('自动重试两次后仍失败');
      expect(model.requests).toHaveLength(5);
      expect(model.requests[1]).toContain('工具参数 JSON 解析失败');
      expect(model.requests[3]).toContain('工具参数 JSON 解析失败');
      expect((await f.knowledge.dreamStore().progress(job.id))?.autonomy).toMatchObject({ steps: 5, read_ids: [f.claim.id] });
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
    } finally { await f.close(); await model.close(); }
  });
  it('stops after two extra retries, preserves accepted progress, and does not delegate an unbounded retry', async () => {
    const model = await modelServer([read, { name: 'dream_stage_group', args: JSON.stringify({ group_id: 'accepted', group: qualityDraft([sampleClaim()]) }) }, badQuote, unclosed, badQuote, finish]);
    const f = await flowHarness(new ScriptAdapter([]), { dream: true, config: { llm: { provider: 'http-model', model: 'example-model' } } });
    let delegated = 0;
    try {
      f.ctx.llm.registerAdapter(['http-model'], model.adapter);
      f.ctx.on('agent/request-error', () => { delegated += 1; return Promise.resolve({ kind: 'retry' }); });
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      const failed = await waitJob(worker.queue, job.id, 'failed');
      expect(failed.attempts).toBe(1); expect(failed.lastError).toContain('工具参数格式无效'); expect(failed.lastError).toContain('自动重试两次后仍失败');
      expect(failed.lastError).not.toContain('PRIVATE_BODY_MARKER'); expect(failed.lastError).not.toContain('子会话未正常结束');
      expect(delegated).toBe(0); expect(model.requests).toHaveLength(5);
      const progress = await f.knowledge.dreamStore().progress(job.id);
      expect(progress?.autonomy).toMatchObject({ steps: 5, read_ids: [f.claim.id] });
      expect(progress?.entries).toHaveLength(1); expect(progress?.entries[0]).toMatchObject({ candidate: { group_id: 'accepted' }, status: 'pending' });
      expect(progress?.entries[0]?.draft).not.toBeNull(); expect(progress?.finished).toBe(false);
      expect(await f.knowledge.dreamStore().final(job.id)).toBeNull();
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
    } finally { await f.close(); await model.close(); }
  });
  it('does not exceed the existing exploration and closing budgets while retrying', async () => {
    const model = await modelServer([badQuote, unclosed, finish]);
    const f = await flowHarness(new ScriptAdapter([]), { dream: true, config: { llm: { provider: 'http-model', model: 'example-model' }, dream: { maxModelSteps: 1, maxWrapUpSteps: 1 } } });
    try {
      f.ctx.llm.registerAdapter(['http-model'], model.adapter);
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      expect((await waitJob(worker.queue, job.id)).result).toMatchObject({ modelSteps: 1, wrapUpSteps: 1, budgetLimited: true });
      expect(model.requests).toHaveLength(2); expect(model.requests[1]).toContain('wrap_up');
      expect(model.requests[1]).toContain('工具参数 JSON 解析失败');
      expect((await f.knowledge.dreamStore().progress(job.id))?.entries).toEqual([]);
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual([f.claim]);
    } finally { await f.close(); await model.close(); }
  });
  it.each([
    { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages SSE contains invalid JSON' },
    { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: invalid block index' },
    { code: 'AUTH_FAILED', message: 'tool input is invalid JSON' },
  ])('delegates other failures without using the format retry allowance: $code / $message', async (failure) => {
    const adapter = new ScriptAdapter([[{ type: 'finish', reason: { kind: 'error', failure } }]]);
    const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'mock', model: 'mock' } } });
    let delegated = 0;
    try {
      f.ctx.on('agent/request-error', () => { delegated += 1; return Promise.resolve(undefined); });
      const job = await f.ctx.acnDream.request(); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.');
      expect((await waitJob(worker.queue, job.id, 'failed')).lastError).not.toContain('工具参数格式无效');
      expect(delegated).toBe(1); expect(adapter.requests).toHaveLength(1);
      expect(JSON.stringify(adapter.requests)).not.toContain('工具参数 JSON 解析失败');
    } finally { await f.close(); }
  });
});
