// 用可控屏障覆盖卸载时的模型等待、prepared 提交与重新启用恢复。
import { expect, it, vi } from 'vitest';
import { AcnInbox } from '../../src/inbox/service.js';
import { ClaimStore } from '../../src/store/claims.js';
import { InboxStore } from '../../src/store/inbox.js';
import { InboxIdSchema, PolicyIdSchema } from '../../src/protocol/ids.js';
import { ClaimSchema } from '../../src/protocol/claim.js';
import { inboxFixture, inboxMessage, emptyInternalize, teamServer } from '../team/helpers.js';
import { newDraft, waitJob } from '../formation/helpers.js';
import { deferred } from '../dream/helpers.js';

async function twoBatches(store: InboxStore): Promise<void> {
  const first = inboxMessage();
  await store.acceptPulled(first);
  await store.acceptPulled(inboxMessage({ id: InboxIdSchema.parse('inbox_00000002'), message_type: 'claim_attribute_update', policy: { ...first.policy, id: PolicyIdSchema.parse('policy_00000002'), message_type: 'claim_attribute_update' } }));
}
const output = (name: string, policy: string) => ({ text: JSON.stringify({ ...emptyInternalize(), new_claims: [{ ...newDraft(), name, source_claim_ids: [policy] }] }) });

it.each([1, 2])('unloading during model call %i cancels it, releases pending messages and allows another job and a resumed Inbox', async (blockedCall) => {
  const entered = deferred(); const release = deferred();
  let calls = 0; let signal: AbortSignal | undefined;
  const fixture = await inboxFixture(async (_route, _system, _input, _tokens, currentSignal) => {
    calls += 1;
    if (calls === blockedCall) { signal = currentSignal; entered.resolve(); await release.promise; }
    return output(`batch_${calls}`, `policy_0000000${calls}`);
  });
  let resumed: AcnInbox | undefined;
  try {
    const store = new InboxStore(fixture.knowledge.context()); await twoBatches(store);
    const worker = fixture.knowledge.jobs; if (worker === null) throw new Error('Missing worker.');
    await worker.start(); const job = await fixture.inbox.enqueue(false); await entered.promise;
    await fixture.inbox.close(); expect(signal?.aborted).toBe(true);
    await waitJob(worker.queue, job.id, 'queued');
    expect((await fixture.knowledge.snapshot()).claims.map((claim) => claim.name)).toEqual(blockedCall === 1 ? [] : ['batch_1']);
    expect(await store.listPending()).toHaveLength(3 - blockedCall);
    expect(() => fixture.inbox.enqueue()).toThrow(/暂停/);
    worker.register('recap', () => Promise.resolve({ available: true }));
    const other = await worker.enqueue('recap', {}); expect((await waitJob(worker.queue, other.id)).result).toEqual({ available: true });
    release.resolve();
    let resumedCalls = 0;
    resumed = new AcnInbox(fixture.knowledge, () => { resumedCalls += 1; return Promise.resolve(output(`resumed_${resumedCalls}`, `policy_0000000${blockedCall + resumedCalls - 1}`)); }, () => '');
    await waitJob(worker.queue, job.id);
    expect(resumedCalls).toBe(3 - blockedCall);
    expect(await store.hasUnfinished()).toBe(false);
    expect((await fixture.knowledge.snapshot()).claims).toHaveLength(2);
  } finally { release.resolve(); await resumed?.close(); await fixture.close(); }
});

it('unloading after prepared awaits that fixed commit, stops before the next model batch and leaves its message recoverable', async () => {
  const entered = deferred(); const release = deferred(); let calls = 0;
  const fixture = await inboxFixture(() => { calls += 1; return Promise.resolve(output(`batch_${calls}`, `policy_0000000${calls}`)); });
  const claims = new ClaimStore(fixture.knowledge.context()); const write = claims.write.bind(claims);
  vi.spyOn(ClaimStore.prototype, 'write').mockImplementation(async (claim) => {
    if (ClaimSchema.parse(claim).name === 'batch_1') { entered.resolve(); await release.promise; }
    return write(claim);
  });
  try {
    const store = new InboxStore(fixture.knowledge.context()); await twoBatches(store);
    const worker = fixture.knowledge.jobs; if (worker === null) throw new Error('Missing worker.');
    await worker.start(); const job = await fixture.inbox.enqueue(false); await entered.promise;
    let closed = false; const closing = fixture.inbox.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release.resolve(); await closing; await waitJob(worker.queue, job.id, 'queued');
    expect(calls).toBe(1);
    expect((await fixture.knowledge.snapshot()).claims.map((claim) => claim.name)).toEqual(['batch_1']);
    expect((await store.listPending()).map((item) => item.id)).toEqual(['inbox_00000002']);
    worker.register('recap', () => Promise.resolve({ available: true }));
    const other = await worker.enqueue('recap', {}); await waitJob(worker.queue, other.id);
  } finally { release.resolve(); vi.restoreAllMocks(); await fixture.close(); }
});

it('closing aborts an explicit in-flight pull and never enqueues new work after disposal', async () => {
  const entered = deferred(); const release = deferred();
  const server = await teamServer(async () => { entered.resolve(); await release.promise; return { body: { messages: [] } }; });
  const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } });
  try {
    const request = expect(fixture.inbox.request()).rejects.toBeDefined(); await entered.promise;
    await fixture.inbox.close(); await request;
    expect(await fixture.knowledge.jobs?.queue.list()).toEqual([]);
  } finally { release.resolve(); await fixture.close(); await server.close(); }
});
