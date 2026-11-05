// 首轮并发不能改变已准入的知识归属，工具写入必须与模型上下文一致。
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { KnowledgeSessions } from '../../src/knowledge/sessions.js';
import { pluginRecordOf } from '@deepseek-ai/dsh-session';
import { flowHarness, turn } from '../flow/harness.js';
import { ScriptAdapter, textResponse, toolResponse } from '../flow/adapter.js';
import { ClaimStore } from '../../src/store/claims.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { executeInteraction } from '../../src/dsh-adapter/interaction-service.js';

describe('additional release boundary probes', () => {
  it('rejects a pending selection if a user turn has started before the selection commits', async () => {
    let releaseRead = () => {}; const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let enteredRead = () => {}; const reading = new Promise<void>((resolve) => { enteredRead = resolve; });
    let releaseModel = () => {}; const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
    let enteredModel = () => {}; const requesting = new Promise<void>((resolve) => { enteredModel = resolve; });
    const adapter = new ScriptAdapter([async () => { enteredModel(); await modelGate; return toolResponse('race-claim', 'claim', { action: 'list' }); }, textResponse('Alpha response.')]);
    const f = await flowHarness(adapter, { formation: true, config: {
      upstream: 'alpha', upstreams: { alpha: { agentId: 'agent-a' }, beta: { agentId: 'agent-b' } },
      llm: { provider: 'mock', model: 'mock' }, formation: { idleRecap: false }, dream: { enabled: false },
    } });
    let running: Promise<void> | undefined;
    try {
      const pool = f.ctx.acnRuntime; const alpha = await pool.activate('alpha');
      await new ClaimStore(alpha.context()).write(sampleClaim({ name: 'ALPHA_CONTEXT_ONLY' }));
      const agent = await f.create('selection-race');
      const catalog = (await import('../../src/knowledge/sessions.js')).KnowledgeSessions;
      // 原方法仅以 .call(this) 调用，保留当前目录实例。
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const nativeFlush = catalog.prototype.flush;
      let first = true;
      vi.spyOn(catalog.prototype, 'flush').mockImplementation(async function (this: KnowledgeSessions, id) { if (first) { first = false; enteredRead(); await readGate; } return nativeFlush.call(this, id); });
      const selecting = executeInteraction(f.ctx, { action: 'select', sessionId: agent.session.id, key: 'beta' }, pool);
      await reading;
      running = turn(agent, 'Continue the alpha task.'); await requesting;
      releaseRead(); const result = await selecting;
      const after = pool.view(agent.session.header);
      releaseModel(); await running;
      const current = await pool.knowledge(agent.session.header);
      expect(JSON.stringify(adapter.requests[0])).toContain('ALPHA_CONTEXT_ONLY');
      expect(result.ok).toBe(false);
      expect(after.key).toBe('alpha');
      expect((await current.snapshot()).claims).toContainEqual(expect.objectContaining({ name: 'ALPHA_CONTEXT_ONLY' }));
      expect((await (await pool.activate('beta')).snapshot()).claims).toEqual([]);
    } finally { releaseRead(); releaseModel(); await running; vi.restoreAllMocks(); await f.close(); }
  });

  it('keeps identity aligned under native concurrent selection and first turn without delays or method replacement', async () => {
    const adapter = new ScriptAdapter(Array.from({ length: 60 }, () => textResponse('Native race response.')));
    const f = await flowHarness(adapter, { config: {
      upstream: 'alpha', upstreams: { alpha: { agentId: 'agent-a' }, beta: { agentId: 'agent-b' } },
      llm: { provider: 'mock', model: 'mock' }, dream: { enabled: false },
    } });
    try {
      const pool = f.ctx.acnRuntime; const alpha = await pool.activate('alpha');
      await new ClaimStore(alpha.context()).write(sampleClaim({ name: 'NATIVE_ALPHA_CONTEXT' }));
      let crossed = 0; let rejected = 0; let ordered = 0; let changedAfterStart = 0;
      f.ctx.on('session/event', (session, event) => {
        const record = pluginRecordOf(event);
        if (record?.type === 'plugin:acn/team-selection' && z.object({ key: z.literal('beta') }).safeParse(record.data).success && session.snapshotEvents().some((item) => item.type === 'turn/start' || item.type === 'request/header')) {
          changedAfterStart += 1;
        }
      });
      for (let i = 0; i < 60; i += 1) {
        const agent = await f.create(`native-race-${i}`); const index = adapter.requests.length;
        let selection: Promise<Awaited<ReturnType<typeof executeInteraction>>>; let running: Promise<void>;
        if (i % 2 === 0) { selection = executeInteraction(f.ctx, { action: 'select', sessionId: agent.session.id, key: 'beta' }, pool); running = (async () => { for (let phase = 0; phase < Math.floor(i / 2) % 10; phase += 1) await Promise.resolve(); await turn(agent, 'Native concurrent task.'); })(); }
        else { running = turn(agent, 'Native concurrent task.'); selection = executeInteraction(f.ctx, { action: 'select', sessionId: agent.session.id, key: 'beta' }, pool); }
        const [result] = await Promise.all([selection, running]);
        if (!result.ok) rejected += 1;
        else if (JSON.stringify(adapter.requests[index]).includes('NATIVE_ALPHA_CONTEXT')) crossed += 1;
        else ordered += 1;
      }
      expect(crossed).toBe(0);
      expect(changedAfterStart).toBe(0);
      expect(rejected + ordered + crossed).toBe(60);
    } finally { await f.close(); }
  }, 45000);

});
