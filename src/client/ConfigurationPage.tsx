// 配置草稿只在保存成功后采用服务端快照；冲突与未知结果不会伪装成成功。
import { useEffect, useId, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode, SelectHTMLAttributes } from 'react';
import type { ConfigurationResult, ConfigurationSnapshot, ConfigurationValues, SaveConfiguration } from '../configuration.js';
import type { ConfigurationText } from './locales.js';

export interface ConfigurationApi {
  read: (signal?: AbortSignal) => Promise<ConfigurationSnapshot>;
  save: (request: SaveConfiguration) => Promise<ConfigurationResult>;
}
export interface ConfigurationPageProps { api: ConfigurationApi; t: (key: ConfigurationText) => string }
const control: CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l3, #b6b6b6)', borderRadius: 8, padding: '9px 12px', background: 'var(--dsw-alias-bg-layer-1, Canvas)', color: 'inherit', font: 'inherit' };
const section: CSSProperties = { display: 'grid', gap: 16, margin: 0, padding: '20px 0', border: 0, borderBottom: '1px solid var(--dsw-alias-border-l1, #b6b6b6)' };
const hint: CSSProperties = { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, inherit)', margin: '6px 0 0' };
function Field({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return <label style={{ display: 'block', fontSize: 14 }}><span style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>{label}</span>{children}<span style={{ ...hint, display: 'block' }}>{help}</span></label>;
}
function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  // 保留原生键盘与弹出菜单，只替换装饰箭头，避免平台默认箭头贴住边框。
  return <span style={{ display: 'block', position: 'relative' }}>
    <select {...props} style={{ ...control, appearance: 'none', WebkitAppearance: 'none', paddingRight: 40 }} />
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>;
}

