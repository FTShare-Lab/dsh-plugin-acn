// 即使文件系统没有 POSIX 打开标志，也拒绝符号链接、硬链接和打开期间替换的文件。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const module = await original<typeof import('node:fs')>();
  return { ...module, constants: { ...module.constants, O_NOFOLLOW: undefined, O_NONBLOCK: undefined } };
});
import { openSingleFile } from '../../src/store/regular-file.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
it('reads regular files and rejects file aliases without O_NOFOLLOW', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-file-')); roots.push(root);
  const path = join(root, 'file'); await fs.writeFile(path, 'public');
  const invalid = () => new Error('Single regular file required.');
  const file = await openSingleFile(path, invalid); try { expect(await file.readFile('utf8')).toBe('public'); } finally { await file.close(); }
  await fs.symlink(path, join(root, 'alias')); await expect(openSingleFile(join(root, 'alias'), invalid)).rejects.toThrow('Single regular');
  await fs.link(path, join(root, 'hardlink')); await expect(openSingleFile(path, invalid)).rejects.toThrow('Single regular');
});
it('rejects replacement between lstat and open and closes the rejected descriptor', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-file-')); roots.push(root);
  const path = join(root, 'file'); await fs.writeFile(path, 'original');
  const open = fs.open.bind(fs); let closed = false;
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    await fs.rename(path, join(root, 'old')); await fs.writeFile(path, 'replacement');
    const file = await open(...args); const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => { closed = true; await close(); }); return file;
  });
  await expect(openSingleFile(path, () => new Error('Changed file.'))).rejects.toThrow('Changed file.'); expect(closed).toBe(true);
});
