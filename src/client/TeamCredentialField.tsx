// 密钥草稿默认掩码显示；已存密钥只读取状态，显隐按钮不向宿主请求正文。
import { displayMessage } from '../interaction-messages.js';
import { useEffect, useId, useState } from 'react';
import type { CredentialRequest, CredentialResult } from '../credentials.js';
import { muted, inputStyle } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
type CredentialApi = (request: CredentialRequest, signal?: AbortSignal) => Promise<CredentialResult>;
export function TeamCredentialField({ reference, api, c, disabled, value, change, refresh, removed = false, bound = false, remove }: { reference: string; api?: CredentialApi | undefined; c: Copy; disabled: boolean; value: string; change: (value: string) => void; refresh: number; removed?: boolean; bound?: boolean; remove?: () => void }) {
  const id = useId(); const [visible, setVisible] = useState(false); const [status, setStatus] = useState<CredentialResult>();
  useEffect(() => {
    setVisible(false); setStatus(undefined);
    if (api === undefined) return;
    const controller = new AbortController();
    void api({ action: 'describe', reference }, controller.signal).then((result) => { if (!controller.signal.aborted) setStatus(result); }, () => { if (!controller.signal.aborted) setStatus({ ok: false, message: c('无法读取密钥状态，请重新打开配置。', 'Could not read key status; reopen configuration.') }); });
    return () => { controller.abort(); };
  }, [api, reference, refresh]);
  useEffect(() => { if (disabled || value === '') setVisible(false); }, [disabled, value]);
  const label = c('团队鉴权密钥', 'Team authentication key');
  const toggle = visible ? c('隐藏密钥', 'Hide key') : c('显示密钥', 'Show key');
  return <div>
    <div className="acn-field"><label htmlFor={id}>{label}</label><div style={{ position: 'relative' }}>
      <input id={id} type={visible ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} autoCapitalize="none" style={{ ...inputStyle, paddingRight: 42 }} disabled={disabled} value={value} placeholder={removed ? c('保存后不使用团队密钥', 'No team key after saving') : status?.configured ? c('••••••••（已设置，留空保留）', '•••••••• (configured; leave blank to keep)') : c('粘贴团队管理员提供的 key，无鉴权时留空', 'Paste the key supplied by your administrator; optional without authentication')} onChange={(event) => { change(event.target.value); }} />
      <button type="button" aria-label={toggle} aria-controls={id} aria-pressed={visible} title={value === '' ? c('输入新密钥后可切换显示', 'Enter a new key to toggle visibility') : toggle} disabled={disabled || value === ''} onClick={() => { setVisible((current) => !current); }} style={{ position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)', display: 'grid', placeItems: 'center', width: 30, height: 30, padding: 4, border: 0, borderRadius: 5, color: 'inherit', background: 'transparent', cursor: disabled || value === '' ? 'default' : 'pointer', opacity: disabled || value === '' ? 0.4 : 0.7 }}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{visible && <path d="m3 3 18 18" />}</svg>
      </button>
    </div></div>
    {(bound || status?.configured || removed) && remove && <button type="button" className="acn-btn" disabled={disabled} onClick={remove}>{removed ? c('撤销移除', 'Undo removal') : c('移除密钥绑定', 'Remove key binding')}</button>}
    {removed && <p role="status" style={muted}>{c('保存后新启动的会话不再发送团队密钥，已启动的会话仍保留原连接。', 'New sessions will not send a team key after saving. Existing sessions retain their connection.')}</p>}
    {!removed && <p style={muted}>{(status === undefined ? '' : displayMessage(status.message, c, status.messageInfo)) || (status?.configured ? c('已设置密钥。留空保留现有密钥，输入新密钥可替换。', 'Key configured. Leave blank to keep it, or enter a replacement.') : c('点击「保存配置」时保存密钥，由 DSH 托管。', 'The key is stored by DSH when you save the configuration.'))}</p>}
    {!removed && (status?.writable === false || status?.ok === false) && <p style={muted}>{c('仍可输入密钥检查连接；保存新密钥需要可写的 DSH 凭据托管服务。', 'You can still enter a key to check the connection. Saving a new key requires writable DSH credential storage.')}</p>}
  </div>;
}
