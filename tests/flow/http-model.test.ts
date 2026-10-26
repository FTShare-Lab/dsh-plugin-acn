// 回环模型服务与真实 HTTP 适配器核对工具 schema、执行和结果回传。
import { randomUUID } from 'node:crypto';
import { DeepSeekAdapter as MessagesAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import type { DeepSeekAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { SessionId } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';
import { ScriptAdapter } from './adapter.js';
import { flowHarness, turn } from './harness.js';

describe('Claim tools through a loopback model endpoint', () => {
  it.each(['list', 'read', 'update'] as const)('round-trips a model-driven %s call', async (action) => {
    const flow = await flowHarness(new ScriptAdapter([]));
    const { revision } = await flow.knowledge.readClaim(flow.claim.id);
    const args = action === 'list' ? { action } : action === 'read' ? { action, id: flow.claim.id } : { action, id: flow.claim.id, expected_revision: revision, statement: 'Revised through the model endpoint.' };
    const server = await startMockLlmServer({ sequence: ['tool_call_success', 'success'], toolName: 'claim', toolArguments: JSON.stringify(args), successText: 'done' });
    try {
      const adapter = new MessagesAdapter({
        options: () => resolveAdapterOptions({ baseURL: `${server.baseURL}/v1`, thinking: 'disabled' }),
        resolveAuth: () => Promise.resolve({ headers: {} }),
        resolveUserId: () => randomUUID() as ReturnType<DeepSeekAdapterOptions['resolveUserId']>,
        prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
      });
      flow.ctx.llm.registerAdapter(['http-model'], adapter);
      const agent = await flow.harness.create(SessionId('http-model-session'), { provider: 'http-model', model: 'example-model' });
      await turn(agent);
      expect(server.requests).toHaveLength(2);
      const first = JSON.stringify(server.requests[0]?.body);
      const last = JSON.stringify(server.requests[1]?.body);
      expect(first).toContain('claim'); expect(first).toContain('additionalProperties');
      expect(last).toContain('tool_result');
      expect(last).toContain(action === 'list' ? 'items' : 'sha256-v1:');
      if (action === 'update') expect((await flow.knowledge.readClaim(flow.claim.id)).claim.statement).toBe('Revised through the model endpoint.');
    } finally { await server.close(); await flow.close(); }
  });
});
