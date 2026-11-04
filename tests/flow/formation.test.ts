// 生产循环、真实命令和回环 HTTP 模型贯通知识形成及生命周期事件。
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { DeepSeekAdapter as MessagesAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import type { DeepSeekAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import type { MockLlmBehavior } from '@deepseek-ai/dsh-llm-mock-server';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { describe, expect, it, vi } from 'vitest';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { FormationStore } from '../../src/formation/checkpoint.js';
import Formation from '../../src/plugins/formation.js';
import { formationOwnership, formationReplay } from '../../src/dsh-adapter/formation-replay.js';
import { resolveConfig } from '../../src/config.js';
import { emptyOutput, newDraft, waitJob } from '../formation/helpers.js';
import { ScriptAdapter, textResponse } from './adapter.js';
import { flowHarness, turn } from './harness.js';

describe('formation in the production host', () => {
  it('reads original events through a fresh persistence host and refuses a different owner', async () => {
    const flow = await flowHarness(new ScriptAdapter([textResponse('Durable public reply.')]), { persistence: true });
    const cold = new Context();
    try {
      const agent = await flow.create(); await turn(agent, 'Durable public task.'); await flow.ctx.sessionPersistence.flush();
      await cold.plugin(Persistence, { root: join(flow.root, 'logs') });
      cold.provide('sessions', { get: () => undefined } as unknown as Context['sessions']);
      const replay = formationReplay(cold, flow.knowledge.config);
      expect(await formationOwnership(cold, flow.knowledge.config)(agent.session.id)).toBe(true);
      expect(await formationOwnership(cold, resolveConfig({ ...flow.knowledge.config, agentId: 'agent-b' }))(agent.session.id)).toBe(false);
      expect(await formationOwnership(cold, flow.knowledge.config)('missing-session')).toBe(false);
      const projections = await replay(agent.session.id);
      expect(JSON.stringify(projections)).toContain('Durable public task.'); expect(JSON.stringify(projections)).toContain('Durable public reply.');
      await expect(formationReplay(cold, resolveConfig({ ...flow.knowledge.config, agentId: 'agent-b' }))(agent.session.id)).rejects.toMatchObject({ kind: 'transcript_source' });
    } finally { await cold.fiber.dispose(); await flow.close(); }
  });
  it('replays the original host log after a failed projection and component reload', async () => {
    const adapter = new ScriptAdapter([textResponse('The service contract has been verified.'), textResponse(JSON.stringify(emptyOutput()))]);
    const flow = await flowHarness(adapter, { formation: true, persistence: true, config: { formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false } } });
    try {
      const agent = await flow.create(); const original = flow.ctx.acnFormation;
      const record = original.transcript.record.bind(original.transcript);
      vi.spyOn(original.transcript, 'record').mockImplementation((id, projection) => projection.entry?.type === 'user'
        ? Promise.reject(Object.assign(new Error('PRIVATE_OCCUPIED_DETAIL'), { code: 'EPERM' })) : record(id, projection));
      await turn(agent, 'Verify the bounded retry behavior.');
      await expect(original.flush(agent.session.id)).rejects.toMatchObject({ kind: 'transcript_occupied' });
      expect(adapter.requests).toHaveLength(1);
      await flow.fibers.formation?.dispose(); await flow.ctx.plugin(Formation);
      const restored = flow.ctx.acnFormation; const job = await restored.recap(agent.session.id);
      if (job === null) throw new Error('Expected replayed Recap');
      await waitJob(restored.worker.queue, job.id);
      expect(adapter.requests).toHaveLength(2);
      expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Verify the bounded retry behavior.');
      expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('The service contract has been verified.');
      expect((await restored.transcript.state(agent.session.id)).recappedThroughSeq).toBeGreaterThan(0);
    } finally { await flow.close(); }
  });
  it.each([{ llm: {}, expected: 32_768 }, { llm: { maxOutputTokens: 8192 }, expected: 8192 }])('passes the resolved output budget to the background model: $expected', async ({ llm, expected }) => {
    const adapter = new ScriptAdapter([textResponse('The task is complete.'), textResponse(JSON.stringify(emptyOutput()))]);
    const flow = await flowHarness(adapter, { formation: true, config: { llm, formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false } } });
    try {
      const agent = await flow.create(); await turn(agent);
      const job = await flow.ctx.acnFormation.finalize(agent.session.id);
      await waitJob(flow.ctx.acnFormation.worker.queue, job.id);
      expect(adapter.requests).toHaveLength(2);
      expect(adapter.requests[1]?.maxTokens).toBe(expected);
    } finally { await flow.close(); }
  });

  it.each([false, true])('normalizes explicit reasoning envelopes while retaining reference validation (invalid=%s)', async (invalid) => {
    const draft = newDraft(); if (invalid) draft.source_claim_ids = ['claim_deadbeef'];
    const response = `REASONING_ONLY_MARKER with {"example":true}. </think>${JSON.stringify({ ...emptyOutput(), new_claims: [draft] })}`;
    const adapter = new ScriptAdapter([textResponse('The public task is complete.'), ...Array.from({ length: invalid ? 2 : 1 }, () => textResponse(response))]);
    const flow = await flowHarness(adapter, { formation: true, config: { llm: { structuredRetries: 2 }, formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false } } });
    try {
      const agent = await flow.create(); await turn(agent); const job = await flow.ctx.acnFormation.finalize(agent.session.id);
      await waitJob(flow.ctx.acnFormation.worker.queue, job.id, invalid ? 'failed' : 'succeeded');
      expect(await new ClaimStore(flow.knowledge.context()).list()).toHaveLength(invalid ? 1 : 2);
      expect(JSON.stringify(await flow.ctx.acnFormation.worker.queue.list())).not.toContain('REASONING_ONLY_MARKER');
      expect(adapter.requests).toHaveLength(invalid ? 3 : 2);
    } finally { await flow.close(); }
  });
  it('formed Claims appear in the next admitted change notice while the session catalog stays frozen', async () => {
    const adapter = new ScriptAdapter([textResponse('checked'), textResponse(JSON.stringify({ ...emptyOutput(), new_claims: [newDraft()] })), textResponse('continued')]);
    const flow = await flowHarness(adapter, { formation: true, config: { formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false } } });
    try {
      const agent = await flow.create(); await turn(agent);
      const job = await flow.ctx.acnFormation.finalize(agent.session.id); await waitJob(flow.ctx.acnFormation.worker.queue, job.id);
      await turn(agent, 'Continue with the service contract.');
      const messages = adapter.requests[2]?.messages;
      expect(JSON.stringify(messages)).toContain('bounded_retry_0');
      expect(JSON.stringify(messages?.find((message) => message.role === 'system'))).not.toContain('bounded_retry_0');
    } finally { await flow.close(); }
  });
  it('compaction forms a valid Claim and Trace; later idle and disposal do not repeat the range', async () => {
    const output = { ...emptyOutput(), new_claims: [newDraft()], used_claim_ids: ['claim_00000001', 'claim_deadbeef'] };
    const adapter = new ScriptAdapter([textResponse('The example contract confirms the retry boundary.'), textResponse(JSON.stringify(output)), textResponse(JSON.stringify({ ...output, used_claim_ids: ['claim_00000001'] }))]);
    const flow = await flowHarness(adapter, { formation: true, config: { formation: { finalizeIdleMinutes: 1, finalizeOnDispose: true } } });
    try {
      const handle = await flow.ctx.agents.create({ sessionId: SessionId('session-a'), agentOptions: { provider: 'mock', model: 'mock' } });
      const formation = flow.ctx.acnFormation;
      await turn(handle.agent, 'Verify the retry contract.'); await formation.flush();
      const until = (await formation.transcript.state('session-a')).lastSeenSeq;
      flow.ctx.emit('session/event', handle.agent.session, { type: 'compaction/summary', seq: until + 1, time: Date.now(), data: { shadowedRange: { start: 0, end: until }, shadowedSeqs: [until] } } as unknown as SessionEvent);
      await formation.flush();
      const recap = (await formation.worker.queue.list()).find((job) => job.kind === 'recap');
      if (recap === undefined) throw new Error('Expected a compaction Recap.');
      await waitJob(formation.worker.queue, recap.id);
      expect(await new ClaimStore(flow.knowledge.context()).list()).toHaveLength(2);
      const traces = await new TraceStore(flow.knowledge.context()).list(); expect(traces).toHaveLength(1);
      expect(traces[0]?.input_claims).toEqual([flow.claim.id]); expect(traces[0]?.output_claims).toHaveLength(1);
      expect((await new FormationStore(flow.knowledge.context()).read('session-a'))?.warnings).toEqual([]);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      flow.ctx.emit('agent/status', { agent: handle.agent, status: 'idle' }); await vi.advanceTimersByTimeAsync(60_000); vi.useRealTimers();
      await formation.flush(); await handle.dispose(); await formation.flush();
      await vi.waitFor(async () => { expect((await formation.worker.queue.list()).every((job) => job.state === 'succeeded')).toBe(true); });
      expect(adapter.requests).toHaveLength(3); expect(await new TraceStore(flow.knowledge.context()).list()).toHaveLength(1);
      await expect(fs.access(flow.knowledge.context().paths.uploads)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.useRealTimers(); await flow.close(); }
  });
  it('auto Finalize fires after idle, cancels its timer on running, and processes the next turn incrementally', async () => {
    const adapter = new ScriptAdapter([textResponse('first answer'), textResponse(JSON.stringify(emptyOutput())), textResponse('second answer'), textResponse(JSON.stringify(emptyOutput()))]);
    const flow = await flowHarness(adapter, { formation: true, config: { formation: { finalizeIdleMinutes: 1, finalizeOnDispose: false } } });
    try {
      const agent = await flow.create(); const formation = flow.ctx.acnFormation;
      await turn(agent, 'First task.'); await formation.flush();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      flow.ctx.emit('agent/status', { agent, status: 'idle' }); flow.ctx.emit('agent/status', { agent, status: 'running' });
      await vi.advanceTimersByTimeAsync(60_000); vi.useRealTimers();
      expect(await formation.worker.queue.list()).toEqual([]);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); flow.ctx.emit('agent/status', { agent, status: 'idle' }); await vi.advanceTimersByTimeAsync(60_000); vi.useRealTimers();
      await formation.flush(); const first = (await formation.worker.queue.list())[0]; if (first === undefined) throw new Error('Expected idle Finalize.'); await waitJob(formation.worker.queue, first.id);
      await turn(agent, 'Second task.'); const next = await formation.finalize(agent.session.id); await waitJob(formation.worker.queue, next.id);
      const background = adapter.requests.filter((request) => request.system?.includes('复盘阶段'));
      expect(background).toHaveLength(2); expect(JSON.stringify(background[1]?.messages)).not.toContain('First task.'); expect(JSON.stringify(background[1]?.messages)).toContain('Second task.');
    } finally { vi.useRealTimers(); await flow.close(); }
  });
  it('manual Finalize, failure status and retry use real command registration without a conversation turn', async () => {
    const adapter = new ScriptAdapter([textResponse('conversation complete'), ...Array.from({ length: 5 }, () => textResponse('invalid')), textResponse(JSON.stringify({ ...emptyOutput(), new_claims: [newDraft()] }))]);
    const flow = await flowHarness(adapter, { formation: true, config: { formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false } } });
    try {
      const agent = await flow.create(); await turn(agent);
      await vi.waitFor(() => { expect(flow.ctx.commands.list(agent).map((command) => command.name)).toContain('acn-finalize'); });
      const execute = (command: string) => flow.ctx.commands.execute(agent, command, [], new AbortController().signal);
      const queued = await execute('/acn-finalize'); expect(queued?.result.kind).toBe('success');
      await flow.ctx.acnFormation.flush(); const job = (await flow.ctx.acnFormation.worker.queue.list())[0]; if (job === undefined) throw new Error('Expected manual Finalize.');
      await waitJob(flow.ctx.acnFormation.worker.queue, job.id, 'failed');
      expect(JSON.stringify(await execute('/acn-status'))).toContain(job.id);
      expect((await execute(`/acn-status retry ${job.id}`))?.result.kind).toBe('success'); await waitJob(flow.ctx.acnFormation.worker.queue, job.id);
      expect(adapter.requests).toHaveLength(7);
      expect(await new ClaimStore(flow.knowledge.context()).list()).toHaveLength(2);
      await flow.fibers.formation?.dispose();
      expect(flow.ctx.commands.list(agent).map((command) => command.name)).not.toContain('acn-finalize'); expect(flow.ctx.commands.list(agent).map((command) => command.name)).toContain('acn-status');
    } finally { await flow.close(); }
  });
  it('child sessions cannot create formation transcripts or execute Finalize', async () => {
    const flow = await flowHarness(new ScriptAdapter([textResponse('child answer')]), { formation: true });
    try {
      const child = await flow.ctx.agents.create({ sessionId: SessionId('child-session'), meta: { origin: 'subagent' }, agentOptions: { provider: 'mock', model: 'mock' } });
      await turn(child.agent); await flow.ctx.acnFormation.flush();
      const result = await flow.ctx.commands.execute(child.agent, '/acn-finalize', [], new AbortController().signal);
      expect(result?.result.kind).toBe('error'); expect(await flow.ctx.acnFormation.transcript.read('child-session')).toEqual([]);
      await expect(fs.access(flow.knowledge.context().paths.transcript('child-session'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await flow.close(); }
  });
  it.each([{ failures: [] }, { failures: ['server_error'] }, { failures: ['service_unavailable'] }] satisfies { failures: MockLlmBehavior[] }[])('uses prepared calls against a loopback adapter, including transient failures: $failures', async ({ failures }) => {
    const output = JSON.stringify({ ...emptyOutput(), new_claims: [newDraft()] });
    const server = await startMockLlmServer({ sequence: ['success', ...failures, 'success'], successText: output });
    const flow = await flowHarness(new ScriptAdapter([]), { formation: true, config: { formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false } } });
    try {
      const adapter = new MessagesAdapter({ options: () => resolveAdapterOptions({ baseURL: `${server.baseURL}/v1`, thinking: 'disabled' }), resolveAuth: () => Promise.resolve({ headers: {} }), resolveUserId: () => randomUUID() as ReturnType<DeepSeekAdapterOptions['resolveUserId']>, prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }) });
      flow.ctx.llm.registerAdapter(['http-model'], adapter);
      const agent = await flow.harness.create(SessionId('http-formation'), { provider: 'http-model', model: 'example-model' });
      await turn(agent); const job = await flow.ctx.acnFormation.finalize(agent.session.id); await waitJob(flow.ctx.acnFormation.worker.queue, job.id);
      expect(server.requests).toHaveLength(2 + failures.length);
      const background = JSON.stringify(server.requests.at(-1)?.body); expect(background).toContain('JSON schema'); expect(background).toContain('source_claim_ids'); expect(background).not.toContain('"tools":');
      expect(await new ClaimStore(flow.knowledge.context()).list()).toHaveLength(2);
    } finally { await server.close(); await flow.close(); }
  });
});
