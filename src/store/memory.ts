// 双文件锁内发布固定目标；先记日志，恢复识别精确 before/after 并保留外部第三版本。
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StoreContext } from './context.js';
import { hasCode, StoreError } from './errors.js';
import { withFileLocks } from './lock.js';
import { writeTextAtomic, writeTextAtomicIfAbsent, removeFile } from './atomic.js';
import { readYamlOr, writeYamlAtomic } from './yaml.js';

export const MemoryTextsSchema = z.strictObject({ memory: z.string(), user: z.string() });
export type MemoryTexts = z.infer<typeof MemoryTextsSchema>;
const Key = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const ReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), id: Key, fingerprint: z.string(), result: z.json(), conflict: z.boolean() });
const PendingSchema = z.strictObject({ schemaVersion: z.literal(1), id: Key, fingerprint: z.string(), before: MemoryTextsSchema, after: MemoryTextsSchema, result: z.json() });
export interface MemoryTransition { next: MemoryTexts; result: z.infer<ReturnType<typeof z.json>> }
export interface MemoryTransaction { id?: string; fingerprint?: string; signal?: AbortSignal; prepared?: () => void }
export class MemoryFileStore {
  constructor(readonly context: StoreContext) {}
  private async readText(path: string): Promise<string> {
    let file;
    try { file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (hasCode(error, 'ENOENT')) return ''; throw error; }
    try {
      const info = await file.stat(); if (!info.isFile() || info.nlink !== 1) throw new StoreError('conflict', 'Private Memory must be a single-link regular file.');
      try { return new TextDecoder('utf-8', { fatal: true }).decode(await file.readFile()); }
      catch (error) { if (error instanceof TypeError) throw new StoreError('decode', 'Private Memory is not valid UTF-8.'); throw error; }
    } finally { await file.close(); }
  }
  private async raw(): Promise<MemoryTexts> { return { memory: await this.readText(this.context.paths.memory), user: await this.readText(this.context.paths.user) }; }
  async recover(): Promise<void> { if (await readYamlOr(this.context.paths.memoryPending, PendingSchema, () => null) !== null) await this.locked(() => this.recoverLocked()); }
  private async recoverLocked(): Promise<void> {
    const pending = await readYamlOr(this.context.paths.memoryPending, PendingSchema, () => null); if (pending === null) return;
    const completed = await readYamlOr(this.context.paths.memoryReceipt(pending.id), ReceiptSchema, () => null);
    if (completed !== null) { if (completed.id !== pending.id || completed.fingerprint !== pending.fingerprint) throw new StoreError('conflict', 'Memory pending transaction differs from its receipt.'); await removeFile(this.context.paths.memoryPending, this.context.logger); return; }
    const current = await this.raw(); const conflict = (['memory', 'user'] as const).some((target) => current[target] !== pending.before[target] && current[target] !== pending.after[target]);
    if (!conflict) for (const target of ['memory', 'user'] as const) if (current[target] !== pending.after[target]) await writeTextAtomic(this.context.paths[target], pending.after[target], this.context.logger);
    await writeYamlAtomic(this.context.paths.memoryReceipt(pending.id), { schemaVersion: 1, id: pending.id, fingerprint: pending.fingerprint, result: pending.result, conflict }, ReceiptSchema, this.context.logger);
    await removeFile(this.context.paths.memoryPending, this.context.logger);
  }
  read(signal?: AbortSignal): Promise<MemoryTexts> { return this.locked(async () => { await this.recoverLocked(); return this.raw(); }, signal); }
  async write(texts: MemoryTexts): Promise<void> { await this.transact(() => ({ next: texts, result: null })); }
  async transact(change: (texts: MemoryTexts) => MemoryTransition, options: MemoryTransaction = {}) {
    return this.locked(() => this.transactLocked(change, options), options.signal);
  }
  async importAbsent(texts: Partial<MemoryTexts>, signal?: AbortSignal): Promise<{ imported: string[]; skipped: string[] }> {
    return this.locked(async () => {
      await this.recoverLocked();
      const imported: string[] = []; const skipped: string[] = []; const selected: Partial<MemoryTexts> = {};
      for (const target of ['memory', 'user'] as const) {
        if (texts[target] === undefined) continue;
        try { await fs.lstat(this.context.paths[target]); skipped.push(target); }
        catch (error) { if (!hasCode(error, 'ENOENT')) throw error; selected[target] = texts[target]; imported.push(target); }
      }
      if (imported.length > 0) {
        const receipt = await this.transactLocked((before) => ({ next: { ...before, ...selected }, result: null }), { ...(signal === undefined ? {} : { signal }) });
        if (receipt.conflict) throw new StoreError('conflict', 'Private Memory changed during import; retry without overwriting it.');
        // 文本事务把缺失与空文本视为同值；迁移仍需保留源端的空文件存在性。
        for (const target of ['memory', 'user'] as const) if (selected[target] === '') await writeTextAtomicIfAbsent(this.context.paths[target], '', this.context.logger);
      }
      return { imported, skipped };
    }, signal);
  }
  private async transactLocked(change: (texts: MemoryTexts) => MemoryTransition, options: MemoryTransaction) {
      await this.recoverLocked(); const id = Key.parse(options.id ?? randomUUID()); const fingerprint = options.fingerprint ?? '';
      const existing = await readYamlOr(this.context.paths.memoryReceipt(id), ReceiptSchema, () => null);
      if (existing !== null) { if (existing.id !== id || existing.fingerprint !== fingerprint) throw new StoreError('conflict', 'Memory transaction identity differs from its receipt.'); return existing; }
      options.signal?.throwIfAborted(); const before = await this.raw(); const transition = change(before);
      const pending = PendingSchema.parse({ schemaVersion: 1, id, fingerprint, before, after: transition.next, result: transition.result });
      options.signal?.throwIfAborted(); options.prepared?.();
      await writeYamlAtomic(this.context.paths.memoryPending, pending, PendingSchema, this.context.logger);
      await this.recoverLocked(); const result = await readYamlOr(this.context.paths.memoryReceipt(id), ReceiptSchema, () => null);
      if (result === null) throw new StoreError('conflict', 'Memory transaction did not produce a receipt.'); return result;
  }
  private async locked<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try { if ((await fs.lstat(this.context.paths.memories)).isSymbolicLink()) throw new StoreError('conflict', 'Private Memory directory cannot be a symbolic link.'); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    return withFileLocks([`${this.context.paths.memory}.lock`, `${this.context.paths.user}.lock`], action, { timeoutMs: this.context.lockTimeoutMs, signal });
  }
}
