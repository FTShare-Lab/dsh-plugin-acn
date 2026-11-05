// 外部记忆工具正常服务宿主会话，其调用与结果不进入知识提炼；程序桥保留公共子调用。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime';
import { describe, expect, it } from 'vitest';
import { ScriptAdapter, textResponse, toolResponse } from './adapter.js';
import { flowHarness, turn } from './harness.js';
import { waitJob } from '../formation/helpers.js';
import { TranscriptStore } from '../../src/formation/transcript.js';

const privateMarker = 'EXTERNAL_PRIVATE_CONTENT_MARKER';
const emptyFormation = '{"new_claims":[],"updated_claims":[],"used_claim_ids":[],"new_disputes":[]}';
function externalTool(name: string, called: () => void) {
  return defineTool({ name, description: 'An external private note tool.', parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: () => { called(); return Promise.resolve({ note: privateMarker }); } });
}
class ScriptRuntime extends PtcRuntime {
  readonly language = 'typescript'; readonly isolation = 'test';
  override resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 10_000 }; }
  override async run(request: PtcRunSpec): Promise<PtcRunResult> {
    const functions = request.bindings.find((binding) => binding.global === 'tools')?.functions;
    const memory = functions?.['mcp__notes__MemorySearch']; const claim = functions?.['claim'];
    if (memory === undefined || claim === undefined) throw new Error('Missing bridge bindings.');
    const value = await memory({ query: privateMarker }); await claim({ action: 'read', id: 'claim_00000001' });
    return { logs: [privateMarker], value };
  }
}
describe('external memory exclusion', () => {
  it.each(['memory', 'memory_read', 'memory_write', 'mcp__notes__search_memory', 'MyMEMORYTool'].flatMap((name) => ['recap', 'finalize'].map((kind) => ({ name, kind }))))('filters $name from $kind without blocking the external tool', async ({ name, kind }) => {
    const adapter = new ScriptAdapter([toolResponse('external-note', name, { query: privateMarker }), toolResponse('public-claim', 'claim', { action: 'read', id: 'claim_00000001' }), textResponse('Checked the public rule.'), textResponse(emptyFormation)]);
    const f = await flowHarness(adapter, { formation: true, config: { formation: { idleRecap: false } } }); let calls = 0;
    try {
      f.ctx.tools.register(externalTool(name, () => { calls += 1; })); const agent = await f.create(); await turn(agent);
      const formation = f.ctx.acnFormation; await formation.flush(agent.session.id);
      const captured = JSON.stringify(await formation.transcript.read(agent.session.id)); expect(captured).not.toContain(privateMarker); expect(captured).toContain(f.claim.statement);
      const job = kind === 'recap' ? await formation.recap(agent.session.id) : await formation.finalize(agent.session.id);
      if (job === null) throw new Error('Missing formation job.'); await waitJob(formation.worker.queue, job.id);
      const request = adapter.requests[3]; expect(request).toBeDefined(); expect(JSON.stringify(request)).not.toContain(privateMarker); expect(JSON.stringify(request)).toContain(f.claim.statement);
      expect(JSON.stringify(request?.system)).toContain('Memory 工具调用及其结果不能成为 Claim/Dispute 内容或证据来源');
      expect(calls).toBe(1); expect((await f.knowledge.snapshot()).claims).toEqual([f.claim]);
      await expect(fs.access(join(f.knowledge.context().paths.root, 'memories'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await formation.worker.queue.list()).map((item) => item.kind)).toEqual([kind]);
    } finally { await f.close(); }
  });
  it('filters namespaced memory subcalls and wrapper output while keeping public Claim evidence', async () => {
    const adapter = new ScriptAdapter([toolResponse('program-a', 'run_code', { code: `return await tools.mcp__notes__MemorySearch({query:"${privateMarker}"});`, description: 'Read private notes and inspect a public Claim.' }), textResponse('Checked the public rule.'), textResponse(emptyFormation)]);
    const f = await flowHarness(adapter, { formation: true, filesystem: true, toolMode: 'ptc', config: { formation: { idleRecap: false } } }); let calls = 0;
    try {
      f.ctx.tools.register(externalTool('mcp__notes__MemorySearch', () => { calls += 1; })); await f.ctx.plugin(ScriptRuntime);
      const agent = await f.create(); await turn(agent); const formation = f.ctx.acnFormation; await formation.flush(agent.session.id);
      const job = await formation.finalize(agent.session.id); await waitJob(formation.worker.queue, job.id);
      expect(calls).toBe(1); const request = JSON.stringify(adapter.requests[2]); expect(request).not.toContain(privateMarker); expect(request).not.toContain('return await tools'); expect(request).toContain(f.claim.statement);
      expect((await new TranscriptStore(f.knowledge.context()).state(agent.session.id)).seenSourceIds).toContain(f.claim.id);
    } finally { await f.close(); }
  });
});
