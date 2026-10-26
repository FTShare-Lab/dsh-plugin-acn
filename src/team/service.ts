// 团队门面集中连接状态与去重警告，所有失败保持可操作且不泄露凭据。
import type { ResolvedConfig } from '../config.js';
import type { AgentId } from '../protocol/ids.js';
import { nowSeconds } from '../protocol/time.js';
import type { StoreLogger } from '../store/context.js';
import { TeamError } from './errors.js';
import { TeamHttp } from './http.js';
import { RouterClient } from './router-client.js';
import { MaintainerClient } from './maintainer-client.js';

export interface ConnectionStatus { state: 'unknown' | 'ok' | 'failed'; at?: string; error?: string }
export interface TeamStatus { mode: 'solo' | 'team'; router: ConnectionStatus; maintainer: ConnectionStatus }
export class TeamFacade {
  readonly router: RouterClient;
  readonly maintainer: MaintainerClient;
  private readonly states: TeamStatus = { mode: 'team', router: { state: 'unknown' }, maintainer: { state: 'unknown' } };
  private readonly warned = new Set<string>();
  constructor(config: ResolvedConfig['team'], agentId: AgentId, private readonly logger: StoreLogger) {
    this.router = new RouterClient(new TeamHttp('router', config.routerEndpoint, agentId, config));
    this.maintainer = new MaintainerClient(new TeamHttp('maintainer', config.maintainerEndpoint, agentId, config));
  }
  status(): TeamStatus { return structuredClone(this.states); }
  async request<T>(service: 'router' | 'maintainer', action: () => Promise<T>): Promise<T> {
    try {
      const result = await action(); this.states[service] = { state: 'ok', at: nowSeconds() }; return result;
    } catch (error) {
      if (!(error instanceof TeamError)) throw error;
      if (error.kind === 'cancelled') throw error;
      this.states[service] = { state: 'failed', at: nowSeconds(), error: error.message };
      const warning = error.kind === 'auth' ? 'auth' : `${service}:${error.kind}`;
      if (!this.warned.has(warning)) {
        this.warned.add(warning);
        this.logger.warn(`${error.message}${error.kind === 'auth' && !this.router.http.credentialConfigured() ? ' 鉴权未配置，请设置 team.keyEnv 指定的环境变量。' : ''}`);
      }
      throw error;
    }
  }
  async health(signal?: AbortSignal): Promise<void> {
    await Promise.allSettled((['router', 'maintainer'] as const).map((service) => this.request(service, async () => {
      const result = await this[service].health(signal);
      if (result.team_auth_enabled && result.auth_passed === undefined) throw new TeamError('protocol', service, 'POST /health');
      if (result.team_auth_enabled && result.auth_passed === false) throw new TeamError('auth', service, 'POST /health', 401);
      return result;
    })));
  }
  async close(): Promise<void> { await Promise.all([this.router.http.close(), this.maintainer.http.close()]); }
}
