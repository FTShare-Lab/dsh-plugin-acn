// 回环测试服务记录真实 HTTP 信封；临时身份凭据只存在进程环境中。
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConfig, type ConfigInput } from '../../src/config.js';
import { AcnKnowledge } from '../../src/knowledge/service.js';
import { AcnInbox } from '../../src/inbox/service.js';
import type { StructuredBackend } from '../../src/llm/structured.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import { InboxMessageSchema, type InboxMessage } from '../../src/protocol/inbox.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import type { Claim } from '../../src/protocol/claim.js';
import { ClaimIdSchema, AgentIdSchema } from '../../src/protocol/ids.js';

export interface Request { path: string; body: unknown; method: string }
export interface Reply { status?: number; body?: unknown; raw?: string; delayMs?: number; stream?: (response: ServerResponse) => void }
export async function teamServer(handler: (request: Request) => Reply | Promise<Reply>, port = 0) {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    const run = async () => {
      let raw = ''; for await (const chunk of request) raw += String(chunk);
      const item = { path: request.url ?? '', body: raw ? JSON.parse(raw) as unknown : null, method: request.method ?? '' }; requests.push(item);
      const reply = await handler(item);
      if (reply.delayMs) await new Promise<void>((resolve) => { setTimeout(resolve, reply.delayMs); });
      response.statusCode = reply.status ?? 200;
      response.setHeader('Content-Type', 'application/json');
      if (reply.stream) { reply.stream(response); return; }
      response.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    };
    void run().catch(() => { if (!response.destroyed) { response.statusCode = 500; response.end('{}'); } });
  });
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  const address = server.address(); if (typeof address !== 'object' || address === null) throw new Error('No loopback listener.');
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); server.closeAllConnections(); }) };
}
export const emptyInternalize = () => ({ new_claims: [], updated_claims: [], new_disputes: [] });
export const inboxMessage = (overrides: Partial<InboxMessage> = {}): InboxMessage => InboxMessageSchema.parse({ id: 'inbox_00000001', message_type: 'policy_update', policy: { id: 'policy_00000001', message_type: 'policy_update', name: 'retry_boundary', statement: 'Retry only idempotent requests within a bounded budget.', scope: 'service / retries', status: 'active', created_at: '2026-01-02T00:00:00Z' }, ...overrides });
export function arbitrationMessage(local: Claim = sampleClaim(), other: Claim = sampleClaim({ id: ClaimIdSchema.parse('claim_00000002'), holder: AgentIdSchema.parse('agent-b') })): InboxMessage {
  const message = inboxMessage();
  return InboxMessageSchema.parse({ ...message, message_type: 'claim_attribute_update', policy: { ...message.policy, message_type: 'claim_attribute_update' }, arbitration_resolution: { dispute_id: 'dispute_00000001', resolution_id: 'resolution_00000001', resolved_by: 'human', resolved_at: '2026-01-02T00:00:00Z', resolution_type: 'coexist', resolution_basis: 'evidence', conclusion: 'The two scopes coexist.', dispute_snapshot: { id: 'dispute_00000001', name: 'scope_conflict', claims: [local.id, other.id], summary: 'Check scope boundaries.', reporter_agent_id: 'agent-a', status: 'open', created_at: '2026-01-01T00:00:00Z' }, direct_claim_snapshots: [local, other] } });
}
export async function inboxFixture(backend: StructuredBackend = () => Promise.resolve({ text: JSON.stringify(emptyInternalize()) }), config: ConfigInput = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-inbox-'));
  const warnings: string[] = [];
  const knowledge = new AcnKnowledge(resolveConfig({ ...config, agentId: config.agentId || 'agent-a', home: root, llm: { provider: 'mock', model: 'mock', ...config.llm } }), { debug() {}, warn: (text: string) => { warnings.push(text); } });
  await knowledge.initialize();
  const inbox = new AcnInbox(knowledge, backend, await loadPromptRenderer());
  return { root, knowledge, inbox, warnings, close: async () => { await inbox.close(); await knowledge.jobs?.close(); await knowledge.team?.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
