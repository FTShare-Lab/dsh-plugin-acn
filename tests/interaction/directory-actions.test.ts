// 打开已有目录复用主机桌面接口，不依赖已启用的知识组件，也不创建或搬迁目录。
import { Context } from '@deepseek-ai/cordis';
import fs from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { executeInteraction } from '../../src/dsh-adapter/interaction-service.js';
it('opens native paths with spaces and unicode and expands home before handing off', async () => {
  const ctx = new Context(); const root = await fs.mkdtemp(join(tmpdir(), 'acn-directory-'));
  const open = vi.fn().mockResolvedValue({ opened: true });
  ctx.provide('sessionController', { canOpenWorkspacePath: () => true, openWorkspacePath: open } as unknown as Context['sessionController']);
  try {
    const path = join(root, 'Work Files 知识'); await fs.mkdir(path);
    expect(await executeInteraction(ctx, { action: 'open_directory', path })).toMatchObject({ ok: true }); expect(open).toHaveBeenCalledWith({ path }, expect.any(AbortSignal));
    expect(await executeInteraction(ctx, { action: 'open_directory', path: '~' })).toMatchObject({ ok: true }); expect(open).toHaveBeenLastCalledWith({ path: homedir() }, expect.any(AbortSignal));
    const file = join(root, 'file.txt'); await fs.writeFile(file, 'example');
    expect(await executeInteraction(ctx, { action: 'open_directory', path: file })).toMatchObject({ ok: false });
    expect(await executeInteraction(ctx, { action: 'open_directory', path: join(root, 'missing') })).toMatchObject({ ok: false }); expect(open).toHaveBeenCalledTimes(2);
  } finally { await ctx.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
