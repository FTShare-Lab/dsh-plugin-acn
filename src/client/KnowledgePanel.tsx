// 知识浏览与处理活动独立于同步；筛选、展开和刷新只读取当前身份的公开台账。
import { useEffect, useRef, useState } from 'react';
import { settingsUpstreams } from './TeamSettingsPage.js';
import type { InteractionApi } from './TeamSettingsPage.js';
import { displayMessage } from '../interaction-messages.js';
import { ActivityDetails, activityState } from './ActivityDetails.js';
import type { InteractionRequest, KnowledgeView } from '../interaction.js';
import { Button, Select, Tabs, configurationLabel, inputStyle, muted } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
import { KnowledgeReference } from './KnowledgeReference.js';
import { KnowledgeDetail } from './KnowledgeDetail.js';
export function KnowledgePanel({ api, initialKey, initialTab = 'knowledge', c, openSource, openSettings }: { api: InteractionApi; initialKey: string; initialTab?: 'knowledge' | 'activity'; c: Copy; openSource?: (id: string) => void; openSettings?: (() => void) | undefined }) {
  const [key, setKey] = useState(initialKey); const [choices, setChoices] = useState<{ key: string; name: string }[]>([]);
  const [tab, setTab] = useState<'knowledge' | 'activity'>(initialTab);
  const [kind, setKind] = useState<'claim' | 'dispute' | 'trace'>('claim'); const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0); const [activityOffset, setActivityOffset] = useState(0); const [data, setData] = useState<KnowledgeView>();
  const [message, setMessage] = useState(''); const [readError, setReadError] = useState('');
  const [acting, setActing] = useState(false); const actionController = useRef<AbortController>();
  useEffect(() => () => { actionController.current?.abort(); }, []);
  const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const [sourceOnly, setSourceOnly] = useState(''); const [attention, setAttention] = useState(false);
  const [references, setReferences] = useState<{ id: string; from: string }[]>([]);
  const reference = references.at(-1);
  const openClaim = (id: string, from: string) => { setReferences((items) => [...items, { id, from }]); };
  useEffect(() => { const controller = new AbortController(); void api.read(controller.signal).then((snapshot) => { if (!controller.signal.aborted) setChoices(Object.entries(settingsUpstreams(snapshot.values)).map(([key, item]) => ({ key, name: `${configurationLabel(item.name || key, item.agentId)}${item.enabled ? '' : c('（已停用）', ' (disabled)')}` }))); }, () => { if (!controller.signal.aborted) setMessage(c('无法加载身份列表。', 'Could not load identities.')); }); return () => { controller.abort(); }; }, [api, c]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true);
    void api.interact(tab === 'activity' ? { action: 'activity', key, attentionOnly: attention, sourceSession: sourceOnly, offset: activityOffset } : { action: 'knowledge', key, kind, query, offset }, controller.signal).then((result) => { if (controller.signal.aborted) return; if (result.ok && result.knowledge !== undefined) { setData(result.knowledge); setReadError(''); } else { setData(undefined); setReadError(displayMessage(result.message, c, result.messageInfo)); } }, () => { if (!controller.signal.aborted) { setData(undefined); setReadError(c('无法读取本地知识，请重试。', 'Could not read local knowledge. Retry.')); } }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); };
  }, [api, key, tab, kind, query, offset, activityOffset, attention, sourceOnly, refresh, c]);
  async function action(request: InteractionRequest) {
    const controller = new AbortController(); actionController.current = controller; setActing(true); setMessage('');
    try {
      const result = await api.interact(request, controller.signal);
      if (controller.signal.aborted) return;
      setMessage(displayMessage(result.message, c, result.messageInfo));
      if (result.ok) setRefresh((value) => value + 1);
    } catch { if (!controller.signal.aborted) setMessage(c('无法确认操作结果，请刷新活动。', 'The operation result is unknown. Refresh Activity.')); }
    finally { if (actionController.current === controller) { actionController.current = undefined; setActing(false); } }
  }

  const activities = data?.activities.filter((item) => (!attention || (item.requiresAttention ?? (item.state === 'failed' || item.state === 'paused'))) && (sourceOnly === '' || item.sessionId === sourceOnly)) ?? [];

  return <div className="acn-page">
    <div className="acn-actions" style={{ margin: '4px 0 10px' }}><Select aria-label={c('知识身份', 'Knowledge identity')} disabled={acting} value={key} onChange={(event) => { setKey(event.target.value); setOffset(0); setActivityOffset(0); setMessage(''); setData(undefined); setReferences([]); }}>{choices.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</Select>
    <Button disabled={busy || acting} onClick={() => { setRefresh((value) => value + 1); }}>{c('刷新', 'Refresh')}</Button></div>
    {reference && <KnowledgeReference key={references.length} api={api} runtimeKey={key} id={reference.id} from={reference.from} c={c} back={() => { setReferences((items) => items.slice(0, -1)); }} openClaim={openClaim} />}
    <div hidden={reference !== undefined}><Tabs<'knowledge' | 'activity'> label={c('知识页面', 'Knowledge pages')} choices={[[ 'knowledge', c('本地知识', 'Local knowledge') ], [ 'activity', c('处理活动', 'Activity') ]]} value={tab} change={(next) => { setData(undefined); setTab(next); }}>
    <p style={muted}>{c('浏览不会同步收件或调用模型。已完成本地处理不等于团队上传完成。', 'Browsing does not sync or call a model. Local completion does not imply team delivery.')}</p>
    {message && <div role="status"><p>{message}</p>{openSettings && <Button onClick={openSettings}>{c('检查 ACN 设置', 'Check ACN settings')}</Button>}</div>}{readError && <p role="alert">{readError}</p>}{busy && <p role="status">{c('正在读取…', 'Loading…')}</p>}
    {data && <p style={muted}>{c('等待团队投递', 'Pending team delivery')}: Claim {data.pendingClaims} · Dispute {data.pendingDisputes}</p>}
    {tab === 'knowledge' ? <div>
      <div style={{ display: 'flex', gap: 12, margin: '16px 0', flexWrap: 'wrap' }}><Select aria-label={c('知识类型', 'Knowledge type')} value={kind} onChange={(event) => { setKind(event.target.value === 'trace' ? 'trace' : event.target.value === 'dispute' ? 'dispute' : 'claim'); setOffset(0); }}><option value="claim">Claim</option><option value="dispute">Dispute</option><option value="trace">Trace</option></Select><input aria-label={c('搜索知识', 'Search knowledge')} placeholder={c('搜索名称、范围或正文', 'Search names, scopes, or content')} style={{ ...inputStyle, flex: '1 1 240px' }} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></div>
      {data?.items.length === 0 && <p style={muted}>{c('暂无符合条件的知识。复盘可能没有产出，也可能更新已有知识。', 'No matching knowledge. A recap may update existing knowledge or produce no changes.')}</p>}
      {data?.items.map((item) => <details key={`${key}:${kind}:${item.id}`} style={{ padding: '13px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)' }}><summary style={{ cursor: 'pointer' }}><strong>{item.name}</strong> <span style={muted}>{item.status} · {item.id}</span></summary><KnowledgeDetail text={item.detail} c={c} openClaim={(id) => { openClaim(id, `${item.name} · ${item.id}`); }} /></details>)}
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}><Button disabled={busy || offset === 0} onClick={() => { setOffset(Math.max(0, offset - 30)); }}>{c('上一页', 'Previous')}</Button><Button disabled={busy || !data?.omitted} onClick={() => { setOffset(offset + 30); }}>{c('下一页', 'Next')}</Button></div>
    </div> : <div>
      <div style={{ display: 'flex', gap: 16, margin: '16px 0', alignItems: 'center', flexWrap: 'wrap' }}><label><input type="checkbox" checked={attention} onChange={(event) => { setAttention(event.target.checked); setActivityOffset(0); }} /> {c('只看需要处理', 'Needs attention')}</label><input style={{ ...inputStyle, width: 'auto' }} aria-label={c('来源会话筛选', 'Filter source session')} placeholder={c('按来源会话 ID 筛选', 'Source session ID')} value={sourceOnly} onChange={(event) => { setSourceOnly(event.target.value); setActivityOffset(0); }} /></div>
      {data && activities.length === 0 && <p style={muted}>{c('暂无处理活动。', 'No activity.')}</p>}
      {activities.map((item) => <details key={item.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)' }}><summary style={{ cursor: 'pointer' }}>{item.kind} · {activityState(item, c)} <span style={muted}>{new Date(item.updatedAt).toLocaleString()}</span></summary><ActivityDetails item={item} runtimeKey={key} busy={busy || acting} c={c} action={(request) => { void action(request); }} openSource={openSource} openClaim={openClaim} /></details>)}
      <div className="acn-actions"><Button disabled={busy || acting || activityOffset === 0} onClick={() => { setActivityOffset(Math.max(0, activityOffset - 30)); }}>{c('上一页活动', 'Previous activity page')}</Button><Button disabled={busy || acting || !data?.activitiesOmitted} onClick={() => { setActivityOffset(activityOffset + 30); }}>{c('下一页活动', 'Next activity page')}</Button></div>
    </div>}
    </Tabs></div>
  </div>;
}
