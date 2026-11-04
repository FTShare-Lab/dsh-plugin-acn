// 去掉可选打开标志，验证链接拒绝与普通 Memory 读写仍由显式文件检查保障。
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryFileStore } from '../../src/store/memory.js';
import { context } from '../helpers.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-platform-memory-')); roots.push(root);
  const c = context(join(root, 'agent')); await fs.mkdir(c.paths.memories, { recursive: true });
  const external = join(root, 'example.txt'); await fs.writeFile(external, 'public example');
  const original = fs.open.bind(fs);
  const open = vi.spyOn(fs, 'open').mockImplementation((path, flags, mode) => original(path, typeof flags === 'number' ? flags & ~(constants.O_NOFOLLOW ?? 0) & ~(constants.O_NONBLOCK ?? 0) : flags, mode));
  return { root, c, external, store: new MemoryFileStore(c), original, open };
}
describe('Memory protection without POSIX open flags', () => {
  it('reads absent and ordinary files, publishes updates and replays the same transaction once', async () => {
    const f = await setup(); expect(await f.store.read()).toEqual({ memory: '', user: '' });
    await f.store.write({ memory: 'stable knowledge', user: 'a preference' });
    expect(await f.store.read()).toEqual({ memory: 'stable knowledge', user: 'a preference' });
    const edit = () => f.store.transact((before) => ({ next: { ...before, memory: before.memory + ' appended' }, result: true }), { id: 'same-call', fingerprint: 'same-operation' });
    await edit(); await edit(); expect((await f.store.read()).memory).toBe('stable knowledge appended');
  });
  it.each(['memory', 'user'] as const)('rejects an existing %s file link before opening its target', async (key) => {
    const f = await setup(); await fs.symlink(f.external, f.c.paths[key]);
    await expect(f.store.read()).rejects.toMatchObject({ kind: 'conflict' });
    expect(f.open).not.toHaveBeenCalled(); expect(await fs.readFile(f.external, 'utf8')).toBe('public example');
  });
  it('rejects a file replaced by a link between lstat and open even without NOFOLLOW', async () => {
    const f = await setup(); await fs.writeFile(f.c.paths.memory, 'original');
    f.open.mockImplementation(async (path, flags, mode) => {
      if (path === f.c.paths.memory) { await fs.unlink(f.c.paths.memory); await fs.symlink(f.external, f.c.paths.memory); }
      return f.original(path, typeof flags === 'number' ? flags & ~(constants.O_NOFOLLOW ?? 0) & ~(constants.O_NONBLOCK ?? 0) : flags, mode);
    });
    await expect(f.store.read()).rejects.toMatchObject({ kind: 'conflict' });
    expect(await fs.readFile(f.external, 'utf8')).toBe('public example');
  });
  it('rejects a junction used as the memories directory', async () => {
    const f = await setup(); await fs.rmdir(f.c.paths.memories); const target = join(f.root, 'elsewhere'); await fs.mkdir(target);
    await fs.symlink(target, f.c.paths.memories, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.store.read()).rejects.toMatchObject({ kind: 'conflict' }); expect(await fs.readdir(target)).toEqual([]);
  });
});
