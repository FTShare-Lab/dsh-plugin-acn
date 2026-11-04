// 目录选择只更新草稿，打开目录交给主机的桌面能力；取消选择保留输入。
import { useId, useState } from 'react';
import type { InteractionApi } from './TeamSettingsPage.js';
import { Button, inputStyle } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
export function KnowledgeDirectoryField({ value, change, busy, api, c, label, feedback }: { value: string; change: (path: string) => void; busy: boolean; api: InteractionApi; c: Copy; label: string; feedback: (text: string, failed?: boolean) => void }) {
  const id = useId(); const [working, setWorking] = useState(false);
  async function choose() {
    if (!api.pickDirectory) return;
    setWorking(true);
    try { const selected = await api.pickDirectory(); if (selected !== null) change(selected); }
    catch { feedback(c('无法打开目录选择器，请稍后重试。', 'Could not open the folder chooser. Try again.'), true); }
    finally { setWorking(false); }
  }
  async function open() {
    setWorking(true);
    try { const result = await api.interact({ action: 'open_directory', path: value }); if (!result.ok) feedback(c(result.message, 'Could not open the directory. Check that it exists and is accessible.'), true); }
    catch { feedback(c('无法打开目录，请检查路径是否存在。', 'Could not open the directory. Check that it exists.'), true); }
    finally { setWorking(false); }
  }
  return <div className="acn-field"><label htmlFor={id}>{label}</label><div className="acn-directory-control"><div className="acn-directory-input"><input id={id} required style={{ ...inputStyle, paddingRight: 42 }} disabled={busy || working} value={value} onChange={(event) => { change(event.target.value); }} /><button type="button" className="acn-directory-picker" aria-label={c('选择知识目录', 'Choose knowledge directory')} title={c('选择文件夹', 'Choose folder')} disabled={busy || working || !api.pickDirectory} onClick={() => { void choose(); }}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z" /></svg></button></div><Button disabled={busy || working || !value.trim()} onClick={() => { void open(); }}>{c('打开目录', 'Open directory')}</Button></div></div>;
}
