// 请求时解析凭据引用；回环直连，优先环境代理并支持系统代理，重试与响应校验有界。
import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch } from 'undici';
import { systemProxyFor } from './system-proxy.js';
import type { z } from 'zod';
import type { ResolvedConfig } from '../config.js';
import type { AgentId } from '../protocol/ids.js';
import { TeamError } from './errors.js';
import type { ConnectionFailure } from './errors.js';
import { abortable } from '../llm/structured.js';

export type CredentialResolver = (reference: string) => Promise<string | undefined>;
const environmentCredential: CredentialResolver = (reference) => Promise.resolve(process.env[reference]);
function connectionFailure(error: unknown, timedOut: boolean): ConnectionFailure {
  if (timedOut) return 'timeout';
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns' : code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH' ? 'unreachable' : 'network';
}

export function bypassProxy(endpoint: string): boolean {
  const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || isIP(host) === 4 && host.startsWith('127.');
}
export function teamUrl(endpoint: string, path: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = ''; url.hash = '';
  return url.href;
}
export class TeamHttp {
  private readonly dispatcher: Promise<Agent | EnvHttpProxyAgent | ProxyAgent>;
  private readonly stop = new AbortController();
  constructor(readonly service: 'router' | 'maintainer', readonly endpoint: string, readonly agentId: AgentId, readonly config: ResolvedConfig['team'], private readonly credential: CredentialResolver = environmentCredential) {
    const hasEnvironmentProxy = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].some((name) => Boolean(process.env[name]?.trim()));
    const fallback = process.env['all_proxy'] || process.env['ALL_PROXY'];
    const environment = fallback ? { httpProxy: process.env['http_proxy'] || process.env['HTTP_PROXY'] || fallback, httpsProxy: process.env['https_proxy'] || process.env['HTTPS_PROXY'] || fallback } : {};
    this.dispatcher = bypassProxy(endpoint) ? Promise.resolve(new Agent()) : hasEnvironmentProxy ? Promise.resolve(new EnvHttpProxyAgent(environment)) : systemProxyFor(endpoint).then((proxy) => proxy ? new ProxyAgent(proxy) : new Agent());
  }
  async credentialConfigured(): Promise<boolean> { return this.config.keyEnv !== '' && Boolean(await this.credential(this.config.keyEnv)); }
  async post<T>(path: string, data: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T>;
  async post(path: string, data: unknown, schema?: undefined, signal?: AbortSignal): Promise<void>;
  async post<T>(path: string, data: unknown, schema?: z.ZodType<T>, signal?: AbortSignal): Promise<T | void> {
    const operation = `POST ${path}`;
    for (let attempt = 0; ; attempt += 1) {
      const timeout = AbortSignal.timeout(Math.min(this.config.timeoutMs, 2_147_483_647));
      const combined = AbortSignal.any([this.stop.signal, timeout, ...signal === undefined ? [] : [signal]]);
      let failure: TeamError;
      try {
        if (combined.aborted) throw new TeamError(timeout.aborted ? 'retryable' : 'cancelled', this.service, operation);
        const key = this.config.keyEnv ? await abortable(this.credential(this.config.keyEnv), combined) ?? '' : '';
        const response = await fetch(teamUrl(this.endpoint, path), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, dispatcher: await abortable(this.dispatcher, combined),
          redirect: 'error', signal: combined,
          body: JSON.stringify({ auth: { agent_id: this.agentId, acn_key: key }, data }),
        });
        if (response.ok) {
          if (schema === undefined) { await response.body?.cancel(); return; }
          let body: unknown;
          try { body = await response.json(); }
          catch (error) { throw new TeamError(error instanceof SyntaxError ? 'protocol' : 'retryable', this.service, operation, response.status); }
          const parsed = schema.safeParse(body);
          if (!parsed.success) throw new TeamError('protocol', this.service, operation, response.status);
          return parsed.data;
        }
        await response.body?.cancel();
        const status = response.status;
        const kind = status === 401 || this.service === 'router' && status === 403 ? 'auth'
          : path === '/inbox/ack' && (status === 404 || status === 405) ? 'legacy_route'
          : status === 408 || status === 429 || status >= 500 ? 'retryable' : 'client';
        failure = new TeamError(kind, this.service, operation, status);
      } catch (error) {
        if (signal?.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError') throw new TeamError('retryable', this.service, operation, undefined, 'timeout');
        if (signal?.aborted || this.stop.signal.aborted) throw new TeamError('cancelled', this.service, operation);
        failure = error instanceof TeamError ? error : new TeamError('retryable', this.service, operation, undefined, connectionFailure(error, timeout.aborted));
      }
      if (failure.kind !== 'retryable' || attempt >= this.config.retryCount) throw failure;
      const backoff = Math.min(this.config.retryMaxDelayMs, this.config.retryBaseDelayMs * 2 ** Math.min(attempt, 16));
      try { await delay(Math.max(1, Math.min(this.config.retryMaxDelayMs, Math.round(backoff * (0.8 + Math.random() * 0.4)))), undefined, { signal: AbortSignal.any([this.stop.signal, ...signal === undefined ? [] : [signal]]) }); }
      catch {
        if (signal?.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError') throw new TeamError('retryable', this.service, operation, undefined, 'timeout');
        throw new TeamError('cancelled', this.service, operation);
      }
    }
  }
  async close(): Promise<void> { this.stop.abort(); await (await this.dispatcher).destroy(); }
}
