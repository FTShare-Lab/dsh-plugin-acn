// 在独立进程中挂载真实组合，检查激活状态、隔离与卸载清理。
import assert from 'node:assert/strict';
import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { FiberState, Context } from '@deepseek-ai/cordis';
import { boot, createRuntimeResolution, loadOverlayPatches, loadProfileDirectory, PluginPackages } from '@deepseek-ai/dsh-app-boot';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import Commands from '@deepseek-ai/dsh-commands';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Claim } from '../../../src/protocol/claim.js';
import type { Validation } from '../../../src/dream/schema.js';
import type {} from '../../../src/plugins/memory.js';

function lastJson(options: GenerateOptions): unknown {
  for (const message of [...options.messages].reverse()) for (const block of [...message.content].reverse()) if (block.type === 'text') {
    try { return JSON.parse(block.text) as unknown; } catch { /* Ignore host wrappers. */ }
  }
  throw new Error('Missing tool JSON.');
}
class LocalModel extends LlmAdapter {
  private dreamCalls = 0;

  calls = 0;
  private readonly calibration: boolean;
  constructor(calibration = false) { super(); this.calibration = calibration; }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model }); }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted(); await Promise.resolve(); this.calls += 1;
    const raw = options.messages.flatMap((message) => message.content).filter((block) => block.type === 'text').map((block) => block.text).join('');
    if (options.tools?.some((tool) => tool.name === 'dream_apply_group')) {
      const firstInput = options.messages.flatMap((message) => message.content).find((block) => block.type === 'text' && block.text.includes('"dream_context"'));
      assert.ok(firstInput?.type === 'text'); const input = JSON.parse(firstInput.text) as { claims: Claim[] }; const current = input.claims[0]; assert.ok(current);
      const step = this.dreamCalls++; let name: string; let args: object;
      if (this.calibration && step === 0) { name = 'dream_record_candidates'; args = { candidates: [{ group_id: 'install-group', claim_ids: [current.id], kind: 'evidence', reason: 'Check the current direct contract.' }] }; }
      else if (this.calibration && step === 1) { name = 'file_read'; args = { path: 'source.txt', claim_ids: [current.id] }; }
      else if (step === (this.calibration ? 2 : 0)) {
        name = 'dream_stage_group'; const receipt = this.calibration ? lastJson(options) as { evidence_id: string } : null;
        args = { group_id: 'install-group', group: receipt === null ? { kind: 'quality', reason: 'Remove a synthetic one-time record.', operations: [{ id: current.id, action: 'deprecate', reason: 'Synthetic one-time material.' }] } : { kind: 'evidence', reason: 'Check direct file evidence.', evidence_ids: [receipt.evidence_id], change_basis: [{ claim_id: current.id, removed_or_changed: 'Narrow broad retries.', added: 'Only read retries.', justification: 'The file states the read boundary.', evidence_ids: [receipt.evidence_id] }], operations: [{ id: current.id, action: 'update', changes: { statement: 'Retry only read requests within the explicit service budget.', confidence: 'high', evidence_summary: 'A versioned file supports read-only retries; writes remain unverified.' } }] } };
      } else if (step === (this.calibration ? 3 : 1)) { name = 'dream_validate'; args = { group_id: 'install-group' }; }
      else if (step === (this.calibration ? 4 : 2)) { const validation = lastJson(options) as Validation; name = 'dream_apply_group'; args = { group_id: 'install-group', validation_id: validation.validation_id, review: { claims: validation.input.before.map((claim) => ({ claim_id: claim.id, final_name: claim.name, name_reason: 'Name matches the final body.', information_preserved: 'Only the synthetic record or the explicitly disproved scope is removed.', removal_or_correction: 'Current direct material bounds the correction.', factual_correction: this.calibration, output_ids: this.calibration ? [claim.id] : [], evidence_ids: Object.keys(validation.input.evidence) })), scope_and_certainty: 'No broader guarantees.' } }; }
      else { name = 'dream_finish'; args = { review: { quality: 'Reviewed input.', evidence: 'Used the direct file when enabled.', consolidation: 'No other consolidation needed.' } }; }
      const id = ToolCallId(`dream-${step}`); const argumentsJson = JSON.stringify(args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    if (this.calibration && options.tools?.some((tool) => tool.name === 'read')) {
      if (JSON.stringify(options.messages).includes('file_version')) { yield { type: 'text-delta', index: 0, text: 'The source directly limits retries to reads.' }; yield { type: 'finish', reason: { kind: 'stop' } }; return; }
      const childInput = options.messages.filter((message) => message.role === 'user' && message.source?.kind === 'acn-formation').flatMap((message) => message.content).filter((block) => block.type === 'text').map((block) => block.text).join('');
      const input = JSON.parse(childInput) as { claims: Claim[] };
      const id = ToolCallId('installed-evidence-read'); const args = JSON.stringify({ path: 'source.txt', claim_ids: input.claims.map((claim) => claim.id) });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name: 'read', argumentsDelta: args }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: args } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    if (raw.startsWith('{') && raw.includes('"phase"')) {
      const request = JSON.parse(raw) as { phase: string; claims?: Claim[]; before?: Claim[]; validation?: Validation; evidence?: Record<string, { output: { content: string } }> };
      const first = (request.claims ?? request.before)?.[0]; let response: object;
      if (request.phase === 'memory_review') response = { ops: [{ op: 'add', target: 'user', entry: 'Prefers concise explanations.' }] };
      else if (request.phase === 'candidates' && first) response = { review: { quality: 'Review an explicit test record.', evidence: 'Calibration unavailable.', consolidation: 'No other candidate needed.' }, candidates: [{ group_id: 'install-group', claim_ids: [first.id], kind: 'quality', reason: 'Explicit synthetic one-time test record.' }], sync_candidates: [] };
      else if (request.phase === 'draft' && first) response = { action: 'stage', group: { kind: 'quality', reason: 'Remove the one-time test record.', operations: [{ id: first.id, action: 'deprecate', reason: 'Only this synthetic record is episodic.' }] } };
      else if (request.phase === 'review' && request.validation) {
        const v = request.validation; const fields = ['name', 'statement', 'scope', 'evidence_summary'] as const;
        response = { decision: 'apply', reason: 'Reviewed every field of the synthetic record.', reason_kind: 'useful_knowledge', semantic: { claims: v.input.before.map((claim) => ({ claim_id: claim.id, final_name: claim.name, name_reason: 'Retired history keeps the original name.', information_preserved: 'Only synthetic one-time test material is removed.', removal_or_correction: 'Historical body remains stored.', factual_correction: false, output_ids: [], evidence_ids: [] })), scope_and_certainty: 'No facts changed.' }, self_review: { group_id: v.input.group_id, validation_id: v.validation_id, preservation: v.input.before.flatMap((claim) => fields.map((field) => ({ before: { claim_id: claim.id, field, quote: claim[field] }, after: [], disposition: 'episodic', reason: 'Explicit synthetic one-time test material.', evidence: [] }))), support: [], scope_and_certainty: 'No new facts or confidence increase.' } };
      } else throw new Error('Unexpected installed Dream request.');
      if (this.calibration && request.phase === 'candidates' && first) response = { review: { quality: 'No cleanup.', evidence: 'Check the direct file.', consolidation: 'No consolidation.' }, candidates: [{ group_id: 'install-group', claim_ids: [first.id], kind: 'evidence', reason: 'Calibrate the direct retry scope.' }], sync_candidates: [] };
      if (this.calibration && request.phase === 'draft' && first) response = { action: 'stage', group: { kind: 'evidence', reason: 'Correct the scope using direct versioned material.', evidence_ids: Object.keys(request.evidence ?? {}), change_basis: [{ claim_id: first.id, removed_or_changed: 'Correct broad retry scope.', added: 'Retry only reads within the budget.', justification: 'The direct source states the limitation.', evidence_ids: Object.keys(request.evidence ?? {}) }], operations: [{ id: first.id, action: 'update', changes: { statement: 'Retry only read requests within the explicit service budget.', confidence: 'high', evidence_summary: `Historical evidence: ${first.evidence_summary}\nA new versioned file supports reads only; writes remain unverified.` } }] } };
      if (this.calibration && request.phase === 'review' && request.validation) {
        const v = request.validation; const fields = ['name', 'statement', 'scope', 'evidence_summary'] as const; const ids = Object.keys(v.input.evidence); const proof = ids.map((evidence_id) => { const receipt = v.input.evidence[evidence_id] as { output: { content: string } }; return { evidence_id, quote: receipt.output.content }; }); const quote = (claim: Pick<Claim, 'id' | typeof fields[number]>, field: typeof fields[number]) => ({ claim_id: claim.id, field, quote: claim[field] });
        response = { decision: 'apply', reason: 'Direct versioned material supports the bounded scope.', reason_kind: 'useful_knowledge', semantic: { claims: v.input.before.map((claim) => ({ claim_id: claim.id, final_name: claim.name, name_reason: 'The name still describes the bounded rule.', information_preserved: 'Conditions and uncertainty reviewed.', removal_or_correction: 'Correct scope using direct material.', factual_correction: true, output_ids: [claim.id], evidence_ids: ids })), scope_and_certainty: 'Only reads are supported.' }, self_review: { group_id: v.input.group_id, validation_id: v.validation_id, preservation: v.input.before.flatMap((claim) => fields.map((field) => ({ before: quote(claim, field), after: v.input.after.map((output) => quote(output, field)), disposition: 'corrected', reason: 'Direct file supports the bounded scope.', evidence: proof }))), support: v.input.after.flatMap((claim) => fields.map((field) => ({ after: quote(claim, field), before: v.input.before.map((input) => quote(input, field)), evidence: proof, reason: 'Direct source and prior unchanged fields.' }))), scope_and_certainty: 'Writes remain unverified.' } };
      }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(response) }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    const inbox = JSON.stringify(options.messages).includes('inbox_messages');
    const text = this.calls === 1 ? 'Verified the retry boundary using the current service contract.' : JSON.stringify({ new_claims: [{ id: '$new_claim_0$', name: 'bounded_retries', statement: 'Retry idempotent requests only within an explicit service budget.', scope: 'service / retries', confidence: this.calibration ? 'medium' : 'high', evidence_summary: 'Compared the current task evidence with the service contract.', source_claim_ids: inbox ? ['policy_00000001'] : [] }], updated_claims: [], ...inbox ? {} : { used_claim_ids: [] }, new_disputes: [] });
    yield { type: 'text-delta', index: 0, text }; yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const [patchPath, scenario = 'active', installedBaseUrl] = process.argv.slice(2);
// 发布类型中的 const enum 没有运行时导出；数值与基线状态机一致。
const activeState = 2 as FiberState.ACTIVE;
if (patchPath === undefined) throw new Error('Expected a bundle patch path.');
const configPath = join(process.cwd(), 'cordis.yml');
await writeFile(configPath, '[]\n');
const patches = loadOverlayPatches('acn-smoke', patchPath);
if (scenario === 'disabled') patches.push({ id: 'acn-knowledge', disabled: true });
const configured = scenario === 'configured' || scenario === 'calibrated' || scenario === 'memory' || scenario === 'memory_off' || scenario.startsWith('disabled_');
const home = join(process.cwd(), 'knowledge');
if (configured) patches.push({ id: 'acn-knowledge', config: { agentId: 'agent-a', home, dream: { evidenceCalibration: scenario === 'calibrated' }, memory: { enabled: scenario !== 'memory_off', review: { intervalTurns: scenario === 'memory' ? 1 : 10 } } } });
if (scenario === 'calibrated') await writeFile(join(process.cwd(), 'source.txt'), 'Retry only read requests within the explicit service budget. Writes remain unverified.');
if (scenario.startsWith('disabled_')) patches.push({ id: `acn-${scenario.slice('disabled_'.length)}`, disabled: true });

let ctx: Context | undefined;
let harness: AgentLoopTestHarness | undefined;
try {
  ctx = await boot('acn-smoke', configPath, patches, async (root) => {
    if (installedBaseUrl !== undefined) {
      // 与 CLI 的启动链一致，先装运行时解析，再加载 profile 内的插件。
      const installAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-agent-loop-testkit/package.json'));
      const profile = loadProfileDirectory('acn-smoke', dirname(fileURLToPath(installedBaseUrl)), installAnchor);
      const resolution = await createRuntimeResolution({ installAnchor, profile });
      const layer = profile.layers.find((candidate) => candidate.packageName === 'dsh-plugin-acn');
      assert.ok(layer, 'Installed bundle must be a selected profile layer.');
      assert.ok(resolution.localPackageNames.includes('dsh-plugin-acn'));
      assert.ok(!resolution.entries.some((candidate) => candidate.name === 'dsh-plugin-acn'), 'The test must not substitute the checkout package.');
      assert.equal(await realpath(layer.packageDir), await realpath(join(profile.dir, 'node_modules', 'dsh-plugin-acn')));
      await root.plugin(PluginPackages, { resolution });
    }
    await mountAgentLoopTestDependencies(root, { workingDirectory: true });
    root.llm.registerAdapter(['local-model'], new LocalModel(scenario === 'calibrated'));
    await root.plugin(Commands);
    harness = await mountAgentLoopTestHarness(root);
    root.logger.exporter({
      export: (message) => {
        if (message.type === 'info') process.stdout.write(`${String(message.args[0])}\n`);
      },
    });
  }, installedBaseUrl ?? new URL('../../../package.json', import.meta.url).href);

  const entry = [...ctx.loader.entries()].find((candidate) => candidate.options.id === 'acn-knowledge');
  assert.ok(entry, 'Knowledge entry must be present in the mounted bundle.');
  assert.equal(ctx.get('acnFormation'), undefined, 'Formation must not leak into the root realm.');
  assert.equal(ctx.get('acnDream'), undefined, 'Dream must not leak into the root realm.');
  assert.equal(ctx.get('acnMemory'), undefined, 'Memory must not leak into the root realm.');
  assert.equal(ctx.get('acnKnowledge'), undefined, 'Knowledge must not leak into the root realm.');

  if (scenario === 'disabled') {
    assert.equal(entry.disabled, true);
    assert.notEqual(entry.fiber?.state, activeState);
    assert.equal(entry.ctx.get('acnKnowledge'), undefined);
  } else {
    assert.ok(entry.fiber, 'Knowledge entry must import successfully.');
    assert.equal(entry.fiber.state, activeState);
    const scopedContext = entry.fiber.ctx;
    assert.ok(scopedContext.get('acnKnowledge'), 'Knowledge service must be visible inside its group.');
    assert.equal(scopedContext.acnKnowledge.config.llm.maxOutputTokens, 32_768, 'The loaded bundle must use the current background output default.');
    assert.ok(harness);
    const agent = await harness.create(SessionId('loader-session'), { provider: 'local-model', model: 'example-model' });
    const toolNames = ctx.tools.schemas().map((tool) => tool.name);
    const sections = (await ctx.systemPrompt.assemble({ agent })).sections.map((section) => section.name);
    const commands = ctx.commands.list(agent).map((command) => command.name);
    assert.equal(toolNames.includes('claim'), configured && scenario !== 'disabled_tools');
    assert.equal(toolNames.includes('memory'), configured && scenario !== 'disabled_memory' && scenario !== 'memory_off');
    assert.equal(sections.includes('acn:memory'), configured && scenario !== 'disabled_memory' && scenario !== 'memory_off');
    assert.equal(sections.includes('acn:knowledge'), configured && scenario !== 'disabled_prompt');
    assert.equal(commands.includes('claim'), configured && scenario !== 'disabled_commands');
    assert.equal(commands.includes('acn-status'), scenario !== 'disabled_commands');
    assert.equal(commands.includes('acn-finalize'), configured && scenario !== 'disabled_commands' && scenario !== 'disabled_formation');
    assert.equal(commands.includes('inbox'), configured && scenario !== 'disabled_commands' && scenario !== 'disabled_inbox');
    assert.equal(commands.includes('dream'), configured && scenario !== 'disabled_commands' && scenario !== 'disabled_dream');
    assert.equal(toolNames.includes('consult_router'), false, 'The installed solo profile has no team tool.');
    if (scenario === 'memory') {
      const before = (await ctx.systemPrompt.assemble({ agent })).sections.find((section) => section.name === 'acn:memory')?.text;
      const result = await ctx.tools.execute({ name: 'memory', arguments: { ops: [{ op: 'add', target: 'memory', entry: 'INSTALLED_PRIVATE_MARKER' }] }, agent, callId: ToolCallId('installed-memory'), signal: new AbortController().signal });
      assert.equal(result.isError, false); assert.match(JSON.stringify(result.value), /"success":true/);
      assert.equal((await ctx.systemPrompt.assemble({ agent })).sections.find((section) => section.name === 'acn:memory')?.text, before);
      const next = await harness.create(SessionId('installed-memory-next'), { provider: 'local-model', model: 'example-model' });
      assert.match((await ctx.systemPrompt.assemble({ agent: next })).sections.find((section) => section.name === 'acn:memory')?.text ?? '', /INSTALLED_PRIVATE_MARKER/);
    }
    if (toolNames.includes('claim')) {
      const result = await ctx.tools.execute({ name: 'claim', arguments: { action: 'list' }, agent, callId: ToolCallId('loader-call'), signal: new AbortController().signal });
      assert.equal(result.isError, false);
      assert.match(JSON.stringify(result.value), /"items":\[\]/);
    }
    if (commands.includes('acn-status')) {
      const status = await ctx.commands.execute(agent, '/acn-status', [], new AbortController().signal);
      assert.equal(status?.result.kind, 'success');
    }
    if (commands.includes('acn-finalize')) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Verify the retry boundary using the service contract.' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      const finalized = await ctx.commands.execute(agent, '/acn-finalize', [], new AbortController().signal);
      assert.equal(finalized?.result.kind, 'success');
      const formation = scopedContext.get('acnFormation'); assert.ok(formation);
      const deadline = Date.now() + 8000;
      for (;;) {
        const jobs = await formation.worker.queue.list();
        assert.ok(!jobs.some((job) => job.state === 'failed'), 'Installed formation job must succeed.');
        if (jobs.length > 0 && jobs.every((job) => job.state === 'succeeded') && (scenario !== 'memory' || jobs.some((job) => job.kind === 'memory_review'))) break;
        assert.ok(Date.now() < deadline, 'Installed formation must reach applied.'); await delay(20);
      }
      const knowledge = scopedContext.get('acnKnowledge'); assert.ok(knowledge);
      assert.equal((await knowledge.listClaims()).items.length, 1); assert.equal((await knowledge.listTraces()).items.length, 1);
      if (scenario === 'memory') {
        const memory = scopedContext.get('acnMemory'); assert.ok(memory); assert.deepEqual((await memory.snapshot()).user_entries, ['Prefers concise explanations.']);
        const jobs = await formation.worker.queue.list(); assert.ok(jobs.some((job) => job.kind === 'memory_review' && job.state === 'succeeded'));
        assert.ok(!JSON.stringify(await knowledge.listTraces()).includes('INSTALLED_PRIVATE_MARKER'));
      }
      if (commands.includes('inbox')) {
        const context = knowledge.context(); await mkdir(context.paths.inbox, { recursive: true });
        await writeFile(context.paths.pendingInbox('inbox_00000001'), JSON.stringify({ id: 'inbox_00000001', message_type: 'policy_update', policy: { id: 'policy_00000001', message_type: 'policy_update', name: 'retry_bound', statement: 'Use bounded retries.', scope: 'service', status: 'active', created_at: '2026-01-01T00:00:00Z' } }));
        const response = await ctx.commands.execute(agent, '/inbox', [], new AbortController().signal); assert.equal(response?.result.kind, 'success');
        const deadline = Date.now() + 8000;
        for (;;) {
          const jobs = await formation.worker.queue.list(); assert.ok(!jobs.some((job) => job.state === 'failed'), 'Installed Inbox job must succeed.');
          if (jobs.some((job) => job.kind === 'inbox' && job.state === 'succeeded') && jobs.every((job) => job.state === 'succeeded')) break;
          assert.ok(Date.now() < deadline, 'Installed Inbox must reach applied.'); await delay(20);
        }
        assert.equal((await knowledge.listClaims()).items.length, 2); assert.equal((await knowledge.listTraces()).items.length, 2);
        await access(context.paths.doneInbox('inbox_00000001'));
        if (commands.includes('dream')) {
          assert.equal((await ctx.commands.execute(agent, '/dream', [], new AbortController().signal))?.result.kind, 'success');
          const deadline = Date.now() + 8000;
          for (;;) { const jobs = await formation.worker.queue.list(); assert.ok(!jobs.some((job) => job.state === 'failed'), `Installed Dream must succeed: ${jobs.filter((job) => job.state === 'failed').map((job) => job.lastError).join('; ')}`); if (jobs.some((job) => job.kind === 'dream' && job.state === 'succeeded')) { const dream = jobs.find((job) => job.kind === 'dream'); assert.ok(dream); await access(join(context.paths.dreamJob(dream.id), 'report.md')); break; } assert.ok(Date.now() < deadline, 'Installed Dream must reach applied.'); await delay(20); }
          assert.equal((await knowledge.listTraces()).items.length, 4);
          const snapshot = await knowledge.snapshot(); assert.equal(snapshot.claims.filter((claim) => claim.status === 'deprecated').length, scenario === 'calibrated' ? 0 : 1);
          if (scenario === 'calibrated') assert.ok(snapshot.claims.some((claim) => claim.confidence === 'high' && claim.evidence_summary.includes('versioned file')));
        }
      }
    }
    if (!configured) await assert.rejects(access(home), { code: 'ENOENT' });
    if (scenario === 'dispose') {
      await entry.fiber.dispose();
      assert.equal(scopedContext.get('acnKnowledge'), undefined, 'Disposal must revoke the service.');
      assert.equal(ctx.commands.list(agent).length, 0, 'Dependent commands must be revoked with the service.');
    }
  }
  process.stdout.write(`ACN_SMOKE_OK:${scenario}\n`);
} finally {
  await ctx?.fiber.dispose();
}
