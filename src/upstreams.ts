// 工作配置决定知识根和团队客户端；旧目录映射只在首次配置升级时生成。
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ResolvedConfig } from './config.js';
import { resolveConfig, upstreamsOf } from './config.js';

export { upstreamsOf } from './config.js';

export function resolveUpstream(config: ResolvedConfig, key: string, includeDisabled = false): ResolvedConfig | undefined {
  const profile = upstreamsOf(config)[key];
  if (profile === undefined || !profile.enabled && !includeDisabled) return undefined;
  const home = profile.legacyStorage === 'base' ? config.home : profile.legacyStorage === 'personal' ? join(config.home, 'personal') : profile.legacyStorage === 'connection' ? join(config.home, 'connections', profile.legacyKey ?? '') : join(config.home, key, 'data');
  return resolveConfig({ ...config, upstreams: undefined, upstream: '', connections: [], defaultConnection: '', sessionEpoch: 0,
    home, agentId: profile.agentId, legacyEnabled: true, team: { ...config.team, routerEndpoint: profile.routerEndpoint, maintainerEndpoint: profile.maintainerEndpoint, keyEnv: profile.keyEnv, timeoutMs: profile.timeoutMs } });
}

export function defaultUpstream(config: ResolvedConfig): string {
  return config.upstreams === undefined ? (config.agentId ? 'personal' : '') : config.upstream;
}

// 同一实际目录及其符号链接视为同一项目。
export async function canonicalProjectPath(cwd: string): Promise<string> {
  const path = resolve(cwd);
  try { return await realpath(path); } catch { return path; }
}
