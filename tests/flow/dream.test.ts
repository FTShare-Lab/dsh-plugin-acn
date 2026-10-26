// 真实宿主命令、路由与上下文刷新贯通整理插件，子会话不能触发后台整理。
import { SessionId } from '@deepseek-ai/dsh-session';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import { phaseBackend, until } from '../dream/helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { waitJob } from '../formation/helpers.js';
import { ClaimStore } from '../../src/store/claims.js';
import { ScriptAdapter, textResponse } from './adapter.js';
import { flowHarness, turn } from './harness.js';

function requestText(request: GenerateOptions): string { return request.messages.flatMap((message) => message.content).filter((block) => block.type === 'text').map((block) => block.text).join(''); }
describe('Dream in production host', () => {
  it('runs /dream through the prepared model route and admits a foreground change notice', async () => {
    const backend = phaseBackend([sampleClaim()]); const reply = async (request: GenerateOptions) => textResponse((await backend({ provider: 'mock', model: 'mock' }, request.system ?? '', requestText(request), 4000, new AbortController().signal)).text);
    const adapter = new ScriptAdapter([textResponse('Checked the current contract.'), reply, reply, reply, textResponse('Continued after knowledge maintenance.')]);
    const f = await flowHarness(adapter, { dream: true });
    try { const agent = await f.create(); await turn(agent); const result = await f.ctx.commands.execute(agent, '/dream', [], new AbortController().signal); expect(result?.result.kind).toBe('success'); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.'); const job = (await worker.queue.list()).find((item) => item.kind === 'dream'); if (!job) throw new Error('Missing Dream job.'); await waitJob(worker.queue, job.id); expect(adapter.requests).toHaveLength(4); expect(adapter.requests.slice(1).every((request) => request.tools === undefined || request.tools.length === 0)).toBe(true); expect((await new ClaimStore(f.knowledge.context()).list())[0]?.status).toBe('deprecated'); await turn(agent); expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('deprecated'); await f.fibers.dream?.dispose(); expect(f.ctx.commands.list(agent).some((command) => command.name === 'dream')).toBe(false); }
    finally { await f.close(); }
  });
  it('rejects child trigger/stop and invalid arguments without invoking a model', async () => {
    const adapter = new ScriptAdapter([]); const f = await flowHarness(adapter, { dream: true });
    try { const child = await f.ctx.agents.create({ sessionId: SessionId('child-session'), meta: { origin: 'subagent' }, agentOptions: { provider: 'mock', model: 'mock' } }); for (const command of ['/dream', '/dream stop']) expect((await f.ctx.commands.execute(child.agent, command, [], new AbortController().signal))?.result.kind).toBe('error'); const agent = await f.create(); expect((await f.ctx.commands.execute(agent, '/dream unknown', [], new AbortController().signal))?.result.kind).toBe('error'); expect((await f.ctx.commands.execute(agent, '/dream stop', [], new AbortController().signal))?.result.kind).toBe('success'); expect(adapter.requests).toEqual([]); }
    finally { await f.close(); }
  });
  it('checks eligibility on agent creation, then honors disabled configuration', async () => {
    for (const enabled of [true, false]) {
      const adapter = new ScriptAdapter([textResponse(JSON.stringify({ review: { quality: 'Keep original.', evidence: 'Unavailable.', consolidation: 'Separate knowledge is useful.' }, candidates: [], sync_candidates: [] }))]);
      const f = await flowHarness(adapter, { dream: true, config: { llm: { provider: 'mock', model: 'mock' }, dream: { enabled, minChangedClaims: 1 } } });
      try { const agent = await f.ctx.agents.create({ sessionId: SessionId('auto-session'), agentOptions: { provider: 'mock', model: 'mock' } }); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.'); if (enabled) { await until(async () => (await worker.queue.list()).some((job) => job.kind === 'dream')); const job = (await worker.queue.list())[0]; if (!job) throw new Error('Missing job.'); await waitJob(worker.queue, job.id); expect(adapter.requests).toHaveLength(1); } else { expect((await f.ctx.commands.execute(agent.agent, '/dream', [], new AbortController().signal))?.result.kind).toBe('error'); expect(await worker.queue.list()).toEqual([]); } }
      finally { await f.close(); }
    }
  });
});
