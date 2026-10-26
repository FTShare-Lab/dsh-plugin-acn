// 重建宿主会话对象模拟进程恢复，验证身份记录随日志持久化与 fork 继承。
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionId, SessionLogOffset, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.js';
import { bindSession, sessionAllowed } from '../../src/dsh-adapter/session-binding.js';

const contexts: Context[] = [];
async function host() { const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SessionStore); return ctx; }
afterEach(async () => { await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose())); });
const config = resolveConfig({ agentId: 'agent-a', home: '/tmp/example/knowledge' });
declare module '@deepseek-ai/dsh-session' { interface PluginRecordMap { 'plugin:example/legacy': { value: string } } }

describe('durable session identity', () => {
  it('restores the same identity from its log without depending on the old header object', async () => {
    const first = await host(); const session = first.sessions.create(SessionId('original'));
    bindSession(first, config, session.header); expect(sessionAllowed(first, config, session.header)).toBe(true);
    const restored = await host(); const next = restored.sessions.create(session.id, { seed: session.snapshotEvents() });
    bindSession(restored, config, next.header); expect(next.header).not.toBe(session.header);
    expect(sessionAllowed(restored, config, next.header)).toBe(true);
    expect(next.snapshotEvents().map(pluginRecordOf).filter((record) => record?.type === 'plugin:acn/session-binding')).toHaveLength(1);
  });
  it.each([{ agentId: 'agent-b' }, { home: '/tmp/example/other' }])('rejects an offline YAML change %j with the default epoch', async (change) => {
    const first = await host(); const session = first.sessions.create(SessionId('original'));
    bindSession(first, config, session.header);
    const restored = await host(); const next = restored.sessions.create(session.id, { seed: session.snapshotEvents() });
    const changed = resolveConfig({ ...config, ...change });
    bindSession(restored, changed, next.header); expect(changed.sessionEpoch).toBe(0);
    expect(sessionAllowed(restored, changed, next.header)).toBe(false);
  });
  it('keeps inherited identity records on forks even with a new creation timestamp', async () => {
    const first = await host(); const session = first.sessions.create(SessionId('original'));
    bindSession(first, config, session.header);
    const other = await host(); const fork = other.sessions.create(SessionId('fork'), { seed: session.snapshotEvents(), inheritedEventCount: SessionLogOffset(session.snapshotEvents().length), meta: { parentSession: session.id, isSeeded: true } });
    const changed = resolveConfig({ ...config, agentId: 'agent-b' });
    bindSession(other, changed, fork.header); expect(sessionAllowed(other, changed, fork.header)).toBe(false);
  });
  it.each([false, true])('binds a fresh child of a verified parent with isSeeded=%s', async (isSeeded) => {
    const ctx = await host(); const parent = ctx.sessions.create(SessionId('parent'));
    bindSession(ctx, config, parent.header);
    const child = ctx.sessions.create(SessionId('child'), { ...isSeeded ? { seed: [], inheritedEventCount: SessionLogOffset(0) } : {}, meta: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1, isSeeded } });
    bindSession(ctx, config, child.header); expect(sessionAllowed(ctx, config, child.header)).toBe(true);
    const restored = await host(); const next = restored.sessions.create(child.id, { seed: child.snapshotEvents() });
    bindSession(restored, config, next.header); expect(sessionAllowed(restored, config, next.header)).toBe(true);
  });
  it('does not bind a fresh child to a parent from another identity', async () => {
    const ctx = await host(); const parent = ctx.sessions.create(SessionId('parent'));
    bindSession(ctx, config, parent.header);
    const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 } });
    const changed = resolveConfig({ ...config, agentId: 'agent-b' });
    bindSession(ctx, changed, child.header); expect(sessionAllowed(ctx, changed, child.header)).toBe(false);
  });
  it('does not silently bind a legacy history without an identity record', async () => {
    const first = await host(); const session = first.sessions.create(SessionId('legacy'));
    appendPluginRecord(session, 'plugin:example/legacy', { value: 'earlier session history' });
    const legacySeed = session.snapshotEvents();
    const other = await host(); const restored = other.sessions.create(SessionId('legacy'), { seed: legacySeed });
    bindSession(other, config, restored.header); expect(sessionAllowed(other, config, restored.header)).toBe(false);
    expect(sessionAllowed(other, resolveConfig({}), restored.header)).toBe(true);
  });
});
