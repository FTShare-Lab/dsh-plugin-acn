// 网页入口只消费公开插件槽位与标准 Remote，不读取宿主密钥或文件。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { configurationRemote } from '../dsh-adapter/configuration-remote.js';
import { ConfigurationResultSchema, ConfigurationSnapshotSchema } from '../configuration.js';
import { ConfigurationPage } from '../client/ConfigurationPage.js';
import type { ConfigurationApi } from '../client/ConfigurationPage.js';
import { en, zh } from '../client/locales.js';
import type { ConfigurationText } from '../client/locales.js';

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'acn.configuration': ConfigurationText } }
export const inject = ['slots', 'locale', 'remote'];
export async function apply(ctx: Context): Promise<void> {
  const remote = ctx.get('remote') as TypertClientRemote;
  const unmount = await remote.$mount(configurationRemote);
  ctx.effect(() => unmount);
  ctx.effect(() => ctx.locale.register('acn.configuration', { en, zh }));
  // 命名空间在 mount 后才存在，必须在子作用域声明注入；只注入 remote 根服务不够。
  void ctx.inject(['remote.acnConfiguration'], (child) => { registerPage(child); });
}
function registerPage(ctx: Context): void {
  const remote = ctx.get('remote') as TypertClientRemote;
  async function invoke(endpoint: string, input: object, signal?: AbortSignal): Promise<unknown> {
    const method = configurationRemote.methods[endpoint];
    if (method === undefined || method.mode === 'stream') throw new Error('ACN configuration endpoint unavailable.');
    const result = await method.invoke(remote, input, signal);
    if (!result.ok) throw new Error('ACN configuration request failed.');
    return result.value;
  }
  const api: ConfigurationApi = {
    read: async (signal) => ConfigurationSnapshotSchema.parse(await invoke('acnConfiguration/read', {}, signal)),
    save: async (request) => ConfigurationResultSchema.parse(await invoke('acnConfiguration/save', { request })),
  };
  const t = ctx.locale.bind('acn.configuration');
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-plugin-acn', locale: 'acn.configuration',
  }, () => <ConfigurationPage api={api} t={t} />)));
}
