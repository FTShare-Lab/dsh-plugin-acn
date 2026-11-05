// 真正创建宿主子会话并执行工具，验证发布前限制、原生工具模式和独立上下文。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { restrictedExplorer } from '../../src/dsh-adapter/dream-evidence.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import { EvidenceStore } from '../../src/dream/evidence-store.js';
import type { Receipts } from '../../src/dream/evidence.js';
import { ClaimStore } from '../../src/store/claims.js';
import { candidate } from '../dream/helpers.js';
import { calibrationDraft, calibrationReviews, evidenceFixture, material } from '../dream/evidence-helpers.js';
import { waitJob } from '../formation/helpers.js';
import { ScriptAdapter, textResponse, toolResponse } from './adapter.js';
import { finishDream, lastJson, readReceipt } from '../dream/autonomous-helpers.js';
import { ValidationSchema } from '../../src/dream/schema.js';
import { flowHarness } from './harness.js';

function requestText(request: GenerateOptions): string { return request.messages.flatMap((message) => message.content).filter((block) => block.type === 'text').map((block) => block.text).join(''); }
describe('restricted evidence child in the host', () => {
  it.each(['AUTH', 'MALFORMED_RESPONSE', 'MAX_TOKENS'])('reports a safe model failure category for evidence: %s', async (code) => {
    const f = await evidenceFixture();
    const adapter = new ScriptAdapter([[{ type: 'finish', reason: code === 'MAX_TOKENS' ? { kind: 'max-tokens' } : { kind: 'error', failure: { code, message: 'PRIVATE_PROVIDER_FAILURE_MARKER' } } }]]);
    const host = await flowHarness(adapter);
    try {
      const run = restrictedExplorer(host.ctx, (await loadPromptRenderer())('dream_evidence.j2', {}))({ store: f.store, claims: f.initial, route: { provider: 'mock', model: 'mock' }, config: f.knowledge.config.llm, signal: new AbortController().signal });
      const failure: unknown = await run.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error); if (!(failure instanceof Error)) throw new Error('Missing model error.');
      expect(failure.message).toContain(code); expect(failure.message).not.toContain('PRIVATE_');
      expect(adapter.requests).toHaveLength(1); expect((await f.store.read())?.model_steps).toBe(1); expect((await f.store.read())?.completed).toBe(false);
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(f.initial);
    } finally { await host.close(); await f.close(); }
  });
  it.each(['failure', 'receipt'] as const)('finishes safely at the evidence budget without renewing it: %s', async (mode) => {
    const f = await evidenceFixture({ config: { dream: { evidenceMaxSteps: 1 } } });
    const adapter = new ScriptAdapter([mode === 'failure' ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'Transient provider failure.' } } }] : toolResponse('read', 'read', { path: 'source.txt', claim_ids: f.initial.map((claim) => claim.id) }), textResponse('A retry must not bypass the budget.')]);
    const host = await flowHarness(adapter);
    try {
      host.ctx.on('agent/request-error', () => Promise.resolve({ kind: 'retry' }));
      const explore = restrictedExplorer(host.ctx, (await loadPromptRenderer())('dream_evidence.j2', {}));
      const input = { store: f.store, claims: f.initial, route: { provider: 'mock', model: 'mock' }, config: f.knowledge.config.llm, signal: new AbortController().signal };
      await explore(input); await explore(input);
      expect(adapter.requests).toHaveLength(1); expect((await f.store.read())?.model_steps).toBe(1);
      expect((await f.store.read())?.completed).toBe(true); expect(Object.keys((await f.store.read())?.receipts ?? {})).toHaveLength(mode === 'receipt' ? 1 : 0);
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(f.initial);
    } finally { await host.close(); await f.close(); }
  });
  it('runs the full enabled plugin pipeline in the command session workspace', async () => {
    const workspace = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'acn-host-evidence-'))); await fs.writeFile(join(workspace, 'source.txt'), material);
    const adapter = new ScriptAdapter([
      () => toolResponse('register', 'dream_record_candidates', { candidates: input ? [candidate([input], 'evidence')] : [] }),
      (request) => {
        expect(request.tools?.map((tool) => tool.name)).toContain('dream_apply_group');
        expect(request.tools?.map((tool) => tool.name)).not.toContain('bash');
        expect(requestText(request)).toContain(JSON.stringify(workspace).slice(1, -1));
        return toolResponse('read-a', 'file_read', { path: 'source.txt', claim_ids: [input?.id] });
      },
      (request) => { const receipt = readReceipt(request); return toolResponse('stage', 'dream_stage_group', { group_id: 'group-a', group: calibrationDraft(input ? [input] : [], { [receipt.evidence_id]: receipt } as Receipts) }); },
      toolResponse('validate', 'dream_validate', { group_id: 'group-a' }),
      (request) => { const validation = ValidationSchema.parse(lastJson(request)); return toolResponse('apply', 'dream_apply_group', { group_id: 'group-a', validation_id: validation.validation_id, review: calibrationReviews(validation).semantic }); },
      finishDream(),
    ]);
    const f = await flowHarness(adapter, { dream: true, formation: true, inbox: true, persistence: true, config: { llm: { provider: 'mock', model: 'mock' }, formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false }, inbox: { pullOnSessionStart: false }, dream: { evidenceCalibration: true } } }); const input = f.claim;
    try {
      const handle = await f.ctx.agents.create({ sessionId: SessionId('foreground-evidence'), meta: { cwd: workspace }, agentOptions: { provider: 'mock', model: 'mock' } });
      const result = await f.ctx.commands.execute(handle.agent, '/dream', [], new AbortController().signal); expect(result?.result.kind).toBe('success'); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.'); const job = (await worker.queue.list()).find((job) => job.kind === 'dream'); if (!job) throw new Error('Missing job.');
      await waitJob(worker.queue, job.id); expect(adapter.requests).toHaveLength(6); expect((await new ClaimStore(f.knowledge.context()).list())[0]).toMatchObject({ confidence: 'high', statement: material });
      for (const request of adapter.requests) expect(request.maxTokens).toBe(32_768);
      const manifest = await new EvidenceStore(f.knowledge.context(), job.id, 'group-a').read(); expect(manifest).toMatchObject({ completed: true, calls: 1, model_steps: 0, workspace_root: workspace });
      const jobs = await worker.queue.list(); expect(jobs.every((job) => job.kind === 'dream')).toBe(true); const sessions = await fs.readdir(f.knowledge.context().paths.sessions); expect(sessions.some((session) => session.startsWith('acn-evidence-'))).toBe(false);
    } finally { await f.close(); await fs.rm(workspace, { recursive: true, force: true }); }
  });
  it.each(['native', 'ptc'] as const)('denies inherited, reserved and newly registered tools under %s even if policy allows', async (toolMode) => {
    const f = await evidenceFixture(); let child: Agent | undefined; let unsafeCalls = 0;
    const adapter = new ScriptAdapter([toolResponse('read-a', 'read', { path: 'source.txt', claim_ids: f.initial.map((claim) => claim.id) }), textResponse('Complete.')]);
    const host = await flowHarness(adapter, { toolMode });
    try {
      host.ctx.systemPrompt.section({ name: 'ambient-private', order: 0, text: 'PRIVATE_AMBIENT_MARKER' });
      host.ctx.systemPrompt.context({ name: 'ambient-private-context', order: 0, text: 'PRIVATE_AMBIENT_MARKER', required: true });
      host.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }));
      for (const name of ['bash', 'edit', 'web_fetch', 'memory', 'upload', 'subagent']) host.ctx.tools.register(defineTool({ name, description: 'Forbidden test capability.', parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, execute: () => { unsafeCalls += 1; return Promise.resolve({}); } }));
      const checks: Promise<unknown>[] = [];
      host.ctx.on('agent/created', ({ agent }) => {
        if (!agent.session.id.startsWith('acn-evidence-')) return; child = agent;
        agent.ctx.tools.register(defineTool({ name: 'late_write', description: 'Forbidden scoped capability.', parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, execute: () => { unsafeCalls += 1; return Promise.resolve({}); } }));
        for (const name of ['bash', 'edit', 'web_fetch', 'memory', 'upload', 'subagent', 'run_code', 'late_write']) checks.push(host.ctx.tools.execute({ name, arguments: {}, agent, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal }));
        checks.push(host.ctx.tools.execute({ name: 'claim', arguments: { action: 'update', id: f.initial[0]?.id, changes: { confidence: 'high' } }, agent, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal }));
      });
      const render = await loadPromptRenderer(); await restrictedExplorer(host.ctx, render('dream_evidence.j2', {}))({ store: f.store, claims: f.initial, route: { provider: 'mock', model: 'mock' }, config: f.knowledge.config.llm, signal: new AbortController().signal }); for (const result of await Promise.all(checks)) expect(result).toMatchObject({ isError: true });
      expect(child).toBeDefined(); expect(unsafeCalls).toBe(0); expect(Object.keys((await f.store.read())?.receipts ?? {})).toHaveLength(1); expect(adapter.requests.every((request) => request.tools?.map((tool) => tool.name).sort().join(',') === 'claim,glob,grep,read')).toBe(true); expect(JSON.stringify(adapter.requests)).not.toContain('PRIVATE_AMBIENT_MARKER'); expect(JSON.stringify(adapter.requests)).not.toContain('late_write');
    } finally { await host.close(); await f.close(); }
  });
  it('rechecks rewritten read arguments at execution and never returns private content', async () => {
    const f = await evidenceFixture(); const adapter = new ScriptAdapter([toolResponse('read-a', 'read', { path: 'source.txt', claim_ids: f.initial.map((claim) => claim.id) }), textResponse('No permitted evidence found.')]); const host = await flowHarness(adapter);
    try {
      await fs.writeFile(join(f.workspace, 'USER.md'), 'PRIVATE_FILE_MARKER');
      host.ctx.on('tools/pre-execute', (execution, next) => { if (execution.name === 'read' && typeof execution.arguments === 'object' && execution.arguments !== null) Object.assign(execution.arguments, { path: 'USER.md' }); return next(); });
      await restrictedExplorer(host.ctx, (await loadPromptRenderer())('dream_evidence.j2', {}))({ store: f.store, claims: f.initial, route: { provider: 'mock', model: 'mock' }, config: f.knowledge.config.llm, signal: new AbortController().signal });
      expect(Object.keys((await f.store.read())?.receipts ?? {})).toHaveLength(0); expect(JSON.stringify(adapter.requests)).not.toContain('PRIVATE_FILE_MARKER');
    } finally { await host.close(); await f.close(); }
  });
  it('keeps concurrent child workspaces and receipt manifests separate', async () => {
    const left = await evidenceFixture(); const right = await evidenceFixture(); await fs.writeFile(join(right.workspace, 'source.txt'), 'A distinct workspace source.');
    const reply = (request: GenerateOptions) => JSON.stringify(request.messages).includes('file_version') ? textResponse('Complete.') : toolResponse(crypto.randomUUID(), 'read', { path: 'source.txt', claim_ids: left.initial.map((claim) => claim.id) });
    const host = await flowHarness(new ScriptAdapter([reply, reply, reply, reply]));
    try {
      const explore = restrictedExplorer(host.ctx, (await loadPromptRenderer())('dream_evidence.j2', {})); await Promise.all([left, right].map((f) => explore({ store: f.store, claims: f.initial, route: { provider: 'mock', model: 'mock' }, config: f.knowledge.config.llm, signal: new AbortController().signal })));
      const a = await left.store.read(); const b = await right.store.read(); expect(Object.values(a?.receipts ?? {})[0]?.output.content).toBe(material); expect(Object.values(b?.receipts ?? {})[0]?.output.content).toBe('A distinct workspace source.'); expect(a?.workspace_root).not.toBe(b?.workspace_root);
    } finally { await host.close(); await left.close(); await right.close(); }
  });
  it.each(['timeout', 'stop', 'steps'] as const)('stops and drains the child on %s, completing only a budget stop', async (mode) => {
    const f = await evidenceFixture({ config: { dream: { evidenceMaxSteps: 1 } } });
    const adapter = new ScriptAdapter(mode === 'steps' ? [toolResponse('read-a', 'read', { path: 'source.txt', claim_ids: f.initial.map((claim) => claim.id) })] : [async (request) => { await new Promise<void>((done) => { request.signal?.addEventListener('abort', () => { done(); }, { once: true }); }); return textResponse('Cancelled.'); }]);
    const host = await flowHarness(adapter); const abort = new AbortController(); let disposed = false;
    host.ctx.on('agent/disposed', ({ agent }) => { if (agent.session.id.startsWith('acn-evidence-')) disposed = true; });
    try {
      const render = await loadPromptRenderer(); const run = restrictedExplorer(host.ctx, render('dream_evidence.j2', {}))({ store: f.store, claims: f.initial, route: { provider: 'mock', model: 'mock' }, config: { ...f.knowledge.config.llm, timeoutMs: mode === 'timeout' ? 100 : 5000 }, signal: abort.signal });
      if (mode === 'stop') { const timer = setTimeout(() => { abort.abort(new Error('Stopped by user.')); }, 100); timer.unref(); }
      if (mode === 'steps') await run; else await expect(run).rejects.toThrow();
      expect(disposed).toBe(true); expect((await f.store.read())?.completed).toBe(mode === 'steps'); expect(adapter.requests).toHaveLength(1); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(f.initial);
    } finally { await host.close(); await f.close(); }
  });
});
