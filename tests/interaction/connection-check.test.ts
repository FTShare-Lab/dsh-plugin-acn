// 使用真实回环 HTTP 区分鉴权、协议、服务和连接故障，不回显地址或响应正文。
import { expect, it } from 'vitest';
import { checkTeamConnection } from '../../src/dsh-adapter/interaction-service.js';
import { flowHarness } from '../flow/harness.js';
import { ScriptAdapter } from '../flow/adapter.js';
import { teamServer } from '../team/helpers.js';
import { displayMessage } from '../../src/interaction-messages.js';
it.each([
  [401, undefined, '认证未通过'],
  [200, 'invalid response', '服务响应不符合 ACN 协议'],
  [404, undefined, '服务拒绝了请求'],
  [503, undefined, '服务暂时不可用'],
] as const)('classifies HTTP %s health failures', async (status, raw, reason) => {
  const f = await flowHarness(new ScriptAdapter([])); const server = await teamServer(() => ({ status, ...(raw === undefined ? {} : { raw }) }));
  try {
    const result = await checkTeamConnection(f.ctx, { agentId: 'agent-a', name: 'Example', routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, keyEnv: '', timeoutMs: 1000 });
    expect(result.ok).toBe(false); expect(result.checks?.every((check) => check.message.includes(reason))).toBe(true);
    expect(result.message).toContain('继续本地工作'); expect(result.message).not.toContain('使用前');
    expect(JSON.stringify(result)).not.toContain(server.endpoint); expect(JSON.stringify(result)).not.toContain('invalid response');
    for (const check of result.checks ?? []) expect(displayMessage(check.message, (_zh, en) => en)).not.toMatch(/[\u4e00-\u9fff]/);
  } finally { await server.close(); await f.close(); }
});
it('reports a timeout independently from authentication', async () => {
  const f = await flowHarness(new ScriptAdapter([])); const server = await teamServer(() => ({ delayMs: 300, body: { status: 'ok', team_auth_enabled: false } }));
  try {
    const result = await checkTeamConnection(f.ctx, { agentId: 'agent-a', name: 'Example', routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, keyEnv: '', timeoutMs: 30 });
    expect(result.checks?.every((check) => check.message.includes('超时'))).toBe(true);
  } finally { await server.close(); await f.close(); }
});
