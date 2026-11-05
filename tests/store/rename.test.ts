// 模拟 Windows 临时占用，确认保留旧文件、原子替换和有限失败边界。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { renameFile } from '../../src/store/rename.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('retries a transient Windows sharing violation without removing the old destination', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-rename-')); const source = join(root, 'new'); const target = join(root, 'current');
  try {
    await fs.writeFile(source, 'new'); await fs.writeFile(target, 'old');
    const original = fs.rename.bind(fs); let blocked = true;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (blocked) { blocked = false; expect(await fs.readFile(target, 'utf8')).toBe('old'); throw Object.assign(new Error('Temporarily busy'), { code: 'EPERM' }); }
      await original(from, to);
    });
    await renameFile(source, target);
    expect(rename).toHaveBeenCalledTimes(2); expect(await fs.readFile(target, 'utf8')).toBe('new');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it.each(['win32', 'darwin'])('keeps permanent failures observable on %s', async (platform) => {
  vi.stubGlobal('process', { ...process, platform });
  const failure = Object.assign(new Error('Access denied'), { code: 'EACCES' });
  const rename = vi.spyOn(fs, 'rename').mockRejectedValue(failure);
  await expect(renameFile('source', 'target')).rejects.toBe(failure);
  expect(rename).toHaveBeenCalledTimes(platform === 'win32' ? 6 : 1);
});
