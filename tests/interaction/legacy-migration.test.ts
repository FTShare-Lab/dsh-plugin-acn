// 旧身份升级为工作配置时延续已验证归属；损坏或不匹配的绑定不能迁移。
import { expect, it, vi } from 'vitest';
import { SessionId, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import Knowledge from '../../src/plugins/knowledge.js';
import { resolveConfig, UpstreamSchema } from '../../src/config.js';
import { configurationValues, mergeConfiguration } from '../../src/configuration.js';
import { resolveUpstream, upstreamsOf } from '../../src/upstreams.js';
import { identityOf } from '../../src/dsh-adapter/session-binding.js';
import { ClaimStore } from '../../src/store/claims.js';
import { flowHarness, turn } from '../flow/harness.js';
import { ScriptAdapter, textResponse } from '../flow/adapter.js';
import { teamServer } from '../team/helpers.js';

it.each([
  { team: false, cold: false }, { team: false, cold: true },
  { team: true, cold: false }, { team: true, cold: true },
])('preserves the same legacy identity after a settings migration (team=$team, cold=$cold)', async ({ team, cold }) => {
  const server = await teamServer((request) => ({ body: request.path.endsWith('/overview') ? { scopes: [] } : { status: 'ok', team_auth_enabled: false } }));
  const adapter = new ScriptAdapter([textResponse('Original work.'), textResponse('Continued in the same identity.')]);
  const f = await flowHarness(adapter, { persistence: true, config: { ...(team ? { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint } } : {}), dream: { enabled: false } } });
  try {
    const original = await f.ctx.agents.create({ sessionId: SessionId('legacy-work'), agentOptions: { provider: 'mock', model: 'mock' } });
    await turn(original.agent);
    expect(f.ctx.acnRuntime.view(original.agent.session.header).available).toBe(true);
    const previous = f.knowledge.config; const key = team ? 'legacy' : 'personal';
    const profiles = upstreamsOf(previous); const profile = profiles[key];
    if (profile === undefined) throw new Error('Missing original work configuration.');
    // 设置页保存名称时生成 upstreams；新默认身份不能接管已开始的会话。
    const values = { ...configurationValues(previous), upstreams: { ...profiles, [key]: { ...profile, name: '日常工作' }, review: UpstreamSchema.parse({ agentId: 'agent-b' }) }, upstream: 'review' };
    const next = resolveConfig(mergeConfiguration({ ...previous }, values)); const mapped = resolveUpstream(next, key);
    if (mapped === undefined) throw new Error('Missing migrated work configuration.');
    expect(identityOf(mapped)).toBe(identityOf(previous));
    if (cold) await original.dispose();
    await f.fibers.knowledge.dispose(); await f.ctx.plugin(Knowledge, next);
    const handle = cold ? await f.ctx.agents.resume({ resumeSessionId: original.agent.session.id, agentOptions: { provider: 'mock', model: 'mock' } }) : original;
    try {
      const pool = f.ctx.acnRuntime;
      expect(handle.agent.session.firstLiveSeq > 0).toBe(cold);
      await vi.waitFor(() => { expect(pool.view(handle.agent.session.header)).toMatchObject({ key, available: true, locked: true }); });
      const knowledge = await pool.knowledge(handle.agent.session.header);
      expect(knowledge.context().paths.root).toBe(f.knowledge.context().paths.root);
      expect(await new ClaimStore(knowledge.context()).list()).toContainEqual(expect.objectContaining({ id: f.claim.id }));
      await turn(handle.agent);
      expect(adapter.requests).toHaveLength(2); expect(JSON.stringify(adapter.requests[1])).toContain(f.claim.name);
      await expect(pool.select(handle.agent.session.header, 'review')).rejects.toMatchObject({ kind: 'bound' });
      const selections = handle.agent.session.snapshotEvents().map(pluginRecordOf).filter((record) => record?.type === 'plugin:acn/team-selection');
      expect(selections).toHaveLength(1); expect(selections[0]?.data).toMatchObject({ key, identity: identityOf(previous) });
    } finally { await handle.dispose(); }
  } finally { await f.close(); await server.close(); }
});

it.each(['malformed', 'conflicting', 'changed'] as const)('rejects legacy migration when the previous identity is %s', async (kind) => {
  const adapter = new ScriptAdapter([textResponse('Original work.')]);
  const f = await flowHarness(adapter, { config: { dream: { enabled: false } } });
  try {
    const agent = await f.create(); await turn(agent);
    if (kind !== 'changed') appendPluginRecord(agent.session, 'plugin:acn/session-binding', { schemaVersion: 1, identity: kind === 'malformed' ? 'invalid' : 'f'.repeat(64) });
    const previous = f.knowledge.config; const profiles = upstreamsOf(previous);
    if (kind === 'changed') profiles['personal'] = UpstreamSchema.parse({ ...profiles['personal'], agentId: 'agent-b' });
    const next = resolveConfig(mergeConfiguration({ ...previous }, { ...configurationValues(previous), upstreams: profiles, upstream: 'personal' }));
    await f.fibers.knowledge.dispose(); await f.ctx.plugin(Knowledge, next);
    expect(f.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ available: false, locked: true, phase: 'blocked' });
    expect(agent.session.snapshotEvents().map(pluginRecordOf).some((record) => record?.type === 'plugin:acn/team-selection')).toBe(false);
    await turn(agent); expect(adapter.requests).toHaveLength(1);
  } finally { await f.close(); }
});
