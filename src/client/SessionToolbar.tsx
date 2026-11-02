// 会话工具栏显示固定归属、收件准备与修复入口；仅来源会话显示新产生的结果。
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { InteractionApi } from './TeamSettingsPage.js';
import type { Activity, InteractionRequest, SessionView } from '../interaction.js';
import { ComposerMenu, Icon, MenuItem, Notice } from './ComposerMenu.js';
import type { SettingsTab } from './TeamSettingsPage.js';
import type { Copy } from './interaction-ui.js';
import { configurationLabel } from './interaction-ui.js';
type Props = Pick<PropsRuntime<'conversation.input.left'>, 'sessionId' | 'useSession'> & {
  api: InteractionApi; c: Copy; block: (id: string, reason?: string) => void;
  openSettings: (tab?: SettingsTab) => void; openKnowledge: (key: string, activity?: boolean) => void;
  suppressed?: boolean;
};
export const composerBlockReason = (view: SessionView): string | undefined => !view.available || view.phase === 'blocked' || view.phase === 'syncing' && view.needsPreparation ? view.message || '等待首次团队收件同步完成。' : undefined;
// 读取不会改变草稿选择，也不会触发同步；归属由持久绑定和默认配置决定。
async function readDraft(api: InteractionApi, sessionId: string, _c: Copy, signal?: AbortSignal) {
  return api.interact({ action: 'session', sessionId }, signal);
}
export function SessionToolbar(props: Props) {
  const subagent = props.useSession((session: { subagent: unknown }) => session.subagent !== null);
  return subagent ? null : <SessionControls key={props.sessionId} {...props} />;
}
function SessionControls({ api, c, block, openSettings, openKnowledge, sessionId, useSession, suppressed = false }: Props) {
  const running = useSession((session: { running: boolean }) => session.running);
  const anchor = useRef<HTMLButtonElement>(null); const menuId = useId();
  const close = useCallback(() => { setMenu(false); }, []);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<{ text: string; failed: boolean }>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => { if (notice === undefined) return; const timer = setTimeout(() => { setNotice(undefined); }, notice.failed ? 9000 : 5000); return () => { clearTimeout(timer); }; }, [notice]);
  const [view, setView] = useState<SessionView>(); const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attention, setAttention] = useState<{ key: string; count: number }>(); const [completion, setCompletion] = useState<Activity & { runtimeKey: string }>();
  const [visible, setVisible] = useState(document.visibilityState === 'visible' && document.hasFocus());
  const [inDialog, setInDialog] = useState(false);
  const seen = useRef(new Set<string>());
  const generation = useRef(0);
  const mutation = useRef(0);
  useEffect(() => { const update = () => { setVisible(document.visibilityState === 'visible' && document.hasFocus()); }; const dialogFocus = () => { setInDialog(Boolean(document.activeElement?.closest('[role="dialog"], dialog[open]'))); }; dialogFocus();
    document.addEventListener('focusin', dialogFocus); window.addEventListener('focus', update); window.addEventListener('blur', update); document.addEventListener('visibilitychange', update); return () => { document.removeEventListener('focusin', dialogFocus); window.removeEventListener('focus', update); window.removeEventListener('blur', update); document.removeEventListener('visibilitychange', update); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); const current = ++generation.current;
    block(sessionId, c('正在读取知识归属…', 'Loading knowledge binding…'));
    async function load() {
      const result = await readDraft(api, sessionId, c, controller.signal);
      if (controller.signal.aborted || generation.current !== current) return;
      if (!result.ok || result.session === undefined) { fail(result.message); return; }
      setView(result.session); block(sessionId, composerBlockReason(result.session));
    }
    function fail(message: string) {
      setLoadError(message || c('知识服务暂不可用。', 'Knowledge service unavailable.'));
      block(sessionId, c('无法读取 ACN 状态，请打开 ACN 菜单重试。', 'Cannot read ACN status. Open the ACN menu to retry.'));
    }
    void load().catch(() => { if (!controller.signal.aborted) fail(c('知识服务暂不可用，请重试。', 'Knowledge service is unavailable. Retry.')); });
    return () => { controller.abort(); generation.current += 1; block(sessionId); };
  }, [api, sessionId, block, c]);
  useEffect(() => {
    if (view === undefined) return;
    const controller = new AbortController(); let active = false;
    async function poll() {
      if (active || controller.signal.aborted || !visible) return; active = true;
      const version = mutation.current;
      try {
        const result = await api.interact({ action: 'session', sessionId }, controller.signal);
        if (controller.signal.aborted || mutation.current !== version) return;
        if (result.session === undefined) return;
        // 首发准备中的旧读结果不能提前放行；仍显示正在同步，允许取消等待。
        if (inFlight.current && result.session.phase !== 'syncing') return;
        setView(result.session); block(sessionId, composerBlockReason(result.session));
        if (result.session.key !== view?.key || !result.session.choices.some((item) => item.key === result.session?.key && item.agentId)) return;
        const knowledge = await api.interact({ action: 'activity', key: view?.key ?? 'personal' }, controller.signal);
        if (controller.signal.aborted || mutation.current !== version || knowledge.knowledge === undefined) return;
        const data = knowledge.knowledge;
        setAttention({ key: data.key, count: data.pendingClaims + data.pendingDisputes + data.activities.filter((item) => item.state === 'failed' || item.state === 'paused').length });
        const item = data.activities.find((activity) => activity.sessionId === sessionId && activity.unseen && ['succeeded', 'failed'].includes(activity.state) && !seen.current.has(`${data.key}:${activity.id}:${activity.updatedAt}`));
        if (item !== undefined && view?.showCompletion !== false) setCompletion({ ...item, runtimeKey: data.key });
      } catch { /* 轮询失败不撤销已验证的归属；显式同步和活动页提供重试。 */ }
      finally { active = false; }
    }
    void poll(); const timer = setInterval(() => { void poll(); }, 2500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, sessionId, view?.key, view?.showCompletion, visible, block]);
  const showCompletion = visible && !inDialog && completion?.runtimeKey === view?.key && !suppressed && !menu && notice === undefined && view?.showCompletion === true;
  useEffect(() => {
    if (completion === undefined || !showCompletion) return;
    let second = 0; const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { seen.current.add(`${completion.runtimeKey}:${completion.id}:${completion.updatedAt}`); void api.interact({ action: 'ack', key: completion.runtimeKey, id: completion.id, version: completion.updatedAt }).catch(() => { seen.current.delete(`${completion.runtimeKey}:${completion.id}:${completion.updatedAt}`); }); }); });
    const timer = setTimeout(() => { setCompletion(undefined); }, 5000);
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); clearTimeout(timer); };
  }, [api, completion, showCompletion, view?.key]);
  async function action(request: InteractionRequest) {
    const token = generation.current;
    const version = ++mutation.current;
    inFlight.current = true; setBusy(true); setNotice(undefined);
    if (request.action === 'select' || request.action === 'sync' && view?.needsPreparation) block(sessionId, c('正在准备团队知识…', 'Preparing team knowledge…'));
    try {
      const result = request.action === 'session' ? await readDraft(api, sessionId, c) : await api.interact(request);
      if (generation.current !== token || mutation.current !== version) return;
      if (result.session !== undefined) {
        setView(result.session); setLoadError(''); block(sessionId, composerBlockReason(result.session));
        if (result.session.key !== view?.key) { setAttention(undefined); setCompletion(undefined); }
      }
      const text = result.message || (request.action !== 'session' ? result.session?.message : '');
      if (text) setNotice({ text, failed: !result.ok || result.session?.phase === 'failed' || result.session?.phase === 'blocked' });
      if (!result.ok && view === undefined) setLoadError(result.message);
    } catch {
      if (generation.current === token && mutation.current === version) {
        const text = c('无法确认操作结果，请重新读取状态。', 'Could not confirm the result. Reload the status.');
        setNotice({ text, failed: true }); if (!view) setLoadError(text);
      }
    } finally { if (generation.current === token && mutation.current === version) { inFlight.current = false; setBusy(false); } }
  }
  const selected = view?.choices.find((item) => item.key === view.key);
  const pending = attention && attention.key === view?.key ? attention.count : 0;
  const configured = Boolean(selected?.agentId);
  const team = (view?.activeMode ?? selected?.mode) === 'team';
  const choices = view?.choices.filter((item) => item.enabled && item.agentId) ?? [];
  const trouble = Boolean(loadError || view?.phase === 'failed' || view?.phase === 'blocked');
  const syncing = view?.phase === 'syncing';
  const name = view?.name || c('选择工作配置', 'Choose configuration');
  const title = c('ACN 记忆与知识', 'ACN memory and knowledge');
  const label = title + ' · ' + name;
  const settingsLabel = c('ACN 插件设置', 'ACN settings');
  const finishMenu = (work: () => void) => { anchor.current?.focus(); close(); work(); };
  const choose = (request: InteractionRequest) => { finishMenu(() => { void action(request); }); };
  return <>
    <button type="button" ref={anchor} className="acn-trigger" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={menu} aria-controls={menu ? menuId : undefined} onClick={() => { setMenu(!menu); }} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenu(true); } }}>
      <span className="acn-mark" data-state={trouble ? 'warning' : syncing || pending > 0 ? 'activity' : team ? 'team' : undefined}><Icon name="network" /></span><span className="acn-short-label">ACN · {name}</span><span className="acn-chevron"><Icon name="chevron" size={11} /></span>
    </button>
    {menu && <ComposerMenu anchor={anchor} id={menuId} label={title} close={close}>
      <p>{c('当前会话', 'Current session')} · <strong>{name}</strong>{view?.locked && c('（已固定）', ' (fixed)')}</p>
      {loadError && <><p role="alert">{loadError}</p><MenuItem icon="sync" disabled={busy} onClick={() => { choose({ action: 'session', sessionId }); }}>{c('重试读取状态', 'Reload status')}</MenuItem></>}
      {selected && <p>Agent ID · {selected.agentId} · {team ? c('团队', 'Team') : c('单人', 'Solo')}</p>}
      {(trouble || syncing || view?.configurationChanged) && view?.message && <p role={trouble ? 'alert' : 'status'}>{view.message}</p>}
      {syncing && <MenuItem icon="close" onClick={() => { choose({ action: 'cancel', sessionId }); }}>{c('取消等待', 'Cancel waiting')}</MenuItem>}
      {view && !view.locked && choices.length > 0 && <>
        {view.choices.filter((item) => item.enabled && item.agentId).map((item) => <MenuItem key={item.key} icon={view.key === item.key ? 'check' : item.mode === 'solo' ? 'user' : 'network'} role="menuitemradio" aria-checked={view.key === item.key} disabled={busy || running || syncing} onClick={() => { if (view.key === item.key) { anchor.current?.focus(); close(); } else choose({ action: 'select', sessionId, key: item.key }); }}>{configurationLabel(item.name, item.agentId)}{item.key === view.defaultConnection && <small>{c('全局默认', 'Global default')}</small>}</MenuItem>)}
        <hr className="acn-separator" />
      </>}
      {view?.configurationChanged && !view.locked && <MenuItem icon="sync" disabled={busy || running || syncing} onClick={() => { choose({ action: 'select', sessionId, key: view.key }); }}>{c('按已保存配置启动', 'Start with saved configuration')}</MenuItem>}
      {configured && <MenuItem icon="book" onClick={() => { finishMenu(() => { openKnowledge(view?.key ?? 'personal'); }); }}>{c('知识与活动', 'Knowledge and activity')}{pending > 0 && <small>{pending} {c('项待处理', 'need attention')}</small>}</MenuItem>}
      {configured && view?.available && <MenuItem icon="recap" disabled={busy || running || syncing || view.needsPreparation} onClick={() => { choose({ action: 'recap', sessionId }); }}>{c('复盘本次会话', 'Recap session')}</MenuItem>}
      {team && view?.available && !syncing && <MenuItem icon="sync" disabled={busy || running} onClick={() => { choose({ action: 'sync', sessionId }); }}>{view.phase === 'failed' ? c('重试同步', 'Retry sync') : c('同步收件', 'Sync Inbox')}</MenuItem>}
      {!configured && !team && !loadError && view && <p>{c('在插件设置中新建工作配置，填写 Agent ID 后即可使用。', 'Create a work configuration with an Agent ID in ACN settings.')}</p>}
      <hr className="acn-separator" /><MenuItem icon="settings" onClick={() => { finishMenu(() => { openSettings(team && trouble ? 'upstreams' : undefined); }); }}>{settingsLabel}</MenuItem>
    </ComposerMenu>}
    {notice && !suppressed && <Notice c={c} failed={notice.failed} close={() => { setNotice(undefined); }}>{notice.text}</Notice>}
    {completion && showCompletion && <Notice c={c} failed={completion.state === 'failed'} close={() => { setCompletion(undefined); }}><strong>{completion.kind} · {completion.state === 'failed' ? c('未完成', 'Incomplete') : c('本地处理完成', 'Local processing complete')}</strong><p>{completion.error ?? completion.summary}</p><button type="button" className="acn-tab" onClick={() => { openKnowledge(view?.key ?? 'personal', true); setCompletion(undefined); }}>{c('查看处理活动', 'View activity')}</button></Notice>}
  </>;
}
