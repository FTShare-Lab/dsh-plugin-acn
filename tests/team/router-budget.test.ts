// Router 总等待上限覆盖 HTTP 与退避；用户取消保留独立分类。
import { expect, it } from 'vitest';
import { TeamFacade } from '../../src/team/service.js';
import { resolveConfig } from '../../src/config.js';
import { AgentIdSchema } from '../../src/protocol/ids.js';
import { teamServer } from './helpers.js';
it.each(['query', 'overview'] as const)('bounds %s retries including backoff', async (operation) => {
  const server = await teamServer(() => ({ status: 503 }));
  const config = resolveConfig({ team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, routerTimeoutMs: 150, timeoutMs: 1000, retryCount: 20, retryBaseDelayMs: 1000, retryMaxDelayMs: 1000 } });
  const team = new TeamFacade(config.team, AgentIdSchema.parse('agent-a'), { warn() {}, debug() {} });
  try {
    const request = operation === 'query' ? team.router.query({ scope: 'service', semantic_query: null }) : team.router.overview();
    await expect(request).rejects.toMatchObject({ kind: 'retryable', connectionFailure: 'timeout' });
    expect(server.requests).toHaveLength(1);
  } finally { await team.close(); await server.close(); }
});
