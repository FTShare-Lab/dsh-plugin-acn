// 安装后的空白草稿经过配置重载与恢复，仍能显式初始化、发送和复盘。
import { expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { sampleClaim } from '../knowledge-fixtures.js';
import Knowledge from '../../src/plugins/knowledge.js';
import { resolveConfig } from '../../src/config.js';
import { ClaimStore } from '../../src/store/claims.js';
import { flowHarness, turn } from '../flow/harness.js';
import { ScriptAdapter, textResponse } from '../flow/adapter.js';
import { emptyOutput, newDraft, waitJob } from '../formation/helpers.js';

it.each([false, true])('initializes the reused blank session and forms a Claim after setup (upstreams=%s)', async (upstreams) => {
  const adapter = new ScriptAdapter([textResponse('Verified the retry boundary in the example project.'), textResponse(JSON.stringify({ ...emptyOutput(), new_claims: [newDraft()] }))]);
  const flow = await flowHarness(adapter, { configured: false, persistence: true, formation: true, config: { dream: { enabled: false }, formation: { idleRecap: false }, memory: { review: { enabled: false } } } });
  try {
    const original = await flow.ctx.agents.create({ sessionId: SessionId('reused-blank'), agentOptions: { provider: 'mock', model: 'mock' } });
    await original.dispose();
    await flow.fibers.knowledge.dispose();
    const config = resolveConfig({ ...flow.knowledge.config, agentId: 'agent-a', sessionEpoch: Date.now() + 1000, ...(upstreams ? { upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } } } : {}) });
    await flow.ctx.plugin(Knowledge, config);
    const resumed = await flow.ctx.agents.resume({ resumeSessionId: original.agent.session.id, agentOptions: { provider: 'mock', model: 'mock' } });
    try {
      const pool = flow.ctx.acnRuntime;
      expect(pool.view(resumed.agent.session.header)).toMatchObject({ available: false, locked: false });
      expect((await pool.select(resumed.agent.session.header, upstreams ? 'coding' : 'personal')).available).toBe(true);
      await turn(resumed.agent);
      expect(adapter.requests).toHaveLength(1);
      const services = await pool.service(resumed.agent.session.header);
      const job = await services.formation?.recap(resumed.agent.session.id);
      if (!job || !services.formation) throw new Error('Expected a Recap job.');
      await waitJob(services.formation.worker.queue, job.id);
      expect(await new ClaimStore(services.knowledge.context()).list()).toEqual([expect.objectContaining({ name: 'bounded_retry_0' })]);
      await expect(pool.select(resumed.agent.session.header, upstreams ? 'coding' : 'personal')).rejects.toMatchObject({ kind: 'bound' });
    } finally { await resumed.dispose(); }
  } finally { await flow.close(); }
});

it('retains the same ownership and Claim across disable and restore', async () => {
  const flow = await flowHarness(new ScriptAdapter([textResponse('First task.'), textResponse('Continued in the same identity.')]), { config: { upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } }, dream: { enabled: false }, memory: { review: { enabled: false } } } });
  try {
    const agent = await flow.create(); await turn(agent);
    const original = await flow.ctx.acnRuntime.knowledge(agent.session.header);
    await new ClaimStore(original.context()).write(sampleClaim());
    await flow.fibers.knowledge.dispose();
    const paused = await flow.ctx.plugin(Knowledge, resolveConfig({ ...flow.knowledge.config, upstream: '', upstreams: { coding: { agentId: 'agent-a', enabled: false } } }));
    expect(flow.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ available: false, locked: true });
    await paused.dispose(); await flow.ctx.plugin(Knowledge, flow.knowledge.config);
    await vi.waitFor(() => { expect(flow.ctx.acnRuntime.view(agent.session.header).available).toBe(true); });
    expect((await flow.ctx.acnRuntime.knowledge(agent.session.header)).context().paths.root).toBe(original.context().paths.root);
    expect(await new ClaimStore(original.context()).list()).toHaveLength(1);
    await turn(agent);
  } finally { await flow.close(); }
});

it('does not treat an internal model turn without a human message as an initializable blank session', async () => {
  const flow = await flowHarness(new ScriptAdapter([textResponse('Internal work completed.')]), { config: { upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' }, review: { agentId: 'agent-b' } }, dream: { enabled: false } } });
  try {
    const agent = await flow.create();
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the internal task.' }], source: { kind: 'acn-formation' } }));
    await agent.whenIdle();
    expect(agent.session.snapshotEvents().some((event) => event.type === 'user/message' && event.data.source.kind === 'user')).toBe(false);
    expect(flow.ctx.acnRuntime.view(agent.session.header).locked).toBe(true);
    await expect(flow.ctx.acnRuntime.select(agent.session.header, 'review')).rejects.toMatchObject({ kind: 'bound' });
  } finally { await flow.close(); }
});
