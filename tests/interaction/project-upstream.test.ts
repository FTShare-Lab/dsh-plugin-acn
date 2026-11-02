// 真实会话与持久日志验证项目最近选择，避免浏览、旧会话及内部子代理改变新会话归属。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { flowHarness, turn } from '../flow/harness.js';
import { ScriptAdapter, textResponse } from '../flow/adapter.js';
import { resolveConfig, UpstreamSchema } from '../../src/config.js';
import { configurationValues, mergeConfiguration } from '../../src/configuration.js';
import Knowledge from '../../src/plugins/knowledge.js';

const config = () => ({ upstream: 'coding', upstreams: { coding: UpstreamSchema.parse({ agentId: 'agent-a' }), review: UpstreamSchema.parse({ agentId: 'agent-b' }) }, dream: { enabled: false }, memory: { review: { enabled: false } }, formation: { idleRecap: false } });
type Flow = Awaited<ReturnType<typeof flowHarness>>;
const create = (flow: Flow, id: string, cwd: string) => flow.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd }, agentOptions: { provider: 'mock', model: 'mock' } });
const choice = (flow: Flow, handle: AgentHandle) => flow.ctx.acnRuntime.view(handle.agent.session.header).key;

it('inherits the latest newly created session per project and preserves existing drafts', async () => {
  const adapter = new ScriptAdapter([]); const flow = await flowHarness(adapter, { config: config() });
  try {
    const a = join(flow.root, 'project-a'), b = join(flow.root, 'project-b');
    const older = await create(flow, 'older', a); const latest = await create(flow, 'latest', a);
    expect(choice(flow, older)).toBe('coding');
    await flow.ctx.acnRuntime.select(latest.agent.session.header, 'review');
    const inherited = await create(flow, 'inherited', a);
    expect(choice(flow, inherited)).toBe('review'); expect(choice(flow, older)).toBe('coding');
    await flow.ctx.acnRuntime.select(older.agent.session.header, 'coding');
    expect(choice(flow, await create(flow, 'after-older-change', a))).toBe('review');
    expect(choice(flow, await create(flow, 'other-project', b))).toBe('coding');
    expect(adapter.requests).toHaveLength(0);
  } finally { await flow.close(); }
});

it('reads a cold persisted choice after reload without activating the historical Agent', async () => {
  const adapter = new ScriptAdapter([]); const flow = await flowHarness(adapter, { persistence: true, config: config() });
  try {
    const cwd = join(flow.root, 'project');
    const first = await create(flow, 'persisted-choice', cwd);
    await flow.ctx.acnRuntime.select(first.agent.session.header, 'review'); await first.dispose();
    const previous = flow.knowledge.config;
    await flow.fibers.knowledge.dispose(); await flow.ctx.plugin(Knowledge, previous);
    expect(flow.ctx.sessions.get(SessionId('persisted-choice'))).toBeUndefined();
    const next = await create(flow, 'after-reload', cwd);
    expect(choice(flow, next)).toBe('review');
    expect(flow.ctx.agents.get(SessionId('persisted-choice'))).toBeUndefined();
    expect(flow.ctx.sessions.get(SessionId('persisted-choice'))).toBeUndefined();
    expect(adapter.requests).toHaveLength(0);
  } finally { await flow.close(); }
});

it('orders by creation time even after an older session is resumed and used', async () => {
  const adapter = new ScriptAdapter([textResponse('Older session completed.')]);
  const flow = await flowHarness(adapter, { persistence: true, config: config() });
  try {
    const cwd = join(flow.root, 'project'); const older = await create(flow, 'older-history', cwd);
    await flow.ctx.acnRuntime.select(older.agent.session.header, 'review'); await older.dispose();
    const newer = await create(flow, 'newer-history', cwd);
    await flow.ctx.acnRuntime.select(newer.agent.session.header, 'coding'); await newer.dispose();
    const resumed = await flow.ctx.agents.resume({ resumeSessionId: SessionId('older-history'), agentOptions: { provider: 'mock', model: 'mock' } });
    expect(choice(flow, resumed)).toBe('review'); await turn(resumed.agent); await resumed.dispose();
    expect(choice(flow, await create(flow, 'after-old-resume', cwd))).toBe('coding');
    expect(adapter.requests).toHaveLength(1);
  } finally { await flow.close(); }
});

