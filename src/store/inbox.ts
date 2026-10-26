// Inbox 快照校验、租约领取和本地完成状态；网络 receipt ACK 由上层执行。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { InboxMessageSchema, inboxEventAt, type InboxMessage } from '../protocol/inbox.js';
import { InboxIdSchema } from '../protocol/ids.js';
import { nowSeconds, timestampNanos } from '../protocol/time.js';
import type { StoreContext } from './context.js';
import { hasCode, StoreError } from './errors.js';
import { withFileLock } from './lock.js';
import { readYaml, writeYamlAtomic } from './yaml.js';
import { removeFile } from './atomic.js';

export interface ClaimedInboxMessage { message: InboxMessage; leaseId: string }
export class InboxStore {
  constructor(readonly context: StoreContext, readonly processingStaleAfterSecs = 600) {
    if (!Number.isFinite(processingStaleAfterSecs) || processingStaleAfterSecs < 0) throw new StoreError('decode', 'Invalid inbox lease timeout.');
  }
  private locked<T>(action: () => Promise<T>): Promise<T> { return withFileLock(this.context.paths.knowledgeLock, action, { timeoutMs: this.context.lockTimeoutMs }); }
  private async names(): Promise<string[]> {
    try { return (await fs.readdir(this.context.paths.inbox)).filter((name) => name.endsWith('.yaml') && !name.includes('.tmp.')); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
  }
  private leasePath(claimed: ClaimedInboxMessage): string {
    const id = InboxIdSchema.parse(claimed.message.id);
    if (!claimed.leaseId.startsWith(`${id}.processing.`) || !/^inbox_[0-9a-f]{8}\.processing\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.yaml$/.test(claimed.leaseId)) throw new StoreError('decode', 'Invalid inbox lease identifier.');
    return join(this.context.paths.inbox, claimed.leaseId);
  }
  private async exists(path: string): Promise<boolean> { try { await fs.access(path); return true; } catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; } }
  async acceptPulled(value: unknown): Promise<void> {
    const message = InboxMessageSchema.parse(value);
    await this.locked(async () => {
      const existing = (await this.names()).filter((name) => name === `${message.id}.yaml` || name === `${message.id}.done.yaml` || name.startsWith(`${message.id}.processing.`));
      if (existing.length === 0) { await writeYamlAtomic(this.context.paths.pendingInbox(message.id), message, InboxMessageSchema, this.context.logger); return; }
      for (const name of existing) {
        const actual = await readYaml(join(this.context.paths.inbox, name), InboxMessageSchema);
        const comparable = (value: InboxMessage): unknown => JSON.parse(JSON.stringify({ ...value, handled_at: undefined }));
        if (actual.id !== message.id || !isDeepStrictEqual(comparable(actual), comparable(message))) throw new StoreError('conflict', `Inbox snapshot conflict: ${message.id}`);
      }
    });
  }
  private async pending(): Promise<InboxMessage[]> {
    const pending: { message: InboxMessage; mtime: number }[] = [];
    for (const name of await this.names()) {
      if (!/^inbox_[0-9a-f]{8}\.yaml$/.test(name)) continue;
      const path = join(this.context.paths.inbox, name);
      const message = await readYaml(path, InboxMessageSchema);
      if (`${message.id}.yaml` !== name) throw new StoreError('decode', 'Inbox ID differs from filename.');
      if (await this.exists(this.context.paths.doneInbox(message.id))) { await removeFile(path, this.context.logger); continue; }
      pending.push({ message, mtime: (await fs.stat(path)).mtimeMs });
    }
    return pending.sort((a, b) => {
      const first = timestampNanos(inboxEventAt(a.message));
      const second = timestampNanos(inboxEventAt(b.message));
      return (first < second ? -1 : first > second ? 1 : 0) || a.mtime - b.mtime || a.message.id.localeCompare(b.message.id);
    }).map((item) => item.message);
  }
  listPending(): Promise<InboxMessage[]> { return this.locked(() => this.pending()); }
  async hasUnfinished(): Promise<boolean> { return (await this.names()).some((name) => /^inbox_[0-9a-f]{8}(?:\.processing\..+)?\.yaml$/.test(name)); }
  private async recoverUnlocked(nowMs: number, orphaned = false): Promise<number> {
    let recovered = 0;
    for (const name of await this.names()) {
      if (!/^inbox_[0-9a-f]{8}\.processing\..+\.yaml$/.test(name)) continue;
      const path = join(this.context.paths.inbox, name);
      if (!orphaned && nowMs - (await fs.stat(path)).mtimeMs < this.processingStaleAfterSecs * 1000) continue;
      let message: InboxMessage;
      try { message = await readYaml(path, InboxMessageSchema); }
      catch (error) { if (error instanceof StoreError && error.kind === 'decode') { this.context.logger.warn(`Preserved corrupt inbox lease: ${name}`); continue; } throw error; }
      if (!name.startsWith(`${message.id}.processing.`)) { this.context.logger.warn(`Preserved mismatched inbox lease: ${name}`); continue; }
      const pending = this.context.paths.pendingInbox(message.id);
      if (await this.exists(this.context.paths.doneInbox(message.id)) || await this.exists(pending)) await removeFile(path, this.context.logger);
      else { await fs.rename(path, pending); recovered += 1; }
    }
    return recovered;
  }
  recoverStale(nowMs = Date.now()): Promise<number> { return this.locked(() => this.recoverUnlocked(nowMs)); }
  // 仅供持有单消费者 worker 租约的处理器调用；接管后旧 processing 不可能仍被消费。
  recoverOrphans(): Promise<number> { return this.locked(() => this.recoverUnlocked(Date.now(), true)); }
  claimPending(limit = 1024): Promise<ClaimedInboxMessage[]> {
    return this.locked(async () => {
      await this.recoverUnlocked(Date.now());
      const result: ClaimedInboxMessage[] = [];
      for (const message of (await this.pending()).slice(0, limit)) {
        const leaseId = `${message.id}.processing.${process.pid}.${randomBytes(8).toString('hex')}.yaml`;
        const destination = join(this.context.paths.inbox, leaseId);
        await fs.rename(this.context.paths.pendingInbox(message.id), destination);
        // 租约年龄从领取时开始，不能沿用 pending 文件的旧 mtime。
        const now = new Date(); await fs.utimes(destination, now, now);
        result.push({ message, leaseId });
      }
      return result;
    });
  }
  // 调用者已持有知识锁；journal 的完整快照用于完成跨进程接管后的旧租约。
  async validateSnapshotLocked(message: InboxMessage): Promise<string[]> {
    const comparable = (value: InboxMessage) => ({ ...value, handled_at: undefined });
    const names = (await this.names()).filter((name) => name === `${message.id}.yaml` || name === `${message.id}.done.yaml` || name.startsWith(`${message.id}.processing.`));
    for (const name of names) {
      const actual = await readYaml(join(this.context.paths.inbox, name), InboxMessageSchema);
      if (!isDeepStrictEqual(comparable(actual), comparable(message))) throw new StoreError('conflict', 'Inbox completion snapshot mismatch.');
    }
    return names;
  }
  async completeSnapshotLocked(message: InboxMessage): Promise<void> {
    const names = await this.validateSnapshotLocked(message);
    if (!names.includes(`${message.id}.done.yaml`)) await writeYamlAtomic(this.context.paths.doneInbox(message.id), { ...message, handled_at: nowSeconds() }, InboxMessageSchema, this.context.logger);
    for (const name of names) if (name !== `${message.id}.done.yaml`) await removeFile(join(this.context.paths.inbox, name), this.context.logger);
  }
  complete(claimed: ClaimedInboxMessage): Promise<void> {
    const path = this.leasePath(claimed);
    return this.locked(async () => {
      if (!await this.exists(path)) {
        if (await this.exists(this.context.paths.doneInbox(claimed.message.id))) return;
        throw new StoreError('conflict', 'Inbox lease is no longer owned by this task.');
      }
      const actual = await readYaml(path, InboxMessageSchema);
      if (actual.id !== claimed.message.id) throw new StoreError('conflict', 'Inbox lease snapshot mismatch.');
      await writeYamlAtomic(this.context.paths.doneInbox(actual.id), { ...actual, handled_at: nowSeconds() }, InboxMessageSchema, this.context.logger);
      await removeFile(path, this.context.logger);
    });
  }
  release(claimed: ClaimedInboxMessage): Promise<void> {
    const path = this.leasePath(claimed);
    return this.locked(async () => {
      if (!await this.exists(path)) return;
      if (await this.exists(this.context.paths.doneInbox(claimed.message.id))) { await removeFile(path, this.context.logger); return; }
      const pending = this.context.paths.pendingInbox(claimed.message.id);
      if (!await this.exists(pending)) await fs.rename(path, pending);
    });
  }
}
