// 安装前历史与未入队就开聊的会话保持普通聊天；仅安装后的空白会话可选择知识归属。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import { SessionId, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { resolveConfig } from '../../src/config.js';
import { resolveUpstream } from '../../src/upstreams.js';
import Knowledge from '../../src/plugins/knowledge.js';
import { AcnKnowledge } from '../../src/knowledge/service.js';
import { AcnMemory } from '../../src/memory/service.js';
import { ClaimStore } from '../../src/store/claims.js';
import { JobQueue } from '../../src/worker/queue.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { flowHarness, turn } from '../flow/harness.js';
import { ScriptAdapter, textResponse } from '../flow/adapter.js';
import { teamServer } from '../team/helpers.js';

it.each([false, true])('keeps pre-install history usable without adopting ACN (cold=%s)', async (cold) => {
  const adapter = new ScriptAdapter([textResponse('Earlier work.'), textResponse('Continued ordinary work.')]);
  const f = await flowHarness(adapter, { configured: false, persistence: true, filesystem: true, formation: true, inbox: true, dream: true, memory: true, config: { dream: { enabled: false }, formation: { idleRecap: false }, memory: { review: { intervalTurns: 1 } } } });
  try {
    await f.fibers.knowledge.dispose();
    const original = await f.ctx.agents.create({ sessionId: SessionId('pre-install-work'), agentOptions: { provider: 'mock', model: 'mock' } });
    const workspace = join(f.root, 'workspace'); await fs.mkdir(workspace); await fs.writeFile(join(workspace, 'notes.txt'), 'Public project content.');
    await f.ctx.workingDirectory.set(original.agent, workspace); await turn(original.agent, 'PRE_INSTALL_TASK_MARKER');
    if (cold) await original.dispose();
    const config = resolveConfig({ ...f.knowledge.config, upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } } });
    await f.ctx.plugin(Knowledge, config); await f.ctx.plugin(FileTools);
    const handle = cold ? await f.ctx.agents.resume({ resumeSessionId: original.agent.session.id, agentOptions: { provider: 'mock', model: 'mock' } }) : original;
    const agent = handle.agent; const pool = f.ctx.acnRuntime;
    expect(pool.view(agent.session.header)).toMatchObject({ available: false, phase: 'unbound', key: '', locked: true });
    const selected = resolveUpstream(config, 'coding'); if (selected === undefined) throw new Error('Missing test configuration.');
    const unused = new AcnKnowledge(selected, f.ctx.logger);
    await new ClaimStore(unused.context()).write(sampleClaim({ name: 'UNBOUND_PRIVATE_CLAIM_MARKER' }));
    await new AcnMemory(unused).apply({ ops: [{ op: 'add', target: 'memory', entry: 'UNBOUND_PRIVATE_MEMORY_MARKER' }] });
    const call = (name: string, args: unknown) => f.ctx.tools.execute({ name, arguments: args, agent, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
    expect(await call('read', { file_path: join(workspace, 'notes.txt') })).toMatchObject({ isError: false });
    expect(await call('write', { file_path: join(workspace, 'new.txt'), content: 'Ordinary work remains available.' })).toMatchObject({ isError: false });
    expect(await fs.readFile(join(workspace, 'new.txt'), 'utf8')).toBe('Ordinary work remains available.');
    expect(await call('read', { file_path: unused.context().paths.memory })).toMatchObject({ isError: true });
    for (const [name, args] of [['claim', { action: 'list' }], ['memory', { ops: [] }]] as const) expect(await call(name, args)).toMatchObject({ isError: true });
    await turn(agent, 'CONTINUE_WITHOUT_ACN_MARKER');
    expect(adapter.requests, JSON.stringify(agent.session.snapshotEvents().filter((event) => event.type === 'turn/end'))).toHaveLength(2);
    expect(adapter.requests.at(-1)?.tools?.some((tool) => ['claim', 'memory', 'consult_router'].includes(tool.name))).toBe(false);
    expect(JSON.stringify(adapter.requests.at(-1))).not.toMatch(/UNBOUND_PRIVATE_(?:CLAIM|MEMORY)_MARKER/);
    expect(await new JobQueue(unused.context()).list()).toEqual([]);
    expect(agent.session.snapshotEvents().map(pluginRecordOf).filter((record) => record?.type === 'plugin:acn/team-selection')).toEqual([]);
    await expect(pool.select(agent.session.header, 'coding')).rejects.toMatchObject({ kind: 'bound' });
    const command = await f.ctx.commands.execute(agent, '/recap', [], new AbortController().signal);
    expect(command?.result.kind).toBe('error');
    if (command?.result.kind === 'error') expect(command.result.text).toContain('聊天仍可继续');
    await handle.dispose();
  } finally { await f.close(); }
});

