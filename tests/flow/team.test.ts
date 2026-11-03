// 真实宿主把团队工具、冻结目录、后台内化、变化提示和命令生命周期串起来。
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeConsultRouter } from '../../src/tools/consult-router.js';
import { KnowledgeSessions } from '../../src/knowledge/sessions.js';
import { SessionStateStore } from '../../src/store/session-state.js';
import { InboxStore } from '../../src/store/inbox.js';
import { ClaimStore } from '../../src/store/claims.js';
import { ClaimIdSchema, AgentIdSchema } from '../../src/protocol/ids.js';
import { prepareFormation } from '../../src/formation/prepare.js';
import { inboxFixture, inboxMessage, emptyInternalize, teamServer } from '../team/helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { flowHarness, turn } from './harness.js';
import { ScriptAdapter, textResponse, toolResponse } from './adapter.js';
import { newDraft, waitJob } from '../formation/helpers.js';

const overview = { scopes: [{ scope: 'service / retries', active_claims: 2, stale_claims: 0, open_disputes: 0, resolved_disputes: 0, latest_claim_created_at: '2026-01-01T00:00:00Z' }] };
describe('team host integration', () => {
  it('offers consult_router only in team mode, exposes candidate bodies without retrieval debug, and records only returned sources', async () => {
    const candidate = sampleClaim({ id: ClaimIdSchema.parse('claim_11111111'), holder: AgentIdSchema.parse('agent-b') });
    const server = await teamServer((request) => request.path.endsWith('/overview') ? { body: overview } : request.path === '/health' ? { body: { status: 'ok', team_auth_enabled: false } } : { body: { candidate_claims: [candidate], disputes: [], retrieval_debug: { mode: 'scope', failed_paths: [], error_summaries: [] } } });
    const adapter = new ScriptAdapter([toolResponse('query-a', 'consult_router', { mode: 'query', scope: candidate.scope }), textResponse('Used the returned team evidence.')]);
    const flow = await flowHarness(adapter, { config: { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } } });
    try {
      const agent = await flow.create(); expect(flow.ctx.tools.schemas().map((tool) => tool.name)).toContain('consult_router'); await turn(agent);
      const state = await new SessionStateStore(flow.knowledge.context()).read(agent.session.id); const seen = z.object({ seenSourceIds: z.array(z.string()) }).parse(state).seenSourceIds; expect(seen).toEqual([candidate.id]);
      const output = await executeConsultRouter(flow.knowledge, { mode: 'query', scope: candidate.scope }, agent.session.id); expect(output).not.toHaveProperty('retrieval_debug'); expect(output).toHaveProperty('available', true);
      expect(prepareFormation({ new_claims: [{ ...newDraft(), source_claim_ids: [candidate.id] }], updated_claims: [], used_claim_ids: [], new_disputes: [] }, flow.knowledge.context().agentId, [flow.claim], seen).claims[0]?.source_claim_ids).toEqual([candidate.id]);
      const visible = JSON.stringify(adapter.requests); expect(visible).toContain('Team scope overview');
    } finally { await flow.close(); await server.close(); }
  });
  it('freezes the initial overview across resume/compact and bounds the total catalog', async () => {
    let scope = 'service / first'; const server = await teamServer(() => ({ body: { scopes: [{ ...overview.scopes[0], scope }] } })); const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 }, catalog: { maxChars: 300 } });
    try {
      const sessions = new KnowledgeSessions(fixture.knowledge); await sessions.freeze('session-a', 'startup'); const first = sessions.catalog('session-a'); expect(first).toContain(scope); expect(Array.from(first).length).toBeLessThanOrEqual(300);
      scope = 'service / later'; await sessions.freeze('session-a', 'resume'); await sessions.freeze('session-a', 'compact'); expect(sessions.catalog('session-a')).toBe(first); expect(server.requests).toHaveLength(1);
      await sessions.freeze('session-a', 'clear'); expect(sessions.catalog('session-a')).toContain(scope); expect(server.requests).toHaveLength(2);
    } finally { await fixture.close(); await server.close(); }
  });
  it('degrades authenticated failures to domain tool values and the ordinary conversation continues', async () => {
    const server = await teamServer(() => ({ status: 401 })); const adapter = new ScriptAdapter([toolResponse('query-a', 'consult_router', { mode: 'overview' }), textResponse('Continue the local task.')]); const flow = await flowHarness(adapter, { config: { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } } });
    try {
      const agent = await flow.create(); await turn(agent); expect(adapter.requests).toHaveLength(2);
      const result = await flow.ctx.tools.execute({ name: 'consult_router', arguments: { mode: 'overview' }, agent, callId: ToolCallId('failure-value'), signal: new AbortController().signal }); expect(result.isError).toBe(false); expect(result.value).toMatchObject({ available: false, error: { kind: 'auth' } });
      expect((await flow.knowledge.listClaims()).items).toHaveLength(1);
    } finally { await flow.close(); await server.close(); }
  });
  it('rejects invalid query arguments before network and aborts without extending seen sources', async () => {
    const server = await teamServer(() => ({ delayMs: 100, body: { candidate_claims: [sampleClaim()], disputes: [] } })); const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
    try {
      for (const args of [{ mode: 'query', scope: ' ' }, { mode: 'overview', scope: 'extra' }, { mode: 'query' }]) expect(await executeConsultRouter(fixture.knowledge, args, 'session-a')).toMatchObject({ error: { kind: 'validation' } }); expect(server.requests).toEqual([]);
      const abort = new AbortController(); const result = executeConsultRouter(fixture.knowledge, { mode: 'query', scope: 'service' }, 'session-a', abort.signal); setTimeout(() => { abort.abort(); }, 10); expect(await result).toMatchObject({ available: false, error: { kind: 'cancelled' } });
      expect(await new SessionStateStore(fixture.knowledge.context()).read('session-a')).toBeNull();
    } finally { await fixture.close(); await server.close(); }
  });
  it('runs /inbox with formation disabled, uses the request route, notifies Claim changes, and revokes the dependent command on disposal', async () => {
    const adapter = new ScriptAdapter([textResponse('Checked the task.'), textResponse(JSON.stringify({ ...emptyInternalize(), new_claims: [newDraft()] })), textResponse('Observed the new knowledge.')]);
    const flow = await flowHarness(adapter, { inbox: true, formation: false, config: { inbox: { pullOnSessionStart: false } } });
    try {
      const agent = await flow.create(); await turn(agent); await vi.waitFor(async () => { expect(await fsExists(flow.knowledge.context().paths.lastRoute)).toBe(true); });
      await new InboxStore(flow.knowledge.context()).acceptPulled(inboxMessage());
      const result = await flow.ctx.commands.execute(agent, '/inbox', [], new AbortController().signal); expect(result?.result.kind).toBe('success');
      const jobs = flow.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); const job = (await jobs.queue.list()).find((job) => job.kind === 'inbox'); if (job === undefined) throw new Error('No Inbox job.'); await waitJob(jobs.queue, job.id);
      expect(await new ClaimStore(flow.knowledge.context()).list()).toHaveLength(2); await turn(agent); expect(JSON.stringify(adapter.requests.at(-1))).toContain('acn-claim-changes');
      await flow.fibers.inbox?.dispose(); expect(flow.ctx.commands.list(agent).map((item) => item.name)).not.toContain('inbox'); expect(flow.knowledge.jobs).not.toBeNull();
    } finally { await flow.close(); }
  });
});
async function fsExists(path: string): Promise<boolean> { const fs = await import('node:fs/promises'); try { await fs.access(path); return true; } catch { return false; } }

it('retries a failed initial overview using the structured parameters shown in its recovery hint', async () => {
  let available = false;const server = await teamServer(() => available ? { body: overview } : { status: 503 });
  const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
  try {
    const sessions = new KnowledgeSessions(fixture.knowledge);await sessions.freeze('overview-retry', 'startup');
    const encoded = sessions.catalog('overview-retry').match(/\{"mode":"overview"\}/)?.[0];expect(encoded).toBeDefined();if (!encoded) throw new Error('Missing structured retry parameters.');
    available = true;expect(await executeConsultRouter(fixture.knowledge, JSON.parse(encoded), 'overview-retry')).toMatchObject({ mode: 'overview', available: true, scopes: overview.scopes });
    expect(server.requests.filter((request) => request.path.endsWith('/overview'))).toHaveLength(2);
  } finally { await fixture.close();await server.close(); }
});
