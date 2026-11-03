// 通过宿主凭据服务轮换团队凭据，验证旧客户端、连接检查和脱敏边界。
import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { ConfigurationService } from '../../src/dsh-adapter/configuration-service.js';
import { executeInteraction } from '../../src/dsh-adapter/interaction-service.js';
import Knowledge from '../../src/plugins/knowledge.js';
import { resolveConfig } from '../../src/config.js';
import { teamServer } from '../team/helpers.js';
import { flowHarness } from '../flow/harness.js';
import { ScriptAdapter } from '../flow/adapter.js';

it('resolves managed references for connection checks and live clients without copying secrets to configuration', async () => {
  const first = randomBytes(24).toString('hex'); const second = randomBytes(24).toString('hex'); let stored: string | undefined;
  const server = await teamServer((request) => {
    const body = request.body as { auth: { acn_key: string } };
    return body.auth.acn_key !== stored || stored === undefined ? { status: 401 } : request.path.endsWith('/overview') ? { body: { scopes: [] } } : request.path.endsWith('/query') ? { body: { candidate_claims: [], disputes: [] } } : { body: { status: 'ok', team_auth_enabled: true, auth_passed: true } };
  });
  const flow = await flowHarness(new ScriptAdapter([]), { config: { dream: { enabled: false } } });
  const provider = {
    resolve: vi.fn(() => Promise.resolve(stored === undefined ? undefined : { value: stored, source: 'file' })),
    describe: vi.fn(() => Promise.resolve({ configured: stored !== undefined, writable: true })),
    set: vi.fn((_reference: string, value: string) => { stored = value; return Promise.resolve(); }),
  };
  flow.ctx.provide('credentials', provider as unknown as CredentialProvider);
  try {
    const service = new ConfigurationService(flow.ctx);
    expect(await service.credential({ action: 'describe', reference: 'EXAMPLE_TEAM_TOKEN' })).toMatchObject({ ok: true, configured: false, writable: true });
    const result = await service.credential({ action: 'store', reference: 'EXAMPLE_TEAM_TOKEN', value: first });
    expect(result).toMatchObject({ ok: true, configured: true }); expect(JSON.stringify(result)).not.toContain(first);
    const connection = { name: '开发', agentId: 'agent-a', routerEndpoint: `${server.endpoint}/team-a`, maintainerEndpoint: `${server.endpoint}/team-a`, keyEnv: 'EXAMPLE_TEAM_TOKEN' };
    expect((await executeInteraction(flow.ctx, { action: 'check', connection })).ok).toBe(true);
    await flow.fibers.knowledge.dispose(); await flow.ctx.plugin(Knowledge, resolveConfig({ ...flow.knowledge.config, upstream: 'coding', upstreams: { coding: connection }, team: { retryCount: 0 } }));
    const agent = await flow.create(); const knowledge = await flow.ctx.acnRuntime.knowledge(agent.session.header);
    await knowledge.team?.router.query({ scope: 'service', semantic_query: null });
    await service.credential({ action: 'store', reference: 'EXAMPLE_TEAM_TOKEN', value: second });
    await knowledge.team?.router.query({ scope: 'service', semantic_query: null });
    expect(server.requests.filter((request) => request.path.endsWith('/query')).map((request) => (request.body as { auth: { acn_key: string } }).auth.acn_key)).toEqual([first, second]);
    expect(server.requests.every((request) => request.path.startsWith('/team-a/'))).toBe(true);
    expect(JSON.stringify(knowledge.config)).not.toContain(second);
    provider.resolve.mockRejectedValueOnce(new Error(second));
    let failure: unknown; try { await knowledge.team?.router.query({ scope: 'service', semantic_query: null }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: 'retryable' }); expect(String(failure)).not.toContain(second);
  } finally { await flow.close(); await server.close(); }
});

