// 按系统设置和代理例外验证团队服务出网选择。
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bypassSystemProxy, parseMacProxy, parseWindowsProxy } from '../../src/team/system-proxy.js';
import { resolveConfig } from '../../src/config.js';
import { AgentIdSchema } from '../../src/protocol/ids.js';

vi.mock('../../src/team/system-proxy.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/team/system-proxy.js')>();
  return { ...original, systemProxyFor: vi.fn() };
});
import { systemProxyFor } from '../../src/team/system-proxy.js';
import { TeamHttp } from '../../src/team/http.js';

afterEach(() => { vi.unstubAllEnvs(); vi.mocked(systemProxyFor).mockReset(); });
describe('system proxy', () => {
  it('reads enabled macOS HTTP and HTTPS proxies and exception list', () => {
    expect(parseMacProxy('<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 7890\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 7890\n ExceptionsList : <array> {\n 0 : *.example.com\n 1 : 10.0.0.0/8\n }\n}')).toEqual({ http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890', exceptions: ['*.example.com', '10.0.0.0/8'] });
    expect(parseMacProxy('ProxyAutoConfigEnable : 1\nHTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 7890')).toEqual({ exceptions: [] });
    expect(parseMacProxy('HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 80')).toEqual({ http: 'http://localhost', exceptions: [] });
  });
  it('reads Windows per-protocol and shared proxies, respecting disabled and PAC settings', () => {
    expect(parseWindowsProxy(' ProxyEnable REG_DWORD 0x1\r\n ProxyServer REG_SZ http=127.0.0.1:8001;https=127.0.0.1:8002\r\n ProxyOverride REG_SZ <local>;*.example.com')).toEqual({ http: 'http://127.0.0.1:8001', https: 'http://127.0.0.1:8002', exceptions: ['<local>', '*.example.com'] });
    expect(parseWindowsProxy(' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ 127.0.0.1:8001')).toEqual({ http: 'http://127.0.0.1:8001', https: 'http://127.0.0.1:8001', exceptions: [] });
    expect(parseWindowsProxy(' ProxyEnable REG_DWORD 0x1\n AutoConfigURL REG_SZ http://example.com/proxy.pac')).toEqual({ exceptions: [] });
  });
  it('matches domains, globs, ports, local names and IPv4 subnets without bypassing unrelated hosts', () => {
    const rules = ['*.example.com', '10/8', '<local>', 'host.example.net:8080', 'service-*.example.org', 'fd00::/8'];
    for (const url of ['http://example.com', 'http://a.example.com', 'http://10.2.3.4', 'http://printer', 'http://host.example.net:8080', 'http://service-a.example.org', 'http://[fd00::1]']) expect(bypassSystemProxy(new URL(url), rules)).toBe(true);
    for (const url of ['http://example.com.other', 'http://11.2.3.4', 'http://host.example.net:8081', 'http://outside.invalid', 'http://[fe80::1]']) expect(bypassSystemProxy(new URL(url), rules)).toBe(false);
  });
  it('prefers an explicit environment proxy to system settings', async () => {
    for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) vi.stubEnv(key, '');
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
    const endpoint = 'http://service.invalid'; const config = resolveConfig({ team: { routerEndpoint: endpoint, maintainerEndpoint: endpoint, retryCount: 0, timeoutMs: 500 } }).team;
    const client = new TeamHttp('router', endpoint, AgentIdSchema.parse('agent-a'), config);
    try { await expect(client.post('/health', {})).rejects.toMatchObject({ kind: 'retryable' }); expect(systemProxyFor).not.toHaveBeenCalled(); }
    finally { await client.close(); }
  });
  it('routes a real team request through the detected system proxy when no environment proxy is set', async () => {
    for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) vi.stubEnv(key, '');
    let connects = 0; const server = createServer((_req, response) => { connects += 1; response.writeHead(502).end(); }); server.on('connect', (_req, socket) => { connects += 1; socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No proxy listener');
    vi.mocked(systemProxyFor).mockResolvedValue(`http://127.0.0.1:${address.port}`);
    const endpoint = 'http://service.invalid'; const config = resolveConfig({ team: { routerEndpoint: endpoint, maintainerEndpoint: endpoint, retryCount: 0, timeoutMs: 500 } }).team;
    const client = new TeamHttp('router', endpoint, AgentIdSchema.parse('agent-a'), config);
    try { await expect(client.post('/health', {})).rejects.toMatchObject({ kind: 'retryable' }); expect(connects).toBe(1); expect(systemProxyFor).toHaveBeenCalledWith(endpoint); }
    finally { await client.close(); await new Promise<void>((resolve) => { server.close(() => { resolve(); }); server.closeAllConnections(); }); }
  });
});
