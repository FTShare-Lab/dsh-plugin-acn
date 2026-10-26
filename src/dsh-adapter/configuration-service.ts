// 配置写入交给宿主的 profile 锁、原子持久化和 Loader 重载，防止覆盖其他页面的修改。
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import type { Context, FiberState } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-config-editor';
import type {} from '@deepseek-ai/dsh-llm';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import { configurationBusy } from './session-binding.js';
import { ConfigError } from '../config.js';
import { configurationValues, mergeConfiguration, SaveConfigurationSchema } from '../configuration.js';
import type { ConfigurationSnapshot, ConfigurationResult, ModelChoice, SaveConfiguration } from '../configuration.js';
import { agentHomePath } from '../store/paths.js';

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
    if (this.ctx.agents.list().some((agent) => agent.status === 'running')) throw new ConfigurationBusy();
  }

  private entry(): Entry {
    const rows = this.ctx.configEditor.entries().filter((entry) => entry.options.id === 'acn-knowledge' && entry.options.name === 'dsh-plugin-acn/knowledge');
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
    return { revision: configurationRevision(raw), values, models, active: entry.fiber?.state === activeState, dataDirectory: values.agentId === '' ? '' : agentHomePath(values.home, values.agentId) };
  }

  async save(request: SaveConfiguration): Promise<ConfigurationResult> {
    const parsed = SaveConfigurationSchema.safeParse(request);
    if (!parsed.success) return { ok: false, code: 'invalid', fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))] };
    const { revision, values } = parsed.data;
    try {
      const entry = this.entry();
      if (configurationRevision(entryConfig(entry)) !== revision) return { ok: false, code: 'conflict', fields: [] };
      if (values.agentId === '') throw new ConfigError(['agentId']);
      if (values.mode === 'team' && (!values.routerEndpoint || !values.maintainerEndpoint)) throw new ConfigError(['team']);
      const previous = configurationValues(entryConfig(entry));
      mergeConfiguration(entryConfig(entry), values);
      await checkDirectory(agentHomePath(values.home, values.agentId));
      if (values.provider !== '' && !(await this.models()).some((model) => model.provider === values.provider && model.id === values.model)) {
        return { ok: false, code: 'unavailable', fields: ['llm'] };
      }
      this.checkIdle();
      this.pending += 1;
      let conflict = false;
      const identity = (value: typeof previous) => value.agentId === '' ? '' : agentHomePath(value.home, value.agentId);
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
        if (identity(previous) !== identity(values)) next.sessionEpoch = epoch();
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