it('rejects blank values and invalid references before touching the credential provider', async () => {
  const flow = await flowHarness(new ScriptAdapter([]));
  try {
    const service = new ConfigurationService(flow.ctx);
    expect((await service.credential({ action: 'store', reference: 'INVALID-NAME', value: ' ' })).ok).toBe(false);
    expect((await service.credential({ action: 'describe', reference: 'EXAMPLE_TEAM_TOKEN' })).message).toContain('重新启动应用');
  } finally { await flow.close(); }
});

it('checks an entered draft key without modifying managed credentials or returning the secret', async () => {
  const value = randomBytes(24).toString('hex'); const existing = randomBytes(24).toString('hex');
  const server = await teamServer((request) => (request.body as { auth: { acn_key: string } }).auth.acn_key !== value ? { status: 401 } : request.path.endsWith('/overview') ? { body: { scopes: [] } } : { body: { status: 'ok', team_auth_enabled: true, auth_passed: true } });
  const flow = await flowHarness(new ScriptAdapter([]));
  const provider = { resolve: vi.fn(() => Promise.resolve({ value: existing, source: 'file' })), describe: vi.fn(() => Promise.resolve({ configured: true, writable: true })), set: vi.fn() };
  flow.ctx.provide('credentials', provider as unknown as CredentialProvider);
  try {
    const service = new ConfigurationService(flow.ctx);
    const connection = { agentId: 'agent-a', routerEndpoint: `${server.endpoint}/team-a`, maintainerEndpoint: `${server.endpoint}/team-a`, keyEnv: '' };
    const result = await service.credential({ action: 'check', connection, value });
    expect(result).toMatchObject({ ok: true, checks: [{ service: 'maintainer', state: 'ok' }, { service: 'router', state: 'ok' }] });
    expect(provider.set).not.toHaveBeenCalled(); expect(provider.resolve).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain(value);
    expect(server.requests).toHaveLength(3);
  } finally { await flow.close(); await server.close(); }
});

it('allows a transient key check without a credential provider but refuses readonly storage', async () => {
  const server = await teamServer((request) => request.path.endsWith('/overview') ? { body: { scopes: [] } } : { body: { status: 'ok', team_auth_enabled: true, auth_passed: true } });
  const flow = await flowHarness(new ScriptAdapter([]));
  try {
    const service = new ConfigurationService(flow.ctx); const value = randomBytes(24).toString('hex');
    expect((await service.credential({ action: 'check', connection: { agentId: 'agent-a', routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint }, value })).ok).toBe(true);
    const set = vi.fn(); flow.ctx.provide('credentials', { describe: () => Promise.resolve({ configured: true, writable: false }), set } as unknown as CredentialProvider);
    expect(await service.credential({ action: 'store', reference: 'EXAMPLE_TEAM_TOKEN', value })).toMatchObject({ ok: false, writable: false }); expect(set).not.toHaveBeenCalled();
  } finally { await flow.close(); await server.close(); }
});

it.each(['draft', 'saved'])('cancels both pending team requests for a %s key check', async (mode) => {
  let closed = 0;
  const server = await teamServer(() => ({ stream: (response) => { response.on('close', () => { closed += 1; }); response.write('{'); } }));
  const flow = await flowHarness(new ScriptAdapter([])); const controller = new AbortController();
  try {
    const connection = { agentId: 'agent-a', routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, timeoutMs: 5000 };
    const result = mode === 'draft' ? new ConfigurationService(flow.ctx).credential({ action: 'check', connection, value: randomBytes(24).toString('hex') }, controller.signal) : executeInteraction(flow.ctx, { action: 'check', connection }, undefined, controller.signal);
    await vi.waitFor(() => { expect(server.requests).toHaveLength(2); }); controller.abort();
    expect(await result).toMatchObject({ ok: false, message: '检查已取消。' });
    await vi.waitFor(() => { expect(closed).toBe(2); }); expect(server.requests.every((request) => request.path === '/health')).toBe(true);
  } finally { controller.abort(); await flow.close(); await server.close(); }
});
