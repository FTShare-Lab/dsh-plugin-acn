// Router 只提供候选知识和派生概览，不接收 Agent 私有状态。
import { AgentQuerySchema, RouterQueryResultSchema, ScopesOverviewSnapshotSchema } from '../protocol/router.js';
import type { AgentQuery, RouterQueryResult, ScopesOverviewSnapshot } from '../protocol/router.js';
import { HealthResponseSchema } from '../protocol/auth.js';
import type { TeamHttp } from './http.js';

export class RouterClient {
  constructor(readonly http: TeamHttp) {}
  query(query: AgentQuery, signal?: AbortSignal): Promise<RouterQueryResult> { return this.http.post('/claims/query', AgentQuerySchema.parse(query), RouterQueryResultSchema, signal); }
  overview(signal?: AbortSignal): Promise<ScopesOverviewSnapshot> { return this.http.post('/claims/scopes/overview', {}, ScopesOverviewSnapshotSchema, signal); }
  health(signal?: AbortSignal) { return this.http.post('/health', {}, HealthResponseSchema, signal); }
}