it.each(['disabled', 'removed', 'identity'] as const)('uses the global default when the most recent configuration is %s', async (change) => {
  const flow = await flowHarness(new ScriptAdapter([]), { persistence: true, config: config() });
  try {
    const cwd = join(flow.root, 'project'); const first = await create(flow, 'previous-choice', cwd);
    await flow.ctx.acnRuntime.select(first.agent.session.header, 'review'); await first.dispose();
    const previous = flow.knowledge.config;
    const upstreams = { ...previous.upstreams };
    const review = upstreams['review']; if (review === undefined) throw new Error('Missing fixture configuration.');
    if (change === 'removed') delete upstreams['review'];
    else upstreams['review'] = change === 'disabled' ? { ...review, enabled: false } : { ...review, agentId: UpstreamSchema.parse({ agentId: 'agent-c' }).agentId };
    await flow.fibers.knowledge.dispose(); await flow.ctx.plugin(Knowledge, resolveConfig({ ...previous, upstreams }));
    expect(choice(flow, await create(flow, 'after-config-change', cwd))).toBe('coding');
  } finally { await flow.close(); }
});

it('ignores internal child sessions and supports parallel new conversations', async () => {
  const flow = await flowHarness(new ScriptAdapter([]), { config: config() });
  try {
    const cwd = join(flow.root, 'project'); const parent = await create(flow, 'parent', cwd);
    const newest = await create(flow, 'newest-user-session', cwd);
    await flow.ctx.acnRuntime.select(newest.agent.session.header, 'review');
    await flow.ctx.agents.create({ sessionId: SessionId('internal-child'), parentAgent: parent.agent, meta: { cwd, parentSession: parent.agent.session.id, origin: 'subagent', delegationDepth: 1 }, agentOptions: { provider: 'mock', model: 'mock' } });
    const handles = await Promise.all(['parallel-a', 'parallel-b'].map((id) => create(flow, id, cwd)));
    expect(handles.map((handle) => choice(flow, handle))).toEqual(['review', 'review']);
    expect(choice(flow, parent)).toBe('coding');
  } finally { await flow.close(); }
});

it('matches aliases of the same project and supports a blank global default', async () => {
  const flow = await flowHarness(new ScriptAdapter([]), { config: { ...config(), upstream: '' } });
  try {
    const project = join(flow.root, 'project'), alias = join(flow.root, 'alias');
    await fs.mkdir(project); await fs.symlink(project, alias, 'dir');
    const first = await create(flow, 'explicit-choice', alias);
    expect(choice(flow, first)).toBe(''); await flow.ctx.acnRuntime.select(first.agent.session.header, 'review');
    expect(choice(flow, await create(flow, 'same-real-project', project))).toBe('review');
    expect(choice(flow, await create(flow, 'unrelated-project', join(flow.root, 'other')))).toBe('');
  } finally { await flow.close(); }
});

it('falls back without mutating configuration when history cannot be read', async () => {
  const flow = await flowHarness(new ScriptAdapter([]), { persistence: true, config: config() });
  try {
    vi.spyOn(flow.ctx.sessionPersistence, 'list').mockRejectedValueOnce(new Error('Unavailable history'));
    expect(choice(flow, await create(flow, 'unavailable-history', join(flow.root, 'project')))).toBe('coding');
    const raw = { ...config(), projectUpstreams: { '/tmp/legacy-project': 'removed-profile' } };
    const values = configurationValues(raw);
    expect(values).not.toHaveProperty('projectUpstreams');
    expect(mergeConfiguration(raw, values)).not.toHaveProperty('projectUpstreams');
  } finally { await flow.close(); }
});
