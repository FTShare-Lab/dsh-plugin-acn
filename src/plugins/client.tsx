// 网页入口只消费公开插件槽位与标准 Remote，不读取宿主密钥或文件。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { useEffect, useRef, useState } from 'react';
import { configurationRemote } from '../dsh-adapter/configuration-remote.js';
import { ConfigurationResultSchema, ConfigurationSnapshotSchema } from '../configuration.js';
import { TeamSettingsPage } from '../client/TeamSettingsPage.js';
import type { InteractionApi, SettingsTab } from '../client/TeamSettingsPage.js';
import { KnowledgePanel } from '../client/KnowledgePanel.js';
import { SessionToolbar } from '../client/SessionToolbar.js';
import { interactionStyles } from '../client/interaction-styles.js';
import { Modal } from '../client/interaction-ui.js';
import { InteractionResultSchema } from '../interaction.js';
import { en, zh } from '../client/locales.js';
import type { ConfigurationText } from '../client/locales.js';

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'acn.configuration': ConfigurationText } }
export const inject = ['slots', 'locale', 'remote'];
export async function apply(ctx: Context): Promise<void> {
  const remote = ctx.get('remote') as TypertClientRemote;
  const unmount = await remote.$mount(configurationRemote);
  ctx.effect(() => unmount);
  if (typeof document !== 'undefined') ctx.effect(() => {
    const sheet = document.createElement('style'); sheet.textContent = interactionStyles; document.head.append(sheet);
    return () => { sheet.remove(); };
  });
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
  const api: InteractionApi = {
    read: async (signal) => ConfigurationSnapshotSchema.parse(await invoke('acnConfiguration/read', {}, signal)),
    save: async (request) => ConfigurationResultSchema.parse(await invoke('acnConfiguration/save', { request })),
    interact: async (request, signal) => InteractionResultSchema.parse(await invoke('acnConfiguration/interact', { request }, signal)),
  };
  const t = ctx.locale.bind('acn.configuration');
  const c = (chinese: string, english: string) => t('title') === 'Configuration' ? english : chinese;
  const settingsTitle = () => c('ACN 插件设置', 'ACN settings');
  const closeLabel = () => c('关闭', 'Close');
  function openSource(id: string, close?: () => void) { const workspace = ctx.get('uiWorkspace'); if (workspace) { close?.(); workspace.openSession(id as SessionId); } }
  function SettingsEntry({ initialTab = 'personal', close }: { initialTab?: SettingsTab; close?: () => void }) {
    const [key, setKey] = useState<string>();
    const previous = useRef<HTMLElement | null>(null); const back = useRef<HTMLButtonElement>(null);
    useEffect(() => { if (key !== undefined) back.current?.focus(); else if (previous.current?.isConnected) previous.current.focus({ preventScroll: true }); }, [key]);
    return <><div hidden={key !== undefined}><TeamSettingsPage initialTab={initialTab} api={api} t={t} openKnowledge={(value) => { previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setKey(value); }} /></div>{key !== undefined && <>
      <button ref={back} type="button" className="acn-tab" onClick={() => { setKey(undefined); }}>{c('‹ 返回 ACN 插件设置', '‹ Back to ACN settings')}</button>
      <KnowledgePanel api={api} initialKey={key} c={c} openSource={(id) => { openSource(id, close); }} />
    </>}</>;
  }
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-plugin-acn', locale: 'acn.configuration',
  }, () => <SettingsEntry />)));
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'acn', order: 65, label: settingsTitle, locale: 'acn.configuration' }, ({ close }) => <SettingsEntry close={close} />)));
  void ctx.inject(['conversation'], (child) => {
    const block = (id: string, reason?: string) => { child.conversation.blocks.set(id as SessionId, reason === undefined ? undefined : { reason }); };
    function Toolbar(props: PropsRuntime<'conversation.input.left'>) { return <ToolbarSession key={props.sessionId} {...props} />; }
    function ToolbarSession(props: PropsRuntime<'conversation.input.left'>) {
      const [settings, setSettings] = useState<SettingsTab>(); const [knowledge, setKnowledge] = useState<{ key: string; activity: boolean }>();
      const title = c('知识与活动', 'Knowledge and activity');
      return <><SessionToolbar {...props} api={api} c={c} block={block} suppressed={settings !== undefined || knowledge !== undefined} openSettings={(tab = 'personal') => { setSettings(tab); }} openKnowledge={(key, activity = false) => { setKnowledge({ key, activity }); }} />
        {settings !== undefined && <Modal title={settingsTitle()} closeLabel={closeLabel()} close={() => { setSettings(undefined); }}><SettingsEntry initialTab={settings} close={() => { setSettings(undefined); }} /></Modal>}
        {knowledge && <Modal title={title} closeLabel={closeLabel()} close={() => { setKnowledge(undefined); }}><KnowledgePanel api={api} initialKey={knowledge.key} initialTab={knowledge.activity ? 'activity' : 'knowledge'} c={c} openSource={(id) => { openSource(id, () => { setKnowledge(undefined); }); }} /></Modal>}
      </>;
    }
    child.effect(() => child.slots.inject('conversation.input.left', () => child.slots.register({ name: 'conversation.input.left', id: 'acn', order: 50, locale: 'acn.configuration' }, Toolbar)));
  });
}