export function ConfigurationPage({ api, t }: ConfigurationPageProps) {
  const reloadHintId = useId();
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>();
  const [values, setValues] = useState<ConfigurationValues>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ key: ConfigurationText; fields?: string[]; error: boolean }>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api.read(controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setSnapshot(next); setValues(next.values); setMessage(undefined);
    }, () => { if (!controller.signal.aborted) setMessage({ key: 'errorLoad', error: true }); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [api, reload]);
  const change = <K extends keyof ConfigurationValues>(key: K, value: ConfigurationValues[K]) => {
    setValues((current) => current === undefined ? current : { ...current, [key]: value });
    setMessage(undefined);
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (snapshot === undefined || values === undefined || saving) return;
    setSaving(true); setMessage(undefined);
    try {
      const result = await api.save({ revision: snapshot.revision, values });
      if (result.ok) {
        setSnapshot(result.snapshot); setValues(result.snapshot.values); setMessage({ key: 'saved', error: false });
      } else {
        setMessage({ key: result.code === 'inactive' ? 'activation' : result.code, fields: result.fields, error: true });
      }
    } catch { setMessage({ key: 'errorTransport', error: true }); }
    finally { setSaving(false); }
  }
  const selected = values === undefined ? '' : JSON.stringify([values.provider, values.model]);
  const automatic = JSON.stringify(['', '']);
  const knownModel = snapshot?.models.some((model) => JSON.stringify([model.provider, model.id]) === selected) ?? false;
  const dirty = snapshot !== undefined && values !== undefined && JSON.stringify(values) !== JSON.stringify(snapshot.values);
  const feedback = message !== undefined && <p role={message.error ? 'alert' : 'status'} style={{ fontSize: 14, lineHeight: 1.6, margin: '8px 0 0', color: message.error ? 'var(--dsw-alias-state-error-primary, #b42318)' : 'inherit' }}>{t(message.key)}{message.fields?.length ? ` ${message.fields.join(', ')}` : ''}</p>;
  return <div style={{ maxWidth: 760, padding: '12px 4px 28px', lineHeight: 1.5 }}>
    <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>{t('title')}</h2>
    <p style={hint}>{t('intro')}</p>
    {loading && <p role="status">{t('loading')}</p>}
    {snapshot !== undefined && values !== undefined && <form onSubmit={(event) => { void save(event); }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--dsw-alias-bg-layer-1, Canvas)', padding: '14px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, #b6b6b6)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <p role="status" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t(dirty ? 'unsaved' : snapshot.values.agentId === '' ? 'pending' : 'noChanges')}</p>
            <p style={hint}>{t('saveHint')}</p>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <button type="submit" disabled={saving || loading} style={{ ...control, width: 'auto', fontWeight: 600, borderColor: 'transparent', background: 'var(--dsw-alias-button-primary-fill, #4361ee)', color: 'var(--dsw-alias-label-primary-foreground, #fff)' }}>{t(saving ? 'saving' : 'save')}</button>
            <span style={{ display: 'grid', gap: 4 }}>
              <button type="button" disabled={saving || loading} title={t('reloadHint')} aria-describedby={reloadHintId} style={{ ...control, width: 'auto' }} onClick={() => { setReload((current) => current + 1); }}>{t('reload')}</button>
              <span id={reloadHintId} style={{ ...hint, margin: 0, fontSize: 12 }}>{t('reloadHint')}</span>
            </span>
          </div>
        </div>
        {feedback}
      </div>
      <fieldset disabled={saving || loading} style={{ border: 0, padding: 0, margin: 0 }}>
        <section style={section} aria-label={t('identity')}>
          <strong>{t('identity')}</strong>
          <Field label={t('agentId')} help={t(values.mode === 'solo' ? 'agentSoloHint' : 'agentTeamHint')}><input style={control} value={values.agentId} required placeholder="personal" autoComplete="off" onChange={(event) => { change('agentId', event.target.value); }} /></Field>
          <Field label={t('home')} help={t('homeHint')}><input style={control} value={values.home} required autoComplete="off" onChange={(event) => { change('home', event.target.value); }} /></Field>
          <p style={hint}>{t('switchHint')}</p>
        </section>
        <section style={section} aria-label={t('model')}>
          <Field label={t('model')} help={t('modelHint')}>
            <Select value={selected} onChange={(event) => {
              const model = snapshot.models.find((item) => JSON.stringify([item.provider, item.id]) === event.target.value);
              setValues((current) => current === undefined ? current : { ...current, provider: model?.provider ?? '', model: model?.id ?? '' }); setMessage(undefined);
            }}>
              <option value={automatic}>{t('automatic')}</option>
              {!knownModel && selected !== automatic && <option value={selected}>{values.provider} / {values.model} — {t('unavailableModel')}</option>}
              {snapshot.models.map((model) => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.provider} / {model.id}</option>)}
            </Select>
          </Field>
          <p style={hint}>{t('modelHelp')}</p>
        </section>
        <section style={section} aria-label={t('connection')}>
          <strong>{t('connection')}</strong>
          <Field label={t('mode')} help={t(values.mode === 'solo' ? 'soloHint' : 'teamHint')}>
            <Select value={values.mode} onChange={(event) => { change('mode', event.target.value === 'team' ? 'team' : 'solo'); }}><option value="solo">{t('solo')}</option><option value="team">{t('team')}</option></Select>
          </Field>
          {values.mode === 'team' && <>
            <Field label={t('router')} help=""><input style={control} type="url" value={values.routerEndpoint} required placeholder="http://127.0.0.1:8001" onChange={(event) => { change('routerEndpoint', event.target.value); }} /></Field>
            <Field label={t('maintainer')} help=""><input style={control} type="url" value={values.maintainerEndpoint} required placeholder="http://127.0.0.1:8002" onChange={(event) => { change('maintainerEndpoint', event.target.value); }} /></Field>
            <Field label={t('keyEnv')} help={t('keyHint')}><input style={control} value={values.keyEnv} autoComplete="off" placeholder="ACN_TEAM_TOKEN" onChange={(event) => { change('keyEnv', event.target.value); }} /></Field>
            <Field label={t('timeout')} help={t('timeoutHint')}><input style={control} type="number" min={1} step={1} required value={values.timeoutMs} onChange={(event) => { change('timeoutMs', Number(event.target.value)); }} /></Field>
          </>}
        </section>
      </fieldset>
      <p style={hint}>{t(!snapshot.active ? 'inactive' : snapshot.values.agentId === '' ? 'pending' : 'active')}</p>
      {snapshot.dataDirectory !== '' && <p style={{ ...hint, overflowWrap: 'anywhere' }}>{t('directory')}: <code>{snapshot.dataDirectory}</code></p>}
    </form>}
    {snapshot === undefined && feedback}
    {snapshot === undefined && !loading && <button type="button" onClick={() => { setReload((current) => current + 1); }}>{t('reload')}</button>}
  </div>;
}
