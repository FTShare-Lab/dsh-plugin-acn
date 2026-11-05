// 验证 Windows 锁目录删除中的短暂拒绝；持续权限错误仍有限失败。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireFileLease } from '../../src/store/lock.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const denied = () => Object.assign(new Error('Directory pending deletion'), { code: 'EPERM', syscall: 'mkdir' });
it('acquires a real lease after a temporary Windows mkdir refusal', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-lock-retry-')); const path = join(root, 'queue.lock');
  const calls = vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(denied());
  try {
    const lease = await acquireFileLease(path);
    try { lease.check(); expect(calls).toHaveBeenCalledTimes(2); expect(await fs.stat(path).then((value) => value.isDirectory())).toBe(true); }
    finally { await lease.release(); }
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it.each(['win32', 'darwin'])('does not hide a permanent refusal on %s', async (platform) => {
  vi.stubGlobal('process', { ...process, platform });
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-lock-denied-'));
  const calls = vi.spyOn(lockfile, 'lock').mockRejectedValue(denied());
  try { await expect(acquireFileLease(join(root, 'queue.lock'))).rejects.toMatchObject({ kind: 'io' }); expect(calls).toHaveBeenCalledTimes(platform === 'win32' ? 6 : 1); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
});
