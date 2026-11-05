// 桌面宿主未设置环境代理时，读取 macOS / Windows 的系统 HTTP 代理与例外。
import { execFile } from 'node:child_process';
import { BlockList, isIP } from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);
export interface SystemProxy { http?: string; https?: string; exceptions: string[] }
const empty = (): SystemProxy => ({ exceptions: [] });

function proxyUrl(host: string | undefined, port?: string): string | undefined {
  if (!host || port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return undefined;
  try {
    const address = port === undefined ? host : `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
    const url = new URL(address.includes('://') ? address : `http://${address}`);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password ? url.origin : undefined;
  } catch { return undefined; }
}

export function parseMacProxy(output: string): SystemProxy {
  const values = new Map<string, string>(); const exceptions: string[] = []; let inExceptions = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (inExceptions) { if (line === '}') inExceptions = false; else { const m = /^\d+\s*:\s*(.+)$/.exec(line); if (m?.[1]) exceptions.push(m[1].trim()); } continue; }
    if (/^ExceptionsList\s*:\s*<array>\s*\{$/.test(line)) { inExceptions = true; continue; }
    const pair = /^(\w+)\s*:\s*(.*)$/.exec(line); if (pair?.[1] && pair[2] !== undefined) values.set(pair[1], pair[2].trim());
  }
  if (values.get('ProxyAutoConfigEnable') === '1' || values.get('ProxyAutoDiscoveryEnable') === '1') return empty();
  if (values.get('ExcludeSimpleHostnames') === '1') exceptions.push('<local>');
  const http = values.get('HTTPEnable') === '1' ? proxyUrl(values.get('HTTPProxy'), values.get('HTTPPort')) : undefined;
  const https = values.get('HTTPSEnable') === '1' ? proxyUrl(values.get('HTTPSProxy'), values.get('HTTPSPort')) : undefined;
  return { ...(http ? { http } : {}), ...(https ? { https } : {}), exceptions };
}

export function parseWindowsProxy(output: string): SystemProxy {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) { const m = /^\s*(\w+)\s+REG_\w+\s+(.*)$/.exec(line); if (m?.[1] && m[2] !== undefined) values.set(m[1].toLowerCase(), m[2].trim()); }
  if (values.get('autoconfigurl') || Number(values.get('proxyenable')) !== 1) return empty();
  const server = values.get('proxyserver') ?? ''; let http: string | undefined; let https: string | undefined;
  if (server.includes('=')) for (const entry of server.split(';')) { const [protocol, address] = entry.split('=', 2).map((part) => part.trim()); if (protocol?.toLowerCase() === 'http') http = proxyUrl(address); if (protocol?.toLowerCase() === 'https') https = proxyUrl(address); }
  else http = https = proxyUrl(server);
  return { ...(http ? { http } : {}), ...(https ? { https } : {}), exceptions: (values.get('proxyoverride') ?? '').split(';').filter(Boolean) };
}

// 系统例外包含域名、通配符、IP/CIDR 和 <local>；只对 IP 字面量应用 CIDR。
export function bypassSystemProxy(endpoint: URL, exceptions: readonly string[]): boolean {
  const host = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase(); const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
  return exceptions.flatMap((rule) => rule.split(/[,;\s]+/)).some((raw) => {
    const rule = raw.toLowerCase(); if (!rule) return false; if (rule === '*') return true; if (rule === '<local>') return isIP(host) === 0 && !host.includes('.');
    if (rule.includes('/')) {
      const [network, prefix] = rule.split('/'); if (!network || !prefix) return false;
      const family = isIP(host); const parts = network.split('.'); if (family === 4) while (parts.length < 4) parts.push('0');
      const address = family === 4 ? parts.join('.') : network; const bits = Number(prefix);
      if (!family || isIP(address) !== family || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) return false;
      const block = new BlockList(); const type = family === 4 ? 'ipv4' : 'ipv6'; block.addSubnet(address, bits, type); return block.check(host, type);
    }
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rule); if (!m?.[1] || m[2] && m[2] !== port) return false;
    const pattern = m[1].replace(/^\[|\]$/g, '').replace(/^\*?\./, '');
    if (pattern.includes('*')) return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(host);
    return host === pattern || isIP(host) === 0 && host.endsWith(`.${pattern}`);
  });
}

export async function systemProxyFor(endpoint: string): Promise<string | undefined> {
  try {
    let proxy: SystemProxy;
    if (process.platform === 'darwin') proxy = parseMacProxy((await run('/usr/sbin/scutil', ['--proxy'], { timeout: 5000 })).stdout);
    else if (process.platform === 'win32') proxy = parseWindowsProxy((await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { timeout: 5000, windowsHide: true })).stdout);
    else return undefined;
    const url = new URL(endpoint); const exceptions = [...proxy.exceptions, process.env['no_proxy'] ?? process.env['NO_PROXY'] ?? ''];
    if (bypassSystemProxy(url, exceptions)) return undefined;
    return url.protocol === 'https:' ? proxy.https : proxy.http;
  } catch { return undefined; }
}
