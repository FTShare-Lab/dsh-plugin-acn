// 来源详情只查当前身份的本地实体，缺失时解释边界，不暗中发起团队请求。
import { displayMessage } from '../interaction-messages.js';
import { useEffect, useRef, useState } from 'react';
import type { InteractionApi } from './TeamSettingsPage.js';
import type { KnowledgeReference as Reference } from '../interaction.js';
import { Button, muted } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
import { KnowledgeDetail } from './KnowledgeDetail.js';
import { KnowledgeSources } from './SourceSessionLink.js';
export function KnowledgeReference({ api, runtimeKey, id, from, origin, c, back, openClaim, openSource }: { api: InteractionApi; runtimeKey: string; id: string; from: string; origin?: HTMLElement | null; c: Copy; back: () => void; openClaim: (id: string, from: string) => void; openSource?: ((id: string) => void) | undefined }) {
  const [data, setData] = useState<Reference>(); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  const heading = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = origin ?? document.activeElement;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView?.({ block: 'start' });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) { previous.focus({ preventScroll: true }); previous.scrollIntoView?.({ block: 'nearest' }); } };
  }, [origin]);
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError('');
    void api.interact({ action: 'reference', key: runtimeKey, id }, controller.signal).then((result) => { if (controller.signal.aborted) return; if (result.ok && result.reference) setData(result.reference); else setError(displayMessage(result.message, c, result.messageInfo) || c('无法读取来源。', 'Could not read source.')); }, () => { if (!controller.signal.aborted) setError(c('无法读取来源，请重试。', 'Could not read source. Retry.')); });
    return () => { controller.abort(); };
  }, [api, runtimeKey, id, refresh, c]);
  return <section className="acn-reference" aria-label={c('来源知识详情', 'Source claim details')}>
    <div className="acn-reference-actions"><button ref={heading} type="button" className="acn-back-link" onClick={back}><span aria-hidden="true">←</span>{c('返回上一条详情', 'Back to previous details')}</button><Button onClick={() => { setRefresh((value) => value + 1); }}>{c('刷新来源', 'Refresh source')}</Button></div>
    <p style={muted}>{c('引用来自', 'Referenced by')}: {from}</p><p>{id}</p>
    {error ? <p role="alert">{error}</p> : data === undefined ? <p role="status">{c('正在读取来源…', 'Reading source…')}</p> : data.item ? <><h3>{data.item.name}</h3><KnowledgeDetail text={data.item.detail} c={c} openClaim={(next) => { openClaim(next, data.item?.name ?? id); }} /><KnowledgeSources sources={data.item.sources} api={api} c={c} open={openSource} /></> : <p role="status">{c('此来源未保存在当前知识库。', 'This source is not in the current local store.')}</p>}
  </section>;
}
