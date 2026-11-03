// 来源详情只查当前身份的本地实体，缺失时解释边界，不暗中发起团队请求。
import { displayMessage } from '../interaction-messages.js';
import { useEffect, useState } from 'react';
import type { InteractionApi } from './TeamSettingsPage.js';
import type { KnowledgeReference as Reference } from '../interaction.js';
import { Button, muted } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
import { KnowledgeDetail } from './KnowledgeDetail.js';
export function KnowledgeReference({ api, runtimeKey, id, from, c, back, openClaim }: { api: InteractionApi; runtimeKey: string; id: string; from: string; c: Copy; back: () => void; openClaim: (id: string, from: string) => void }) {
  const [data, setData] = useState<Reference>(); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError('');
    void api.interact({ action: 'reference', key: runtimeKey, id }, controller.signal).then((result) => { if (controller.signal.aborted) return; if (result.ok && result.reference) setData(result.reference); else setError(displayMessage(result.message, c, result.messageInfo) || c('无法读取来源。', 'Could not read source.')); }, () => { if (!controller.signal.aborted) setError(c('无法读取来源，请重试。', 'Could not read source. Retry.')); });
    return () => { controller.abort(); };
  }, [api, runtimeKey, id, refresh, c]);
  return <section aria-label={c('来源知识详情', 'Source claim details')}>
    <div className="acn-actions"><Button onClick={back}>{c('返回上一条详情', 'Back to previous details')}</Button><Button onClick={() => { setRefresh((value) => value + 1); }}>{c('刷新来源', 'Refresh source')}</Button></div>
    <p style={muted}>{c('引用来自', 'Referenced by')}: {from}</p><p>{id}</p>
    {error ? <p role="alert">{error}</p> : data === undefined ? <p role="status">{c('正在读取来源…', 'Reading source…')}</p> : data.item ? <><h3>{data.item.name}</h3><KnowledgeDetail text={data.item.detail} c={c} openClaim={(next) => { openClaim(next, data.item?.name ?? id); }} /></> : <p role="status">{c('此来源不在当前工作配置的本地知识库中。它可能是尚未内化的团队知识，或已移除的本地来源。浏览不会自动查询团队；团队工具只支持按主题和范围检索，不支持按此 ID 精确读取；可以让 Agent 按来源主题尝试查找，但不保证找回此条来源。', 'This source is absent from this configuration’s local store. It may be team knowledge that has not been internalized, or a removed local source. Browsing never queries the team automatically; Team tools search by topic and scope, without exact ID reads. The Agent can try a topic search, but may not retrieve this particular source.')}</p>}
  </section>;
}
