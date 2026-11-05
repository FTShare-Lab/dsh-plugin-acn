// 使用同名锁目录提供跨进程互斥，并检查知识锁到队列锁的获取顺序。
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import lockfile from 'proper-lockfile';
import { hasCode, LockTimeoutError, StoreError } from './errors.js';

const heldLocks = new AsyncLocalStorage<readonly string[]>();
export interface LockOptions { timeoutMs?: number | undefined; staleMs?: number | undefined; signal?: AbortSignal | undefined }

// 生命周期锁不参与领域锁的嵌套排序；调用方必须在释放前停止所有受保护工作。
export async function acquireFileLease(path: string, options: LockOptions = {}): Promise<{ check(): void; release(): Promise<void> }> {
  options.signal?.throwIfAborted();
  const lockPath = resolve(path);
  const timeout = options.timeoutMs ?? 30_000;
  const stale = options.staleMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(stale) || stale < 5000) throw new StoreError('lock_order', 'Invalid lock timing options.');
  await fs.mkdir(dirname(lockPath), { recursive: true });
  const deadline = performance.now() + timeout;
  let compromised: Error | undefined;
  let pendingDeleteRetries = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      const release = await lockfile.lock(lockPath, { realpath: false, lockfilePath: lockPath, stale, retries: 0, onCompromised: (error: Error) => { compromised = error; } });
      if (options.signal?.aborted) { await release(); options.signal.throwIfAborted(); }
      return { check: () => { if (compromised !== undefined) throw new StoreError('lock_compromised', 'Lock ownership was lost.', { cause: compromised }); }, release };
    } catch (error) {
      options.signal?.throwIfAborted();
      // NTFS 删除中的锁目录可能暂时拒绝同名 mkdir；不改用别的锁路径或绕过互斥。
      if (process.platform === 'win32' && hasCode(error, 'EPERM') && typeof error === 'object' && error !== null && 'syscall' in error && error.syscall === 'mkdir' && pendingDeleteRetries < 5 && performance.now() < deadline) {
        await delay(Math.min(10 * 2 ** pendingDeleteRetries++, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal });
        continue;
      }
      if (!hasCode(error, 'ELOCKED')) throw new StoreError('io', `Cannot acquire lock: ${lockPath}`, { cause: error });
      if (performance.now() >= deadline) throw new LockTimeoutError(lockPath);
      await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal });
    }
  }
}

export async function withFileLock<T>(path: string, action: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lockPath = resolve(path);
  const held = heldLocks.getStore() ?? [];
  // 同一知识根中的这两个路径按字典序排列，与约定的锁顺序一致。
  if (held.some((previous) => previous >= lockPath)) throw new StoreError('lock_order', `Lock order violation: ${lockPath}`);
  const lease = await acquireFileLease(lockPath, options);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const result = await heldLocks.run([...held, lockPath], action);
    lease.check();
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try { await lease.release(); }
  catch (error) { if (outcome.ok) outcome = { ok: false, error: new StoreError('lock_compromised', `Cannot release lock: ${lockPath}`, { cause: error }) }; }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export function withFileLocks<T>(paths: readonly string[], action: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const ordered = [...new Set(paths.map((path) => resolve(path)))].sort();
  const acquire = (index: number): Promise<T> => {
    const path = ordered[index];
    return path === undefined ? action() : withFileLock(path, () => acquire(index + 1), options);
  };
  return acquire(0);
}
