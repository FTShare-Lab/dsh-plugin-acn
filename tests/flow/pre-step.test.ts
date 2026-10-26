// 在真实循环中核对注入与 waterfall 返回值的当前步骤可见性。
import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';
import { ScriptAdapter, textResponse } from './adapter.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'acn-timing-probe': { kind: 'acn-timing-probe' } }
}
const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'acn-timing-probe' } });

describe('pre-step admission on the supported runtime', () => {
  it('inject inside pre-step is deferred until the next step', async () => {
    const ctx = new Context();
    try {
      await mountAgentLoopTestDependencies(ctx);
      const adapter = new ScriptAdapter([textResponse('first'), textResponse('second')]);
      ctx.llm.registerAdapter(['mock'], adapter);
      let injected = false;
      ctx.on('agent/pre-step', ({ agent }, next) => {
        if (!injected) { agent.inject(message('deferred marker')); injected = true; }
        return next();
      });
      const harness = await mountAgentLoopTestHarness(ctx);
      const agent = await harness.create(SessionId('timing-inject'), { provider: 'mock', model: 'mock' });
      agent.followup(message('start'));
      await agent.whenIdle();
      expect(adapter.requests).toHaveLength(2);
      expect(JSON.stringify(adapter.requests[0])).not.toContain('deferred marker');
      expect(JSON.stringify(adapter.requests[1])).toContain('deferred marker');
    } finally { await ctx.fiber.dispose(); }
  });

  it('a pre-step decision appends durable context to the current request without a second request', async () => {
    const ctx = new Context();
    try {
      await mountAgentLoopTestDependencies(ctx);
      const adapter = new ScriptAdapter([textResponse('done')]);
      ctx.llm.registerAdapter(['mock'], adapter);
      ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next();
        return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, message('current marker')] };
      });
      const harness = await mountAgentLoopTestHarness(ctx);
      const agent = await harness.create(SessionId('timing-decision'), { provider: 'mock', model: 'mock' });
      const sources: string[] = [];
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'user/message') sources.push(event.data.source.kind);
      });
      agent.followup(message('start'));
      await agent.whenIdle();
      expect(adapter.requests).toHaveLength(1);
      expect(JSON.stringify(adapter.requests[0])).toContain('current marker');
      expect(sources).toEqual(['acn-timing-probe', 'acn-timing-probe']);
    } finally { await ctx.fiber.dispose(); }
  });
});
