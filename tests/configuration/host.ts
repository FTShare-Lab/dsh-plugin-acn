// 消费构建产物，使用真实宿主编辑器验证落盘、热重载和多窗口冲突。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import Commands from '@deepseek-ai/dsh-commands';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include';
import type {} from '../../src/dsh-adapter/configuration-service.js';

class Model extends LlmAdapter {
  calls = 0;
  hold: Promise<void> | undefined;
  override listModels(provider: string): Promise<LlmModelInfo[]> { return Promise.resolve([{ provider, id: 'example-model', name: 'Example model' }]); }
  override async *stream(): AsyncIterable<StreamChunk> { this.calls += 1; await this.hold; yield { type: 'finish', reason: { kind: 'stop' } }; }
}
const root = process.cwd();
const model = new Model();
const base = join(root, 'cordis.yml'); const patch = join(root, 'cordis.patch.yml'); const packagePath = join(root, 'package.json');
await writeFile(base, '[]\n');
await writeFile(packagePath, JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }));
const patches = loadOverlayPatches('configuration-test', fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url)));
patches.push({ id: 'acn-knowledge', config: { agentId: '', catalog: { maxClaims: 37 }, dream: { evidenceCalibration: true, enabled: false }, formation: { finalizeOnDispose: false, finalizeIdleMinutes: 0 }, memory: { review: { enabled: false } } } });
await writeFile(patch, '# Keep the profile comment.\n' + stringify(patches));
const ctx = await boot('configuration-test', base, patches, async (context) => {
  context.provide('profileContext', { name: 'configuration-test', dir: root, patchPath: patch, installAnchor: fileURLToPath(new URL('../../package.json', import.meta.url)), cwd: root, home: join(root, 'home'), startedBundles: [], overlays: [], telemetryDisabledEnv: 'true' });
  await mountAgentLoopTestDependencies(context, { workingDirectory: true });
  context.llm.registerAdapter(['example'], model);
  await context.plugin(Commands);
  await context.plugin(Persistence, { root: join(root, 'sessions') });
  await mountAgentLoopTestHarness(context);
  await context.plugin(TypertRegistry);
  await context.plugin(ConfigEditor);
}, new URL('../../package.json', import.meta.url).href);
try {
  const service = ctx.acnConfiguration;
  assert.ok(service, 'Configuration Remote is mounted.');
  const initial = await service.read();
  assert.equal(initial.values.agentId, '');
  assert.ok(initial.models.some((model) => model.provider === 'example' && model.id === 'example-model'));
  const home = join(root, 'knowledge');
  const request = { revision: initial.revision, values: { ...initial.values, agentId: 'agent-a', home, provider: 'example', model: 'example-model' } };
  let saved = await service.save(request);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  if (!saved.ok) throw new Error('Expected saved configuration.');
  assert.equal(saved.snapshot.dataDirectory, join(home, 'agents', 'agent-a'));
  const entry = [...ctx.loader.entries()].find((item) => item.options.id === 'acn-knowledge');
  assert.ok(entry?.fiber);
  assert.equal(entry.fiber.state, 2);
  assert.equal(entry.fiber.ctx.acnKnowledge.config.agentId, 'agent-a');
  assert.equal(entry.fiber.ctx.acnKnowledge.config.catalog.maxClaims, 37);
  assert.equal(entry.fiber.ctx.acnKnowledge.config.dream.evidenceCalibration, true);
  assert.equal((await service.interact({ action: 'probe', provider: 'example', model: 'example-model' })).ok, true, 'The configuration service reaches the isolated runtime through the actual loader entry.');
  assert.match(await readFile(patch, 'utf8'), /Keep the profile comment/);
  assert.deepEqual(await service.save(request), { ok: false, code: 'conflict', fields: [] });

  const beforeInvalid = await readFile(patch, 'utf8');
  for (const values of [
    { ...saved.snapshot.values, agentId: '../escape' },
    { ...saved.snapshot.values, mode: 'team' as const, routerEndpoint: 'http://127.0.0.1:8101' },
    { ...saved.snapshot.values, home: packagePath },
  ]) assert.equal((await service.save({ revision: saved.snapshot.revision, values })).ok, false);
  assert.deepEqual(await service.save({ revision: saved.snapshot.revision, values: { ...saved.snapshot.values, model: 'missing-model' } }), { ok: false, code: 'unavailable', fields: ['llm'] });
  assert.equal(await readFile(patch, 'utf8'), beforeInvalid);

  const create = (id: string) => ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'example', model: 'example-model' } });
  const memory = (agent: Agent, entry: string) => ctx.tools.execute({ name: 'memory', arguments: { ops: [{ op: 'add', target: 'memory', entry }] }, agent, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
  const sections = async (agent: Agent) => (await ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.filter((section) => section.name === 'acn:memory' || section.name === 'acn:claim-catalog');
  const turn = async (agent: Agent) => { agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check the current context.' }], source: { kind: 'user' } })); await agent.whenIdle(); };
  const first = await create('original-session');
  assert.equal((await memory(first.agent, 'FROZEN_PRIVATE_MARKER')).isError, false);
  await first.dispose();
  const live = await create('live-session');
  const frozen = await sections(live.agent);
  assert.match(JSON.stringify(frozen), /FROZEN_PRIVATE_MARKER/);
  assert.equal((await memory(live.agent, 'LATER_PRIVATE_MARKER')).isError, false);
  saved = await service.save({ revision: saved.snapshot.revision, values: { ...saved.snapshot.values, timeoutMs: 12345 } });
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.deepEqual(await sections(live.agent), frozen, 'Same-store reload preserves frozen Memory and catalog.');
  assert.doesNotMatch(JSON.stringify(await sections(live.agent)), /LATER_PRIVATE_MARKER/);
  await turn(live.agent);
  const beforeBusy = await readFile(patch, 'utf8');
  let release: (() => void) | undefined;
  model.hold = new Promise<void>((resolve) => { release = resolve; });
  live.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Wait for the active turn.' }], source: { kind: 'user' } }));
  assert.deepEqual(await service.save({ revision: saved.snapshot.revision, values: { ...saved.snapshot.values, agentId: 'busy-agent' } }), { ok: false, code: 'busy', fields: [] });
  assert.equal(await readFile(patch, 'utf8'), beforeBusy);
  release?.(); model.hold = undefined; await live.agent.whenIdle();

  await mkdir(join(home, 'agents', 'agent-a'), { recursive: true });
  const retained = join(home, 'agents', 'agent-a', 'retained.txt'); await writeFile(retained, 'old knowledge is retained');
  const results = await Promise.all(['agent-b', 'agent-c'].map((agentId) => service.save({ revision: saved.snapshot.revision, values: { ...saved.snapshot.values, agentId } })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.ok(results.some((result) => !result.ok && result.code === 'conflict'));
  assert.equal(await readFile(retained, 'utf8'), 'old knowledge is retained');

  assert.equal((await memory(live.agent, 'WRONG_IDENTITY_MARKER')).isError, true);
  assert.equal((await ctx.commands.execute(live.agent, '/acn-finalize', [], new AbortController().signal))?.result.kind, 'error');
  assert.doesNotMatch(JSON.stringify(await sections(live.agent)), /FROZEN_PRIVATE_MARKER|LATER_PRIVATE_MARKER/);
  const previousCalls = model.calls; await turn(live.agent); assert.equal(model.calls, previousCalls, 'Stale session cannot reach the model.');
  await live.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('live-session'), agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await memory(resumed.agent, 'RESUMED_WRONG_MARKER')).isError, true);
  await turn(resumed.agent); assert.equal(model.calls, previousCalls);
  const current = await create('current-session');
  assert.equal((await memory(current.agent, 'CURRENT_IDENTITY_MARKER')).isError, false);
  await turn(current.agent); assert.equal(model.calls, previousCalls + 1);
  assert.doesNotMatch(JSON.stringify(await sections(current.agent)), /FROZEN_PRIVATE_MARKER/);
  const fork = await ctx.agents.create({ sessionId: SessionId('historical-fork'), seed: [], inheritedEventCount: SessionLogOffset(0), meta: { parentSession: resumed.agent.session.id, isSeeded: true }, agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await memory(fork.agent, 'FORK_WRONG_MARKER')).isError, true);
  await fork.dispose(); await resumed.dispose(); await current.dispose();

  const beforeExternal = await service.read();
  const external = parse(await readFile(patch, 'utf8')) as PatchOptions[];
  external.push({ id: 'acn-knowledge', config: { ...(entry.options.config as Record<string, unknown>), catalog: { maxClaims: 49 } } });
  await writeFile(patch, stringify(external));
  const conflict = await service.save({ revision: beforeExternal.revision, values: { ...beforeExternal.values, agentId: 'agent-d' } });
  assert.deepEqual(conflict, { ok: false, code: 'conflict', fields: [] });
  assert.equal(entry.fiber.ctx.acnKnowledge.config.catalog.maxClaims, 49);
  assert.equal((await service.read()).values.agentId, beforeExternal.values.agentId);
  const beforeIdentityConflict = await service.read();
  const externalLive = await create('external-identity-session');
  const externalRows = parse(await readFile(patch, 'utf8')) as PatchOptions[];
  externalRows.push({ id: 'acn-knowledge', config: { ...(entry.options.config as Record<string, unknown>), agentId: 'external-agent' } });
  await writeFile(patch, stringify(externalRows));
  assert.deepEqual(await service.save({ revision: beforeIdentityConflict.revision, values: { ...beforeIdentityConflict.values, timeoutMs: 23456 } }), { ok: false, code: 'conflict', fields: [] });
  assert.equal((await service.read()).values.agentId, 'external-agent');
  assert.equal((await service.read()).values.timeoutMs, beforeIdentityConflict.values.timeoutMs, 'Conflicting draft is not applied.');
  assert.equal((await memory(externalLive.agent, 'EXTERNAL_WRONG_MARKER')).isError, true);
  const callsBeforeExternal = model.calls; await turn(externalLive.agent); assert.equal(model.calls, callsBeforeExternal);
  const externalState = entry.options.config as Record<string, unknown>;
  assert.ok(typeof externalState.sessionEpoch === 'number' && externalState.sessionEpoch >= externalLive.agent.session.header.createdAt);
  await externalLive.dispose();
  const externalResume = await ctx.agents.resume({ resumeSessionId: SessionId('external-identity-session'), agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await memory(externalResume.agent, 'EXTERNAL_RESUME_WRONG_MARKER')).isError, true);
  await externalResume.dispose();
  const busyConflictSnapshot = await service.read();
  const racing = await create('external-busy-session');
  const racingRows = parse(await readFile(patch, 'utf8')) as PatchOptions[];
  racingRows.push({ id: 'acn-knowledge', config: { ...(entry.options.config as Record<string, unknown>), agentId: 'external-next' } });
  await writeFile(patch, stringify(racingRows));
  // 仅在真实编辑器的预重载与变更回调之间插入另一标签页的输入，复现 running 先于准入的窗口。
  const edit = ctx.configEditor.edit.bind(ctx.configEditor);
  ctx.configEditor.edit = (target, change) => edit(target, (current, inherited) => {
    racing.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Concurrent input during external reload.' }], source: { kind: 'user' } }));
    assert.equal(racing.agent.status, 'running');
    return change(current, inherited);
  });
  try {
    assert.deepEqual(await service.save({ revision: busyConflictSnapshot.revision, values: { ...busyConflictSnapshot.values, timeoutMs: 34567 } }), { ok: false, code: 'conflict', fields: [] });
  } finally { ctx.configEditor.edit = edit; }
  await racing.agent.whenIdle();
  const racingConfig = entry.options.config as Record<string, unknown>;
  assert.ok(typeof racingConfig.sessionEpoch === 'number' && racingConfig.sessionEpoch >= racing.agent.session.header.createdAt);
  assert.equal((await service.read()).values.timeoutMs, busyConflictSnapshot.values.timeoutMs);
  await racing.dispose();
  const racingResume = await ctx.agents.resume({ resumeSessionId: SessionId('external-busy-session'), agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await memory(racingResume.agent, 'RACING_RESUME_WRONG_MARKER')).isError, true);
  await racingResume.dispose();
  process.stdout.write('ACN_CONFIGURATION_OK\n');
} finally { await ctx.fiber.dispose(); }
