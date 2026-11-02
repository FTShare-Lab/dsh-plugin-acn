#!/usr/bin/env bash
# 在临时主目录安装预构建包，验证公开 CLI 组合出的插件配置。
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task_temp="$(mktemp -d /tmp/acn-install.XXXXXX)"
task_dsh="${DSH_BIN:-dsh}"
trap 'rm -rf "$task_temp"' EXIT
cd "$task_root"

if ! command -v "$task_dsh" >/dev/null 2>&1; then
  printf 'Missing dsh CLI; install the compatible runtime or set DSH_BIN.\n' >&2
  exit 1
fi

export DSH_HOME="$task_temp/dsh"
export DSH_AGENTS_HOME="$task_temp/agents"
export DSH_TELEMETRY_DISABLED=true

mkdir -p "$task_temp/package"
pnpm pack --pack-destination "$task_temp/package" >"$task_temp/pack.log" 2>&1 || {
  cat "$task_temp/pack.log" >&2
  exit 1
}
task_packages=("$task_temp"/package/*.tgz)
if [[ "${#task_packages[@]}" -ne 1 || ! -f "${task_packages[0]}" ]]; then
  printf 'Expected exactly one package tarball.\n' >&2
  exit 1
fi

"$task_dsh" --profile acn-smoke --from-default-profile web --dump-config >"$task_temp/before.yml"
"$task_dsh" plugin --profile acn-smoke add "${task_packages[0]}" >"$task_temp/install.log" 2>&1 || {
  cat "$task_temp/install.log" >&2
  exit 1
}
"$task_dsh" --profile acn-smoke --dump-config >"$task_temp/composed.yml"

node --input-type=module - "$task_temp/composed.yml" "${task_packages[0]}" <<'JS'
// 验证具体组合结构，避免只匹配日志或注释中的插件名称。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke';

const [configPath, tarballPath] = process.argv.slice(2);
const entries = parse(await readFile(configPath, 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
});
const group = entries.find((entry) => entry.id === 'acn');
assert.equal(group?.isolate?.acnKnowledge, true);
assert.equal(group?.isolate?.acnMemory, true);
assert.deepEqual(group.config.map((entry) => entry.id), ['acn-configuration', 'acn-knowledge', 'acn-prompt', 'acn-tools', 'acn-formation', 'acn-inbox', 'acn-dream', 'acn-memory', 'acn-commands']);
assert.equal(group.config[0].name, 'dsh-plugin-acn');
assert.equal(group.config[1].name, 'dsh-plugin-acn/knowledge');
const { stdout } = await promisify(execFile)('tar', ['-tf', tarballPath]);
const files = stdout.trim().split('\n');
for (const required of ['README.md', 'README_EN.md', 'CHANGELOG.md', 'docs/index.md', 'docs/config.md', 'docs/user-guide.md', 'docs/command-reference.md', 'docs/development.md', 'docs/architecture.md', 'docs/acn-compat.md', 'docs/dsh-compat.md', 'docs/outstanding-issues.md', 'docs/assets/install-package.jpg', 'docs/assets/team-settings.jpg', 'docs/assets/session-sync.jpg', 'docs/assets/knowledge-view.jpg', 'docs/assets/activity-view.jpg', 'docs/assets/config-team.jpg']) assert.ok(files.includes(`package/${required}`), `Missing document or image: ${required}`);
assert.ok(!files.some((file) => /^package\/docs\/(?:plan\/|validation\/|acceptance\.md$|release\.md$)/.test(file)));
for (const required of ['lib/memory.js', 'lib/plugins/memory.js', 'lib/types/memory/index.d.ts', 'lib/types/plugins/memory.d.ts', 'prompts/what_is_memory.j2', 'prompts/memory.j2', 'prompts/memory_review_system.j2', 'prompts/memory_review.j2']) assert.ok(files.includes(`package/${required}`), `Missing Memory package file: ${required}`);
for (const required of ['lib/dream.js', 'lib/plugins/dream.js', 'lib/types/dream/index.d.ts', 'lib/types/plugins/dream.d.ts', 'lib/types/dream/evidence-store.d.ts', 'lib/types/dsh-adapter/dream-evidence.d.ts', 'prompts/claim_dream.j2', 'prompts/dream_compaction.j2', 'prompts/dream_evidence.j2']) assert.ok(files.includes(`package/${required}`), `Missing Dream package file: ${required}`);
for (const required of ['lib/index.js', 'lib/client.js', 'lib/types/plugins/client.d.ts', 'lib/plugins/inbox.js', 'lib/inbox.js', 'lib/team.js', 'lib/upload.js', 'lib/types/plugins/inbox.d.ts', 'lib/types/inbox/index.d.ts', 'lib/types/team/index.d.ts', 'lib/types/upload/index.d.ts', 'prompts/inbox_policy_update_internalize.j2', 'prompts/inbox_claim_attribute_update_internalize.j2', 'lib/plugins/knowledge.js', 'lib/plugins/prompt.js', 'lib/plugins/tools.js', 'lib/plugins/commands.js', 'lib/plugins/formation.js', 'lib/formation.js', 'lib/types/plugins/formation.d.ts', 'lib/types/formation/index.d.ts', 'lib/protocol.js', 'lib/store.js', 'lib/types/index.d.ts', 'lib/types/plugins/knowledge.d.ts', 'lib/types/plugins/tools.d.ts', 'lib/types/plugins/prompt.d.ts', 'lib/types/plugins/commands.d.ts', 'lib/types/protocol/index.d.ts', 'lib/types/store/index.d.ts', 'prompts/knowledge.j2', 'prompts/session_recap.j2', 'prompts/what_is_claim.j2', 'prompts/what_is_dispute.j2', 'prompts/what_is_policy.j2', 'cordis.patch.yml', 'LICENSE-MIT', 'LICENSE-APACHE']) {
  assert.ok(files.includes(`package/${required}`), `Missing package file: ${required}`);
}
assert.ok(!files.some((file) => /^package\/(src|tests|node_modules)\//.test(file)));
const installed = createRequire(join(process.env.DSH_HOME, 'profiles', 'acn-smoke', 'package.json'));
// 元数据通过安装包公开子路径解析，覆盖根包及每个组件，避免本地文件掩盖漏包。
for (const part of ['', ...group.config.filter((entry) => entry.name.startsWith('dsh-plugin-acn/')).map((entry) => entry.name.slice('dsh-plugin-acn/'.length))]) {
  const prefix = `dsh-plugin-acn/${part ? `${part}/` : ''}`;
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(installed.resolve(`${prefix}locale/${language}.json`), 'utf8'));
    assert.ok(locale.meta.title.trim()); assert.ok(locale.meta.description.trim());
    if (part === '') {
      assert.equal(locale.meta.title, language === 'zh' ? 'ACN记忆框架' : 'agent-claim-network');
      if (language === 'zh') assert.equal(locale.meta.description, '从agent工作轨迹中沉淀可复用的知识与记忆，让知识经验在团队中流动');
      // 详细介绍按包根解析，必须在安装后的包中仍可找到正文与相对图片。
      assert.equal(locale.meta.detail, language === 'zh' ? 'README.md' : 'README_EN.md');
      const packageRoot = dirname(installed.resolve('dsh-plugin-acn/package.json'));
      const detailPath = join(packageRoot, locale.meta.detail);
      const detail = await readFile(detailPath, 'utf8');
      assert.equal(detail, await readFile(join(process.cwd(), locale.meta.detail), 'utf8'), 'Installed documentation must match the repository README.');
      const images = [...detail.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)];
      assert.ok(images.length > 0, 'The localized detail must include the real configuration screenshot.');
      for (const image of images) {
        const bytes = await readFile(join(dirname(detailPath), image[1]));
        assert.ok(bytes.length > 0, `Missing detail image: ${image[1]}`);
      }
    }
  }
  const icon = await readFile(installed.resolve(`${prefix}icon`));
  assert.ok(icon.length > 0 && icon.length <= 256 * 1024);
  assert.match(icon.toString('utf8'), /<svg\s[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
}
const protocol = await import(pathToFileURL(installed.resolve('dsh-plugin-acn/protocol')).href);
const store = await import(pathToFileURL(installed.resolve('dsh-plugin-acn/store')).href);
const formation = await import(pathToFileURL(installed.resolve('dsh-plugin-acn/formation-core')).href);
assert.equal(protocol.ClaimIdSchema.parse('claim_00000001'), 'claim_00000001');
assert.equal(typeof store.InboxStore, 'function');
assert.equal(typeof formation.FormationStore, 'function');
const inbox = await import(pathToFileURL(installed.resolve('dsh-plugin-acn/inbox-core')).href);
const team = await import(pathToFileURL(installed.resolve('dsh-plugin-acn/team')).href);
const upload = await import(pathToFileURL(installed.resolve('dsh-plugin-acn/upload-core')).href);
assert.equal(typeof inbox.InboxEffectStore, 'function');
assert.equal(typeof team.TeamFacade, 'function');
assert.equal(typeof upload.UploadDelivery, 'function');
const dream = await import(pathToFileURL(installed.resolve('dsh-plugin-acn/dream-core')).href);
assert.equal(typeof dream.DreamStore, 'function');
assert.equal(typeof dream.AcnDream, 'function');
assert.equal(typeof dream.EvidenceStore, 'function');
const memory = await import(pathToFileURL(installed.resolve('dsh-plugin-acn/memory-core')).href);
assert.equal(typeof memory.AcnMemory, 'function'); assert.equal(typeof memory.MemoryReview, 'function');
// 宿主 peer 由真实 Loader 共享；普通 Node 导入不能代表插件的运行环境。
const root = process.cwd();
const host = join(root, 'tests', 'plugin', 'fixtures', 'host.ts');
const patch = join(root, 'cordis.patch.yml');
const runtime = await runLoaderSmoke({
  label: 'installed-acn', tempDirPrefix: 'acn-installed-loader-',
  binScript: host, libBinScript: host, configPath: patch,
  binArgs: [patch, 'configured', pathToFileURL(join(process.env.DSH_HOME, 'profiles', 'acn-smoke', 'package.json')).href],
  tsconfigPath: join(root, 'tsconfig.json'), mode: 'lib',
  env: { DSH_TELEMETRY_DISABLED: 'true' },
});
assert.ok(runtime.stdout.includes('ACN_SMOKE_OK:configured'));
const calibrated = await runLoaderSmoke({
  label: 'installed-acn-calibrated', tempDirPrefix: 'acn-installed-calibration-',
  binScript: host, libBinScript: host, configPath: patch,
  binArgs: [patch, 'calibrated', pathToFileURL(join(process.env.DSH_HOME, 'profiles', 'acn-smoke', 'package.json')).href],
  tsconfigPath: join(root, 'tsconfig.json'), mode: 'lib', env: { DSH_TELEMETRY_DISABLED: 'true' },
});
assert.ok(calibrated.stdout.includes('ACN_SMOKE_OK:calibrated'));
const privateMemory = await runLoaderSmoke({
  label: 'installed-acn-memory', tempDirPrefix: 'acn-installed-memory-',
  binScript: host, libBinScript: host, configPath: patch,
  binArgs: [patch, 'memory', pathToFileURL(join(process.env.DSH_HOME, 'profiles', 'acn-smoke', 'package.json')).href],
  tsconfigPath: join(root, 'tsconfig.json'), mode: 'lib', env: { DSH_TELEMETRY_DISABLED: 'true' },
});
assert.ok(privateMemory.stdout.includes('ACN_SMOKE_OK:memory'));
// 只修改临时解包副本，验证实际 CLI 的宿主引擎安装门禁。
const taskTemp = join(process.env.DSH_HOME, '..', 'incompatible');
await mkdir(taskTemp, { recursive: true });
const run = promisify(execFile);
await run('tar', ['-xf', tarballPath, '-C', taskTemp]);
const manifestPath = join(taskTemp, 'package', 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.engines.dsh = '>=999.0.0';
await writeFile(manifestPath, JSON.stringify(manifest));
const incompatible = join(taskTemp, 'incompatible.tgz');
await run('tar', ['-czf', incompatible, '-C', taskTemp, 'package']);
await run(process.env.DSH_BIN ?? 'dsh', ['--profile', 'acn-incompatible', '--from-default-profile', 'web', '--dump-config']);
let rejected = false;
try { await run(process.env.DSH_BIN ?? 'dsh', ['plugin', '--profile', 'acn-incompatible', 'add', incompatible]); }
catch (error) { rejected = error.code !== 0 && /incompatib|engines\.dsh|requires.*dsh/i.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`); }
assert.ok(rejected, 'The actual CLI must refuse an incompatible DSH engine.');
const after = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
assert.equal(after.engines.dsh, '>=0.2.1-rc.2 <0.3.0');
JS

printf 'Installation smoke passed (DSH %s): default, calibration, private Memory, release documents and incompatible engine rejection.\n' "$("$task_dsh" --version)"
