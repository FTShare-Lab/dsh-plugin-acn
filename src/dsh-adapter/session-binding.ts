// 身份切换后拒绝旧会话及其派生会话，防止旧上下文访问新身份的数据。
import type { Context } from '@deepseek-ai/cordis';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResolvedConfig } from '../config.js';
import { agentHomePath } from '../store/paths.js';

const BindingSchema = z.strictObject({ schemaVersion: z.literal(1), identity: z.string().regex(/^[0-9a-f]{64}$/) });
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap { 'plugin:acn/session-binding': z.infer<typeof BindingSchema> }
}
// 身份随宿主会话日志持久化和继承；缓存只避免每次门禁重新扫描历史。
const bindings = new WeakMap<SessionHeader, string | null>();
const identityOf = (config: ResolvedConfig): string => createHash('sha256').update(config.agentId === '' ? '' : agentHomePath(config.home, config.agentId)).digest('hex');

export function bindSession(ctx: Context, config: ResolvedConfig, header: SessionHeader): void {
  if (bindings.has(header)) return;
  const session = ctx.sessions.get(header.id);
  if (session === undefined) { bindings.set(header, null); return; }
  const records = session.snapshotEvents().map(pluginRecordOf).filter((record) => record?.type === 'plugin:acn/session-binding');
  if (records.length > 0) {
    const values = records.map((record) => BindingSchema.safeParse(record?.data));
    const first = values[0];
    bindings.set(header, first?.success && values.every((value) => value.success && value.data.identity === first.data.identity) ? first.data.identity : null);
    return;
  }
  // 没有持久身份的旧日志无法证明归属；不能因重启后配置不同而自动改绑。
  const parent = header.parentSession === undefined ? undefined : ctx.sessions.get(header.parentSession);
  // 全新子会话未必继承日志；只允许从当前已验证身份的父会话建立绑定。
  const verifiedParent = parent !== undefined && sessionAllowed(ctx, config, parent.header);
  if (session.firstLiveSeq > 0 || (header.parentSession !== undefined || header.isSeeded) && !verifiedParent) { bindings.set(header, null); return; }
  const identity = identityOf(config);
  bindings.set(header, identity);
  try { appendPluginRecord(session, 'plugin:acn/session-binding', { schemaVersion: 1, identity }); }
  catch (error) { bindings.set(header, null); throw error; }
}

export const sessionChanged = 'ACN 会话身份与当前配置不一致，或缺少可验证的历史身份记录，请新建会话。旧会话不能访问当前身份的知识和私有记忆。';
export const configurationBusy = 'ACN 配置正在应用，请稍后重试。';
export function sessionAllowed(ctx: Context, config: ResolvedConfig, header: SessionHeader): boolean {
  // 未配置时没有可暴露的 ACN 数据，不干预宿主原有会话。
  if (config.agentId === '') return true;
  const identity = identityOf(config);
  const bound = bindings.get(header);
  if (bound !== identity) return false;
  if (config.sessionEpoch === 0) return true;
  const seen = new Set<string>();
  let current: SessionHeader | undefined = header;
  while (current !== undefined) {
    if (current.createdAt <= config.sessionEpoch || seen.has(current.id)) return false;
    seen.add(current.id);
    if (current.parentSession === undefined) return true;
    // 不把无法验证来源的历史 fork 当成全新会话。
    current = ctx.sessions.get(current.parentSession)?.header;
  }
  return false;
}
