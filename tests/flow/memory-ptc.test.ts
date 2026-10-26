// 用测试执行后端驱动宿主真实程序桥，公共子调用可引用，私有调用及程序回显不进入形成。
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime';
import { describe, expect, it } from 'vitest';
import { ScriptAdapter, textResponse, toolResponse } from './adapter.js';
import { flowHarness, turn } from './harness.js';
import { waitJob } from '../formation/helpers.js';
import { TranscriptStore } from '../../src/formation/transcript.js';

class ScriptRuntime extends PtcRuntime {
  readonly language = 'typescript'; readonly isolation = 'test';
  override resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 10_000 }; }
  override async run(request: PtcRunSpec): Promise<PtcRunResult> {
    const functions = request.bindings.find((binding) => binding.global === 'tools')?.functions; if (!functions?.['memory'] || !functions['claim']) throw new Error('Missing bridge bindings.');
    const value = await functions['memory']({ ops: [{ op: 'add', target: 'user', entry: 'PRIVATE_PROGRAM_MARKER' }] });
    await functions['claim']({ action: 'read', id: 'claim_00000001' }); return { logs: ['PRIVATE_PROGRAM_MARKER'], value };
  }
}
describe('private Memory through the program bridge', () => {
  it('keeps Memory arguments/results and program source/output out of Finalize while retaining public Claim bodies', async () => {
    const adapter = new ScriptAdapter([toolResponse('program-a', 'run_code', { code: 'return await tools.memory({ops:[{op:"add",target:"user",entry:"PRIVATE_PROGRAM_MARKER"}]});', description: 'Update a private preference and inspect a public Claim.' }), textResponse('Checked the public example.'), textResponse('{"new_claims":[],"updated_claims":[],"used_claim_ids":[],"new_disputes":[]}')]);
    const f = await flowHarness(adapter, { memory: true, formation: true, filesystem: true, toolMode: 'ptc', config: { formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false }, memory: { review: { enabled: false } } } });
    try {
      await f.ctx.plugin(ScriptRuntime); const agent = await f.create(); await turn(agent, 'Inspect the public retry rule.'); expect((await f.ctx.acnMemory.snapshot()).user_entries).toEqual(['PRIVATE_PROGRAM_MARKER']);
      await f.ctx.commands.execute(agent, '/acn-finalize', [], new AbortController().signal); const worker = f.knowledge.jobs; if (!worker) throw new Error('Missing worker.'); const job = (await worker.queue.list()).find((job) => job.kind === 'finalize'); if (!job) throw new Error('Missing Finalize.'); await waitJob(worker.queue, job.id);
      const input = JSON.stringify(adapter.requests[2]); expect(input).not.toContain('PRIVATE_PROGRAM_MARKER'); expect(input).not.toContain('return await tools.memory'); expect(input).toContain(f.claim.statement);
      expect((await new TranscriptStore(f.knowledge.context()).state(agent.session.id)).seenSourceIds).toContain(f.claim.id);
    } finally { await f.close(); }
  });
});
