// 设置按连接、知识模型与偏好组织；模型探测成功才保存，编辑草稿与其他设置独立。
import { useEffect, useRef, useState } from 'react';
import type { ConfigurationApi } from './ConfigurationPage.js';
import type { ConfigurationSnapshot, ConfigurationValues } from '../configuration.js';
import type { Connection } from '../config.js';
import { ConnectionSchema } from '../config.js';
import type { InteractionRequest, InteractionResult } from '../interaction.js';
import type { ConfigurationText } from './locales.js';
import { Button, Row, Select, Tabs, inputStyle, muted } from './interaction-ui.js';
export interface InteractionApi extends ConfigurationApi { interact: (request: InteractionRequest, signal?: AbortSignal) => Promise<InteractionResult> }
export type SettingsTab = 'personal' | 'team' | 'knowledge';
export interface TeamSettingsProps { api: InteractionApi; t: (key: ConfigurationText) => string; openKnowledge: (key: string) => void; initialTab?: SettingsTab }
type ConnectionDraft = Omit<Connection, 'agentId'> & { agentId: string };

export function TeamSettingsPage({ api, t, openKnowledge, initialTab = 'personal' }: TeamSettingsProps) {
  const c = (zh: string, en: string) => t('title') === 'Configuration' ? en : zh;
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>();
  const [message, setMessage] = useState(''); const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false); const [editor, setEditor] = useState<ConnectionDraft>();
  const [checks, setChecks] = useState<InteractionResult['checks']>();
  const [personal, setPersonal] = useState({ agentId: '', home: '' });
  const [confirmation, setConfirmation] = useState<{ id: string; remove: boolean }>();
  const probe = useRef<AbortController>();
  const [probing, setProbing] = useState(false);
  useEffect(() => { const controller = new AbortController(); void api.read(controller.signal).then((value) => { if (!controller.signal.aborted) { setSnapshot(value); setPersonal({ agentId: value.values.agentId, home: value.values.home }); } }, () => { if (!controller.signal.aborted) { setMessage(t('errorLoad')); setError(true); } }); return () => { controller.abort(); probe.current?.abort(); }; }, [api, t]);
  function feedback(text: string, failed = false) { setMessage(text); setError(failed); }
  async function persist(values: ConfigurationValues): Promise<boolean> {
    if (snapshot === undefined) return false;
    setBusy(true);
    try { const result = await api.save({ revision: snapshot.revision, values }); if (!result.ok) { feedback(t(result.code === 'inactive' ? 'activation' : result.code), true); return false; } setSnapshot(result.snapshot);
      setPersonal((draft) => draft.agentId === snapshot.values.agentId && draft.home === snapshot.values.home || draft.agentId === values.agentId && draft.home === values.home ? { agentId: result.snapshot.values.agentId, home: result.snapshot.values.home } : draft); feedback(c('已保存并应用。', 'Saved and applied.')); return true; }
    catch { feedback(t('errorTransport'), true); return false; }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try { const value = await api.read(); setSnapshot(value); setPersonal({ agentId: value.values.agentId, home: value.values.home }); setEditor(undefined); setChecks(undefined); setConfirmation(undefined); feedback(c('已重新加载。未保存的修改已丢弃。', 'Reloaded. Unsaved changes were discarded.')); }
    catch { feedback(t('errorLoad'), true); } finally { setBusy(false); }
  }
  async function chooseModel(value: string) {
    if (snapshot === undefined || probing || busy) return;
    const selected = snapshot.models.find((item) => JSON.stringify([item.provider, item.id]) === value);
    const controller = new AbortController(); probe.current = controller; setProbing(true);
    feedback(c('正在验证知识模型…', 'Checking knowledge model…'));
    try {
      const result = await api.interact({ action: 'probe', provider: selected?.provider ?? '', model: selected?.id ?? '' }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) { feedback(result.message, true); return; }
      await persist({ ...snapshot.values, provider: selected?.provider ?? '', model: selected?.id ?? '' });
    } catch { if (!controller.signal.aborted) feedback(c('模型验证未完成，保留原模型。', 'Model check failed; the previous model is retained.'), true); }
    finally { if (probe.current === controller) { probe.current = undefined; setProbing(false); } }
  }
  async function saveConnection() {
    if (editor === undefined || snapshot === undefined) return;
    const parsed = ConnectionSchema.safeParse({ ...editor, id: editor.id === 'legacy' ? 'legacy-check' : editor.id });
    if (!parsed.success) { feedback(c('请检查连接名称、Agent ID、服务地址和认证环境变量名。', 'Check the name, Agent ID, service URLs, and credential variable name.'), true); return; }
    const values = editor.id === 'legacy' ? { ...snapshot.values, agentId: editor.agentId, mode: 'team' as const, routerEndpoint: editor.routerEndpoint, maintainerEndpoint: editor.maintainerEndpoint, keyEnv: editor.keyEnv, timeoutMs: editor.timeoutMs } : { ...snapshot.values, connections: (snapshot.values.connections ?? []).some((item) => item.id === editor.id) ? (snapshot.values.connections ?? []).map((item) => item.id === editor.id ? parsed.data : item) : [...snapshot.values.connections ?? [], parsed.data] };
    if (await persist(values)) { setEditor(undefined); setChecks(undefined); }
  }
  async function checkConnection() {
    if (editor === undefined) return;
    const controller = new AbortController(); probe.current = controller; setProbing(true); setChecks(undefined);
    try { const result = await api.interact({ action: 'check', connection: { ...editor, id: editor.id === 'legacy' ? 'legacy-check' : editor.id } }, controller.signal); if (!controller.signal.aborted) { setChecks(result.checks); feedback(result.message, !result.ok); } }
    catch { if (!controller.signal.aborted) feedback(c('检查未完成，可保存后稍后重试。', 'Check failed. You can save and retry later.'), true); }
    finally { if (probe.current === controller) { probe.current = undefined; setProbing(false); } }
  }
  async function confirmChange() {
    if (confirmation === undefined || snapshot === undefined) return;
    const current = snapshot.values;
    const values = confirmation.id === 'legacy' ? { ...current, legacyEnabled: false, defaultConnection: current.defaultConnection === 'legacy' ? '' : current.defaultConnection } : { ...current, connections: (current.connections ?? []).flatMap((item) => item.id !== confirmation.id ? [item] : confirmation.remove ? [] : [{ ...item, enabled: false }]), defaultConnection: current.defaultConnection === confirmation.id ? '' : current.defaultConnection };
    if (await persist(values)) { setConfirmation(undefined); setEditor(undefined); }
  }
  if (snapshot === undefined) return <div className="acn-page"><p role={error ? 'alert' : 'status'}>{message || t('loading')}</p>{error && <Button onClick={() => { void reload(); }}>{t('reload')}</Button>}</div>;
  const values = snapshot.values;
  const connections = [...(values.mode === 'team' ? [{ id: 'legacy', name: c('原有团队连接', 'Existing team connection'), agentId: values.agentId, enabled: values.legacyEnabled !== false, routerEndpoint: values.routerEndpoint, maintainerEndpoint: values.maintainerEndpoint, keyEnv: values.keyEnv, timeoutMs: values.timeoutMs }] : []), ...values.connections ?? []];
  const disabled = busy || probing;
  const dirty = personal.agentId !== values.agentId || personal.home !== values.home;
  function addConnection() { setEditor({ id: crypto.randomUUID(), name: '', agentId: '', enabled: true, routerEndpoint: '', maintainerEndpoint: '', keyEnv: '', timeoutMs: 15000 }); setChecks(undefined); setConfirmation(undefined); feedback(''); }
  return <div className="acn-page">
    <Tabs<SettingsTab> label={c('ACN 插件设置', 'ACN settings')} value={tab} disabled={disabled} choices={[
      ['personal', c('单人设置', 'Personal')], ['team', c('团队连接', 'Team connections')], ['knowledge', c('知识与模型', 'Knowledge and model')],
    ]} change={(next) => { setTab(next); feedback(''); }}>
      {message && <p role={error ? 'alert' : 'status'} style={{ ...muted, padding: '6px 9px', marginBottom: 10, borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2, #8881)', color: error ? 'var(--dsw-alias-state-error-primary, #b2433b)' : 'inherit' }}>{message}</p>}
      {tab === 'personal' && <form onSubmit={(event) => { event.preventDefault(); if (dirty && !disabled) void persist({ ...values, ...personal }); }}>
        <h3>{c('个人知识库', 'Personal knowledge store')}</h3>
        <p style={muted}>{c('新会话默认使用单人模式，无需连接团队。不同项目可复用同一身份积累的知识与私有记忆。', 'New sessions start in solo mode. Projects with the same identity share local knowledge and private memory; no team connection is needed.')}</p>
        <label className="acn-field">{t('agentId')}<input required disabled={disabled} style={inputStyle} value={personal.agentId} placeholder="personal" autoComplete="off" onChange={(event) => { setPersonal({ ...personal, agentId: event.target.value }); feedback(''); }} /></label>
        <p style={muted}>{c('可自取固定名称，如 personal。使用小写字母、数字、下划线或连字符；不会按项目自动更换。', 'Choose a stable name such as personal, using lowercase letters, numbers, underscores or hyphens. It does not change with the project.')}</p>
        <label className="acn-field">{t('home')}<input required disabled={disabled} style={inputStyle} value={personal.home} autoComplete="off" onChange={(event) => { setPersonal({ ...personal, home: event.target.value }); feedback(''); }} /></label>
        <p style={muted}>{c('填写绝对路径或 ~/ 路径。更换身份或目录不会迁移原数据，请在新会话中使用新配置。', 'Enter an absolute path or a ~/ path. Changing identity or directory leaves the old data in place; start a new session to use the change.')}</p>
        <div className="acn-actions"><Button primary disabled={disabled || !dirty} type="submit">{t('save')}</Button><Button disabled={disabled} title={t('reloadHint')} onClick={() => { void reload(); }}>{t('reload')}</Button></div>
        <p style={muted}>{dirty ? t('saveHint') + ' ' : ''}{c('重新加载将丢弃未保存的修改。', 'Reloading discards unsaved changes.')}</p>
      </form>}
      {tab === 'knowledge' && <>
      <Row title={c('知识处理模型', 'Knowledge model')} description={t('modelHint')}><div style={{ width: 220, maxWidth: '100%' }}><Select aria-label={c('知识处理模型', 'Knowledge model')} disabled={disabled} value={JSON.stringify([values.provider, values.model])} onChange={(event) => { void chooseModel(event.target.value); }}><option value={JSON.stringify(['', ''])}>{t('automatic')}</option>{values.provider && !snapshot.models.some((item) => item.provider === values.provider && item.id === values.model) && <option value={JSON.stringify([values.provider, values.model])}>{values.model} — {t('unavailableModel')}</option>}{snapshot.models.map((item) => <option key={JSON.stringify([item.provider, item.id])} value={JSON.stringify([item.provider, item.id])}>{item.providerName} / {item.name}</option>)}</Select></div></Row>
      {probing && <p role="status" style={muted}>{c('正在检查，成功后才保存。', 'Checking; saved only after success.')} <Button onClick={() => { probe.current?.abort(); setProbing(false); feedback(c('已取消，原配置保留。', 'Cancelled; previous configuration retained.')); }}>{c('取消检查', 'Cancel check')}</Button></p>}
      <Row title={c('显示知识处理结果', 'Show knowledge results')} description={c('在来源会话显示简短结果。任务失败仍可在处理活动中查看和重试。', 'Show short results in the source session. Failures remain available in activity.')}><input type="checkbox" className="acn-switch" role="switch" aria-label={c('显示知识处理结果', 'Show knowledge results')} disabled={disabled} checked={values.showCompletion !== false} onChange={(event) => { void persist({ ...values, showCompletion: event.target.checked }); }} /></Row>
      <Row title={c('本地知识', 'Local knowledge')} description={c('查看已生效的 Claim、Dispute、Trace 与处理活动。浏览不会同步收件或调用模型。', 'Browse effective claims, disputes, traces, and activity. Browsing does not sync or call a model.')}><Button onClick={() => { openKnowledge(values.mode === 'team' && values.legacyEnabled !== false ? 'legacy' : 'personal'); }}>{c('知识与活动', 'Knowledge and activity')}</Button></Row>
      </>}
      {tab === 'team' && (editor === undefined ? <>
        {connections.length === 0 && <Row title={c('尚未添加团队连接', 'No team connections')} description={c('需要协作时再添加。新会话可在首条消息前选择团队。', 'Add a connection when you want to collaborate. Choose a team before sending the first message.')}><Button onClick={addConnection} disabled={disabled}>{c('添加连接', 'Add connection')}</Button></Row>}
      {connections.map((item) => <Row key={item.id} title={item.name} description={`${item.agentId} · ${item.enabled ? c('已启用', 'Enabled') : c('已停用', 'Disabled')}`}><Button disabled={disabled} onClick={() => { try { const url = new URL(item.maintainerEndpoint); url.pathname = '/app'; window.open(url.toString(), '_blank', 'noopener,noreferrer'); } catch { feedback(c('请先填写有效的 Maintainer 地址。', 'Enter a valid Maintainer URL.'), true); } }}>{c('管理台', 'Console')}</Button><Button disabled={disabled} onClick={() => { setEditor(item); setChecks(undefined); setConfirmation(undefined); feedback(''); }}>{c('配置', 'Configure')}</Button></Row>)}
      {connections.length > 0 && <div style={{ marginTop: 12 }}><Button disabled={disabled} onClick={addConnection}>{c('添加连接', 'Add connection')}</Button></div>}
      {connections.length > 0 && <Row title={c('默认团队连接', 'Default team connection')} description={c('只在会话菜单中标注默认候选，不会自动加入团队或更改已有会话。', 'Marks a suggestion in the session menu. Does not enable a team or change existing session bindings.')}><Select aria-label={c('默认团队连接', 'Default team connection')} disabled={disabled} value={values.defaultConnection ?? ''} onChange={(event) => { void persist({ ...values, defaultConnection: event.target.value }); }}><option value="">{c('不设默认', 'No default')}</option>{connections.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Row>}
      </> : <form onSubmit={(event) => { event.preventDefault(); void saveConnection(); }}>
      <h3>{c('配置团队连接', 'Configure connection')}</h3>
      <p style={muted}>{c('成员 ID 应与团队授权一致。服务暂时不可用时，也可以先保存，使用前再检查连接。', 'Use the member ID authorized by your team. You can save offline and check the connection before using it.')}</p>
      <div className="acn-connection-fields">
      {([['name', c('连接名称', 'Connection name')], ['agentId', 'Agent ID'], ['routerEndpoint', t('router')], ['maintainerEndpoint', t('maintainer')], ['keyEnv', t('keyEnv')]] as const).map(([key, label]) => <label className="acn-field" key={key}>{label}<input style={inputStyle} disabled={disabled} value={editor[key]} required={key !== 'keyEnv'} type={key.endsWith('Endpoint') ? 'url' : 'text'} autoComplete="off" onChange={(event) => { setEditor({ ...editor, [key]: event.target.value }); setChecks(undefined); feedback(''); }} /></label>)}
      <label className="acn-field">{t('timeout')}<input type="number" min="1" style={inputStyle} value={editor.timeoutMs} disabled={disabled} onChange={(event) => { setEditor({ ...editor, timeoutMs: Number(event.target.value) }); setChecks(undefined); feedback(''); }} /></label>
      </div><p style={muted}>{t('keyHint')}</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 20 }}><Button disabled={disabled} type="button" onClick={() => { void checkConnection(); }}>{c('检查连接', 'Check connection')}</Button>{probing && <Button type="button" onClick={() => { probe.current?.abort(); setProbing(false); }}>{c('取消检查', 'Cancel check')}</Button>}<Button primary type="submit" disabled={disabled}>{t('save')}</Button><Button type="button" disabled={disabled} onClick={() => { setEditor(undefined); setChecks(undefined); setConfirmation(undefined); feedback(''); }}>{c('取消编辑', 'Cancel editing')}</Button></div>
      {checks?.map((item) => <p role={item.state === 'failed' ? 'alert' : 'status'} key={item.service}>{item.service}: {item.message}</p>)}
      {connections.some((item) => item.id === editor.id) && <div style={{ marginTop: 24, display: 'flex', gap: 10 }}>{editor.enabled ? <Button type="button" disabled={disabled} onClick={() => { setConfirmation({ id: editor.id, remove: false }); }}>{c('停用连接', 'Disable connection')}</Button> : <Button disabled={disabled} type="button" onClick={() => { void persist(editor.id === 'legacy' ? { ...values, legacyEnabled: true } : { ...values, connections: (values.connections ?? []).map((item) => item.id === editor.id ? { ...item, enabled: true } : item) }).then((ok) => { if (ok) setEditor(undefined); }); }}>{c('恢复连接', 'Enable connection')}</Button>}{editor.id !== 'legacy' && <Button type="button" disabled={disabled} onClick={() => { setConfirmation({ id: editor.id, remove: true }); }}>{c('删除连接', 'Delete connection')}</Button>}</div>}
      {confirmation && <div role="alertdialog" aria-label={c('确认连接变更', 'Confirm connection change')} style={{ padding: 16, marginTop: 16, border: '1px solid #d6d6d6', borderRadius: 8 }}><p>{c('已绑定该连接的会话将暂停知识访问；数据保留，默认连接会一并清空。停用可恢复，删除后需恢复原配置才能继续旧会话。', 'Bound sessions will lose knowledge access. Data is retained and the default is cleared. Disabled connections can be restored; deleted connections require their original configuration.')}</p><Button type="button" disabled={disabled} onClick={() => { void confirmChange(); }}>{c('确认', 'Confirm')}</Button> <Button type="button" onClick={() => { setConfirmation(undefined); }}>{c('取消', 'Cancel')}</Button></div>}
    </form>)}
    </Tabs>
  </div>;
}
