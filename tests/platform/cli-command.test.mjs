// 合并后的安装启动器必须同时支持带空格的 JS 入口和原生命令，参数不得经过 Shell 展开。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { cliCommand } from '../../scripts/cli-command.mjs';
import { runCommand } from '../../scripts/run-command.mjs';
const roots = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))); });
it('runs a JavaScript CLI entry in a directory with spaces and preserves literal arguments', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-cli-')); roots.push(root);
  const directory = join(root, 'cli directory'); await fs.mkdir(directory); const entry = join(directory, 'entry.mjs');
  await fs.writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const args = ['a path with spaces', 'quote"data', 'literal$argument', 'value;part'];
  expect(JSON.parse((await runCommand(entry, args)).stdout)).toEqual(args);
});
it('keeps native executable exit failures and output available to the installer', async () => {
  await expect(runCommand(process.execPath, ['-e', 'process.stdout.write("partial"); process.stderr.write("failed"); process.exit(7);'])).rejects.toMatchObject({ code: 7, stdout: 'partial', stderr: 'failed' });
});

it('launches a native package-manager executable without passing its binary bytes to Node', async () => {
  vi.stubEnv('npm_execpath', process.execPath);
  const [command, args] = await cliCommand('pnpm', ['-e', 'process.stdout.write("native executable");']);
  expect((await runCommand(command, args)).stdout).toBe('native executable');
});
