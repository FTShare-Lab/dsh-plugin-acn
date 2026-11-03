// 知识浏览与处理活动独立于同步；筛选、展开和刷新只读取当前身份的公开台账。
import { useEffect, useState } from 'react';
import { settingsUpstreams } from './TeamSettingsPage.js';
import type { InteractionApi } from './TeamSettingsPage.js';
import type { KnowledgeView } from '../interaction.js';
import { Button, Select, Tabs, configurationLabel, inputStyle, muted } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
import { KnowledgeReference } from './KnowledgeReference.js';
import { KnowledgeDetail } from './KnowledgeDetail.js';
export function KnowledgePanel({ api, initialKey, initialTab = 'knowledge', c, openSource }: { api: InteractionApi; initialKey: string; initialTab?: 'knowledge' | 'activity'; c: Copy; openSource?: (id: string) => void }) {
  const [key, setKey] = useState(initialKey); const [choices, setChoices] = useState<{ key: string; name: string }[]>([]);
  const [tab, setTab] = useState<'knowledge' | 'activity'>(initialTab);
  const [kind, setKind] = useState<'claim' | 'dispute' | 'trace'>('claim'); const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0); const [data, setData] = useState<KnowledgeView>();
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const [sourceOnly, setSourceOnly] = useState(''); const [attention, setAttention] = useState(false);
  const [references, setReferences] = useState<{ id: string; from: string }[]>([]);
  const reference = references.at(-1);
  const openClaim = (id: string, from: string) => { setReferences((items) => [...items, { id, from }]); };
  useEffect(() => { const controller = new AbortController(); void api.read(controller.signal).then((snapshot) => { if (!controller.signal.aborted) setChoices(Object.entries(settingsUpstreams(snapshot.values)).map(([key, item]) => ({ key, name: `${configurationLabel(item.name || key, item.agentId)}${item.enabled ? '' : c('（已停用）', ' (disabled)')}` }))); }, () => { if (!controller.signal.aborted) setMessage(c('无法加载身份列表。', 'Could not load identities.')); }); return () => { controller.abort(); }; }, [api, c]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true);
    void api.interact(tab === 'activity' ? { action: 'activity', key } : { action: 'knowledge', key, kind, query, offset }, controller.signal).then((result) => { if (controller.signal.aborted) return; if (result.ok && result.knowledge !== undefined) { setData(result.knowledge); setMessage(''); } else { setData(undefined); setMessage(result.message); } }, () => { if (!controller.signal.aborted) { setData(undefined); setMessage(c('无法读取本地知识，请重试。', 'Could not read local knowledge. Retry.')); } }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); };
  }, [api, key, tab, kind, query, offset, refresh, c]);
  async function retry(id: string) {
    setBusy(true);
    try { const result = await api.interact({ action: 'retry', key, id }); setMessage(result.message); setRefresh((value) => value + 1); }
    catch { setMessage(c('无法确认重试结果，请刷新活动。', 'Retry result is unknown; refresh activity.')); } finally { setBusy(false); }
  }
  const activities = data?.activities.filter((item) => (!attention || item.state === 'failed' || item.state === 'paused') && (sourceOnly === '' || item.sessionId === sourceOnly)) ?? [];
  const stateLabel = (state: string) => ({ queued: c('等待处理', 'Queued'), running: c('正在处理', 'Running'), succeeded: c('本地处理完成', 'Locally completed'), failed: c('处理失败', 'Failed'), paused: c('已暂停', 'Paused') })[state] ?? state;
  return <div className="acn-page">
    <div className="acn-actions" style={{ margin: '4px 0 10px' }}><Select aria-label={c('知识身份', 'Knowledge identity')} value={key} onChange={(event) => { setKey(event.target.value); setOffset(0); setData(undefined); setReferences([]); }}>{choices.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</Select>
    <Button disabled={busy} onClick={() => { setRefresh((value) => value + 1); }}>{c('刷新', 'Refresh')}</Button></div>
    {reference && <KnowledgeReference key={references.length} api={api} runtimeKey={key} id={reference.id} from={reference.from} c={c} back={() => { setReferences((items) => items.slice(0, -1)); }} openClaim={openClaim} />}
    <div hidden={reference !== undefined}><Tabs<'knowledge' | 'activity'> label={c('知识页面', 'Knowledge pages')} choices={[[ 'knowledge', c('本地知识', 'Local knowledge') ], [ 'activity', c('处理活动', 'Activity') ]]} value={tab} change={(next) => { setData(undefined); setTab(next); }}>
    <p style={muted}>{c('浏览不会同步收件或调用模型。已完成本地处理不等于团队上传完成。', 'Browsing does not sync or call a model. Local completion does not imply team delivery.')}</p>
    {message && <p role="status">{message}</p>}{busy && <p role="status">{c('正在读取…', 'Loading…')}</p>}
    {data && <p style={muted}>{c('等待团队投递', 'Pending team delivery')}: Claim {data.pendingClaims} · Dispute {data.pendingDisputes}</p>}
    {tab === 'knowledge' ? <div>
      <div style={{ display: 'flex', gap: 12, margin: '16px 0', flexWrap: 'wrap' }}><Select aria-label={c('知识类型', 'Knowledge type')} value={kind} onChange={(event) => { setKind(event.target.value === 'trace' ? 'trace' : event.target.value === 'dispute' ? 'dispute' : 'claim'); setOffset(0); }}><option value="claim">Claim</option><option value="dispute">Dispute</option><option value="trace">Trace</option></Select><input aria-label={c('搜索知识', 'Search knowledge')} placeholder={c('搜索名称、范围或正文', 'Search names, scopes, or content')} style={{ ...inputStyle, flex: '1 1 240px' }} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></div>
      {data?.items.length === 0 && <p style={muted}>{c('暂无符合条件的知识。复盘可能没有产出，也可能更新已有知识。', 'No matching knowledge. A recap may update existing knowledge or produce no changes.')}</p>}
      {data?.items.map((item) => <details key={`${key}:${kind}:${item.id}`} style={{ padding: '13px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)' }}><summary style={{ cursor: 'pointer' }}><strong>{item.name}</strong> <span style={muted}>{item.status} · {item.id}</span></summary><KnowledgeDetail text={item.detail} c={c} openClaim={(id) => { openClaim(id, `${item.name} · ${item.id}`); }} /></details>)}
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}><Button disabled={busy || offset === 0} onClick={() => { setOffset(Math.max(0, offset - 30)); }}>{c('上一页', 'Previous')}</Button><Button disabled={busy || !data?.omitted} onClick={() => { setOffset(offset + 30); }}>{c('下一页', 'Next')}</Button></div>
    </div> : <div>
      <div style={{ display: 'flex', gap: 16, margin: '16px 0', alignItems: 'center', flexWrap: 'wrap' }}><label><input type="checkbox" checked={attention} onChange={(event) => { setAttention(event.target.checked); }} /> {c('只看需要处理', 'Needs attention')}</label><input style={{ ...inputStyle, width: 'auto' }} aria-label={c('来源会话筛选', 'Filter source session')} placeholder={c('按来源会话 ID 筛选', 'Source session ID')} value={sourceOnly} onChange={(event) => { setSourceOnly(event.target.value); }} /></div>
      {data && activities.length === 0 && <p style={muted}>{c('暂无处理活动。', 'No activity.')}</p>}
      {activities.map((item) => <details key={item.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)' }}><summary style={{ cursor: 'pointer' }}>{item.kind} · {stateLabel(item.state)} <span style={muted}>{new Date(item.updatedAt).toLocaleString()}</span></summary><p>{item.summary}</p>{item.error && <p role="alert">{item.error}</p>}<p style={muted}>{item.id} · {c('尝试次数', 'Attempts')}: {item.attempts}</p>{item.sessionId && <p style={muted}>{c('来源会话', 'Source session')}: {item.sessionId}{openSource && <Button onClick={() => { openSource(item.sessionId ?? ''); }}>{c('打开会话', 'Open session')}</Button>}</p>}{(item.state === 'failed' || item.state === 'paused') && <Button disabled={busy} onClick={() => { void retry(item.id); }}>{c('重试任务', 'Retry task')}</Button>}</details>)}
    </div>}
    </Tabs></div>
  </div>;
}
