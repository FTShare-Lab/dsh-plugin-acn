// 来源链接在点击前重新检查可用性，失效时保留当前详情。
import { useEffect, useRef, useState } from 'react';
import type { SourceSession } from '../interaction.js';
import type { InteractionApi } from './TeamSettingsPage.js';
import { Button } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';

export function SourceSessionLink({ source, api, c, open }: { source: SourceSession; api: InteractionApi; c: Copy; open?: ((id: string) => void) | undefined }) {
  const [checking, setChecking] = useState(false); const [error, setError] = useState(''); const controller = useRef<AbortController>();
  useEffect(() => () => { controller.current?.abort(); }, []);
  const label = source.title || source.id;
  async function navigate() {
    const current = new AbortController(); controller.current = current; setChecking(true); setError('');
    try {
      const result = await api.interact({ action: 'source_session', sessionId: source.id }, current.signal);
      if (!current.signal.aborted) { if (result.ok && result.sourceSession?.available) open?.(source.id); else setError(c('来源会话不可用。', 'Source session unavailable.')); }
    } catch { if (!current.signal.aborted) setError(c('无法打开来源会话。', 'Could not open the source session.')); }
    finally { if (!current.signal.aborted) setChecking(false); }
  }
  return <span className="acn-source-link">{source.available && open ? <Button className="acn-text-button" title={source.id} disabled={checking} onClick={() => { void navigate(); }}>{label}</Button> : <span className="acn-help">{label}{source.available ? '' : c('（不可用）', ' (unavailable)')}</span>}{error && <span role="alert" className="acn-help">{error}</span>}</span>;
}
export function KnowledgeSources({ sources, api, c, open }: { sources?: SourceSession[] | undefined; api: InteractionApi; c: Copy; open?: ((id: string) => void) | undefined }) {
  if (!sources?.length) return null;
  return <div className="acn-source-sessions"><span className="acn-help">{c('来源会话', 'Source sessions')}</span>{sources.map((source) => <SourceSessionLink key={source.id} source={source} api={api} c={c} open={open} />)}</div>;
}
