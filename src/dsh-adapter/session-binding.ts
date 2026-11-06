// 身份切换后拒绝旧会话及其派生会话，防止旧上下文访问新身份的数据。
import type { Context } from '@deepseek-ai/cordis';
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { activeUpstream, type ResolvedConfig } from '../config.js';
import { agentHomePath } from '../store/paths.js';

const BindingSchema = z.strictObject({ schemaVersion: z.literal(1), identity: z.string().regex(/^[0-9a-f]{64}$/) });
const EligibilitySchema = z.strictObject({ schemaVersion: z.literal(1) });
const emptyIdentity = createHash('sha256').update('').digest('hex');
export const SelectionSchema = z.strictObject({ schemaVersion: z.literal(1), key: z.string(), identity: z.string().regex(/^[0-9a-f]{64}$/), prepared: z.boolean().optional() });
export type SessionSelection = z.infer<typeof SelectionSchema>;
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap { 'plugin:acn/session-binding': z.infer<typeof BindingSchema>; 'plugin:acn/team-selection': SessionSelection; 'plugin:acn/session-eligibility': z.infer<typeof EligibilitySchema> }
}
// 身份随宿主会话日志持久化和继承；缓存只避免每次门禁重新扫描历史。
const bindings = new WeakMap<SessionHeader, string | null>();
export const identityOf = (config: ResolvedConfig): string => createHash('sha256').update(config.agentId === '' ? '' : agentHomePath(config.home, config.agentId, activeUpstream(config))).digest('hex');
const selections = new WeakMap<SessionHeader, SessionSelection | undefined>();
// 配置插件重载可能保留宿主 Agent；正在运行的实例继续使用原客户端配置。
const runningConfigurations = new WeakMap<SessionHeader, ResolvedConfig>();
const activations = new WeakMap<SessionHeader, number>();
let activationSequence = 0;
export const configurationActivation = (header: SessionHeader): number => activations.get(header) ?? 0;
export function runningConfiguration(header: SessionHeader): ResolvedConfig | undefined { return runningConfigurations.get(header); }
export function rememberConfiguration(header: SessionHeader, config: ResolvedConfig): void { runningConfigurations.set(header, config); activations.set(header, ++activationSequence); }
export function forgetConfiguration(header: SessionHeader): void { runningConfigurations.delete(header); activations.delete(header); }
function decodeSelection(value: unknown): SessionSelection {
  const parsed = SelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : { schemaVersion: 1, key: 'invalid', identity: '0'.repeat(64) };
}
export function observeSelection(header: SessionHeader, event: SessionEvent): void {
  const record = pluginRecordOf(event);
  if (record?.type === 'plugin:acn/team-selection') selections.set(header, decodeSelection(record.data));
}
export function restoreSessionBinding(header: SessionHeader, events: readonly SessionEvent[]): void {
  const records = events.map(pluginRecordOf);
  const values = records.filter((record) => record?.type === 'plugin:acn/session-binding').map((record) => BindingSchema.safeParse(record?.data));
  const first = values[0]; bindings.set(header, first?.success && values.every((value) => value.success && value.data.identity === first.data.identity) ? first.data.identity : null);
  const selected = records.filter((record) => record?.type === 'plugin:acn/team-selection').at(-1);
  selections.set(header, selected === undefined ? undefined : decodeSelection(selected.data));
}
export function sessionSelection(ctx: Context, header: SessionHeader): SessionSelection | undefined {
  if (selections.has(header)) return selections.get(header);
  const records = ctx.sessions.get(header.id)?.snapshotEvents().map(pluginRecordOf).filter((record) => record?.type === 'plugin:acn/team-selection') ?? [];
  const last = records.at(-1);
  const value = last === undefined ? undefined : decodeSelection(last.data);
  selections.set(header, value); return value;
}

