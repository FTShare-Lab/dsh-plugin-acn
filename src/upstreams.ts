// 工作配置决定当前 upstream 与团队客户端，知识根始终指向同一账号目录。
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ResolvedConfig } from './config.js';
import { resolveConfig, upstreamsOf } from './config.js';
import { assertStorageName } from './store/path-names.js';

export { upstreamsOf } from './config.js';

export function resolveUpstream(config: ResolvedConfig, key: string, includeDisabled = false): ResolvedConfig | undefined {
  const profile = upstreamsOf(config)[key];
  if (profile === undefined || !profile.enabled && !includeDisabled) return undefined;
  assertStorageName(key);
  return resolveConfig({ ...config, upstreams: undefined, upstream: key, connections: [], defaultConnection: '', sessionEpoch: 0,
    agentId: profile.agentId, legacyEnabled: true, team: { ...config.team, routerEndpoint: profile.routerEndpoint, maintainerEndpoint: profile.maintainerEndpoint, keyEnv: profile.keyEnv, timeoutMs: profile.timeoutMs } });
}

export function defaultUpstream(config: ResolvedConfig): string {
  return config.upstreams === undefined ? (config.agentId ? 'personal' : '') : config.upstream;
}

// 同一实际目录及其符号链接视为同一项目。
export async function canonicalProjectPath(cwd: string): Promise<string> {
  const path = resolve(cwd);
  try { return await realpath(path); } catch { return path; }
}
