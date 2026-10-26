// 覆盖 Inbox 持久收件、租约状态机与过期恢复的真实文件行为。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxMessageSchema } from '../../src/protocol/inbox.js';
import { InboxStore, readYaml, writeYamlAtomic } from '../../src/store/index.js';
import { context, fixture, logger } from '../helpers.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'acn-inbox-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('inbox lifecycle', () => {
  it('claims once, releases to pending, and completes to done idempotently', async () => {
    const ctx = context(root); const inbox = new InboxStore(ctx);
    const message = await fixture('inbox-policy', InboxMessageSchema);
    await inbox.acceptPulled(message);
    const [claimed] = await inbox.claimPending(); expect(claimed).toBeDefined();
    if (claimed === undefined) throw new Error('Expected a claimed message.');
    expect(await new InboxStore(ctx).claimPending()).toEqual([]);
    await inbox.release(claimed); expect(await inbox.listPending()).toEqual([message]);
    const [again] = await inbox.claimPending(); if (again === undefined) throw new Error('Expected another lease.');
    expect(again.leaseId).not.toBe(claimed.leaseId);
    await expect(inbox.complete(claimed)).rejects.toMatchObject({ kind: 'conflict' });
    await inbox.complete(again); await inbox.complete(again); await inbox.release(again);
    expect(await inbox.listPending()).toEqual([]);
    expect((await readYaml(ctx.paths.doneInbox(message.id), InboxMessageSchema)).handled_at).toBeDefined();
  });
  it.each(['pending', 'processing', 'done'])('accept_pulled validates matching %s snapshots', async (state) => {
    const ctx = context(root); const inbox = new InboxStore(ctx);
    const message = await fixture('inbox-policy', InboxMessageSchema);
    await inbox.acceptPulled(message);
    if (state !== 'pending') {
      const [claimed] = await inbox.claimPending(); if (claimed === undefined) throw new Error('Expected a lease.');
      if (state === 'done') await inbox.complete(claimed);
    }
    await inbox.acceptPulled(message);
    const names = await fs.readdir(ctx.paths.inbox);
    expect(names.filter((name) => name.endsWith('.yaml'))).toHaveLength(1);
  });
  it('rejects corrupt and conflicting snapshots instead of treating them as durable receipts', async () => {
    const ctx = context(root); const inbox = new InboxStore(ctx);
    const message = await fixture('inbox-policy', InboxMessageSchema);
    await inbox.acceptPulled(message);
    await expect(inbox.acceptPulled({ ...message, policy: { ...message.policy, statement: 'different snapshot' } })).rejects.toMatchObject({ kind: 'conflict' });
    await fs.writeFile(ctx.paths.pendingInbox(message.id), 'id: [broken');
    await expect(inbox.acceptPulled(message)).rejects.toMatchObject({ kind: 'decode' });
  });
  it('compares arbitration extension objects independently of JSON key order', async () => {
    const inbox = new InboxStore(context(root));
    const message = await fixture('inbox-resolution', InboxMessageSchema);
    if (message.message_type !== 'claim_attribute_update' || message.arbitration_resolution === undefined) throw new Error('Expected a resolution context.');
    const first = { ...message, arbitration_resolution: { ...message.arbitration_resolution, future_metadata: { first: 1, second: 2 } } };
    const second = { ...message, arbitration_resolution: { ...message.arbitration_resolution, future_metadata: { second: 2, first: 1 } } };
    await inbox.acceptPulled(first); await inbox.acceptPulled(second);
    expect(await inbox.listPending()).toHaveLength(1);
  });
  it('recovers expired processing and clears pending/done collisions', async () => {
    const ctx = context(root); const inbox = new InboxStore(ctx, 600);
    const message = await fixture('inbox-policy', InboxMessageSchema);
    await inbox.acceptPulled(message);
    const [claimed] = await inbox.claimPending(); if (claimed === undefined) throw new Error('Expected a lease.');
    expect(await inbox.recoverStale()).toBe(0);
    const old = new Date(Date.now() - 700_000); await fs.utimes(join(ctx.paths.inbox, claimed.leaseId), old, old);
    expect(await inbox.recoverStale()).toBe(1);
    expect(await inbox.listPending()).toEqual([message]);
    await writeYamlAtomic(ctx.paths.doneInbox(message.id), { ...message, handled_at: message.policy.created_at }, InboxMessageSchema, logger);
    expect(await inbox.listPending()).toEqual([]);
    await expect(fs.access(ctx.paths.pendingInbox(message.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('starts the lease age at claim time, even when pending is old', async () => {
    const ctx = context(root); const inbox = new InboxStore(ctx, 10);
    const message = await fixture('inbox-policy', InboxMessageSchema);
    await inbox.acceptPulled(message);
    const old = new Date(Date.now() - 60_000); await fs.utimes(ctx.paths.pendingInbox(message.id), old, old);
    const claimed = await inbox.claimPending(); expect(claimed).toHaveLength(1);
    expect(await inbox.recoverStale()).toBe(0);
    expect(await new InboxStore(ctx, 10).claimPending()).toEqual([]);
  });
  it('preserves corrupt processing evidence and rejects traversal in a lease', async () => {
    const ctx = { ...context(root), logger: { warn: vi.fn(), debug: vi.fn() } }; const inbox = new InboxStore(ctx, 0);
    const message = await fixture('inbox-policy', InboxMessageSchema);
    await fs.mkdir(ctx.paths.inbox, { recursive: true });
    const path = join(ctx.paths.inbox, `${message.id}.processing.stale.yaml`);
    await fs.writeFile(path, 'id: [broken');
    const old = new Date(Date.now() - 1000); await fs.utimes(path, old, old);
    expect(await inbox.recoverStale()).toBe(0); await fs.access(path);
    expect(ctx.logger.warn).toHaveBeenCalledOnce();
    expect(() => inbox.complete({ message, leaseId: '../../outside.yaml' })).toThrow('Invalid inbox lease');
  });
  it('orders equal event times by filesystem write time', async () => {
    const ctx = context(root); const inbox = new InboxStore(ctx);
    const message = await fixture('inbox-policy', InboxMessageSchema);
    await inbox.acceptPulled({ ...message, id: 'inbox_00000002' }); await inbox.acceptPulled(message);
    const old = new Date(Date.now() - 2000); await fs.utimes(ctx.paths.pendingInbox('inbox_00000002'), old, old);
    expect((await inbox.listPending()).map((item) => item.id)).toEqual(['inbox_00000002', 'inbox_00000001']);
  });
});
