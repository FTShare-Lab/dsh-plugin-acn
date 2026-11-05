// 配置写入交给宿主的 profile 锁、原子持久化和 Loader 重载，防止覆盖其他页面的修改。
import { createHash } from 'node:crypto';
import { messageInfo } from '../interaction-messages.js';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context, FiberState } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-config-editor';
import type {} from '@deepseek-ai/dsh-llm';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import { configurationBusy, runningConfiguration } from './session-binding.js';
import { ConfigError, resolveConfig } from '../config.js';
import { configurationValues, mergeConfiguration, SaveConfigurationSchema } from '../configuration.js';
import type { ConfigurationSnapshot, ConfigurationResult, ModelChoice, SaveConfiguration } from '../configuration.js';
import { AgentPaths, agentHomePath } from '../store/paths.js';
import { invalidStorageName } from '../store/path-names.js';
import { checkTeamConnection, executeInteraction } from './interaction-service.js';
import { upstreamsOf, resolveUpstream } from '../upstreams.js';
import { PendingUploadsSchema } from '../store/uploads.js';
import { withFileLock } from '../store/lock.js';
import { readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { z } from 'zod';
import type { InteractionRequest, InteractionResult } from '../interaction.js';
import { credentialReference } from './team-credentials.js';
import { CredentialRequestSchema } from '../credentials.js';
import type { CredentialRequest, CredentialResult } from '../credentials.js';

declare module '@deepseek-ai/cordis' { interface Context { acnConfiguration: ConfigurationService } }

export function configurationRevision(raw: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}
class ConfigurationBusy extends Error { readonly kind = 'configuration_busy'; }
class ConfigurationConflict extends Error { readonly kind = 'configuration_conflict'; }
// 该 const enum 没有运行时导出；数值与当前宿主 ACTIVE 状态一致。
const activeState = 2 as FiberState.ACTIVE;
function entryConfig(entry: Entry): Record<string, unknown> { return (entry.options.config ?? {}) as Record<string, unknown>; }

// 不提前创建知识文件；从目标目录向上找到现存目录，拒绝文件路径及明显的权限错误。
async function checkDirectory(path: string): Promise<void> {
  let current = path;
  for (;;) {
    try {
      if (!(await stat(current)).isDirectory()) throw new ConfigError(['home']);
      await access(current, constants.R_OK | constants.W_OK | constants.X_OK);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw new ConfigError(['home']);
      const parent = dirname(current);
      if (parent === current) throw new ConfigError(['home']);
      current = parent;
    }
  }
}

export class ConfigurationService extends TypertRemoteService {
  pending = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  // 仅回收本服务新建且从未采用的引用；重启后宁可保留，不能误删旧实例凭据。
  private readonly stagedCredentials = new Set<string>();
  private protectCredentials(raw: Record<string, unknown>): void {
    const config = resolveConfig(raw);
    this.stagedCredentials.delete(config.team.keyEnv);
    for (const item of Object.values(upstreamsOf(config))) this.stagedCredentials.delete(item.keyEnv);
  }
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail; let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release?.(); }
  }
  async credential(request: CredentialRequest, signal?: AbortSignal): Promise<CredentialResult> {
    const result = request.action !== 'check' ? await this.serialize(() => this.credentialOperation(request, signal)) : await this.credentialOperation(request, signal);
    return { ...result, messageInfo: result.messageInfo ?? messageInfo(result.message) };
  }
  private async credentialOperation(request: CredentialRequest, signal?: AbortSignal): Promise<CredentialResult> {
    const parsed = CredentialRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, message: '请检查团队配置，并填写有效的鉴权密钥。' };
    if (parsed.data.action === 'check') {
      try {
        // 草稿密钥只用于此次检查，不覆盖已保存的密钥或配置。
        const { connection, value } = parsed.data;
        return await checkTeamConnection(this.ctx, { ...connection, keyEnv: connection.keyEnv || 'ACN_TEAM_DRAFT' }, () => Promise.resolve(value), signal);
      } catch { return { ok: false, message: '检查未完成，请核对团队配置后重试。' }; }
    }
    const provider = this.ctx.get('credentials');
    if (provider === undefined) return { ok: false, message: '当前 DSH 未提供凭据托管，无法在此页保存新密钥。仍可输入临时密钥检查连接；保存新密钥需使用支持凭据托管的 DSH。已有环境变量引用可继续沿用，高级配置方法见插件配置文档。', writable: false };
    try {
      const reference = credentialReference(parsed.data.reference);
      if (parsed.data.action === 'discard') {
        if (!this.stagedCredentials.has(reference)) return { ok: false, message: '密钥已被配置或会话使用，保留现有凭据。' };
        const config = this.ctx.get('configEditor') === undefined ? this.ctx.get('acnRuntime')?.base.config : resolveConfig(entryConfig(this.entry()));
        const inUse = config !== undefined && (config.team.keyEnv === reference || Object.values(upstreamsOf(config)).some((item) => item.keyEnv === reference))
          || this.ctx.agents.list().some((agent) => runningConfiguration(agent.session.header)?.team.keyEnv === reference);
        if (inUse) { this.stagedCredentials.delete(reference); return { ok: false, message: '密钥已被配置或会话使用，保留现有凭据。' }; }
        await provider.unset(reference);
        this.stagedCredentials.delete(reference);
        return { ok: true, message: '' };
      }
      if (parsed.data.action === 'store') {
        const info = await provider.describe(reference);
        if (!info.writable) return { ok: false, message: '当前密钥存储只读，无法保存新密钥；仍可检查连接，或留空保留现有密钥。', configured: info.configured, writable: false };
        // 保存使用不可变的新引用，失败不能改变旧客户端或其他工作配置的密钥。
        if (info.configured) return { ok: false, message: '已有密钥引用不能覆盖，请重新输入并保存为新引用。' };
        await provider.set(reference, parsed.data.value);
        this.stagedCredentials.add(reference);
      }
      const info = await provider.describe(reference);
      return { ok: true, message: parsed.data.action === 'store' ? '凭据已保存到 DSH 托管存储，完成配置保存后，新启动的会话才会采用；已有会话保留原连接。' : '', configured: info.configured, writable: info.writable };
    } catch {
      this.ctx.logger.warn('Team credential operation could not complete.');
      return { ok: false, message: '凭据操作未完成，请检查宿主凭据服务后重试。' };
    }
  }
  async interact(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionResult> {
    if (this.pending > 0 && ['select', 'sync', 'retry', 'retry_delivery', 'dream_again'].includes(request.action)) return Promise.resolve({ ok: false, message: configurationBusy });
    // Gateway 调用会重绑定 Service tracker；领域实例必须从配置行自己的隔离作用域取。
    const pool = this.entry().fiber?.ctx.get('acnRuntime');
    const result = await executeInteraction(pool?.ctx ?? this.ctx, request, pool, signal);
    return { ...result, messageInfo: result.messageInfo ?? messageInfo(result.message), ...(result.session === undefined ? {} : { session: { ...result.session, messageInfo: messageInfo(result.session.message) } }) };
  }
  constructor(ctx: Context) {
    super(ctx, 'acnConfiguration');
    ctx.on('agent/created', () => { if (this.pending > 0) throw new Error(configurationBusy); });
    ctx.on('agent/pre-step', async (_event, next) => {
      if (this.pending > 0) throw new Error(configurationBusy);
      const decision = await next();
      if (this.pending > 0) throw new Error(configurationBusy);
      return decision;
    });
    ctx.tools.guard((execution) => this.pending > 0 && ['claim', 'consult_router', 'memory'].includes(execution.name) ? configurationBusy : undefined);
  }

  private checkIdle(): void {
    if (this.ctx.agents.list().some((agent) => agent.status === 'running') || this.entry().fiber?.ctx.acnRuntime.preparing) throw new ConfigurationBusy();
  }

  private entry(): Entry {
    const rows = this.ctx.configEditor.entries().filter((entry) => entry.options.id === 'acn-knowledge' && entry.options.name === '@ftai/dsh-plugin-acn/knowledge');
    const entry = rows.length === 1 ? rows[0] : undefined;
    if (entry === undefined) throw new ConfigError(['acn-knowledge']);
    return entry;
  }

  private async models(): Promise<ModelChoice[]> {
    const groups = await Promise.all(this.ctx.llm.listProviders().map(async (provider) => {
      // 一个失效的 provider 不应阻止用户改选其他已注册模型。
      try { return (await this.ctx.llm.listModels(provider.id)).map((model) => ({ provider: provider.id, providerName: provider.name, id: model.id, name: model.name })); }
      catch { return []; }
    }));
    return groups.flat();
  }

  async read(): Promise<ConfigurationSnapshot> {
    const models = await this.models();
    const entry = this.entry();
    const raw = entryConfig(entry);
    const values = configurationValues(raw);
    const config = resolveConfig(raw);
    const upstreamPending: Record<string, number | null> = {};
    for (const key of Object.keys(upstreamsOf(config))) {
      try {
        const selected = resolveUpstream(config, key, true); if (selected === undefined) continue;
        const path = new AgentPaths(agentHomePath(selected.home, selected.agentId)).pendingUploads;
        const pending = await readYamlOr(path, PendingUploadsSchema, () => PendingUploadsSchema.parse({}));
        upstreamPending[key] = pending.claims.length + pending.disputes.length + (pending.consolidations?.length ?? 0) + (pending.acknowledgements?.length ?? 0);
      } catch { upstreamPending[key] = null; this.ctx.logger.warn('Could not read pending counts for an upstream; configuration remains available.'); }
    }
    let dataDirectory = '';
    try { const selected = config.upstreams === undefined ? config : resolveUpstream(config, config.upstream); dataDirectory = selected?.agentId ? agentHomePath(selected.home, selected.agentId) : ''; }
    catch { this.ctx.logger.warn('Could not resolve the selected data directory; configuration remains available.'); }
    return { revision: configurationRevision(raw), values, models, active: entry.fiber?.state === activeState, dataDirectory, upstreamPending };
  }

  save(request: SaveConfiguration): Promise<ConfigurationResult> {
    return this.serialize(() => this.saveOperation(request));
  }
  private async saveOperation(request: SaveConfiguration): Promise<ConfigurationResult> {
    const parsed = SaveConfigurationSchema.safeParse(request);
    if (!parsed.success) return { ok: false, code: 'invalid', fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))] };
    const { revision, values } = parsed.data;
    try {
      const entry = this.entry();
      this.protectCredentials(entryConfig(entry));
      if (configurationRevision(entryConfig(entry)) !== revision) return { ok: false, code: 'conflict', fields: [] };
      if (values.upstreams === undefined && values.agentId === '') throw new ConfigError(['agentId']);
      if (values.mode === 'team' && (!values.routerEndpoint || !values.maintainerEndpoint)) throw new ConfigError(['team']);
      const previous = configurationValues(entryConfig(entry));
      const candidate = resolveConfig(mergeConfiguration(entryConfig(entry), values));
      const enabled = Object.entries(upstreamsOf(candidate)).filter(([, item]) => item.enabled);
      const names = enabled.flatMap(([key, item]) => [key, item.agentId, item.legacyKey ?? '']);
      if (names.some((name) => invalidStorageName(name))) return { ok: false, code: 'invalid', fields: ['windowsStorageName'] };
      await checkDirectory(agentHomePath(candidate.home, 'example'));
      for (const [key] of enabled) { const selected = resolveUpstream(candidate, key); if (selected !== undefined) await checkDirectory(agentHomePath(selected.home, selected.agentId)); }
      if (values.upstreams !== undefined && previous.upstreams === undefined && (previous.agentId !== '' || (previous.connections?.length ?? 0) > 0)) {
        const backup = join(dirname(dirname(agentHomePath(previous.home, 'example'))), 'upstream-migration-v1.yaml');
        await withFileLock(`${backup}.lock`, async () => {
          if (await readYamlOr(backup, z.unknown(), () => null) === null) await writeYamlAtomic(backup, entryConfig(entry), z.unknown(), this.ctx.logger);
        });
      }
      if (values.provider !== '' && !(await this.models()).some((model) => model.provider === values.provider && model.id === values.model)) {
        return { ok: false, code: 'unavailable', fields: ['llm'] };
      }
      this.checkIdle();
      this.pending += 1;
      let conflict = false;
      const identity = (value: typeof previous) => value.upstreams !== undefined || value.agentId === '' ? '' : agentHomePath(value.home, value.agentId);
      const epoch = () => Math.max(Date.now(), ...this.ctx.agents.list().map((agent) => agent.session.header.createdAt));
      try { await this.ctx.configEditor.edit(entry, (current) => {
        // 宿主获取文件锁并重读外部修改后再次检查，防止两个窗口互相覆盖。
        if (configurationRevision(current) !== revision) {
          // 宿主在回调前已重载磁盘值。保留外部修改，并持久阻止旧会话在重启后改绑身份。
          if (identity(configurationValues(current)) === identity(previous)) throw new ConfigurationConflict();
          conflict = true;
          return { ...current, sessionEpoch: epoch() };
        }
        this.checkIdle();
        const next = mergeConfiguration(current, values);
        // 在交给持久化之前停止回收；即使响应失败，也可能已经落盘。
        this.protectCredentials(next);
        if (values.upstreams === undefined && identity(previous) !== identity(values)) next.sessionEpoch = epoch();
        return next;
      }); } finally { this.pending -= 1; }
      if (conflict) return { ok: false, code: 'conflict', fields: [] };
      if (entry.fiber?.state !== activeState) return { ok: false, code: 'inactive', fields: [] };
      return { ok: true, snapshot: await this.read() };
    } catch (error) {
      if (error instanceof ConfigurationBusy) return { ok: false, code: 'busy', fields: [] };
      if (error instanceof ConfigurationConflict) return { ok: false, code: 'conflict', fields: [] };
      if (error instanceof ConfigError) return { ok: false, code: 'invalid', fields: [...error.fields] };
      // Loader 和文件系统的异常可能包含私有路径或底层配置，不传给浏览器或日志。
      this.ctx.logger.warn('ACN configuration could not be applied through the profile editor.');
      return { ok: false, code: 'persistence', fields: [] };
    }
  }
}
