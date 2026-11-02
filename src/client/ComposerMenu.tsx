// 弹出菜单和通知渲染在输入框外，菜单贴近入口并保持在可视范围内。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Copy } from './interaction-ui.js';
type IconName = 'network' | 'chevron' | 'book' | 'sync' | 'recap' | 'settings' | 'check' | 'user' | 'close';
const paths: Record<IconName, ReactNode> = {
  network: <><path d="m6 6 11 1-5 11z" /><circle cx="5" cy="5" r="2.8" /><circle cx="18" cy="6" r="2.8" /><circle cx="12" cy="18" r="2.8" /></>,
  chevron: <path d="m6 9 6 6 6-6" />, book: <><path d="M12 6v14M3 4c4 0 7 .2 9 2 2-1.8 5-2 9-2v14c-4 0-7 .2-9 2-2-1.8-5-2-9-2z" /></>,
  sync: <><path d="M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5m-4 7a8 8 0 0 0 14 2l3-3m0 5v-5h-5" /></>, recap: <><path d="M4 11a8 8 0 1 1 1.5 6M4 5v6h6m2-4v5l3 2" /></>,
  settings: <><path d="M3 7h7m5 0h6M3 17h12m4 0h2" /><circle cx="12" cy="7" r="2.5" /><circle cx="17" cy="17" r="2.5" /></>,
  check: <path d="m4 12 5 5L20 6" />, user: <><circle cx="12" cy="7" r="3" /><path d="M4 20a8 8 0 0 1 16 0" /></>, close: <path d="m6 6 12 12M18 6 6 18" />,
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>; }
export function MenuItem({ icon, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName }) {
  return <button type="button" role="menuitem" tabIndex={-1} {...props} className="acn-item"><Icon name={icon} />{children}</button>;
}
export function ComposerMenu({ anchor, close, id, label, children }: { anchor: RefObject<HTMLButtonElement>; close: () => void; id: string; label: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 400 });
  useLayoutEffect(() => {
    const el = root.current; const trigger = anchor.current;
    if (!el || !trigger) return;
    const place = () => {
      const a = trigger.getBoundingClientRect(); const gap = 6; const margin = 8;
      const above = Math.max(0, a.top - gap - margin); const below = Math.max(0, window.innerHeight - a.bottom - gap - margin);
      const upwards = above >= el.scrollHeight || above >= below;
      const maxHeight = Math.max(1, upwards ? above : below);
      setPosition({ left: Math.max(margin, Math.min(a.left, window.innerWidth - el.offsetWidth - margin)), top: upwards ? Math.max(margin, a.top - gap - Math.min(el.scrollHeight + 2, maxHeight)) : a.bottom + gap, maxHeight });
    };
    place(); const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place); ro?.observe(el); ro?.observe(trigger);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    return () => { ro?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);
  useEffect(() => {
    const outside = (event: Event) => { if (event.target instanceof Node && !root.current?.contains(event.target) && !anchor.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [anchor, close]);
  return createPortal(<div ref={root} id={id} role="menu" aria-label={label} className="acn-menu acn-surface" style={position} onKeyDown={(event) => {
    const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); anchor.current?.focus(); close(); }
    else if (keys.includes(event.key)) { event.preventDefault(); event.stopPropagation(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const i = items.indexOf(document.activeElement as HTMLButtonElement); const n = items.length; items[event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : (i + (event.key === 'ArrowUp' ? n - 1 : 1)) % n]?.focus(); }
  }}>{children}</div>, document.body);
}
export function Notice({ children, c, close, failed = false }: { children: ReactNode; c: Copy; close: () => void; failed?: boolean }) {
  return createPortal(<aside className="acn-notice acn-surface"><div role={failed ? 'alert' : 'status'}>{children}</div><button type="button" className="acn-dismiss" aria-label={c('关闭提示', 'Dismiss notification')} onClick={close}><Icon name="close" size={14} /></button></aside>, document.body);
}
