// 工作配置统一管理单人身份与团队服务；编辑草稿、连接检查和保存互相独立。
import { displayMessage } from '../interaction-messages.js';
import { AdvancedPreferences } from './AdvancedPreferences.js';
import { advancedConfiguration } from '../advanced-configuration.js';
import { configurationFieldError } from './configuration-errors.js';
import { useEffect, useRef, useState } from 'react';
import type { ConfigurationApi } from './ConfigurationPage.js';
import type { ConfigurationSnapshot, ConfigurationValues } from '../configuration.js';
import { resolveConfig, UpstreamNameSchema, UpstreamSchema, upstreamsOf } from '../config.js';
import type { Upstream } from '../config.js';
import type { InteractionRequest, InteractionResult } from '../interaction.js';
import type { CredentialRequest, CredentialResult } from '../credentials.js';
import { TeamCredentialField } from './TeamCredentialField.js';
import { ConnectionCheckDialog } from './ConnectionCheckDialog.js';
import type { ConnectionCheckResult } from './ConnectionCheckDialog.js';
import { SettingsToast } from './SettingsToast.js';
import { KnowledgeDirectoryField } from './KnowledgeDirectoryField.js';
import type { ConfigurationText } from './locales.js';
import { Button, Modal, Row, Select, Tabs, inputStyle, muted } from './interaction-ui.js';
export interface InteractionApi extends ConfigurationApi { interact: (request: InteractionRequest, signal?: AbortSignal) => Promise<InteractionResult>; credential?: (request: CredentialRequest, signal?: AbortSignal) => Promise<CredentialResult>; pickDirectory?: () => Promise<string | null> }
export type SettingsTab = 'upstreams' | 'knowledge' | 'preferences';
export interface TeamSettingsProps { api: InteractionApi; t: (key: ConfigurationText) => string; openKnowledge: (key: string) => void; initialTab?: SettingsTab; openPlugins?: (() => void) | undefined }
type Draft = { key: string; existing: boolean; team: boolean; defaultChoice: boolean; value: Omit<Upstream, 'agentId'> & { agentId: string }; secret: string; reference: string; credentialIdentity: string; removeSecret: boolean; base?: Upstream; connectionConflict?: Upstream; pendingReference?: string; pendingValue?: string };
// 引用名属于存储接口；新配置自动分配，避免不同 upstream 意外共用密钥。
const newCredentialReference = () => `ACN_TEAM_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
export function settingsUpstreams(values: ConfigurationValues) {
  return upstreamsOf(resolveConfig({ agentId: values.agentId, home: values.home, team: { routerEndpoint: values.routerEndpoint, maintainerEndpoint: values.maintainerEndpoint, keyEnv: values.keyEnv, timeoutMs: values.timeoutMs }, connections: values.connections, legacyEnabled: values.legacyEnabled, upstreams: values.upstreams, upstream: values.upstream }));
}
export function TeamSettingsPage({ api, t, openKnowledge, initialTab = 'upstreams', openPlugins }: TeamSettingsProps) {
  const c = (zh: string, en: string) => t('title') === 'Configuration' ? en : zh;
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>();
  const [editor, setEditor] = useState<Draft>(); const [home, setHome] = useState('');
  const profileTop = useRef<HTMLDivElement>(null); const previousEditor = useRef(false);
  const editing = editor !== undefined;
  useEffect(() => { if (previousEditor.current !== editing) profileTop.current?.scrollIntoView?.({ block: 'start' }); previousEditor.current = editing; }, [editing]);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState(false);
  const [notice, setNotice] = useState<{ id: number; text: string }>(); const noticeSequence = useRef(0);
  const [defaultConfirm, setDefaultConfirm] = useState<{ from: string; to: string }>();
  const confirmedSaveRejection = useRef(false); const stagedReference = useRef<string>();
  useEffect(() => { const previous = stagedReference.current; stagedReference.current = editor?.pendingReference; if (previous && previous !== editor?.pendingReference) void api.credential?.({ action: 'discard', reference: previous }).catch(() => undefined); }, [api, editor?.pendingReference]);
  // 关闭面板不会取消已提交的异步保存；卸载时保留暂存引用，避免先删除再落盘。
  const [busy, setBusy] = useState(false); const [probing, setProbing] = useState(false);
  const [credentialRefresh, setCredentialRefresh] = useState(0);
  const [checkResult, setCheckResult] = useState<ConnectionCheckResult>(); const probe = useRef<AbortController>();
  const feedback = (text: string, failed = false) => { setMessage(failed ? text : ''); setError(failed); setNotice(text && !failed ? { id: ++noticeSequence.current, text } : undefined); };
  const checkInput = editor === undefined ? undefined : JSON.stringify([editor.value.agentId, editor.team, editor.value.routerEndpoint, editor.value.maintainerEndpoint, editor.value.timeoutMs, editor.value.keyEnv, editor.secret, editor.removeSecret]);
  useEffect(() => { if (checkInput !== undefined) { setCheckResult(undefined); setMessage(''); setError(false); setNotice(undefined); } }, [checkInput]);
  useEffect(() => { const controller = new AbortController(); void api.read(controller.signal).then((value) => { if (!controller.signal.aborted) { setSnapshot(value); setHome(value.values.home); } }, () => { if (!controller.signal.aborted) { setMessage(t('errorLoad')); setError(true); } }); return () => { controller.abort(); probe.current?.abort(); }; }, [api, t]);
  async function persist(values: ConfigurationValues, keyStaged = false): Promise<boolean> {
    if (snapshot === undefined) return false;
    setBusy(true); confirmedSaveRejection.current = false;
    try {
      // 首次建身份前也能保存知识目录和模型，避免必须先向默认目录写入数据。
      const next = values.upstreams === undefined && values.agentId === '' && (values.connections?.length ?? 0) === 0 ? { ...values, upstreams: {}, upstream: '' } : values;
      const result = await api.save({ revision: snapshot.revision, values: next });
      if (!result.ok) { confirmedSaveRejection.current = ['busy', 'conflict', 'invalid', 'unavailable'].includes(result.code); setConflict(['conflict', 'persistence', 'inactive'].includes(result.code)); const keyMessage = keyStaged && confirmedSaveRejection.current ? c('本次密钥替换尚未生效，输入已保留。', 'The key replacement has not taken effect; your input is retained. ') : ''; feedback(keyMessage + t(result.code === 'inactive' ? 'activation' : result.code) + (result.code === 'invalid' ? '\n' + result.fields.map((field) => configurationFieldError(field, c)).join('\n') : ''), true); return false; }
      setConflict(false); setSnapshot(result.snapshot); setHome((draft) => draft === snapshot.values.home || draft === values.home ? result.snapshot.values.home : draft);
      feedback(keyStaged ? c('配置与团队鉴权密钥已保存。', 'Configuration and team authentication key saved.') : c('已保存。', 'Saved.')); return true;
    } catch { setConflict(true); feedback(t('errorTransport'), true); return false; } finally { setBusy(false); }
  }
  async function retryLoad() {
    setBusy(true);
    try { const value = await api.read(); setSnapshot(value); setHome(value.values.home); feedback(''); }
    catch { feedback(t('errorLoad'), true); } finally { setBusy(false); }
  }
  async function refreshDraft() {
    if (snapshot === undefined) return;
    setBusy(true);
    try {
      const current = await api.read(); const remote = settingsUpstreams(current.values);
      const occupied = editor !== undefined && !editor.existing && editor.base !== undefined && remote[editor.key] !== undefined && JSON.stringify(remote[editor.key]) !== JSON.stringify(editor.base);
      if (editor?.base !== undefined && remote[editor.key] !== undefined && (editor.existing || JSON.stringify(remote[editor.key]) === JSON.stringify(editor.base))) {
        const latest = remote[editor.key];
        if (latest !== undefined) {
          const group = (value: Pick<Upstream, 'routerEndpoint' | 'maintainerEndpoint' | 'keyEnv'> & { agentId: string }) => JSON.stringify([value.agentId, Boolean(value.routerEndpoint), value.routerEndpoint, value.maintainerEndpoint, value.keyEnv]);
          const local = { ...editor.value, routerEndpoint: editor.team ? editor.value.routerEndpoint : '', maintainerEndpoint: editor.team ? editor.value.maintainerEndpoint : '', keyEnv: editor.removeSecret ? '' : editor.secret !== '' && editor.pendingReference ? editor.pendingReference : editor.value.keyEnv };
          const localChanged = group(local) !== group(editor.base) || editor.secret !== '';
          const remoteChanged = group(latest) !== group(editor.base);
          const connection = localChanged ? local : latest;
          const merged = { ...latest, ...Object.fromEntries(Object.entries(editor.value).filter(([key, value]) => value !== editor.base?.[key as keyof Upstream])), agentId: connection.agentId, routerEndpoint: connection.routerEndpoint, maintainerEndpoint: connection.maintainerEndpoint, keyEnv: connection.keyEnv };
          const remoteDefault = current.values.upstream ?? (remote['personal'] === undefined ? '' : 'personal');
          // 默认开关未改动时跟随远端，避免仅修改名称就覆盖另一窗口的默认选择。
          const defaultChoice = editor.defaultChoice !== (defaultKey === editor.key) ? editor.defaultChoice : remoteDefault === editor.key;
          const next = { ...editor, existing: true, value: merged, base: latest, defaultChoice, team: Boolean(connection.routerEndpoint), reference: connection.keyEnv || newCredentialReference(), credentialIdentity: !localChanged || group(local) === group(latest) ? latest.agentId : editor.credentialIdentity };
          delete next.connectionConflict;
          if (localChanged && remoteChanged && group(local) !== group(latest)) next.connectionConflict = latest;
          setEditor(next);
        }
      }
      setHome((value) => value === snapshot.values.home ? current.values.home : value);
      setSnapshot(current); setConflict(false); setCheckResult(undefined);
      feedback(occupied ? c('该配置标识已被其他配置使用，草稿已保留。请展开「配置标识」更换后保存。', 'This configuration key is already in use. Your draft is retained; choose another Configuration key before saving.') : c('已刷新远端配置并保留你的修改，请核对后保存。', 'Latest configuration loaded and your edits retained. Review and save.'), occupied);
    } catch { feedback(t('errorLoad'), true); } finally { setBusy(false); }
  }
  async function chooseModel(value: string) {
    if (snapshot === undefined) return;
    const model = snapshot.models.find((item) => JSON.stringify([item.provider, item.id]) === value);
    const controller = new AbortController(); probe.current = controller; setProbing(true); feedback(c('正在检查模型…', 'Checking model…'));
    try {
      const result = await api.interact({ action: 'probe', provider: model?.provider ?? '', model: model?.id ?? '' }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) { feedback(displayMessage(result.message, c, result.messageInfo), true); return; }
      await persist({ ...snapshot.values, provider: model?.provider ?? '', model: model?.id ?? '' });
    } catch { if (!controller.signal.aborted) feedback(c('检查未完成，原模型保留。', 'Check failed; the previous model is retained.'), true); }
    finally { if (probe.current === controller) { probe.current = undefined; setProbing(false); } }
  }
  if (snapshot === undefined) return <div className="acn-page"><p role={error ? 'alert' : 'status'}>{message || t('loading')}</p>{error && <Button disabled={busy} onClick={() => { void retryLoad(); }}>{c('重试加载', 'Retry loading')}</Button>}</div>;
  const values = snapshot.values; const profiles = settingsUpstreams(values); const disabled = busy || probing;
  const defaultKey = values.upstream ?? (profiles['personal'] === undefined ? '' : 'personal');
  const withProfiles = (next: Record<string, Upstream>, upstream = defaultKey): ConfigurationValues => ({ ...values, upstreams: next, upstream });
  const cancelEditor = () => { probe.current?.abort(); setEditor(undefined); setCheckResult(undefined); feedback(''); };
  const add = () => { setEditor({ key: '', existing: false, team: true, defaultChoice: Object.keys(profiles).length === 0, secret: '', removeSecret: false, credentialIdentity: '', reference: newCredentialReference(), value: { name: '', agentId: '', enabled: true, routerEndpoint: '', maintainerEndpoint: '', keyEnv: '', timeoutMs: snapshot?.values.timeoutMs ?? 15000 } }); setCheckResult(undefined); feedback(''); };
  async function saveProfile(confirmedDefault = false) {
    if (editor === undefined) return;
    if (identityCredentialMismatch) { feedback(c('Agent ID 已改变，请填写新身份的团队鉴权密钥，或明确移除密钥绑定后保存。', 'The Agent ID changed. Enter the new identity’s team key, or explicitly remove the key binding before saving.'), true); return; }
    if (editor.connectionConflict) { feedback(c('请先选择保留哪一份团队连接。', 'Choose which team connection to retain first.'), true); return; }
    const reference = editor.secret === '' ? editor.reference : editor.pendingReference && editor.pendingValue === editor.secret ? editor.pendingReference : newCredentialReference();
    const parsed = UpstreamSchema.safeParse({ ...editor.value, name: editor.value.name.trim() || editor.value.agentId, routerEndpoint: editor.team ? editor.value.routerEndpoint.trim() : '', maintainerEndpoint: editor.team ? editor.value.maintainerEndpoint.trim() : '', keyEnv: editor.removeSecret || !editor.team && editor.credentialIdentity !== editor.value.agentId ? '' : editor.team && editor.secret !== '' ? reference : editor.value.keyEnv.trim() });
    let key = editor.key.trim() || editor.value.agentId;
    if (!editor.existing && editor.key.trim() === '') { let suffix = 2; while (profiles[key] !== undefined) key = `${editor.value.agentId}-${suffix++}`; }
    if (!parsed.success) { feedback([...new Set(parsed.error.issues.map((issue) => configurationFieldError(String(issue.path[0] ?? ''), c)))].join('\n'), true); return; }
    if (!UpstreamNameSchema.safeParse(key).success) { feedback(configurationFieldError('key', c), true); return; }
    if (!editor.existing && profiles[key] !== undefined) { feedback(c('配置标识已被使用，请更换后保存。', 'This configuration key is already in use. Choose another key.'), true); return; }
    const nextDefault = parsed.data.enabled && editor.defaultChoice ? key : defaultKey === key ? '' : defaultKey;
    if (nextDefault && defaultKey && nextDefault !== defaultKey && !confirmedDefault) { setDefaultConfirm({ from: profiles[defaultKey]?.name || defaultKey, to: parsed.data.name || key }); return; }
    const submitted = { ...editor, key, base: editor.base ?? parsed.data };
    setEditor(submitted);
    let staged = ''; let saved = false;
    setBusy(true);
    try {
      if (editor.team && editor.secret !== '') {
        if (api.credential === undefined) { feedback(c('密钥托管接口不可用，请更新或重新打开插件。', 'Key storage is unavailable; update or reopen the plugin.'), true); return; }
        setEditor({ ...submitted, pendingReference: reference, pendingValue: editor.secret });
        const existing = editor.pendingReference === reference ? await api.credential({ action: 'describe', reference }) : undefined;
        if (existing && !existing.ok) { feedback(displayMessage(existing.message, c, existing.messageInfo), true); return; }
        const result = existing?.configured ? existing : await api.credential({ action: 'store', reference, value: editor.secret });
        if (!result.ok) { feedback(displayMessage(result.message, c, result.messageInfo), true); return; }
        staged = reference;
      }
      saved = await persist(withProfiles({ ...profiles, [key]: parsed.data }, nextDefault), Boolean(staged));
      if (saved) { setEditor(undefined); setCheckResult(undefined); setCredentialRefresh((value) => value + 1); }
    } catch { feedback(c('无法确认密钥保存结果，配置未更新；请重新检查后保存。', 'Could not confirm the key save; configuration was not updated. Check and save again.'), true); }
    finally {
      // 未知保存结果交给服务端检查引用是否已被采用，不能删除已落盘配置使用的密钥。
      if (staged && !saved && confirmedSaveRejection.current) await api.credential?.({ action: 'discard', reference: staged }).catch(() => undefined);
      setBusy(false);
    }
  }
  async function checkProfile() {
    if (editor === undefined) return;
    const connection = { ...editor.value, routerEndpoint: editor.value.routerEndpoint.trim(), maintainerEndpoint: editor.value.maintainerEndpoint.trim(), keyEnv: editor.removeSecret ? '' : editor.value.keyEnv, name: editor.value.name || editor.value.agentId };
    const parsed = UpstreamSchema.safeParse(connection);
    // 与保存复用同一规则；格式错误不能进入 RPC 后变成“离线可保存”。
    if (!parsed.success || !connection.routerEndpoint || !connection.maintainerEndpoint) {
      const field = parsed.success ? undefined : parsed.error.issues[0]?.path[0];
      let message = c('请检查工作配置中的填写内容。', 'Check the values in this configuration.');
      if (field === 'agentId') message = configurationFieldError('agentId', c);
      else if (field === 'name') message = c('显示名称不能超过 80 个字符。', 'The display name must not exceed 80 characters.');
      else if (field === 'timeoutMs') message = c('团队请求超时必须为正整数，单位为毫秒。', 'Team request timeout must be a positive integer in milliseconds.');
      else if (field === 'maintainerEndpoint' || connection.routerEndpoint && !connection.maintainerEndpoint) message = c('请填写有效的 Maintainer 地址，以 http:// 或 https:// 开头；不能包含用户名、密码、查询参数或片段。', 'Enter a valid Maintainer URL starting with http:// or https://, without a username, password, query or fragment.');
      else if (field === 'routerEndpoint' || !connection.routerEndpoint) message = c('请填写有效的 Router 地址，以 http:// 或 https:// 开头；不能包含用户名、密码、查询参数或片段。', 'Enter a valid Router URL starting with http:// or https://, without a username, password, query or fragment.');
      setCheckResult(undefined); feedback(message, true); return;
    }
    const controller = new AbortController(); probe.current = controller; setProbing(true); setCheckResult(undefined); feedback('');
    try {
      const result = editor.secret === '' ? await api.interact({ action: 'check', connection: parsed.data }, controller.signal) : api.credential === undefined ? { ok: false, message: c('密钥检查接口不可用，请重新打开插件。', 'Key check is unavailable; reopen the plugin.') } : await api.credential({ action: 'check', connection: parsed.data, value: editor.secret }, controller.signal);
      if (!controller.signal.aborted) { setCheckResult({ checks: 'checks' in result ? result.checks : undefined, message: displayMessage(result.message, c, result.messageInfo), failed: !result.ok }); }
    }
    catch { if (!controller.signal.aborted) setCheckResult({ checks: undefined, message: c('未能完成连接检查，请稍后重试。本次检查不会保存配置，输入已保留。', 'The connection check could not complete. Retry later; this check does not save configuration, and your input is retained.'), failed: true }); }
    finally { if (probe.current === controller) { probe.current = undefined; setProbing(false); } }
  }
  const guide = <p style={muted}>{c('向团队管理员索取 Router、Maintainer 地址及成员凭据。尚未部署时，可参考原 ACN 仓库。', 'Ask your team administrator for Router and Maintainer URLs and a member credential, or deploy services using the original ACN repository.')} <a href="https://github.com/FTShare-Lab/agent-claim-network" target="_blank" rel="noopener noreferrer">{c('ACN 部署说明（GitHub）', 'ACN deployment guide (GitHub)')}</a></p>;
  const original = editor === undefined ? undefined : profiles[editor.key];
  const identityCredentialMismatch = editor !== undefined && editor.team && editor.credentialIdentity !== editor.value.agentId && editor.value.keyEnv !== '' && editor.secret === '' && !editor.removeSecret;
  const changingTeam = editor?.existing && original !== undefined && original.agentId === editor.value.agentId && Boolean(original.routerEndpoint) && (original.routerEndpoint !== (editor.team ? editor.value.routerEndpoint : '') || original.maintainerEndpoint !== (editor.team ? editor.value.maintainerEndpoint : ''));
  const pendingCount = editor === undefined ? 0 : snapshot.upstreamPending?.[editor.key];
  const pendingText = pendingCount === null ? c('待投数量读取失败，请检查本地队列。', 'The pending count is unavailable. Check the local queue.') : c(`当前有 ${pendingCount ?? 0} 项团队待投记录。`, `There are ${pendingCount ?? 0} pending team records.`);
  return <div className="acn-page acn-settings-page">{checkResult && <ConnectionCheckDialog result={checkResult} close={() => { setCheckResult(undefined); }} c={c} />}{notice && <SettingsToast key={notice.id} text={notice.text} />}{defaultConfirm && <Modal compact title={c('更改默认配置', 'Change default configuration')} closeLabel={c('关闭确认框', 'Close confirmation')} close={() => { setDefaultConfirm(undefined); setEditor((draft) => draft === undefined ? undefined : { ...draft, defaultChoice: false }); }}><p className="acn-confirm-message">{c('确认将默认配置从', 'Change the default configuration from')} <strong>{defaultConfirm.from}</strong> {c('修改为', 'to')} <strong>{defaultConfirm.to}</strong>{c('？', '?')}</p><div className="acn-confirm-actions"><Button onClick={() => { setDefaultConfirm(undefined); setEditor((draft) => draft === undefined ? undefined : { ...draft, defaultChoice: false }); }}>{c('取消', 'Cancel')}</Button><Button primary onClick={() => { setDefaultConfirm(undefined); void saveProfile(true); }}>{c('确认', 'Confirm')}</Button></div></Modal>}{!snapshot.active && <div role="status"><p>{c('ACN 知识组件未启用。聊天可继续，启用后会自动恢复状态读取。', 'The ACN knowledge component is inactive. Chat remains available; status refresh resumes when enabled.')}</p>{openPlugins ? <Button onClick={openPlugins}>{c('前往插件管理', 'Open plugin manager')}</Button> : <p style={muted}>{c('打开 DSH「插件 → ACN记忆框架」，启用知识组件。', 'Open DSH Plugins → agent-claim-network and enable the knowledge component.')}</p>}</div>}<Tabs<SettingsTab> label={c('ACN 插件设置', 'ACN settings')} value={tab} disabled={disabled} choices={[
    ['upstreams', c('工作配置', 'Work configurations')], ['knowledge', c('知识与模型', 'Knowledge and model')], ['preferences', c('偏好', 'Preferences')],
  ]} change={(next) => { setTab(next); feedback(''); }}>
    {message && (tab !== 'upstreams' || editor === undefined) && <p role={error ? 'alert' : 'status'} className={`acn-feedback ${error ? 'is-error' : ''}`}>{message}</p>}
    {conflict && <Button disabled={disabled} onClick={() => { void refreshDraft(); }}>{c('刷新并保留草稿', 'Refresh and keep edits')}</Button>}
    {tab === 'upstreams' && <><div ref={profileTop} />
      {editor === undefined && <p className="acn-settings-intro">{c('每份工作配置有各自的 Agent ID 和知识库，可单人使用或连接团队。', 'Each work configuration has its own Agent ID and knowledge store, for solo or team use.')}</p>}
      {editor === undefined ? <>
        <div className="acn-profiles">{Object.entries(profiles).map(([key, item]) => <Row key={key} title={item.name || key} badges={<><span className="acn-badge acn-profile-kind" data-mode={item.routerEndpoint ? 'team' : 'solo'}>{item.routerEndpoint ? c('团队', 'Team') : c('单人', 'Solo')}</span>{key === defaultKey && <span className="acn-badge acn-profile-default">{c('默认', 'Default')}</span>}{!item.enabled && <span className="acn-badge">{c('已停用', 'Disabled')}</span>}</>} description={`${item.agentId}${snapshot.upstreamPending?.[key] === null ? c(' · 待投记录读取失败', ' · Pending queue unreadable') : ''}`}>
          <Button disabled={disabled} onClick={() => { openKnowledge(key); }}>{c('知识与活动', 'Knowledge and activity')}</Button>
          <Button disabled={disabled} onClick={() => { setEditor({ key, existing: true, team: Boolean(item.routerEndpoint), defaultChoice: key === defaultKey, secret: '', removeSecret: false, credentialIdentity: item.agentId, base: item, reference: item.keyEnv || newCredentialReference(), value: { ...item } }); setCheckResult(undefined); feedback(''); }}>{c('配置', 'Configure')}</Button>
        </Row>)}</div>
        <div className="acn-actions"><Button primary disabled={disabled} onClick={add}>{c('新建工作配置', 'New configuration')}</Button></div>
        {guide}
      </> : <form onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}>
        <div className="acn-backbar"><button type="button" className="acn-back-link" disabled={busy} onClick={cancelEditor}><span aria-hidden="true">←</span>{c('返回工作配置', 'Back to work configurations')}</button></div>
        <h3>{editor.existing ? c('编辑工作配置', 'Edit configuration') : c('新建工作配置', 'New configuration')}</h3>
        <div className="acn-setting-group acn-profile-options"><Row title={c('启用此配置', 'Enable configuration')} description={c('保存后生效。停用会暂停关联会话，知识保留。', 'Applied on save. Disabling pauses associated sessions and retains knowledge.')}><input type="checkbox" role="switch" aria-label={c('启用此配置', 'Enable configuration')} disabled={disabled} checked={editor.value.enabled} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, enabled: event.target.checked }, defaultChoice: event.target.checked && editor.defaultChoice }); }} /></Row><Row title={c('设为默认', 'Use as default')} description={c('项目没有可用历史时，新会话采用此配置。', 'Used for new sessions when the project has no valid history.')}><input type="checkbox" role="switch" aria-label={c('设为默认', 'Use as default')} disabled={disabled || !editor.value.enabled} checked={editor.defaultChoice} onChange={(event) => { setEditor({ ...editor, defaultChoice: event.target.checked }); }} /></Row></div>
        <label className="acn-field">{c('显示名称（可选）', 'Display name (optional)')}<input style={inputStyle} disabled={disabled} value={editor.value.name} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, name: event.target.value } }); }} /></label>
        <label className="acn-field">Agent ID<input required style={inputStyle} disabled={disabled} value={editor.value.agentId} placeholder="coding" autoComplete="off" onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, agentId: event.target.value } }); }} /></label>
        <p style={muted}>{c('使用小写字母、数字、下划线或连字符。单人使用可自取固定名称，接入团队继续使用此 ID。', 'Use lowercase letters, numbers, underscores or hyphens. Choose a stable ID for solo use; the same ID is used when joining a team.')}</p>
        {original !== undefined && original.agentId !== editor.value.agentId && <p role="status">{c('修改 Agent ID 将使用另一份知识库，原数据保留。若要让旧会话继续，请把 Agent ID 改回原来的值并保存。', 'Changing the Agent ID selects a different store. Original data is retained. To continue old sessions, change the Agent ID back to its original value and save.')}</p>}
        <details className="acn-disclosure"><summary><span>{c('配置标识（upstream）', 'Configuration key (upstream)')}</span></summary><div className="acn-disclosure-body"><input aria-label={c('配置标识', 'Configuration key')} style={inputStyle} disabled={disabled || editor.existing} value={editor.key} placeholder={editor.value.agentId || 'coding'} onChange={(event) => { setEditor({ ...editor, key: event.target.value }); }} /><p style={muted}>{c('新建时留空将按 Agent ID 生成。创建后固定，显示名称仍可修改。', 'Generated from the Agent ID when empty. The key is fixed after creation; the display name can be changed.')}</p></div></details>
        <Row title={c('连接团队服务', 'Connect team services')} description={c('关闭时使用本地知识。开启后填写两个服务地址，Agent ID 保持同一个。', 'Use local knowledge when off. When on, enter both service URLs; the Agent ID stays the same.')}><input type="checkbox" role="switch" aria-label={c('连接团队服务', 'Connect team services')} checked={editor.team} disabled={disabled} onChange={(event) => { setEditor({ ...editor, team: event.target.checked, secret: event.target.checked ? editor.secret : '' }); setCheckResult(undefined); }} /></Row>
        {editor.value.keyEnv !== '' && !editor.team && editor.credentialIdentity !== editor.value.agentId && <p role="status">{c('此身份改为单人使用后，不再绑定原成员密钥；旧凭据保留，避免影响其他已启动实例。', 'Saving this identity in solo mode removes the previous member key binding. The old credential is retained for other resident instances.')}</p>}
        {identityCredentialMismatch && <p role="alert">{c('团队 Agent ID 已改变，原成员密钥可能不匹配。请填写新身份的团队鉴权密钥；仅在服务无需鉴权时选择「移除密钥绑定」。', 'The team Agent ID changed and the previous member key may not match. Enter the new identity’s key, or remove the key binding only if authentication is not required.')}</p>}
        {editor.connectionConflict && <div role="alert"><p>{c('团队连接在另一窗口也有修改。Agent ID、地址和密钥不会混合，请选择一整份连接后再保存。', 'Both windows changed the team connection. Agent IDs, URLs and keys will not be mixed. Choose one complete connection before saving.')}</p><p>{c('已保存连接', 'Saved connection')}: {editor.connectionConflict.routerEndpoint || c('单人模式', 'Solo')} · {editor.connectionConflict.maintainerEndpoint}</p><Button onClick={() => { const next = { ...editor }; delete next.connectionConflict; setEditor(next); }}>{c('保留我的团队连接', 'Keep my team connection')}</Button><Button onClick={() => { const remote = editor.connectionConflict; if (!remote) return; const next = { ...editor, value: { ...editor.value, agentId: remote.agentId, routerEndpoint: remote.routerEndpoint, maintainerEndpoint: remote.maintainerEndpoint, keyEnv: remote.keyEnv }, team: Boolean(remote.routerEndpoint), secret: '', removeSecret: false, reference: remote.keyEnv || newCredentialReference(), credentialIdentity: remote.agentId }; delete next.connectionConflict; delete next.pendingReference; delete next.pendingValue; setEditor(next); }}>{c('采用已保存的团队连接', 'Use the saved team connection')}</Button></div>}
        {editor.team && <>{guide}<div className="acn-connection-fields">{([['routerEndpoint', t('router')], ['maintainerEndpoint', t('maintainer')]] as const).map(([field, label]) => <label key={field} className="acn-field">{label}<input style={inputStyle} required type="url" autoComplete="off" disabled={disabled} value={editor.value[field]} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, [field]: event.target.value } }); setCheckResult(undefined); }} /></label>)}<label className="acn-field">{t('timeout')}<input type="number" min="1" style={inputStyle} value={editor.value.timeoutMs} disabled={disabled} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, timeoutMs: Number(event.target.value) } }); }} /></label></div><TeamCredentialField reference={editor.reference} api={api.credential} c={c} disabled={disabled} value={editor.secret} refresh={credentialRefresh} removed={editor.removeSecret} bound={editor.value.keyEnv !== ''} remove={() => { setEditor({ ...editor, secret: '', removeSecret: !editor.removeSecret }); setCheckResult(undefined); }} change={(secret) => { setEditor({ ...editor, secret, removeSecret: false }); setCheckResult(undefined); }} /><p style={muted}>{c('单人期间的历史 Claim 可继续本地使用，接入团队后不会整库补传。', 'Solo claims remain available locally and are not automatically uploaded when joining.')}</p></>}
        {changingTeam && <p role="status">{c('修改地址会沿用当前知识库。', 'Changing URLs keeps this knowledge store.')}{pendingText}{c('新配置启动后，符合重试条件的记录可能发往新地址。需要隔离团队时请新建工作配置。', 'Eligible pending records may be sent to the new URLs after activation. Create another configuration to isolate teams.')}</p>}
        <div className="acn-actions">{editor.team && <Button disabled={disabled} onClick={() => { void checkProfile(); }}>{probing ? c('正在检查…', 'Checking…') : c('检查连接', 'Check connection')}</Button>}<Button primary disabled={disabled || Boolean(editor.connectionConflict) || identityCredentialMismatch} type="submit">{c('保存配置', 'Save configuration')}</Button><Button disabled={busy} onClick={cancelEditor}>{c('取消编辑', 'Cancel editing')}</Button></div>
        {message && <p role={error ? 'alert' : 'status'} style={muted}>{message}</p>}

      </form>}
    </>}
    {tab === 'knowledge' && <>
      <Row title={c('知识处理模型', 'Knowledge model')} description={t('modelHint')}><Select aria-label={c('知识处理模型', 'Knowledge model')} disabled={disabled} value={JSON.stringify([values.provider, values.model])} onChange={(event) => { void chooseModel(event.target.value); }}><option value={JSON.stringify(['', ''])}>{t('automatic')}</option>{values.provider && !snapshot.models.some((item) => item.provider === values.provider && item.id === values.model) && <option value={JSON.stringify([values.provider, values.model])}>{values.model} — {t('unavailableModel')}</option>}{snapshot.models.map((item) => <option key={JSON.stringify([item.provider, item.id])} value={JSON.stringify([item.provider, item.id])}>{item.providerName} / {item.name}</option>)}</Select></Row>
      <form onSubmit={(event) => { event.preventDefault(); void persist({ ...values, home }); }}><KnowledgeDirectoryField value={home} change={setHome} busy={disabled} api={api} c={c} label={t('home')} feedback={feedback} /><p style={muted}>{c('所有工作配置的知识根目录。修改后使用新目录，原数据保留。', 'Knowledge root for all configurations. Changing it selects a new directory and retains original data.')}</p><div className="acn-actions"><Button primary type="submit" disabled={disabled || home === values.home}>{c('保存目录', 'Save directory')}</Button></div></form>
    </>}
    {tab === 'preferences' && <><div className="acn-setting-group">
      <Row title={c('显示知识处理结果', 'Show knowledge results')} description={c('在来源会话显示任务完成或失败的短暂提示。关闭后仍可在「知识与活动」查看。', 'Briefly show task completion or failure in its source session. Results remain in Knowledge and activity when disabled.')}><input type="checkbox" role="switch" aria-label={c('显示知识处理结果', 'Show knowledge results')} disabled={disabled} checked={values.showCompletion !== false} onChange={(event) => { void persist({ ...values, showCompletion: event.target.checked }); }} /></Row>
      </div>{editor !== undefined && <p className="acn-help">{c('有未保存的工作配置，请先返回工作配置保存或取消，再调整高级参数。', 'Save or cancel the work-configuration draft before editing advanced parameters.')}</p>}<AdvancedPreferences value={values.advanced ?? advancedConfiguration({})} busy={disabled || editor !== undefined} c={c} save={(advanced) => persist({ ...values, advanced })} /></>}
    {probing && <Button onClick={() => { probe.current?.abort(); setProbing(false); feedback(c('已取消检查。', 'Check cancelled.')); }}>{c('取消检查', 'Cancel check')}</Button>}
  </Tabs></div>;
}
