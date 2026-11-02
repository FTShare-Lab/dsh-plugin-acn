// 工作配置统一管理单人身份与团队服务；编辑草稿、连接检查和保存互相独立。
import { useEffect, useRef, useState } from 'react';
import type { ConfigurationApi } from './ConfigurationPage.js';
import type { ConfigurationSnapshot, ConfigurationValues } from '../configuration.js';
import { resolveConfig, UpstreamNameSchema, UpstreamSchema, upstreamsOf } from '../config.js';
import type { Upstream } from '../config.js';
import type { InteractionRequest, InteractionResult } from '../interaction.js';
import type { ConfigurationText } from './locales.js';
import { Button, Row, Select, Tabs, configurationLabel, inputStyle, muted } from './interaction-ui.js';
export interface InteractionApi extends ConfigurationApi { interact: (request: InteractionRequest, signal?: AbortSignal) => Promise<InteractionResult> }
export type SettingsTab = 'upstreams' | 'knowledge';
export interface TeamSettingsProps { api: InteractionApi; t: (key: ConfigurationText) => string; openKnowledge: (key: string) => void; initialTab?: SettingsTab }
type Draft = { key: string; existing: boolean; team: boolean; value: Omit<Upstream, 'agentId'> & { agentId: string } };
export function settingsUpstreams(values: ConfigurationValues) {
  return upstreamsOf(resolveConfig({ agentId: values.agentId, home: values.home, team: { routerEndpoint: values.routerEndpoint, maintainerEndpoint: values.maintainerEndpoint, keyEnv: values.keyEnv, timeoutMs: values.timeoutMs }, connections: values.connections, legacyEnabled: values.legacyEnabled, upstreams: values.upstreams, upstream: values.upstream }));
}
export function TeamSettingsPage({ api, t, openKnowledge, initialTab = 'upstreams' }: TeamSettingsProps) {
  const c = (zh: string, en: string) => t('title') === 'Configuration' ? en : zh;
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>();
  const [editor, setEditor] = useState<Draft>(); const [home, setHome] = useState('');
  const [message, setMessage] = useState(''); const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false); const [probing, setProbing] = useState(false);
  const [checks, setChecks] = useState<InteractionResult['checks']>(); const probe = useRef<AbortController>();
  const feedback = (text: string, failed = false) => { setMessage(text); setError(failed); };
  useEffect(() => { const controller = new AbortController(); void api.read(controller.signal).then((value) => { if (!controller.signal.aborted) { setSnapshot(value); setHome(value.values.home); } }, () => { if (!controller.signal.aborted) { setMessage(t('errorLoad')); setError(true); } }); return () => { controller.abort(); probe.current?.abort(); }; }, [api, t]);
  async function persist(values: ConfigurationValues): Promise<boolean> {
    if (snapshot === undefined) return false;
    setBusy(true);
    try {
      const result = await api.save({ revision: snapshot.revision, values });
      if (!result.ok) { feedback(t(result.code === 'inactive' ? 'activation' : result.code), true); return false; }
      setSnapshot(result.snapshot); setHome((draft) => draft === snapshot.values.home || draft === values.home ? result.snapshot.values.home : draft);
      feedback(c('已保存。新启动的会话使用新配置，现有会话保留启动时的连接。', 'Saved. Newly started sessions use the new configuration; running sessions retain their connection.')); return true;
    } catch { feedback(t('errorTransport'), true); return false; } finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try { const value = await api.read(); setSnapshot(value); setHome(value.values.home); setEditor(undefined); setChecks(undefined); feedback(c('已重新加载，未保存的修改已丢弃。', 'Reloaded. Unsaved changes were discarded.')); }
    catch { feedback(t('errorLoad'), true); } finally { setBusy(false); }
  }
  async function chooseModel(value: string) {
    if (snapshot === undefined) return;
    const model = snapshot.models.find((item) => JSON.stringify([item.provider, item.id]) === value);
    const controller = new AbortController(); probe.current = controller; setProbing(true); feedback(c('正在检查模型…', 'Checking model…'));
    try {
      const result = await api.interact({ action: 'probe', provider: model?.provider ?? '', model: model?.id ?? '' }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) { feedback(result.message, true); return; }
      await persist({ ...snapshot.values, provider: model?.provider ?? '', model: model?.id ?? '' });
    } catch { if (!controller.signal.aborted) feedback(c('检查未完成，原模型保留。', 'Check failed; the previous model is retained.'), true); }
    finally { if (probe.current === controller) { probe.current = undefined; setProbing(false); } }
  }
  if (snapshot === undefined) return <div className="acn-page"><p role={error ? 'alert' : 'status'}>{message || t('loading')}</p>{error && <Button onClick={() => { void reload(); }}>{t('reload')}</Button>}</div>;
  const values = snapshot.values; const profiles = settingsUpstreams(values); const disabled = busy || probing;
  const defaultKey = values.upstream ?? (profiles['personal'] === undefined ? '' : 'personal');
  const withProfiles = (next: Record<string, Upstream>, upstream = defaultKey): ConfigurationValues => ({ ...values, upstreams: next, upstream });
  const add = () => { setEditor({ key: '', existing: false, team: false, value: { name: '', agentId: '', enabled: true, routerEndpoint: '', maintainerEndpoint: '', keyEnv: '', timeoutMs: 15000 } }); setChecks(undefined); feedback(''); };
  async function saveProfile() {
    if (editor === undefined) return;
    const parsed = UpstreamSchema.safeParse({ ...editor.value, name: editor.value.name.trim() || editor.value.agentId, routerEndpoint: editor.team ? editor.value.routerEndpoint.trim() : '', maintainerEndpoint: editor.team ? editor.value.maintainerEndpoint.trim() : '', keyEnv: editor.team ? editor.value.keyEnv.trim() : '' });
    let key = editor.key.trim() || editor.value.agentId;
    if (!editor.existing && editor.key.trim() === '') { let suffix = 2; while (profiles[key] !== undefined) key = `${editor.value.agentId}-${suffix++}`; }
    if (!parsed.success || !UpstreamNameSchema.safeParse(key).success || !editor.existing && profiles[key] !== undefined) { feedback(c('请检查 Agent ID、配置标识和团队地址。两项地址需同时填写或留空。', 'Check the Agent ID, configuration key, and team URLs. Both URLs must be set or empty.'), true); return; }
    if (await persist(withProfiles({ ...profiles, [key]: parsed.data }, Object.keys(profiles).length === 0 ? key : defaultKey))) { setEditor(undefined); setChecks(undefined); }
  }
  async function checkProfile() {
    if (editor === undefined) return;
    const controller = new AbortController(); probe.current = controller; setProbing(true); setChecks(undefined);
    try { const result = await api.interact({ action: 'check', connection: { ...editor.value, name: editor.value.name || editor.value.agentId } }, controller.signal); if (!controller.signal.aborted) { setChecks(result.checks); feedback(result.message, !result.ok); } }
    catch { if (!controller.signal.aborted) feedback(c('检查未完成，可先保存。', 'Check failed. You can save offline.'), true); }
    finally { if (probe.current === controller) { probe.current = undefined; setProbing(false); } }
  }
  const guide = <p style={muted}>{c('还没有 Router 和 Maintainer 地址？可向团队管理员索取，或参考原 ACN 仓库部署这两个服务。', 'Need Router and Maintainer URLs? Ask your team administrator or deploy both services using the original ACN repository.')} <a href="https://github.com/FTShare-Lab/agent-claim-network" target="_blank" rel="noopener noreferrer">{c('ACN 部署说明（GitHub）', 'ACN deployment guide (GitHub)')}</a></p>;
  const original = editor === undefined ? undefined : profiles[editor.key];
  const changingTeam = editor?.existing && original !== undefined && Boolean(original.routerEndpoint) && (original.routerEndpoint !== (editor.team ? editor.value.routerEndpoint : '') || original.maintainerEndpoint !== (editor.team ? editor.value.maintainerEndpoint : ''));
  const pendingCount = editor === undefined ? 0 : snapshot.upstreamPending?.[editor.key];
  const pendingText = pendingCount === null ? c('待投数量读取失败，请检查本地队列。', 'The pending count is unavailable. Check the local queue.') : c(`当前有 ${pendingCount ?? 0} 项团队待投记录。`, `There are ${pendingCount ?? 0} pending team records.`);
  return <div className="acn-page"><Tabs<SettingsTab> label={c('ACN 插件设置', 'ACN settings')} value={tab} disabled={disabled} choices={[
    ['upstreams', c('工作配置', 'Work configurations')], ['knowledge', c('知识与模型', 'Knowledge and model')],
  ]} change={(next) => { setTab(next); feedback(''); }}>
    {message && <p role={error ? 'alert' : 'status'} style={{ ...muted, marginBottom: 12 }}>{message}</p>}
    {tab === 'upstreams' && <>
      <p style={muted}>{c('每份工作配置（upstream）有自己的 Agent ID、知识与私有记忆。可以单人使用，也可以随时配置团队服务。', 'Each work configuration (upstream) owns an Agent ID, knowledge and private memory. Use it solo or configure team services.')}</p>
      {editor === undefined ? <>
        {Object.entries(profiles).map(([key, item]) => <Row key={key} title={item.name || key} description={`${item.agentId} · ${item.enabled ? item.routerEndpoint ? c('团队', 'Team') : c('单人', 'Solo') : c('已停用', 'Disabled')}${key === defaultKey ? c(' · 全局默认', ' · Global default') : ''}${snapshot.upstreamPending?.[key] === null ? c(' · 待投记录读取失败', ' · Pending queue unreadable') : ''}`}>
          <Button disabled={disabled} onClick={() => { openKnowledge(key); }}>{c('知识与活动', 'Knowledge and activity')}</Button>
          <Button disabled={disabled} onClick={() => { setEditor({ key, existing: true, team: Boolean(item.routerEndpoint), value: { ...item } }); setChecks(undefined); feedback(''); }}>{c('配置', 'Configure')}</Button>
        </Row>)}
        <div className="acn-actions"><Button primary disabled={disabled} onClick={add}>{c('新建工作配置', 'New configuration')}</Button></div>
        <Row title={c('全局默认配置', 'Global default')} description={c('项目没有可用历史时采用。新会话优先沿用同项目最近新建会话的配置，首发前可改选。', 'Used when the project has no valid history. New sessions inherit its most recently created conversation configuration and can change it before the first message.')}><Select aria-label={c('全局默认配置', 'Global default')} disabled={disabled} value={defaultKey} onChange={(event) => { void persist(withProfiles(profiles, event.target.value)); }}><option value="">{c('不设全局默认', 'No global default')}</option>{Object.entries(profiles).filter(([, item]) => item.enabled).map(([key, item]) => <option key={key} value={key}>{configurationLabel(item.name || key, item.agentId)}</option>)}</Select></Row>
        {guide}
      </> : <form onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}>
        <h3>{editor.existing ? c('编辑工作配置', 'Edit configuration') : c('新建工作配置', 'New configuration')}</h3>
        <label className="acn-field">{c('显示名称（可选）', 'Display name (optional)')}<input style={inputStyle} disabled={disabled} value={editor.value.name} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, name: event.target.value } }); }} /></label>
        <label className="acn-field">Agent ID<input required style={inputStyle} disabled={disabled} value={editor.value.agentId} placeholder="coding" autoComplete="off" onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, agentId: event.target.value } }); }} /></label>
        <p style={muted}>{c('使用小写字母、数字、下划线或连字符。单人使用可自取固定名称，接入团队继续使用此 ID。', 'Use lowercase letters, numbers, underscores or hyphens. Choose a stable ID for solo use; the same ID is used when joining a team.')}</p>
        {original !== undefined && original.agentId !== editor.value.agentId && <p role="status">{c('修改 Agent ID 将使用另一份知识库，原数据保留。旧会话需要恢复原 ID 后继续。', 'Changing the Agent ID selects a different store. Original data is retained; restore the original ID to continue old sessions.')}</p>}
        <details><summary>{c('配置标识（upstream）', 'Configuration key (upstream)')}</summary><input aria-label={c('配置标识', 'Configuration key')} style={inputStyle} disabled={disabled || editor.existing} value={editor.key} placeholder={editor.value.agentId || 'coding'} onChange={(event) => { setEditor({ ...editor, key: event.target.value }); }} /><p style={muted}>{c('新建时留空将按 Agent ID 生成。创建后固定，显示名称仍可修改。', 'Generated from the Agent ID when empty. The key is fixed after creation; the display name can be changed.')}</p></details>
        <Row title={c('连接团队服务', 'Connect team services')} description={c('关闭时使用本地知识。开启后填写两个服务地址，Agent ID 保持同一个。', 'Use local knowledge when off. When on, enter both service URLs; the Agent ID stays the same.')}><input type="checkbox" role="switch" aria-label={c('连接团队服务', 'Connect team services')} checked={editor.team} disabled={disabled} onChange={(event) => { setEditor({ ...editor, team: event.target.checked }); setChecks(undefined); }} /></Row>
        {editor.team && <>{guide}<div className="acn-connection-fields">{([['routerEndpoint', t('router')], ['maintainerEndpoint', t('maintainer')], ['keyEnv', t('keyEnv')]] as const).map(([field, label]) => <label key={field} className="acn-field">{label}<input style={inputStyle} required={field !== 'keyEnv'} type={field === 'keyEnv' ? 'text' : 'url'} autoComplete="off" disabled={disabled} value={editor.value[field]} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, [field]: event.target.value } }); setChecks(undefined); }} /></label>)}<label className="acn-field">{t('timeout')}<input type="number" min="1" style={inputStyle} value={editor.value.timeoutMs} disabled={disabled} onChange={(event) => { setEditor({ ...editor, value: { ...editor.value, timeoutMs: Number(event.target.value) } }); }} /></label></div><p style={muted}>{t('keyHint')}</p><p style={muted}>{c('单人期间的历史 Claim 可继续本地使用，接入团队后不会整库补传。', 'Solo claims remain available locally and are not automatically uploaded when joining.')}</p></>}
        {changingTeam && <p role="status">{c('修改地址会沿用当前知识库。', 'Changing URLs keeps this knowledge store.')}{pendingText}{c('新配置启动后，符合重试条件的记录可能发往新地址。需要隔离团队时请新建工作配置。', 'Eligible pending records may be sent to the new URLs after activation. Create another configuration to isolate teams.')}</p>}
        <div className="acn-actions">{editor.team && <Button disabled={disabled} onClick={() => { void checkProfile(); }}>{c('检查连接', 'Check connection')}</Button>}<Button primary disabled={disabled} type="submit">{c('保存配置', 'Save configuration')}</Button><Button disabled={busy} onClick={() => { probe.current?.abort(); setEditor(undefined); setChecks(undefined); feedback(''); }}>{c('取消编辑', 'Cancel editing')}</Button></div>
        {checks?.map((item) => <p key={item.service} role={item.state === 'failed' ? 'alert' : 'status'}>{item.service} · {item.message}</p>)}
        {editor.existing && original !== undefined && <Row title={editor.value.enabled ? c('停用配置', 'Disable configuration') : c('恢复配置', 'Enable configuration')} description={c('停用会暂停此配置的知识访问，数据保留，可以恢复。', 'Disabling pauses knowledge access and retains data. You can restore it.')}><Button disabled={disabled} onClick={() => { const next = { ...profiles, [editor.key]: { ...original, enabled: !editor.value.enabled } }; void persist(withProfiles(next, defaultKey === editor.key ? '' : defaultKey)).then((ok) => { if (ok) setEditor(undefined); }); }}>{editor.value.enabled ? c('停用', 'Disable') : c('恢复', 'Enable')}</Button></Row>}
      </form>}
    </>}
    {tab === 'knowledge' && <>
      <Row title={c('知识处理模型', 'Knowledge model')} description={t('modelHint')}><Select aria-label={c('知识处理模型', 'Knowledge model')} disabled={disabled} value={JSON.stringify([values.provider, values.model])} onChange={(event) => { void chooseModel(event.target.value); }}><option value={JSON.stringify(['', ''])}>{t('automatic')}</option>{values.provider && !snapshot.models.some((item) => item.provider === values.provider && item.id === values.model) && <option value={JSON.stringify([values.provider, values.model])}>{values.model} — {t('unavailableModel')}</option>}{snapshot.models.map((item) => <option key={JSON.stringify([item.provider, item.id])} value={JSON.stringify([item.provider, item.id])}>{item.providerName} / {item.name}</option>)}</Select></Row>
      <Row title={c('显示知识处理结果', 'Show knowledge results')} description={c('在来源会话显示简短结果，完整记录可在知识与活动中查看。', 'Show short results in the source session. Full records are available in knowledge and activity.')}><input type="checkbox" role="switch" aria-label={c('显示知识处理结果', 'Show knowledge results')} disabled={disabled} checked={values.showCompletion !== false} onChange={(event) => { void persist({ ...values, showCompletion: event.target.checked }); }} /></Row>
      <form onSubmit={(event) => { event.preventDefault(); void persist({ ...values, home }); }}><label className="acn-field">{t('home')}<input required style={inputStyle} disabled={disabled} value={home} onChange={(event) => { setHome(event.target.value); }} /></label><p style={muted}>{c('所有工作配置的知识根目录。修改后使用新目录，原数据保留。', 'Knowledge root for all configurations. Changing it selects a new directory and retains original data.')}</p><div className="acn-actions"><Button primary type="submit" disabled={disabled || home === values.home}>{c('保存目录', 'Save directory')}</Button></div></form>
    </>}
    {probing && <Button onClick={() => { probe.current?.abort(); setProbing(false); feedback(c('已取消检查。', 'Check cancelled.')); }}>{c('取消检查', 'Cancel check')}</Button>}
    <div className="acn-actions"><Button disabled={disabled} title={t('reloadHint')} onClick={() => { void reload(); }}>{t('reload')}</Button></div><p style={muted}>{c('重新加载将丢弃未保存的修改。', 'Reloading discards unsaved changes.')}</p>
  </Tabs></div>;
}
