// 账号目录保存公开配置索引；凭据、模型引用与任务执行仍由各自所有者管理。
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConfigError, resolveConfig, UpstreamSchema, UpstreamNameSchema, upstreamsOf } from '../config.js';
import type { ResolvedConfig, Upstream } from '../config.js';
import type { StoreLogger } from './context.js';
import { expandHomePath } from './paths.js';
import { hasCode } from './errors.js';
import { writeTextAtomic } from './atomic.js';
import { withFileLock } from './lock.js';

const Summary = z.object({ id: UpstreamNameSchema, name: UpstreamSchema.shape.name, agentId: UpstreamSchema.shape.agentId, enabled: UpstreamSchema.shape.enabled, maintainerEndpoint: UpstreamSchema.shape.maintainerEndpoint, routerEndpoint: UpstreamSchema.shape.routerEndpoint });
const Index = z.object({ schemaVersion: z.literal(1), upstreams: z.array(z.object({ summary: Summary })), preferences: z.object({ defaultUpstream: z.string().nullable().optional() }).optional() });
const ObjectRecord = z.record(z.string(), z.unknown());

async function sameDirectory(left: string, right: string): Promise<boolean> {
  const a = resolve(expandHomePath(left)); const b = resolve(expandHomePath(right));
  if (a === b) return true;
  try {
    const [first, second] = await Promise.all([realpath(a), realpath(b)]);
    return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
  } catch { return false; }
}

async function readIndex(home: string) {
  let text: string;
  try { text = await readFile(join(expandHomePath(home), 'settings.json'), 'utf8'); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw new ConfigError(['libraryIndex']); }
  try {
    const raw = ObjectRecord.parse(JSON.parse(text)); const known = Index.parse(raw);
    if (new Set(known.upstreams.map((item) => item.summary.id)).size !== known.upstreams.length) throw new ConfigError(['libraryIndex']);
    return { raw, known };
  } catch { throw new ConfigError(['libraryIndex']); }
}

export async function prepareLibraryDirectory(previous: Record<string, unknown>, next: Record<string, unknown>): Promise<Record<string, unknown>> {
  const before = resolveConfig(previous); const after = resolveConfig(next);
  if ((before.upstreams !== undefined || before.agentId !== '' || after.upstreams !== undefined) && await sameDirectory(before.home, after.home)) return { ...next, home: before.home };
  const index = await readIndex(after.home); if (index === null) return next;
  const upstreams: Record<string, Upstream> = {};
  for (const { summary } of index.known.upstreams) {
    const { id, ...value } = summary;
    // 连接信息可复用；凭据和模型引用由当前宿主管理。
    const parsed = UpstreamSchema.safeParse({ ...value, timeoutMs: after.team.timeoutMs });
    if (!parsed.success) throw new ConfigError(['libraryIndex']);
    Object.defineProperty(upstreams, id, { value: parsed.data, enumerable: true, writable: true, configurable: true });
  }
  const preferred = index.known.preferences?.defaultUpstream ?? '';
  return { ...next, upstreams, upstream: upstreams[preferred]?.enabled ? preferred : '', agentId: '', connections: [], defaultConnection: '' };
}

// 从已采用的宿主配置生成索引；未变化时不改写，无关扩展字段原位保留。
export async function syncLibraryIndex(config: ResolvedConfig, logger: StoreLogger): Promise<void> {
  const profiles = upstreamsOf(config);
  if (config.upstreams === undefined && Object.keys(profiles).length === 0) return;
  const path = join(expandHomePath(config.home), 'settings.json');
  await withFileLock(`${path}.lock`, async () => {
    const index = await readIndex(config.home);
    const previous = index?.known.upstreams ?? [];
    const summaries = Object.entries(profiles).map(([id, item]) => Summary.parse({ id, ...item }));
    const selected = config.upstreams === undefined ? config.agentId ? 'personal' : '' : config.upstream;
    const expected = { upstreams: summaries, defaultUpstream: selected || null };
    if (index !== null && JSON.stringify({ upstreams: previous.map((item) => item.summary), defaultUpstream: index.known.preferences?.defaultUpstream ?? null }) === JSON.stringify(expected)) return;
    const stored = z.array(ObjectRecord).parse(index?.raw.upstreams ?? []);
    const upstreams = summaries.map((summary) => {
      const position = previous.findIndex((item) => item.summary.id === summary.id);
      const old = position < 0 ? undefined : previous[position]?.summary;
      const fields = position < 0 ? {} : stored[position] ?? {};
      const sameTarget = old !== undefined && old.agentId === summary.agentId && old.maintainerEndpoint === summary.maintainerEndpoint;
      return { ...fields, summary, maintainerRevision: sameTarget && typeof fields.maintainerRevision === 'string' ? fields.maintainerRevision : randomUUID(), identityEpoch: old?.agentId === summary.agentId && typeof fields.identityEpoch === 'string' ? fields.identityEpoch : randomUUID() };
    });
    const preferences = ObjectRecord.parse(index?.raw.preferences ?? {});
    await writeTextAtomic(path, JSON.stringify({ ...index?.raw, schemaVersion: 1, revision: randomUUID(), upstreams, preferences: { ...preferences, defaultUpstream: selected || null } }, null, 2) + '\n', logger);
  });
}
