// 工作配置统一管理单人身份与团队服务；编辑草稿、连接检查和保存互相独立。
import { displayMessage } from '../interaction-messages.js';
import { useEffect, useRef, useState } from 'react';
import type { ConfigurationApi } from './ConfigurationPage.js';
import type { ConfigurationSnapshot, ConfigurationValues } from '../configuration.js';
import { resolveConfig, UpstreamNameSchema, UpstreamSchema, upstreamsOf } from '../config.js';
import type { Upstream } from '../config.js';
import type { InteractionRequest, InteractionResult } from '../interaction.js';
import type { CredentialRequest, CredentialResult } from '../credentials.js';
import { TeamCredentialField } from './TeamCredentialField.js';
import type { ConfigurationText } from './locales.js';
import { Button, Row, Select, Tabs, configurationLabel, inputStyle, muted } from './interaction-ui.js';
export interface InteractionApi extends ConfigurationApi { interact: (request: InteractionRequest, signal?: AbortSignal) => Promise<InteractionResult>; credential?: (request: CredentialRequest, signal?: AbortSignal) => Promise<CredentialResult> }
export type SettingsTab = 'upstreams' | 'knowledge';
export interface TeamSettingsProps { api: InteractionApi; t: (key: ConfigurationText) => string; openKnowledge: (key: string) => void; initialTab?: SettingsTab; openPlugins?: (() => void) | undefined }
type Draft = { key: string; existing: boolean; team: boolean; value: Omit<Upstream, 'agentId'> & { agentId: string }; secret: string; reference: string; credentialIdentity: string; removeSecret: boolean; base?: Upstream; connectionConflict?: Upstream; pendingReference?: string; pendingValue?: string };
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
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState(false);
  const confirmedSaveRejection = useRef(false); const stagedReference = useRef<string>();
  useEffect(() => { const previous = stagedReference.current; stagedReference.current = editor?.pendingReference; if (previous && previous !== editor?.pendingReference) void api.credential?.({ action: 'discard', reference: previous }).catch(() => undefined); }, [api, editor?.pendingReference]);
  // 关闭面板不会取消已提交的异步保存；卸载时保留暂存引用，避免先删除再落盘。
  const [busy, setBusy] = useState(false); const [probing, setProbing] = useState(false);
  const [credentialRefresh, setCredentialRefresh] = useState(0);
  const [checks, setChecks] = useState<InteractionResult['checks']>(); const probe = useRef<AbortController>();
  const feedback = (text: string, failed = false) => { setMessage(text); setError(failed); };
  useEffect(() => { const controller = new AbortController(); void api.read(controller.signal).then((value) => { if (!controller.signal.aborted) { setSnapshot(value); setHome(value.values.home); } }, () => { if (!controller.signal.aborted) { setMessage(t('errorLoad')); setError(true); } }); return () => { controller.abort(); probe.current?.abort(); }; }, [api, t]);
  async function persist(values: ConfigurationValues, keyStaged = false): Promise<boolean> {
    if (snapshot === undefined) return false;
    setBusy(true); confirmedSaveRejection.current = false;
    try {
      // 首次建身份前也能保存知识目录和模型，避免必须先向默认目录写入数据。
      const next = values.upstreams === undefined && values.agentId === '' && (values.connections?.length ?? 0) === 0 ? { ...values, upstreams: {}, upstream: '' } : values;
      const result = await api.save({ revision: snapshot.revision, values: next });
      if (!result.ok) { confirmedSaveRejection.current = ['busy', 'conflict', 'invalid', 'unavailable'].includes(result.code); setConflict(['conflict', 'persistence', 'inactive'].includes(result.code)); const keyMessage = keyStaged && confirmedSaveRejection.current ? c('本次密钥替换尚未生效，输入已保留。', 'The key replacement has not taken effect; your input is retained. ') : ''; feedback(keyMessage + t(result.code === 'inactive' ? 'activation' : result.code), true); return false; }
      setConflict(false); setSnapshot(result.snapshot); setHome((draft) => draft === snapshot.values.home || draft === values.home ? result.snapshot.values.home : draft);
      feedback((keyStaged ? c('配置与团队鉴权密钥已保存。', 'Configuration and team authentication key saved. ') : c('已保存。', 'Saved. ')) + c('新启动的会话使用新配置，现有会话保留启动时的连接。', 'Newly started sessions use the new configuration; running sessions retain their connection.')); return true;
    } catch { setConflict(true); feedback(t('errorTransport'), true); return false; } finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try { const value = await api.read(); setConflict(false); setSnapshot(value); setHome(value.values.home); setEditor(undefined); setChecks(undefined); feedback(c('已重新加载，未保存的修改已丢弃。', 'Reloaded. Unsaved changes were discarded.')); }
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
          const next = { ...editor, existing: true, value: merged, base: latest, team: Boolean(connection.routerEndpoint), reference: connection.keyEnv || newCredentialReference(), credentialIdentity: !localChanged || group(local) === group(latest) ? latest.agentId : editor.credentialIdentity };
          delete next.connectionConflict;
          if (localChanged && remoteChanged && group(local) !== group(latest)) next.connectionConflict = latest;
          setEditor(next);
        }
      }
      setHome((value) => value === snapshot.values.home ? current.values.home : value);
      setSnapshot(current); setConflict(false); setChecks(undefined);
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
  if (snapshot === undefined) return <div className="acn-page"><p role={error ? 'alert' : 'status'}>{message || t('loading')}</p>{error && <Button onClick={() => { void reload(); }}>{t('reload')}</Button>}</div>;
  const values = snapshot.values; const profiles = settingsUpstreams(values); const disabled = busy || probing;
  const defaultKey = values.upstream ?? (profiles['personal'] === undefined ? '' : 'personal');
  const withProfiles = (next: Record<string, Upstream>, upstream = defaultKey): ConfigurationValues => ({ ...values, upstreams: next, upstream });
  async function toggleProfile(key: string, item: Upstream) {
    const enabled = !item.enabled;
    if (await persist(withProfiles({ ...profiles, [key]: { ...item, enabled } }, !enabled && defaultKey === key ? '' : defaultKey))) feedback(enabled
      ? c('已启用此配置，Agent ID 和团队连接保持不变。可在 ACN 菜单中选择使用。', 'Configuration enabled. The Agent ID and team connection are unchanged; select it from the ACN menu.')
      : c('已停用此配置，关联会话暂停聊天和知识处理，数据保留。', 'Configuration disabled. Associated sessions pause chat and knowledge processing; data is retained.'));
  }
  const add = () => { setEditor({ key: '', existing: false, team: false, secret: '', removeSecret: false, credentialIdentity: '', reference: newCredentialReference(), value: { name: '', agentId: '', enabled: true, routerEndpoint: '', maintainerEndpoint: '', keyEnv: '', timeoutMs: 15000 } }); setChecks(undefined); feedback(''); };
  async function saveProfile() {
    if (editor === undefined) return;
    if (identityCredentialMismatch) { feedback(c('Agent ID 已改变，请填写新身份的团队鉴权密钥，或明确移除密钥绑定后保存。', 'The Agent ID changed. Enter the new identity’s team key, or explicitly remove the key binding before saving.'), true); return; }
    if (editor.connectionConflict) { feedback(c('请先选择保留哪一份团队连接。', 'Choose which team connection to retain first.'), true); return; }
    const reference = editor.secret === '' ? editor.reference : editor.pendingReference && editor.pendingValue === editor.secret ? editor.pendingReference : newCredentialReference();
    const parsed = UpstreamSchema.safeParse({ ...editor.value, name: editor.value.name.trim() || editor.value.agentId, routerEndpoint: editor.team ? editor.value.routerEndpoint.trim() : '', maintainerEndpoint: editor.team ? editor.value.maintainerEndpoint.trim() : '', keyEnv: editor.removeSecret || !editor.team && editor.credentialIdentity !== editor.value.agentId ? '' : editor.team && editor.secret !== '' ? reference : editor.value.keyEnv.trim() });
    let key = editor.key.trim() || editor.value.agentId;
    if (!editor.existing && editor.key.trim() === '') { let suffix = 2; while (profiles[key] !== undefined) key = `${editor.value.agentId}-${suffix++}`; }
    if (!parsed.success || !UpstreamNameSchema.safeParse(key).success || !editor.existing && profiles[key] !== undefined) { feedback(c('请检查 Agent ID、配置标识和团队地址。两项地址需同时填写或留空。', 'Check the Agent ID, configuration key, and team URLs. Both URLs must be set or empty.'), true); return; }
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
      saved = await persist(withProfiles({ ...profiles, [key]: parsed.data }, Object.keys(profiles).length === 0 ? key : defaultKey), Boolean(staged));
      if (saved) { setEditor(undefined); setChecks(undefined); setCredentialRefresh((value) => value + 1); }
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
      if (field === 'agentId') message = c('请检查 Agent ID：只能使用小写字母、数字、下划线或连字符。', 'Check the Agent ID: use lowercase letters, numbers, underscores or hyphens.');
      else if (field === 'name') message = c('显示名称不能超过 80 个字符。', 'The display name must not exceed 80 characters.');
      else if (field === 'timeoutMs') message = c('团队请求超时必须为正整数，单位为毫秒。', 'Team request timeout must be a positive integer in milliseconds.');
      else if (field === 'maintainerEndpoint' || connection.routerEndpoint && !connection.maintainerEndpoint) message = c('请填写有效的 Maintainer 地址，以 http:// 或 https:// 开头；不能包含用户名、密码、查询参数或片段。', 'Enter a valid Maintainer URL starting with http:// or https://, without a username, password, query or fragment.');
      else if (field === 'routerEndpoint' || !connection.routerEndpoint) message = c('请填写有效的 Router 地址，以 http:// 或 https:// 开头；不能包含用户名、密码、查询参数或片段。', 'Enter a valid Router URL starting with http:// or https://, without a username, password, query or fragment.');
      setChecks(undefined); feedback(message, true); return;
    }
    const controller = new AbortController(); probe.current = controller; setProbing(true); setChecks(undefined);
    try {
      const result = editor.secret === '' ? await api.interact({ action: 'check', connection: parsed.data }, controller.signal) : api.credential === undefined ? { ok: false, message: c('密钥检查接口不可用，请重新打开插件。', 'Key check is unavailable; reopen the plugin.') } : await api.credential({ action: 'check', connection: parsed.data, value: editor.secret }, controller.signal);
      if (!controller.signal.aborted) { setChecks('checks' in result ? result.checks : undefined); feedback(displayMessage(result.message, c, result.messageInfo), !result.ok); }
    }
    catch { if (!controller.signal.aborted) feedback(c('未能完成连接检查，请稍后重试。本次检查不会保存配置，输入已保留。', 'The connection check could not complete. Retry later; this check does not save configuration, and your input is retained.'), true); }
    finally { if (probe.current === controller) { probe.current = undefined; setProbing(false); } }
  }
  const guide = <p style={muted}>{c('向团队管理员索取 Router、Maintainer 地址及成员凭据。尚未部署时，可参考原 ACN 仓库。服务管理台仅供管理员使用，成员凭据不能代替管理员登录。', 'Ask your team administrator for Router and Maintainer URLs and a member credential, or deploy services using the original ACN repository. Service consoles require administrator credentials; member credentials do not grant administrator access.')} <a href="https://github.com/FTShare-Lab/agent-claim-network" target="_blank" rel="noopener noreferrer">{c('ACN 部署说明（GitHub）', 'ACN deployment guide (GitHub)')}</a></p>;
  const original = editor === undefined ? undefined : profiles[editor.key];
  const identityCredentialMismatch = editor !== undefined && editor.team && editor.credentialIdentity !== editor.value.agentId && editor.value.keyEnv !== '' && editor.secret === '' && !editor.removeSecret;
  const changingTeam = editor?.existing && original !== undefined && original.agentId === editor.value.agentId && Boolean(original.routerEndpoint) && (original.routerEndpoint !== (editor.team ? editor.value.routerEndpoint : '') || original.maintainerEndpoint !== (editor.team ? editor.value.maintainerEndpoint : ''));
  const pendingCount = editor === undefined ? 0 : snapshot.upstreamPending?.[editor.key];
  const pendingText = pendingCount === null ? c('待投数量读取失败，请检查本地队列。', 'The pending count is unavailable. Check the local queue.') : c(`当前有 ${pendingCount ?? 0} 项团队待投记录。`, `There are ${pendingCount ?? 0} pending team records.`);
  return <div className="acn-page">{!snapshot.active && <div role="status"><p>{c('ACN 知识组件未启用。聊天可继续，启用后会自动恢复状态读取。', 'The ACN knowledge component is inactive. Chat remains available; status refresh resumes when enabled.')}</p>{openPlugins ? <Button onClick={openPlugins}>{c('前往插件管理', 'Open plugin manager')}</Button> : <p style={muted}>{c('打开 DSH「插件 → ACN记忆框架」，启用知识组件。', 'Open DSH Plugins → agent-claim-network and enable the knowledge component.')}</p>}</div>}<Tabs<SettingsTab> label={c('ACN 插件设置', 'ACN settings')} value={tab} disabled={disabled} choices={[
    ['upstreams', c('工作配置', 'Work configurations')], ['knowledge', c('知识与模型', 'Knowledge and model')],
  ]} change={(next) => { setTab(next); feedback(''); }}>
    {message && (tab !== 'upstreams' || editor === undefined) && <p role={error ? 'alert' : 'status'} style={{ ...muted, marginBottom: 12 }}>{message}</p>}
    {conflict && <Button disabled={disabled} onClick={() => { void refreshDraft(); }}>{c('刷新并保留草稿', 'Refresh and keep edits')}</Button>}
    {tab === 'upstreams' && <>
      <p style={muted}>{c('每份工作配置（upstream）有自己的 Agent ID、知识与私有记忆。可以单人使用，也可以随时配置团队服务。', 'Each work configuration (upstream) owns an Agent ID, knowledge and private memory. Use it solo or configure team services.')}</p>
      {editor === undefined ? <>
        {Object.entries(profiles).map(([key, item]) => <Row key={key} title={item.name || key} description={`${item.agentId} · ${item.enabled ? item.routerEndpoint ? c('团队', 'Team') : c('单人', 'Solo') : c('已停用', 'Disabled')}${key === defaultKey ? c(' · 全局默认', ' · Global default') : ''}${snapshot.upstreamPending?.[key] === null ? c(' · 待投记录读取失败', ' · Pending queue unreadable') : ''}`}>
          <Button disabled={disabled} onClick={() => { openKnowledge(key); }}>{c('知识与活动', 'Knowledge and activity')}</Button>
          <Button disabled={disabled} onClick={() => { setEditor({ key, existing: true, team: Boolean(item.routerEndpoint), secret: '', removeSecret: false, credentialIdentity: item.agentId, base: item, reference: item.keyEnv || newCredentialReference(), value: { ...item } }); setChecks(undefined); feedback(''); }}>{c('配置', 'Configure')}</Button>
          <Button disabled={disabled} aria-label={c(`${item.enabled ? '停用' : '启用'}配置 ${item.name || key}`, `${item.enabled ? 'Disable' : 'Enable'} configuration ${item.name || key}`)} onClick={() => { void toggleProfile(key, item); }}>{item.enabled ? c('停用', 'Disable') : c('启用', 'Enable')}</Button>
        </Row>)}
        <div className="acn-actions"><Button primary disabled={disabled} onClick={add}>{c('新建工作配置', 'New configuration')}</Button></div>
        <Row title={c('全局默认配置', 'Global default')} description={c('项目没有可用历史时采用。新会话优先沿用同项目最近新建会话的配置，首发前可改选。', 'Used when the project has no valid history. New sessions inherit its most recently created conversation configuration and can change it before the first message.')}><Select aria-label={c('全局默认配置', 'Global default')} disabled={disabled} value={defaultKey} onChange={(event) => { void persist(withProfiles(profiles, event.target.value)); }}><option value="">{c('不设全局默认', 'No global default')}</option>{Object.entries(profiles).filter(([, item]) => item.enabled).map(([key, item]) => <option key={key} value={key}>{configurationLabel(item.name || key, item.agentId)}</option>)}</Select></Row>
        {guide}
      </> : <form onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}>
        <h3>{editor.existing ? c('编辑工作配置', 'Edit configuration') : c('新建工作配置', 'New configuration')}</h3>
        <label className="acn-field">{c('显示名称（可选）', 'Display name (optional)')}<input style={inputStyle} disabled={disabled} value={editor.value.name} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, name: event.target.value } }); }} /></label>
        <label className="acn-field">Agent ID<input required style={inputStyle} disabled={disabled} value={editor.value.agentId} placeholder="coding" autoComplete="off" onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, agentId: event.target.value } }); }} /></label>
        <p style={muted}>{c('使用小写字母、数字、下划线或连字符。单人使用可自取固定名称，接入团队继续使用此 ID。', 'Use lowercase letters, numbers, underscores or hyphens. Choose a stable ID for solo use; the same ID is used when joining a team.')}</p>
        {original !== undefined && original.agentId !== editor.value.agentId && <p role="status">{c('修改 Agent ID 将使用另一份知识库，原数据保留。若要让旧会话继续，请把 Agent ID 改回原来的值并保存。', 'Changing the Agent ID selects a different store. Original data is retained. To continue old sessions, change the Agent ID back to its original value and save.')}</p>}
        <details><summary>{c('配置标识（upstream）', 'Configuration key (upstream)')}</summary><input aria-label={c('配置标识', 'Configuration key')} style={inputStyle} disabled={disabled || editor.existing} value={editor.key} placeholder={editor.value.agentId || 'coding'} onChange={(event) => { setEditor({ ...editor, key: event.target.value }); }} /><p style={muted}>{c('新建时留空将按 Agent ID 生成。创建后固定，显示名称仍可修改。', 'Generated from the Agent ID when empty. The key is fixed after creation; the display name can be changed.')}</p></details>
        <Row title={c('连接团队服务', 'Connect team services')} description={c('关闭时使用本地知识。开启后填写两个服务地址，Agent ID 保持同一个。', 'Use local knowledge when off. When on, enter both service URLs; the Agent ID stays the same.')}><input type="checkbox" role="switch" aria-label={c('连接团队服务', 'Connect team services')} checked={editor.team} disabled={disabled} onChange={(event) => { setEditor({ ...editor, team: event.target.checked, secret: event.target.checked ? editor.secret : '' }); setChecks(undefined); }} /></Row>
        {editor.value.keyEnv !== '' && !editor.team && editor.credentialIdentity !== editor.value.agentId && <p role="status">{c('此身份改为单人使用后，不再绑定原成员密钥；旧凭据保留，避免影响其他已启动实例。', 'Saving this identity in solo mode removes the previous member key binding. The old credential is retained for other resident instances.')}</p>}
        {identityCredentialMismatch && <p role="alert">{c('团队 Agent ID 已改变，原成员密钥可能不匹配。请填写新身份的团队鉴权密钥；仅在服务无需鉴权时选择「移除密钥绑定」。', 'The team Agent ID changed and the previous member key may not match. Enter the new identity’s key, or remove the key binding only if authentication is not required.')}</p>}
        {editor.connectionConflict && <div role="alert"><p>{c('团队连接在另一窗口也有修改。Agent ID、地址和密钥不会混合，请选择一整份连接后再保存。', 'Both windows changed the team connection. Agent IDs, URLs and keys will not be mixed. Choose one complete connection before saving.')}</p><p>{c('已保存连接', 'Saved connection')}: {editor.connectionConflict.routerEndpoint || c('单人模式', 'Solo')} · {editor.connectionConflict.maintainerEndpoint}</p><Button onClick={() => { const next = { ...editor }; delete next.connectionConflict; setEditor(next); }}>{c('保留我的团队连接', 'Keep my team connection')}</Button><Button onClick={() => { const remote = editor.connectionConflict; if (!remote) return; const next = { ...editor, value: { ...editor.value, agentId: remote.agentId, routerEndpoint: remote.routerEndpoint, maintainerEndpoint: remote.maintainerEndpoint, keyEnv: remote.keyEnv }, team: Boolean(remote.routerEndpoint), secret: '', removeSecret: false, reference: remote.keyEnv || newCredentialReference(), credentialIdentity: remote.agentId }; delete next.connectionConflict; delete next.pendingReference; delete next.pendingValue; setEditor(next); }}>{c('采用已保存的团队连接', 'Use the saved team connection')}</Button></div>}
        {editor.team && <>{guide}<div className="acn-connection-fields">{([['routerEndpoint', t('router')], ['maintainerEndpoint', t('maintainer')]] as const).map(([field, label]) => <label key={field} className="acn-field">{label}<input style={inputStyle} required type="url" autoComplete="off" disabled={disabled} value={editor.value[field]} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, [field]: event.target.value } }); setChecks(undefined); }} /></label>)}<label className="acn-field">{t('timeout')}<input type="number" min="1" style={inputStyle} value={editor.value.timeoutMs} disabled={disabled} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, timeoutMs: Number(event.target.value) } }); }} /></label></div><TeamCredentialField reference={editor.reference} api={api.credential} c={c} disabled={disabled} value={editor.secret} refresh={credentialRefresh} removed={editor.removeSecret} bound={editor.value.keyEnv !== ''} remove={() => { setEditor({ ...editor, secret: '', removeSecret: !editor.removeSecret }); setChecks(undefined); }} change={(secret) => { setEditor({ ...editor, secret, removeSecret: false }); setChecks(undefined); }} /><p style={muted}>{c('单人期间的历史 Claim 可继续本地使用，接入团队后不会整库补传。', 'Solo claims remain available locally and are not automatically uploaded when joining.')}</p></>}
        {changingTeam && <p role="status">{c('修改地址会沿用当前知识库。', 'Changing URLs keeps this knowledge store.')}{pendingText}{c('新配置启动后，符合重试条件的记录可能发往新地址。需要隔离团队时请新建工作配置。', 'Eligible pending records may be sent to the new URLs after activation. Create another configuration to isolate teams.')}</p>}
        <div className="acn-actions">{editor.team && <Button disabled={disabled} onClick={() => { void checkProfile(); }}>{c('检查连接', 'Check connection')}</Button>}<Button primary disabled={disabled || Boolean(editor.connectionConflict) || identityCredentialMismatch} type="submit">{c('保存配置', 'Save configuration')}</Button><Button disabled={busy} onClick={() => { probe.current?.abort(); setEditor(undefined); setChecks(undefined); feedback(''); }}>{c('取消编辑', 'Cancel editing')}</Button></div>
        {message && <p role={error ? 'alert' : 'status'} style={muted}>{message}</p>}
        {checks?.map((item) => <p key={item.service} role={item.state === 'failed' ? 'alert' : 'status'}>{item.service} · {displayMessage(item.message, c)}</p>)}
        <p style={muted}>{c('启用和停用在工作配置列表中操作；请先保存修改或取消编辑。启用不会更改 Agent ID 或团队连接。', 'Enable or disable configurations in the list after saving or cancelling edits. Enabling does not change the Agent ID or team connection.')}</p>
      </form>}
    </>}
    {tab === 'knowledge' && <>
      <Row title={c('知识处理模型', 'Knowledge model')} description={t('modelHint')}><Select aria-label={c('知识处理模型', 'Knowledge model')} disabled={disabled} value={JSON.stringify([values.provider, values.model])} onChange={(event) => { void chooseModel(event.target.value); }}><option value={JSON.stringify(['', ''])}>{t('automatic')}</option>{values.provider && !snapshot.models.some((item) => item.provider === values.provider && item.id === values.model) && <option value={JSON.stringify([values.provider, values.model])}>{values.model} — {t('unavailableModel')}</option>}{snapshot.models.map((item) => <option key={JSON.stringify([item.provider, item.id])} value={JSON.stringify([item.provider, item.id])}>{item.providerName} / {item.name}</option>)}</Select></Row>
      <Row title={c('显示知识处理结果', 'Show knowledge results')} description={c('在来源会话显示简短结果，完整记录可在知识与活动中查看。', 'Show short results in the source session. Full records are available in knowledge and activity.')}><input type="checkbox" role="switch" aria-label={c('显示知识处理结果', 'Show knowledge results')} disabled={disabled} checked={values.showCompletion !== false} onChange={(event) => { void persist({ ...values, showCompletion: event.target.checked }); }} /></Row>
      <form onSubmit={(event) => { event.preventDefault(); void persist({ ...values, home }); }}><label className="acn-field">{t('home')}<input required style={inputStyle} disabled={disabled} value={home} onChange={(event) => { setHome(event.target.value); }} /></label><p style={muted}>{c('所有工作配置的知识根目录。修改后使用新目录，原数据保留。', 'Knowledge root for all configurations. Changing it selects a new directory and retains original data.')}</p><div className="acn-actions"><Button primary type="submit" disabled={disabled || home === values.home}>{c('保存目录', 'Save directory')}</Button></div></form>
    </>}
    {probing && <Button onClick={() => { probe.current?.abort(); setProbing(false); feedback(c('已取消检查。', 'Check cancelled.')); }}>{c('取消检查', 'Cancel check')}</Button>}
    <div className="acn-actions">{snapshot.active && openPlugins && <Button disabled={disabled} onClick={openPlugins}>{c('管理 ACN 组件', 'Manage ACN components')}</Button>}<Button disabled={disabled} title={t('reloadHint')} onClick={() => { void reload(); }}>{t('reload')}</Button></div><p style={muted}>{c('重新加载将丢弃未保存的修改。', 'Reloading discards unsaved changes.')}</p>
  </Tabs></div>;
}
