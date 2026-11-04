// 知识浏览与处理活动独立于同步；筛选、展开和刷新只读取当前身份的公开台账。
import { useEffect, useRef, useState } from 'react';
import { settingsUpstreams } from './TeamSettingsPage.js';
import type { InteractionApi } from './TeamSettingsPage.js';
import { displayMessage, messageInfo } from '../interaction-messages.js';
import { ActivityDetails, activityState, activitySummary, activityKind } from './ActivityDetails.js';
import type { InteractionRequest, KnowledgeView } from '../interaction.js';
import { Button, Select, Tabs, configurationLabel, inputStyle } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
import { KnowledgeReference } from './KnowledgeReference.js';
import { knowledgeDate, knowledgeStatus } from './knowledge-labels.js';
import { KnowledgeDetail } from './KnowledgeDetail.js';
export function KnowledgePanel({ api, initialKey, initialTab = 'knowledge', showHeading = false, c, openSource, openSettings }: { api: InteractionApi; initialKey: string; initialTab?: 'knowledge' | 'activity'; showHeading?: boolean; c: Copy; openSource?: (id: string) => void; openSettings?: (() => void) | undefined }) {
  const [key, setKey] = useState(initialKey); const [choices, setChoices] = useState<{ key: string; name: string }[]>([]);
  const [tab, setTab] = useState<'knowledge' | 'activity'>(initialTab);
  const [kind, setKind] = useState<'claim' | 'dispute' | 'trace'>('claim'); const [query, setQuery] = useState('');
  const [status, setStatus] = useState(''); const [delivery, setDelivery] = useState<'all' | 'pending' | 'local'>('all');
  const [activityKindFilter, setActivityKindFilter] = useState(''); const [activityStateFilter, setActivityStateFilter] = useState('');
  const [offset, setOffset] = useState(0); const [activityOffset, setActivityOffset] = useState(0); const [data, setData] = useState<KnowledgeView>();
  const [settingsHint, setSettingsHint] = useState(false);
  const backgroundRead = useRef(false);
  const [message, setMessage] = useState(''); const [readError, setReadError] = useState('');
  const [acting, setActing] = useState(false); const actionController = useRef<AbortController>();
  useEffect(() => () => { actionController.current?.abort(); }, []);
  const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const [sourceOnly, setSourceOnly] = useState(''); const [attention, setAttention] = useState(false);
  const [expandedKnowledge, setExpandedKnowledge] = useState<string>();
  const [expandedActivities, setExpandedActivities] = useState<Set<string>>(() => new Set());
  const [references, setReferences] = useState<{ id: string; from: string }[]>([]);
  const reference = references.at(-1);
  const openClaim = (id: string, from: string) => { setReferences((items) => [...items, { id, from }]); };
  useEffect(() => { const controller = new AbortController(); void api.read(controller.signal).then((snapshot) => { if (!controller.signal.aborted) setChoices(Object.entries(settingsUpstreams(snapshot.values)).map(([key, item]) => ({ key, name: `${configurationLabel(item.name || key, item.agentId)}${item.enabled ? '' : c('（已停用）', ' (disabled)')}` }))); }, () => { if (!controller.signal.aborted) setMessage(c('无法加载身份列表。', 'Could not load identities.')); }); return () => { controller.abort(); }; }, [api, c]);
  useEffect(() => {
    const controller = new AbortController(); if (!backgroundRead.current) setBusy(true); backgroundRead.current = false;
    void api.interact(tab === 'activity' ? { action: 'activity', key, attentionOnly: attention, sourceSession: sourceOnly, kind: activityKindFilter, state: activityStateFilter, offset: activityOffset } : { action: 'knowledge', key, kind, query, status, delivery, offset }, controller.signal).then((result) => { if (controller.signal.aborted) return; if (result.ok && result.knowledge !== undefined) { setData(result.knowledge); setReadError(''); } else { setData(undefined); setReadError(displayMessage(result.message, c, result.messageInfo)); } }, () => { if (!controller.signal.aborted) { setData(undefined); setReadError(c('无法读取本地知识，请重试。', 'Could not read local knowledge. Retry.')); } }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); };
  }, [api, key, tab, kind, query, offset, activityOffset, attention, sourceOnly, activityKindFilter, activityStateFilter, status, delivery, refresh, c]);
  useEffect(() => {
    if (tab !== 'activity' || reference !== undefined || (data?.runningCount ?? 0) === 0) return;
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden' && !busy && !acting) { backgroundRead.current = true; setRefresh((value) => value + 1); } }, 2000);
    return () => { clearInterval(timer); };
  }, [tab, reference, data?.runningCount, busy, acting]);
  async function action(request: InteractionRequest) {
    const controller = new AbortController(); actionController.current = controller; setActing(true); setMessage(''); setSettingsHint(false);
    try {
      const result = await api.interact(request, controller.signal);
      if (controller.signal.aborted) return;
      setMessage(displayMessage(result.message, c, result.messageInfo));
      setSettingsHint(!result.ok && ['connection', 'identity', 'route', 'retry_disabled', 'select_identity'].includes((result.messageInfo ?? messageInfo(result.message)).code.replace(/^task\./, '')));
      if (result.ok) setRefresh((value) => value + 1);
    } catch { if (!controller.signal.aborted) setMessage(c('无法确认操作结果，请刷新活动。', 'The operation result is unknown. Refresh Activity.')); }
    finally { if (actionController.current === controller) { actionController.current = undefined; setActing(false); } }
  }

  const activities = data?.activities ?? [];
  const kindChoices = data?.activityKinds ?? [...new Set(activities.map((item) => item.kind))];
  const sourceChoices = data?.activitySources ?? [...new Set(activities.flatMap((item) => item.sessionId ? [item.sessionId] : []))];
  const filteredActivity = attention || sourceOnly !== '' || activityKindFilter !== '' || activityStateFilter !== '';
  const clearActivity = () => { setAttention(false); setSourceOnly(''); setActivityKindFilter(''); setActivityStateFilter(''); setActivityOffset(0); };
  const statuses = kind === 'claim' ? ['active', 'stale', 'deprecated'] : kind === 'dispute' ? ['open', 'resolved'] : [];
  return <div className="acn-page acn-knowledge-page">
    {showHeading && <div className="acn-page-heading"><h2>{c('知识与活动', 'Knowledge and activity')}</h2><p>{c('查看本地已生效的知识，跟踪处理与投递。', 'Browse local knowledge and follow processing and delivery.')}</p></div>}
    <div className="acn-filterbar"><Select aria-label={c('知识身份', 'Knowledge identity')} disabled={acting} value={key} onChange={(event) => { setKey(event.target.value); setOffset(0); setActivityOffset(0); setMessage(''); setData(undefined); setReferences([]); setExpandedKnowledge(undefined); setExpandedActivities(new Set()); clearActivity(); }}>{choices.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</Select><Button disabled={busy || acting} onClick={() => { setRefresh((value) => value + 1); }}>{c('刷新', 'Refresh')}</Button></div>
    {reference && <KnowledgeReference key={references.length} api={api} runtimeKey={key} id={reference.id} from={reference.from} c={c} back={() => { setReferences((items) => items.slice(0, -1)); }} openClaim={openClaim} />}
    <div hidden={reference !== undefined}><Tabs<'knowledge' | 'activity'> label={c('知识页面', 'Knowledge pages')} choices={[[ 'knowledge', c('本地知识', 'Local knowledge') ], [ 'activity', c('处理活动', 'Activity') ]]} value={tab} change={(next) => { setData(undefined); setTab(next); }}>
      <p className="acn-description">{c('浏览不会同步收件或调用模型。处理完成与团队投递分别记录。', 'Browsing never syncs the Inbox or calls a model. Processing and team delivery are recorded separately.')}</p>
      {message && <div role="status" className="acn-feedback"><p>{message}</p>{settingsHint && openSettings && <Button onClick={openSettings}>{c('检查 ACN 设置', 'Check ACN settings')}</Button>}</div>}
      {readError && <p role="alert" className="acn-feedback is-error">{readError}</p>}{busy && <p role="status" className="acn-help">{c('正在读取…', 'Loading…')}</p>}
      {data && (data.pendingClaims > 0 || data.pendingDisputes > 0) && <div className="acn-counts"><span>{c('等待团队投递', 'Pending delivery')}</span><span>Claim {data.pendingClaims}</span><span>Dispute {data.pendingDisputes}</span></div>}
      {tab === 'knowledge' ? <>
        <div role="tablist" aria-label={c('知识类型', 'Knowledge type')} className="acn-kind-tabs">{(['claim', 'dispute', 'trace'] as const).map((item) => <button type="button" className="acn-tab" role="tab" aria-selected={kind === item} key={item} onClick={() => { setKind(item); setStatus(''); setDelivery('all'); setOffset(0); }}>{item === 'claim' ? 'Claim' : item === 'dispute' ? 'Dispute' : 'Trace'}</button>)}</div>
        <div className="acn-filterbar"><input aria-label={c('搜索知识', 'Search knowledge')} placeholder={c('搜索本地知识', 'Search local knowledge')} style={inputStyle} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} />
          {kind !== 'trace' && <><Select aria-label={c('投递状态', 'Delivery state')} value={delivery} onChange={(event) => { setDelivery(event.target.value === 'pending' ? 'pending' : event.target.value === 'local' ? 'local' : 'all'); setOffset(0); }}><option value="all">{c('全部投递状态', 'All delivery states')}</option><option value="pending">{c('待投递', 'Pending delivery')}</option><option value="local">{c('无待投记录', 'No pending delivery')}</option></Select><Select aria-label={c('知识状态', 'Knowledge status')} value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}><option value="">{c('全部状态', 'All statuses')}</option>{statuses.map((value) => <option key={value} value={value}>{knowledgeStatus(value, c)}</option>)}</Select></>}
        </div>
        {data?.items.length === 0 && <div className="acn-empty">{c('暂无符合条件的知识。复盘可能没有产出，也可能更新已有知识。', 'No matching knowledge. A recap may update existing knowledge or produce no changes.')}</div>}
        {data?.items.map((item) => <details className="acn-entity" key={`${key}:${kind}:${item.id}`} open={expandedKnowledge === item.id} onToggle={(event) => { const open = event.currentTarget.open; setExpandedKnowledge((previous) => open ? item.id : previous === item.id ? undefined : previous); }}><summary aria-label={`${item.name} ${knowledgeStatus(item.status, c)}`}><span className="acn-entity-main"><span className="acn-entity-title">{item.delivery === 'pending' && <span className="acn-badge" data-tone="warning">{c('待投递', 'Pending delivery')}</span>}{item.status && <span className="acn-badge" data-tone={['active', 'resolved'].includes(item.status) ? 'positive' : 'warning'}>{knowledgeStatus(item.status, c)}</span>}<span className="acn-entity-id">{item.id}</span><strong>{item.name}</strong></span>{item.summary && <span className="acn-entity-preview">{item.summary}</span>}</span>{item.updatedAt && <time className="acn-time">{knowledgeDate(item.updatedAt)}</time>}</summary><div className="acn-entity-detail"><KnowledgeDetail text={item.detail} c={c} openClaim={(id) => { openClaim(id, `${item.name} · ${item.id}`); }} /></div></details>)}
        <div className="acn-pagination"><Button disabled={busy || offset === 0} onClick={() => { setOffset(Math.max(0, offset - 30)); }}>{c('上一页', 'Previous')}</Button><small>{c('第', 'Page')} {Math.floor(offset / 30) + 1} {c('页', '')}</small><Button disabled={busy || !data?.omitted} onClick={() => { setOffset(offset + 30); }}>{c('下一页', 'Next')}</Button></div>
      </> : <>
        <div className="acn-filterbar"><Select aria-label={c('活动类型', 'Activity kind')} value={activityKindFilter} onChange={(event) => { setActivityKindFilter(event.target.value); setActivityOffset(0); }}><option value="">{c('全部类型', 'All kinds')}</option>{kindChoices.map((value) => <option key={value} value={value}>{activityKind(value, c)}</option>)}</Select><Select aria-label={c('来源会话筛选', 'Filter source session')} value={sourceOnly} onChange={(event) => { setSourceOnly(event.target.value); setActivityOffset(0); }}><option value="">{c('全部来源会话', 'All source sessions')}</option>{sourceChoices.map((value) => <option key={value} value={value}>{c('会话', 'Session')} {value.slice(-12)}</option>)}</Select><Select aria-label={c('活动结果', 'Activity result')} value={activityStateFilter} onChange={(event) => { setActivityStateFilter(event.target.value); setActivityOffset(0); }}><option value="">{c('全部结果', 'All results')}</option>{['queued', 'running', 'succeeded', 'failed', 'paused', 'rejected'].map((value) => <option key={value} value={value}>{activityState({ id: '', kind: '', state: value, attempts: 0, updatedAt: 0, unseen: false, summary: '' }, c)}</option>)}</Select><label className="acn-help"><input type="checkbox" checked={attention} onChange={(event) => { setAttention(event.target.checked); setActivityOffset(0); }} /> {c('只看需要处理', 'Needs attention')}</label></div>
        {data && activities.length === 0 && <p className="acn-empty">{filteredActivity ? attention ? c('当前筛选下没有处理活动；继续的任务会从「需要处理」列表移出。', 'No activity matches these filters. Resumed tasks leave the needs-attention list.') : c('当前筛选下没有处理活动。', 'No activity matches these filters.') : c('暂无处理活动。', 'No activity.')}</p>}
        {filteredActivity && <div className="acn-actions"><Button className="acn-text-button" onClick={clearActivity}>{c('查看全部活动', 'View all activity')}</Button></div>}
        {activities.map((item) => <details key={item.id} className="acn-entity" open={expandedActivities.has(item.id)} onToggle={(event) => { const open = event.currentTarget.open; setExpandedActivities((previous) => { if (previous.has(item.id) === open) return previous; const next = new Set(previous); if (open) next.add(item.id); else next.delete(item.id); return next; }); }}><summary aria-label={`${item.kind} · ${activityState(item, c)}`}><span className="acn-entity-main"><span className="acn-entity-title"><strong>{activityKind(item.kind, c)}</strong><span className="acn-badge" data-tone={['failed', 'rejected'].includes(item.state) ? 'danger' : item.requiresAttention ? 'warning' : item.state === 'succeeded' ? 'positive' : 'neutral'}>{activityState(item, c)}</span></span><span className="acn-entity-preview" role={item.error ? 'alert' : undefined}>{item.error ? displayMessage(item.error, c, item.errorInfo) : activitySummary(item, c)}</span></span><time className="acn-time">{knowledgeDate(item.updatedAt)}</time></summary><div className="acn-entity-detail"><ActivityDetails item={item} runtimeKey={key} busy={busy || acting} c={c} showSummary={false} action={(request) => { void action(request); }} openSource={openSource} openClaim={openClaim} /></div></details>)}
        <div className="acn-pagination"><Button disabled={busy || acting || activityOffset === 0} onClick={() => { setActivityOffset(Math.max(0, activityOffset - 30)); }}>{c('上一页活动', 'Previous activity page')}</Button><small>{c('第', 'Page')} {Math.floor(activityOffset / 30) + 1} {c('页', '')}</small><Button disabled={busy || acting || !data?.activitiesOmitted} onClick={() => { setActivityOffset(activityOffset + 30); }}>{c('下一页活动', 'Next activity page')}</Button></div>
      </>}
    </Tabs></div>
  </div>;
}
