// 通过真实宿主命令入口验证分页、参数拒绝与失活组件恢复边界，不调用外部模型。
import { expect, it } from 'vitest';
import { ClaimStore } from '../../src/store/claims.js';
import { JobQueue } from '../../src/worker/queue.js';
import { ClaimIdSchema } from '../../src/protocol/ids.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { ScriptAdapter } from './adapter.js';
import { flowHarness } from './harness.js';

it('preserves Claim filters across command pages and rejects invalid writes without model calls', async () => {
  const adapter = new ScriptAdapter([]); const flow = await flowHarness(adapter);
  try {
    const agent = await flow.create();
    const execute = (text: string) => flow.ctx.commands.execute(agent, text, [], new AbortController().signal);
    await new ClaimStore(flow.knowledge.context()).write(sampleClaim({ id: ClaimIdSchema.parse('claim_00000002'), name: 'example second', status: 'deprecated' }));
    const first = await execute('/claim list example --limit 1 --include-deprecated');
    expect(first?.result.kind).toBe('success');
    const next = first?.result.text?.split('下一页：')[1];
    expect(next).toContain('--include-deprecated');
    const second = await execute(next ?? ''); expect(second?.result.kind).toBe('success');
    expect(second?.result.text).toContain('claim_00000002'); expect(second?.result.text).not.toContain('claim_00000001');
    expect((await execute(`/claim show ${flow.claim.id}`))?.result.text).toContain('sha256-v1:');
    const before = await flow.knowledge.readClaim(flow.claim.id);
    for (const text of ['/claim --limit 0', '/claim --offset -1', '/claim --unknown', '/claim show invalid', `/claim set ${flow.claim.id} holder=agent-b`, `/claim set ${flow.claim.id} name=one name=two`, '/acn-import', '/acn-import --unknown /example']) {
      expect((await execute(text))?.result.kind, text).toBe('error');
    }
    expect((await flow.knowledge.readClaim(flow.claim.id)).revision).toBe(before.revision);
    expect(adapter.requests).toEqual([]);
  } finally { await flow.close(); }
});

it('lists failed task pages and rejects retry when its component is inactive', async () => {
  const adapter = new ScriptAdapter([]); const flow = await flowHarness(adapter);
  try {
    const agent = await flow.create();
    const execute = (text: string) => flow.ctx.commands.execute(agent, text, [], new AbortController().signal);
    const queue = new JobQueue(flow.knowledge.context());
    for (let index = 0; index < 11; index += 1) {
      const job = await queue.enqueue('recap', { index }, `session-${index}`);
      await queue.settle(job, 'failed', { lastError: 'Example model unavailable.' });
    }
    const first = await execute('/acn-status failed'); expect(first?.result.text).toContain('/acn-status failed 2');
    const second = await execute('/acn-status failed 2'); expect(second?.result.text).toContain('Page 2/2');
    expect(second?.result.text?.match(/recap failed attempts=/g)).toHaveLength(1);
    const failed = (await queue.list())[0]; if (!failed) throw new Error('Missing task.');
    expect((await execute(`/acn-status retry ${failed.id}`))?.result.kind).toBe('error');
    expect((await queue.read(failed.id))?.state).toBe('failed');
    for (const text of ['/acn-status failed 0', '/acn-status all -1', '/acn-status all 9007199254740992', '/acn-status retry ../escape', '/acn-status extra']) expect((await execute(text))?.result.kind, text).toBe('error');
    expect(adapter.requests).toEqual([]);
  } finally { await flow.close(); }
});