export function sessionHasWork(events: readonly SessionEvent[]): boolean {
  return events.some((event) => event.type === 'request/header' || event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'turn/start' || event.type === 'user/message' && event.data.source.kind === 'user');
}
export function sessionEligible(ctx: Context, header: SessionHeader, events = ctx.sessions.get(header.id)?.snapshotEvents()): boolean {
  return events?.some((event) => {
    const record = pluginRecordOf(event);
    // 兼容旧版在未配置时写入的空身份；它只证明创建时插件已安装，不授予知识权限。
    return record?.type === 'plugin:acn/session-eligibility' && EligibilitySchema.safeParse(record.data).success
      || record?.type === 'plugin:acn/session-binding' && BindingSchema.safeParse(record.data).data?.identity === emptyIdentity;
  }) ?? false;
}
export function markSessionEligible(ctx: Context, header: SessionHeader): void {
  const session = ctx.sessions.get(header.id);
  if (session === undefined || session.firstLiveSeq > 0 || header.isSeeded || header.parentSession !== undefined || sessionHasWork(session.snapshotEvents()) || sessionEligible(ctx, header)) return;
  appendPluginRecord(session, 'plugin:acn/session-eligibility', { schemaVersion: 1 });
}
export function sessionUnbound(ctx: Context, header: SessionHeader, events?: readonly SessionEvent[]): boolean {
  const seen = new Set<string>(); let current: SessionHeader | undefined = header;
  while (current !== undefined) {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    const history = current === header && events !== undefined ? events : ctx.sessions.get(current.id)?.snapshotEvents();
    if (history === undefined) return current !== header;
    for (const event of history) {
      const record = pluginRecordOf(event);
      if (record?.type === 'plugin:acn/team-selection') return false;
      if (record?.type === 'plugin:acn/session-binding' && BindingSchema.safeParse(record.data).data?.identity !== emptyIdentity) return false;
    }
    current = current.parentSession === undefined ? undefined : ctx.sessions.get(current.parentSession)?.header;
  }
  return true;
}

export function bindSession(ctx: Context, config: ResolvedConfig, header: SessionHeader): void {
  if (config.agentId === '') return;
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
  // 全新无 seed 的派生会话继承父会话选择，不能回退到基础身份。历史日志仍须自带记录。
  const parent = header.parentSession === undefined ? undefined : ctx.sessions.get(header.parentSession);
  const parentSelection = parent === undefined ? undefined : sessionSelection(ctx, parent.header);
  if (session.firstLiveSeq === 0 && sessionSelection(ctx, header) === undefined && parentSelection !== undefined) appendPluginRecord(session, 'plugin:acn/team-selection', parentSelection);
  // 没有持久身份的旧日志无法证明归属；不能因重启后配置不同而自动改绑。
  // 全新子会话未必继承日志；只允许从当前已验证身份的父会话建立绑定。
  const verifiedParent = parent !== undefined && sessionAllowed(ctx, config, parent.header);
  if (session.firstLiveSeq > 0 || !verifiedParent && (!sessionEligible(ctx, header) || sessionHasWork(session.snapshotEvents()) || header.parentSession !== undefined || header.isSeeded)) { bindings.set(header, null); return; }
  const identity = identityOf(config);
  bindings.set(header, identity);
  try { appendPluginRecord(session, 'plugin:acn/session-binding', { schemaVersion: 1, identity }); }
  catch (error) { bindings.set(header, null); throw error; }
}

export const sessionChanged = 'ACN 会话身份与当前配置不一致，或缺少可验证的历史身份记录，请新建会话。旧会话不能访问当前身份的知识。';
export const configurationBusy = 'ACN 配置正在应用，请稍后重试。';
export const unboundSession = '本会话未启用 ACN，聊天仍可继续。只有安装插件后新建且尚未发送消息的会话可选择工作配置；如需使用 ACN，请新建会话。';
export function sessionAllowed(ctx: Context, config: ResolvedConfig, header: SessionHeader): boolean {
  // 未配置时没有可暴露的 ACN 数据，不干预宿主原有会话。
  if (config.agentId === '') return true;
  if (config.team.routerEndpoint && !config.legacyEnabled) return false;
  const identity = identityOf(config);
  const selected = sessionSelection(ctx, header);
  // 显式选择已由空白会话门禁验证并持久化，允许宿主复用配置前创建的空白草稿。
  if (selected !== undefined) return selected.identity === identity;
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
