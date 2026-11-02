// 共享设置控件、可键盘切换的标签页与独立弹层，沿用宿主色彩和字号。
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode, SelectHTMLAttributes, ButtonHTMLAttributes } from 'react';
export type Copy = (zh: string, en: string) => string;
export function configurationLabel(name: string, agentId: string): string {
  const label = name.trim() || agentId;
  return !agentId || label === agentId ? label : `${label} · ${agentId}`;
}
export const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, GrayText)', fontSize: 13, lineHeight: 1.55, margin: '4px 0 0' };
export const inputStyle: CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2, #8886)', background: 'var(--dsw-alias-bg-layer-1, Canvas)', color: 'inherit', borderRadius: 8, padding: '7px 10px', font: 'inherit', fontWeight: 400, fontSize: 14, lineHeight: '20px' };
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <span style={{ display: 'block', position: 'relative', maxWidth: '100%', minWidth: 0 }}><select {...props} style={{ ...inputStyle, appearance: 'none', paddingRight: 30, textOverflow: 'ellipsis', ...props.style }} /><svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></span>; }
export function Button({ primary, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) { return <button type="button" {...props} className="acn-btn" style={{ ...inputStyle, width: 'auto', padding: '5px 10px', fontSize: 13, cursor: props.disabled ? 'default' : 'pointer', ...(primary ? { background: 'var(--dsw-alias-label-primary, CanvasText)', color: 'var(--dsw-alias-bg-base, Canvas)', borderColor: 'transparent' } : {}), ...props.style }} />; }
export function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) { return <div className="acn-row"><div><strong style={{ fontWeight: 550 }}>{title}</strong>{description && <p style={muted}>{description}</p>}</div><div>{children}</div></div>; }
export function Tabs<K extends string>({ label, choices, value, change, children, disabled = false }: { label: string; choices: readonly (readonly [K, string])[]; value: K; change: (key: K) => void; children: ReactNode; disabled?: boolean }) {
  const id = useId();
  return <><div role="tablist" aria-label={label} className="acn-tabs" onKeyDown={(e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || disabled) return;
    e.preventDefault(); const i = choices.findIndex(([key]) => key === value); const n = choices.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowLeft' ? n - 1 : 1)) % n;
    const item = choices[next]; if (item) { change(item[0]); e.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus(); }
  }}>{choices.map(([key, title]) => <button type="button" role="tab" key={key} id={id + key} aria-controls={id + '-panel'} aria-selected={key === value} tabIndex={key === value ? 0 : -1} disabled={disabled} onClick={() => { if (key !== value) change(key); }} className="acn-tab">{title}</button>)}</div><div role="tabpanel" id={id + '-panel'} aria-labelledby={id + value}>{children}</div></>;
}
export function Modal({ title, close, closeLabel, children }: { title: string; close: () => void; closeLabel: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement; root.current?.querySelector<HTMLButtonElement>('button')?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  return createPortal(<div className="acn-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div ref={root} role="dialog" aria-modal="true" aria-label={title} className="acn-surface acn-modal" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') { const fields = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0); const first = fields[0]; const last = fields[fields.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}><div className="acn-modal-header"><h2>{title}</h2><button type="button" className="acn-dismiss" onClick={close} aria-label={closeLabel}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m3 3 10 10m0-10L3 13" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg></button></div><div className="acn-modal-body">{children}</div></div></div>, document.body);
}
