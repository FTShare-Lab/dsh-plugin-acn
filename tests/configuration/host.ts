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
import type { ConfigurationValues } from '../../src/configuration.js';
import { ClaimStore } from '@ftai/dsh-plugin-acn/store';
import { ClaimSchema } from '@ftai/dsh-plugin-acn/protocol';
import type { AgentId } from '../../src/protocol/ids.js';
// fixture 只构造静态合法 ID；类型导入不让宿主执行器在运行时依赖源码 JS 或预生成声明。
const fixtureAgentId = (value: string) => value as AgentId;

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
patches.push({ id: 'acn-knowledge', config: { agentId: '', catalog: { maxClaims: 37 }, dream: { evidenceCalibration: true, enabled: false }, formation: { finalizeOnDispose: false, finalizeIdleMinutes: 0 } } });
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
  const beforeSetup = await ctx.agents.create({ sessionId: SessionId('blank-before-setup'), agentOptions: { provider: 'example', model: 'example-model' } });
  const home = join(root, 'knowledge');
  const request = { revision: initial.revision, values: { ...initial.values, agentId: 'agent-a', home, provider: 'example', model: 'example-model' } };
  let saved = await service.save(request);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  if (!saved.ok) throw new Error('Expected saved configuration.');
  assert.equal(saved.snapshot.dataDirectory, join(home, 'agents', 'agent-a'));
  const initialized = await service.interact({ action: 'select', sessionId: beforeSetup.agent.session.id, key: 'personal' });
  assert.equal(initialized.session?.available, true, 'The reused blank session can explicitly initialize after first configuration.');
  beforeSetup.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'First configured task.' }], source: { kind: 'user' } }));
  await beforeSetup.agent.whenIdle();
  assert.equal(model.calls, 1, 'First setup permits a real host turn in the original blank session.');
  await beforeSetup.dispose();
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

  if (process.platform === 'win32') {
    const member = (id: string) => ({ name: '', agentId: fixtureAgentId(id), enabled: true, routerEndpoint: '', maintainerEndpoint: '', keyEnv: '', timeoutMs: 15000 });
    const invalidNames: ConfigurationValues[] = [
      { ...saved.snapshot.values, agentId: 'con' },
      { ...saved.snapshot.values, upstream: 'nul', upstreams: { nul: member('agent-a') } },
      { ...saved.snapshot.values, upstream: 'coding', upstreams: { coding: member('aux') } },
    ];
    for (const values of invalidNames) {
      const result = await service.save({ revision: saved.snapshot.revision, values });
      assert.deepEqual(result, { ok: false, code: 'invalid', fields: ['windowsStorageName'] });
      assert.equal(await readFile(patch, 'utf8'), beforeInvalid);
    }
  }

  const create = (id: string) => ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'example', model: 'example-model' } });
  const claim = async (agent: Agent, name: string) => {
    const result = await ctx.tools.execute({ name: 'claim', arguments: { action: 'list' }, agent, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
    if (!result.isError) {
      const pool = [...ctx.loader.entries()].find((item) => item.options.id === 'acn-knowledge')?.fiber?.ctx.acnRuntime; assert.ok(pool);
      const knowledge = await pool.knowledge(agent.session.header);
      await new ClaimStore(knowledge.context()).write(ClaimSchema.parse({ id: 'claim_00000001', holder: knowledge.context().agentId, name, statement: 'Read requests use a bounded retry budget.', scope: 'example/retry', confidence: 'medium', status: 'active', created_at: '2026-01-01T00:00:00Z', source_claim_ids: [], evidence_summary: 'Checked the example contract.' }));
    }
    return result;
  };
  const sections = async (agent: Agent) => (await ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.filter((section) => section.name === 'acn:claim-catalog');
  const turn = async (agent: Agent) => { agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check the current context.' }], source: { kind: 'user' } })); await agent.whenIdle(); };
  const first = await create('original-session');
  assert.equal((await claim(first.agent, 'FROZEN_CLAIM_MARKER')).isError, false);
  await first.dispose();
  const live = await create('live-session');
  const frozen = await sections(live.agent);
  assert.match(JSON.stringify(frozen), /FROZEN_CLAIM_MARKER/);
  assert.equal((await claim(live.agent, 'LATER_CLAIM_MARKER')).isError, false);
  saved = await service.save({ revision: saved.snapshot.revision, values: { ...saved.snapshot.values, timeoutMs: 12345 } });
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.deepEqual(await sections(live.agent), frozen, 'Same-store reload preserves frozen catalog.');
  assert.doesNotMatch(JSON.stringify(await sections(live.agent)), /LATER_CLAIM_MARKER/);
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

  assert.equal((await claim(live.agent, 'WRONG_IDENTITY_MARKER')).isError, true);
  assert.equal((await ctx.commands.execute(live.agent, '/acn-finalize', [], new AbortController().signal))?.result.kind, 'error');
  assert.doesNotMatch(JSON.stringify(await sections(live.agent)), /FROZEN_CLAIM_MARKER|LATER_CLAIM_MARKER/);
  const previousCalls = model.calls; await turn(live.agent); assert.equal(model.calls, previousCalls, 'Stale session cannot reach the model.');
  await live.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('live-session'), agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await claim(resumed.agent, 'RESUMED_WRONG_MARKER')).isError, true);
  await turn(resumed.agent); assert.equal(model.calls, previousCalls);
  const current = await create('current-session');
  assert.equal((await claim(current.agent, 'CURRENT_IDENTITY_MARKER')).isError, false);
  await turn(current.agent); assert.equal(model.calls, previousCalls + 1);
  assert.doesNotMatch(JSON.stringify(await sections(current.agent)), /FROZEN_CLAIM_MARKER/);
  const fork = await ctx.agents.create({ sessionId: SessionId('historical-fork'), seed: [], inheritedEventCount: SessionLogOffset(0), meta: { parentSession: resumed.agent.session.id, isSeeded: true }, agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await claim(fork.agent, 'FORK_WRONG_MARKER')).isError, true);
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
  assert.equal((await claim(externalLive.agent, 'EXTERNAL_WRONG_MARKER')).isError, true);
  const callsBeforeExternal = model.calls; await turn(externalLive.agent); assert.equal(model.calls, callsBeforeExternal);
  const externalState = entry.options.config as Record<string, unknown>;
  assert.ok(typeof externalState.sessionEpoch === 'number' && externalState.sessionEpoch >= externalLive.agent.session.header.createdAt);
  await externalLive.dispose();
  const externalResume = await ctx.agents.resume({ resumeSessionId: SessionId('external-identity-session'), agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await claim(externalResume.agent, 'EXTERNAL_RESUME_WRONG_MARKER')).isError, true);
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
  assert.equal((await claim(racingResume.agent, 'RACING_RESUME_WRONG_MARKER')).isError, true);
  await racingResume.dispose();
  // 原配置升级后，真实 Loader、Remote、会话日志与项目预选必须一起工作。
  let native = await service.read();
  const upgraded = { ...native.values, upstream: 'coding', upstreams: { coding: { name: '开发', agentId: fixtureAgentId('agent-a'), enabled: true, routerEndpoint: '', maintainerEndpoint: '', keyEnv: '', timeoutMs: 15000 }, review: { name: '审查', agentId: fixtureAgentId('agent-b'), enabled: true, routerEndpoint: '', maintainerEndpoint: '', keyEnv: '', timeoutMs: 15000 } } };
  const upgrade = await service.save({ revision: native.revision, values: upgraded }); assert.equal(upgrade.ok, true, JSON.stringify(upgrade));
  assert.ok((await readFile(join(upgraded.home, 'upstream-migration-v1.yaml'), 'utf8')).includes('external-next'));
  // 跨平台迁移可以留下不用的旧身份；停用的配置不能阻止合法 upstream 的编辑与保存。
  const beforeLegacy = await service.read();
  const migrated = await service.save({ revision: beforeLegacy.revision, values: { ...beforeLegacy.values, agentId: 'con', upstreams: { ...upgraded.upstreams, retired: { ...upgraded.upstreams.review, agentId: fixtureAgentId('aux'), enabled: false } } } });
  assert.equal(migrated.ok, true, JSON.stringify(migrated));
  if (!migrated.ok) throw new Error('Expected inactive legacy identity to remain editable.');
  assert.equal(migrated.snapshot.dataDirectory, join(upgraded.home, 'coding', 'data', 'agents', 'agent-a'));
  const edited = await service.save({ revision: migrated.snapshot.revision, values: { ...migrated.snapshot.values, showCompletion: false } });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  if (!edited.ok) throw new Error('Expected valid upstream settings to save.');
  assert.equal((await service.save({ revision: edited.snapshot.revision, values: beforeLegacy.values })).ok, true);
  const coding = await ctx.agents.create({ sessionId: SessionId('upstream-coding'), meta: { cwd: root }, agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await service.interact({ action: 'session', sessionId: coding.agent.session.id })).session?.key, 'coding');
  assert.equal((await claim(coding.agent, 'UPSTREAM_CODING_CLAIM')).isError, false);
  native = await service.read();
  assert.equal((await service.save({ revision: native.revision, values: { ...native.values, upstream: 'review' } })).ok, true);
  assert.equal((await service.interact({ action: 'session', sessionId: coding.agent.session.id })).session?.key, 'coding');
  // 同一项目沿用最近新建会话；修改全局默认不改绑已存在的会话。
  const inherited = await ctx.agents.create({ sessionId: SessionId('same-project-inherited'), meta: { cwd: root }, agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await service.interact({ action: 'session', sessionId: inherited.agent.session.id })).session?.key, 'coding');
  const directory = join(root, 'another-project'); await mkdir(directory);
  const review = await ctx.agents.create({ sessionId: SessionId('upstream-review'), meta: { cwd: directory }, agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await service.interact({ action: 'session', sessionId: review.agent.session.id })).session?.key, 'review');
  assert.ok(!JSON.stringify(await ctx.systemPrompt.assemble(assembleContextFor(review.agent))).includes('UPSTREAM_CODING_CLAIM'));
  const callsBeforePreference = model.calls;
  assert.equal((await service.interact({ action: 'select', sessionId: review.agent.session.id, key: 'coding' })).ok, true);
  const projectNext = await ctx.agents.create({ sessionId: SessionId('project-recent-next'), meta: { cwd: directory }, agentOptions: { provider: 'example', model: 'example-model' } });
  assert.equal((await service.interact({ action: 'session', sessionId: projectNext.agent.session.id })).session?.key, 'coding');
  assert.equal(model.calls, callsBeforePreference);
  assert.equal((await service.interact({ action: 'session', sessionId: coding.agent.session.id })).session?.key, 'coding');
  // 冷历史浏览不恢复 Agent，也不写入项目配置。
  const coldId = SessionId('cold-project-history'); const coldHeader = { ...review.agent.session.header, id: coldId };
  let inspected = 0;
  ctx.provide('sessionController', { inspect: (id: string) => { assert.equal(id, coldId); inspected += 1; return Promise.resolve({ meta: coldHeader, events: [] }); }, resolveAgent: () => { throw new Error('History browsing must not activate an Agent.'); } } as unknown as typeof ctx.sessionController);
  assert.equal(ctx.sessions.get(coldId), undefined);
  await service.interact({ action: 'session', sessionId: coldId });
  assert.equal(inspected, 1); assert.equal(ctx.sessions.get(coldId), undefined);
  await entry.fiber.ctx.acnRuntime.knowledge(review.agent.session.header);
  await entry.fiber.ctx.acnRuntime.knowledge(projectNext.agent.session.header);
  await coding.dispose(); await inherited.dispose(); await review.dispose(); await projectNext.dispose();
  const beforeBroken = await service.read();
  const withBroken = await service.save({ revision: beforeBroken.revision, values: { ...beforeBroken.values, upstreams: { ...beforeBroken.values.upstreams, broken: { ...upgraded.upstreams.review, enabled: false } } } });
  assert.equal(withBroken.ok, true, JSON.stringify(withBroken));
  const brokenQueue = join(upgraded.home, 'broken', 'data', 'agents', 'agent-b', 'maintainer_uploads');
  await mkdir(brokenQueue, { recursive: true }); await writeFile(join(brokenQueue, 'pending.yaml'), 'claims: invalid-queue\n');
  const recoveredSettings = await service.read(); assert.equal(recoveredSettings.upstreamPending?.['broken'], null);
  assert.equal((await service.save({ revision: recoveredSettings.revision, values: { ...recoveredSettings.values, showCompletion: false } })).ok, true);
  // 保存与临时引用清理共享顺序，连接失联不能删除尚在提交的新密钥。
  const reference = `ACN_TEAM_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
  let removed = false;
  ctx.provide('credentials', { describe: () => Promise.resolve({ configured: false, writable: true }), set: () => Promise.resolve(), unset: () => { removed = true; return Promise.resolve(); } } as unknown as import('@deepseek-ai/dsh-credentials').CredentialProvider);
  assert.equal((await service.credential({ action: 'store', reference, value: crypto.randomUUID() })).ok, true);
  const beforeRace = await service.read(); const raceEdit = ctx.configEditor.edit.bind(ctx.configEditor);
  let enter: (() => void) | undefined; const entered = new Promise<void>((resolve) => { enter = resolve; });
  let finish: (() => void) | undefined; const gate = new Promise<void>((resolve) => { finish = resolve; });
  ctx.configEditor.edit = async (...args: Parameters<typeof raceEdit>) => { enter?.(); await gate; return raceEdit(...args); };
  try {
    const pendingSave = service.save({ revision: beforeRace.revision, values: { ...beforeRace.values, upstreams: { ...beforeRace.values.upstreams, credential_race: { name: '', agentId: fixtureAgentId('agent-race'), enabled: true, routerEndpoint: '', maintainerEndpoint: '', keyEnv: reference, timeoutMs: 1000 } } } });
    await entered; const cleanup = service.credential({ action: 'discard', reference });
    await new Promise<void>((resolve) => { setImmediate(resolve); }); assert.equal(removed, false);
    finish?.(); assert.equal((await pendingSave).ok, true); assert.equal((await cleanup).ok, false); assert.equal(removed, false);
  } finally { finish?.(); ctx.configEditor.edit = raceEdit; }
  // 曾采用的引用在轮换后也不能被迟到清理删除，不能仅因暂无实例就推断可安全清理。
  const historicalReference = `ACN_TEAM_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
  assert.equal((await service.credential({ action: 'store', reference: historicalReference, value: crypto.randomUUID() })).ok, true);
  const historical = await service.read();
  const withHistorical = { ...historical.values, upstreams: { ...historical.values.upstreams, credential_history: { name: '', agentId: fixtureAgentId('agent-history'), enabled: true, routerEndpoint: '', maintainerEndpoint: '', keyEnv: historicalReference, timeoutMs: 1000 } } };
  assert.equal((await service.save({ revision: historical.revision, values: withHistorical })).ok, true);
  const adopted = await service.read();
  assert.equal((await service.save({ revision: adopted.revision, values: { ...adopted.values, upstreams: { ...withHistorical.upstreams, credential_history: { ...withHistorical.upstreams.credential_history, keyEnv: '' } } } })).ok, true);
  assert.equal((await service.credential({ action: 'discard', reference: historicalReference })).ok, false);assert.equal(removed, false);
  await entry.fiber?.dispose();
  assert.equal((await service.read()).active, false);
  const inactive = await service.interact({ action: 'session', sessionId: coldId });
  assert.equal(inactive.ok, false); assert.equal(inactive.serviceAvailable, false); assert.equal(inactive.messageInfo?.code, 'service_inactive');
  process.stdout.write('ACN_CONFIGURATION_OK\n');
} finally { await ctx.fiber.dispose(); }