it.each([false, true])('does not bind a session that spoke before first configuration (upstreams=%s)', async (upstreams) => {
  const adapter = new ScriptAdapter([textResponse('Work before setup.'), textResponse('Work after setup.')]);
  const f = await flowHarness(adapter, { configured: false, config: { dream: { enabled: false } } });
  try {
    const agent = await f.create(); await turn(agent);
    const config = resolveConfig({ ...f.knowledge.config, agentId: 'agent-a', ...(upstreams ? { upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } } } : {}) });
    await f.fibers.knowledge.dispose(); await f.ctx.plugin(Knowledge, config);
    expect(f.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ available: false, locked: true, phase: 'unbound' });
    await turn(agent); expect(adapter.requests).toHaveLength(2);
    await expect(f.ctx.acnRuntime.select(agent.session.header, upstreams ? 'coding' : 'personal')).rejects.toMatchObject({ kind: 'bound' });
  } finally { await f.close(); }
});

it('keeps a blank session created before installation unbound, including before its first message', async () => {
  const f = await flowHarness(new ScriptAdapter([textResponse('First ordinary task.')]), { configured: false });
  try {
    await f.fibers.knowledge.dispose(); const agent = await f.create();
    await f.ctx.plugin(Knowledge, resolveConfig({ ...f.knowledge.config, upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } } }));
    expect(f.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ available: false, locked: true, phase: 'unbound' });
    await expect(f.ctx.acnRuntime.select(agent.session.header, 'coding')).rejects.toMatchObject({ kind: 'bound' });
    await turn(agent); expect(f.ctx.acnRuntime.chatAllowed(agent.session.header)).toBe(true);
  } finally { await f.close(); }
});

it('permits a new unselected blank session to chat and permanently locks out later enrollment', async () => {
  const adapter = new ScriptAdapter([textResponse('Ordinary unbound work.'), textResponse('Still ordinary work.')]);
  const f = await flowHarness(adapter, { config: { upstream: '', upstreams: { coding: { agentId: 'agent-a' } }, dream: { enabled: false } } });
  try {
    const agent = await f.create(); expect(f.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ phase: 'unbound', locked: false });
    await turn(agent); expect(f.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ phase: 'unbound', locked: true });
    await expect(f.ctx.acnRuntime.select(agent.session.header, 'coding')).rejects.toMatchObject({ kind: 'bound' });
    const config = resolveConfig({ ...f.knowledge.config, upstream: 'coding' });
    await f.fibers.knowledge.dispose(); await f.ctx.plugin(Knowledge, config);
    await turn(agent); expect(adapter.requests).toHaveLength(2);
    expect(f.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ phase: 'unbound', locked: true });
  } finally { await f.close(); }
});

it('allows team selection only before the first message of a new eligible session', async () => {
  const server = await teamServer((request) => request.path === '/inbox/pull' ? { body: [] } : request.path.endsWith('/overview') ? { body: { scopes: [] } } : { body: { status: 'ok', team_auth_enabled: false } });
  const f = await flowHarness(new ScriptAdapter([textResponse('Team task.')]), { inbox: true, config: { upstream: '', upstreams: { team: { agentId: 'agent-a', routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint }, other: { agentId: 'agent-b' } }, dream: { enabled: false } } });
  try {
    const agent = await f.create(); expect(f.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ phase: 'unbound', locked: false });
    expect(server.requests).toEqual([]);
    expect((await f.ctx.acnRuntime.select(agent.session.header, 'team')).available).toBe(true);
    await turn(agent);
    await expect(f.ctx.acnRuntime.select(agent.session.header, 'other')).rejects.toMatchObject({ kind: 'bound' });
    expect(f.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ available: true, key: 'team', locked: true });
  } finally { await f.close(); await server.close(); }
});

it.each(['changed', 'malformed'])('does not turn a previously bound %s identity into an unbound session', async (kind) => {
  const adapter = new ScriptAdapter([]);
  const f = await flowHarness(adapter, { config: { upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } }, dream: { enabled: false } } });
  try {
    const agent = await f.create();
    appendPluginRecord(agent.session, 'plugin:acn/team-selection', { schemaVersion: 1, key: 'coding', identity: kind === 'changed' ? '0'.repeat(64) : 'invalid' });
    expect(f.ctx.acnRuntime.view(agent.session.header)).toMatchObject({ phase: 'blocked', available: false });
    expect(f.ctx.acnRuntime.chatAllowed(agent.session.header)).toBe(false);
    await turn(agent); expect(adapter.requests).toEqual([]);
  } finally { await f.close(); }
});
