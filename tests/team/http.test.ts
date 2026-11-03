// 客户端以真实回环 HTTP 验证状态分类、重试、超时、取消、路径前缀和凭据脱敏。
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TeamHttp, bypassProxy, teamUrl } from '../../src/team/http.js';
import { TeamFacade } from '../../src/team/service.js';
import { resolveConfig } from '../../src/config.js';
import { AgentIdSchema } from '../../src/protocol/ids.js';
import { teamServer } from './helpers.js';

const agentId = AgentIdSchema.parse('agent-a');
const config = (endpoint: string, overrides = {}) => resolveConfig({ team: { routerEndpoint: endpoint, maintainerEndpoint: endpoint, retryCount: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 2, ...overrides } }).team;
describe('team HTTP', () => {
  it('preserves endpoint path prefixes and normalizes the query envelope with per-call env credentials', async () => {
    const server = await teamServer(() => ({ body: { candidate_claims: [], disputes: [] } }));
    const team = new TeamFacade(config(`${server.endpoint}/team/v1/`, { keyEnv: 'ACN_TEST_TEAM_CREDENTIAL' }), agentId, { warn() {}, debug() {} });
    const first = randomBytes(24).toString('hex'); const second = randomBytes(24).toString('hex');
    try {
      process.env['ACN_TEST_TEAM_CREDENTIAL'] = first; await team.router.query({ scope: 'service', semantic_query: null });
      process.env['ACN_TEST_TEAM_CREDENTIAL'] = second; await team.router.query({ scope: 'service', semantic_query: null });
      expect(server.requests.map((request) => request.path)).toEqual(['/team/v1/claims/query', '/team/v1/claims/query']);
      expect(server.requests.map((request) => request.body)).toEqual([first, second].map((acn_key) => ({ auth: { agent_id: 'agent-a', acn_key }, data: { scope: 'service', semantic_query: null } })));
    } finally { delete process.env['ACN_TEST_TEAM_CREDENTIAL']; await team.close(); await server.close(); }
  });
  it.each([['router', 401, 'auth', 1], ['router', 403, 'auth', 1], ['maintainer', 401, 'auth', 1], ['maintainer', 403, 'client', 1], ['maintainer', 400, 'client', 1], ['maintainer', 408, 'retryable', 3], ['router', 429, 'retryable', 3], ['router', 503, 'retryable', 3]] as const)('%s HTTP %i is %s, with %i attempts', async (service, status, kind, attempts) => {
    const secret = randomBytes(24).toString('hex');
    const server = await teamServer(() => ({ status, raw: secret.repeat(100) }));
    const client = new TeamHttp(service, server.endpoint, agentId, config(server.endpoint));
    try {
      let failure: unknown; try { await client.post('/example', {}); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ kind, status }); expect(String(failure)).not.toContain(secret); expect(JSON.stringify(failure)).not.toContain(secret);
      expect(server.requests).toHaveLength(attempts);
    } finally { await client.close(); await server.close(); }
  });
  it.each([404, 405])('identifies an older ACK route (%i) without retrying', async (status) => {
    const server = await teamServer(() => ({ status })); const client = new TeamHttp('maintainer', server.endpoint, agentId, config(server.endpoint));
    try { await expect(client.post('/inbox/ack', {})).rejects.toMatchObject({ kind: 'legacy_route' }); expect(server.requests).toHaveLength(1); }
    finally { await client.close(); await server.close(); }
  });
  it.each(['{', '{}'])('rejects malformed JSON or shape without transport retry: %s', async (raw) => {
    const server = await teamServer(() => ({ raw })); const client = new TeamHttp('router', server.endpoint, agentId, config(server.endpoint));
    try { await expect(client.post('/example', {}, z.object({ ok: z.literal(true) }))).rejects.toMatchObject({ kind: 'protocol' }); expect(server.requests).toHaveLength(1); }
    finally { await client.close(); await server.close(); }
  });
  it('retries a response body timeout, then can recover on a later attempt', async () => {
    let attempts = 0;
    const server = await teamServer(() => ++attempts === 1 ? { stream: (response) => { response.write('{'); } } : { body: { ok: true } });
    const client = new TeamHttp('router', server.endpoint, agentId, config(server.endpoint, { timeoutMs: 50 }));
    try { expect(await client.post('/example', {}, z.object({ ok: z.boolean() }))).toEqual({ ok: true }); expect(attempts).toBe(2); }
    finally { await client.close(); await server.close(); }
  });
  it('cancels a retry delay and shutdown aborts in-flight requests', async () => {
    const server = await teamServer(() => ({ status: 503 })); const client = new TeamHttp('router', server.endpoint, agentId, config(server.endpoint, { retryBaseDelayMs: 5000, retryMaxDelayMs: 5000 }));
    const abort = new AbortController();
    try {
      const pending = client.post('/example', {}, undefined, abort.signal); setTimeout(() => { abort.abort(); }, 30);
      await expect(pending).rejects.toMatchObject({ kind: 'cancelled' }); expect(server.requests).toHaveLength(1);
      const closed = expect(client.post('/example', {})).rejects.toMatchObject({ kind: 'cancelled' }); await client.close(); await closed;
    } finally { await client.close(); await server.close(); }
  });
  it('warns once across both services for authentication failure and exposes health independently', async () => {
    let authorized = false;
    const server = await teamServer((request) => request.path === '/health' ? { body: { status: 'ok', team_auth_enabled: true, auth_passed: authorized } } : { status: 401 });
    const warnings: string[] = []; const team = new TeamFacade(config(server.endpoint), agentId, { debug() {}, warn: (text) => { warnings.push(text); } });
    try {
      await team.health(); await team.health(); expect(warnings).toHaveLength(1);
      expect(team.status()).toMatchObject({ router: { state: 'failed' }, maintainer: { state: 'failed' } });
      expect(team.status().router.error).toContain('鉴权失败'); expect(team.status().maintainer.error).toContain('鉴权失败');
      authorized = true; await team.health(); expect(team.status()).toMatchObject({ router: { state: 'ok' }, maintainer: { state: 'ok' } });
    } finally { await team.close(); await server.close(); }
  });
  it('does not mark an auth-enabled health response successful without an auth result', async () => {
    const server = await teamServer(() => ({ body: { status: 'ok', team_auth_enabled: true } })); const team = new TeamFacade(config(server.endpoint), agentId, { warn() {}, debug() {} });
    try { await team.health(); expect(team.status()).toMatchObject({ router: { state: 'failed' }, maintainer: { state: 'failed' } }); expect(team.status().router.error).toContain('协议'); }
    finally { await team.close(); await server.close(); }
  });
  it('uses direct transport only for loopback hosts and retains prefixes', () => {
    for (const endpoint of ['http://localhost:8', 'http://127.0.0.1:8', 'http://[::1]:8']) expect(bypassProxy(endpoint)).toBe(true);
    for (const endpoint of ['https://example.com', 'https://localhost.example.com', 'https://127.0.0.1.example.com']) expect(bypassProxy(endpoint)).toBe(false);
    expect(teamUrl('https://example.com/prefix/', '/health')).toBe('https://example.com/prefix/health');
    expect(() => resolveConfig({ team: { routerEndpoint: 'https://example.com/?key=value', maintainerEndpoint: 'https://example.com' } })).toThrow();
  });
  it('honors environment proxy for a remote host while a loopback endpoint bypasses it', async () => {
    let connections = 0; const proxy = createServer();
    proxy.on('connect', (_request, socket) => { connections += 1; socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve); }); const address = proxy.address(); if (address === null || typeof address === 'string') throw new Error('No proxy listener.');
    const local = await teamServer(() => ({}));
    for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY']) vi.stubEnv(name, `http://127.0.0.1:${address.port}`);
    vi.stubEnv('no_proxy', ''); vi.stubEnv('NO_PROXY', '');
    const remote = new TeamHttp('router', 'https://service.invalid', agentId, config(local.endpoint, { retryCount: 0, timeoutMs: 300 })); const direct = new TeamHttp('router', local.endpoint, agentId, config(local.endpoint));
    try {
      await expect(remote.post('/health', {})).rejects.toMatchObject({ kind: 'retryable' }); expect(connections).toBeGreaterThan(0); const before = connections;
      await direct.post('/health', {}); expect(connections).toBe(before); expect(local.requests).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); await remote.close(); await direct.close(); await local.close(); await new Promise<void>((resolve) => { proxy.close(() => { resolve(); }); proxy.closeAllConnections(); }); }
  });
});

it.each(['timeout', 'cancel', 'close'] as const)('bounds a stalled credential resolver on %s without issuing HTTP', async (cause) => {
  const server = await teamServer(() => ({ body: {} })); const controller = new AbortController();
  let release: ((value: string | undefined) => void) | undefined;
  const pending = new Promise<string | undefined>((resolve) => { release = resolve; });
  const client = new TeamHttp('router', server.endpoint, agentId, config(server.endpoint, { keyEnv: 'EXAMPLE_TEAM_TOKEN', timeoutMs: 30, retryCount: 0 }), () => pending);
  try {
    const result = client.post('/claims/query', {}, undefined, controller.signal);
    const expected = expect(result).rejects.toMatchObject({ kind: cause === 'timeout' ? 'retryable' : 'cancelled' });
    if (cause === 'cancel') controller.abort(); else if (cause === 'close') await client.close();
    await expected; release?.(''); await Promise.resolve(); expect(server.requests).toEqual([]);
  } finally { release?.(''); await client.close(); await server.close(); }
});
