// 真实服务只绑定回环；凭据在内存生成，磁盘仅预置团队 key 的哈希。
import fs from 'node:fs/promises';
import { cliCommand } from './cli-command.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';

const reference = process.env.ACN_REPO;
if (!reference) throw new Error('ACN_REPO is required.');
const root = await fs.mkdtemp(join(tmpdir(), 'acn-contract-'));
const credential = randomBytes(32).toString('hex');
const secondCredential = randomBytes(32).toString('hex');
const adminCredential = randomBytes(32).toString('hex');
const privateValues = [credential, secondCredential, adminCredential, Buffer.from(`user:${adminCredential}`).toString('base64')];
const children = [];
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
let logs = '';
async function port() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback port.');
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
const routerPort = await port(); const maintainerPort = await port();
const router = `http://127.0.0.1:${routerPort}`; const maintainer = `http://127.0.0.1:${maintainerPort}`;
const configPath = join(root, 'config.toml');
const serviceEnv = { ...process.env, ACN_TEST_ADMIN_CREDENTIAL: adminCredential };
function service(name) {
  const child = spawn(join(process.env.CARGO_TARGET_DIR ?? join(reference, 'target'), 'debug', `${name}${process.platform === 'win32' ? '.exe' : ''}`), ['--config', configPath], { env: serviceEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (value) => { logs += value.toString(); }); child.stderr.on('data', (value) => { logs += value.toString(); });
  return child;
}
async function healthy(endpoint, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error('A contract service exited during startup.');
    try { if ((await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* 等待本地监听就绪。 */ }
    await delay(50);
  }
  throw new Error('A contract service did not become healthy.');
}
let outcome = 1;
try {
  const authDir = join(root, 'data', 'team', 'maintainer'); await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(join(authDir, 'auth_keys.yaml'), stringify({ auth: { enabled: true, api_keys: [['agent-a', credential], ['agent-b', secondCredential]].map(([agent_id, value], index) => ({ key_id: `key-${index}`, agent_id, key_hash: `sha256:${createHash('sha256').update(value).digest('hex')}`, generated_time: new Date().toISOString(), status: 'active' })) } }), { mode: 0o600 });
  await fs.writeFile(configPath, `[storage]\nacn_home = ${JSON.stringify(root)}\n[router]\nrefresh_interval_secs = 1\n[router.daemon]\nlisten = "127.0.0.1:${routerPort}"\n[router.auth.team]\nenabled = true\n[router.retrieval]\nenabled = false\n[maintainer.daemon]\nlisten = "127.0.0.1:${maintainerPort}"\n[maintainer.auth.team]\nenabled = true\n[maintainer.auth.admin]\nenabled = true\nusername = "user"\npassword_env = "ACN_TEST_ADMIN_CREDENTIAL"\ncookie_secure = false\n[maintainer.arbitration]\nenabled = false\n[maintainer.sweep]\ntick_interval_secs = 3600\n`, { mode: 0o600 });
  const routerProcess = service('acn-router'); const maintainerProcess = service('acn-maintainer');
  await Promise.all([healthy(router, routerProcess), healthy(maintainer, maintainerProcess)]);
  const webHome = process.env.ACN_CONTRACT_WEB_HOME;
  if (webHome !== undefined) process.stdout.write(JSON.stringify({ router, maintainer, keyEnv: 'ACN_TEST_TEAM_CREDENTIAL', teamData: root, agents: ['agent-a', 'agent-b'] }) + '\n');
  const test = spawn(...await cliCommand(webHome === undefined ? 'pnpm' : process.execPath, webHome === undefined ? ['exec', 'vitest', 'run', '--config', 'vitest.contract.config.ts'] : ['scripts/smoke-web.mjs']), {
    stdio: 'inherit', env: { ...serviceEnv, ACN_CONTRACT_ROUTER: router, ACN_CONTRACT_MAINTAINER: maintainer, ACN_TEST_TEAM_CREDENTIAL: credential, ACN_TEST_OTHER_CREDENTIAL: secondCredential,
      ...webHome === undefined ? {} : { ACN_WEB_HOME: webHome, ACN_WEB_INSTALL: 'browser' },
    },
  });
  children.push(test);
  const [code] = await once(test, 'exit'); outcome = code === 0 || stopping ? 0 : 1;
} catch (error) {
  const text = error instanceof Error ? error.message : 'Contract startup failed.';
  process.stderr.write(`${privateValues.reduce((text, value) => text.replaceAll(value, '[redacted]'), text)}\n`);
  // 配置错误只展示经过脱敏的末尾诊断，正常运行不复制服务日志。
  const safe = privateValues.reduce((text, value) => text.replaceAll(value, '[redacted]'), logs).slice(-4000);
  process.stderr.write(`${safe}\n`);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  if (privateValues.some((value) => logs.includes(value))) { outcome = 1; process.stderr.write('Contract service logs exposed a generated credential.\n'); }
  await fs.rm(root, { recursive: true, force: true });
}
process.exitCode = outcome;
