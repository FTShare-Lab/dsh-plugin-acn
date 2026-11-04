// 独立临时配置验证真实安装、发布内容及宿主引擎门禁，支持 Windows 与类 Unix。
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cliCommand } from './cli-command.mjs';
const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), 'acn-install-'));
const env = { ...process.env, DSH_HOME: join(temp, 'dsh'), DSH_AGENTS_HOME: join(temp, 'agents'), DSH_TELEMETRY_DISABLED: 'true' };
const options = { cwd: root, env, maxBuffer: 16_000_000 };
const cli = async (name, args) => run(...await cliCommand(name, args), options);
try {
  await mkdir(join(temp, 'package'));
  await cli('pnpm', ['pack', '--pack-destination', join(temp, 'package')]);
  const packages = (await readdir(join(temp, 'package'))).filter((name) => name.endsWith('.tgz'));
  if (packages.length !== 1) throw new Error('Expected exactly one package tarball.');
  const dsh = process.env.DSH_BIN ?? 'dsh';
  await cli(dsh, ['--profile', 'acn-smoke', '--from-default-profile', 'web', '--dump-config']);
  await cli(dsh, ['plugin', '--profile', 'acn-smoke', 'add', join(temp, 'package', packages[0])]);
  const composed = await cli(dsh, ['--profile', 'acn-smoke', '--dump-config']);
  await writeFile(join(temp, 'composed.yml'), composed.stdout);
  const verified = await run(process.execPath, ['scripts/verify-install.mjs', join(temp, 'composed.yml'), join(temp, 'package', packages[0])], options);
  process.stdout.write(verified.stdout);
  process.stdout.write(`Installation smoke passed (DSH ${(await cli(dsh, ['--version'])).stdout.trim()}).\n`);
} catch (error) { process.stderr.write(`${error.stdout ?? ''}\n${error.stderr ?? ''}\n`); throw error; }
finally { await rm(temp, { recursive: true, force: true }); }
