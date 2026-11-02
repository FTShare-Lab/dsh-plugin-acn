// 知识浏览与处理活动独立于同步；筛选、展开和刷新只读取当前身份的公开台账。
import { useEffect, useState } from 'react';
import type { InteractionApi } from './TeamSettingsPage.js';
import type { KnowledgeView } from '../interaction.js';
import { Button, Select, Tabs, inputStyle, muted } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
function KnowledgeDetail({ text, c, openClaim }: { text: string; c: Copy; openClaim: (id: string) => void }) {
  let values: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(text); if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return <p>{text}</p>; values = parsed as Record<string, unknown>; } catch { return <p>{text}</p>; }
  const labels: Record<string, string> = { statement: c('知识正文', 'Statement'), scope: c('适用范围', 'Scope'), evidence_summary: c('证据与限制', 'Evidence and limits'), confidence: c('置信度', 'Confidence'), source_claim_ids: c('来源知识', 'Source claims'), holder: c('知识持有者', 'Holder'), created_at: c('创建时间', 'Created'), updated_at: c('更新时间', 'Updated'), last_used: c('最近使用', 'Last used'), summary: c('争议说明', 'Dispute summary'), claims: c('相关知识', 'Related claims'), reporter_agent_id: c('上报成员', 'Reporter'), task: c('来源任务', 'Source task'), agent: c('所属成员', 'Agent'), input_claims: c('参考来源', 'Inputs'), output_claims: c('形成知识', 'Outputs'), resolution: c('处理结论', 'Resolution') };
  return <dl style={{ margin: '16px 0', fontSize: 14 }}>{Object.entries(values).filter(([key, value]) => !['id', 'name', 'status'].includes(key) && value !== null && value !== undefined).map(([key, value]) => <div key={key} style={{ margin: '12px 0' }}><dt style={{ ...muted, fontWeight: 600 }}>{labels[key] ?? key}</dt><dd style={{ margin: '5px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: key === 'task' ? 360 : undefined, overflow: 'auto' }}>{Array.isArray(value) ? value.length === 0 ? c('无', 'None') : value.map((part: unknown, index) => typeof part === 'string' && /^claim_[0-9a-f]{8}$/.test(part) ? <Button key={index} style={{ margin: '0 6px 6px 0', padding: '4px 8px', fontSize: 12 }} onClick={() => { openClaim(part); }}>{part}</Button> : <span key={index}>{typeof part === 'string' ? part : JSON.stringify(part)} </span>) : typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value, null, 2)}</dd></div>)}</dl>;
}
export function KnowledgePanel({ api, initialKey, initialTab = 'knowledge', c, openSource }: { api: InteractionApi; initialKey: string; initialTab?: 'knowledge' | 'activity'; c: Copy; openSource?: (id: string) => void }) {
  const [key, setKey] = useState(initialKey); const [choices, setChoices] = useState<{ key: string; name: string }[]>([]);
  const [tab, setTab] = useState<'knowledge' | 'activity'>(initialTab);
  const [kind, setKind] = useState<'claim' | 'dispute' | 'trace'>('claim'); const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0); const [data, setData] = useState<KnowledgeView>();
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const [sourceOnly, setSourceOnly] = useState(''); const [attention, setAttention] = useState(false);
  useEffect(() => { const controller = new AbortController(); void api.read(controller.signal).then((snapshot) => { if (!controller.signal.aborted) setChoices([{ key: 'personal', name: c('单人模式', 'Solo') }, ...(snapshot.values.mode === 'team' ? [{ key: 'legacy', name: c('原有团队连接', 'Existing team connection') }] : []), ...snapshot.values.connections?.map((item) => ({ key: item.id, name: `${item.name}${item.enabled ? '' : c('（已停用）', ' (disabled)')}` })) ?? []]); }, () => { if (!controller.signal.aborted) setMessage(c('无法加载身份列表。', 'Could not load identities.')); }); return () => { controller.abort(); }; }, [api, c]);
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
    <div className="acn-actions" style={{ margin: '4px 0 10px' }}><Select aria-label={c('知识身份', 'Knowledge identity')} value={key} onChange={(event) => { setKey(event.target.value); setOffset(0); setData(undefined); }}>{choices.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</Select>
    <Button disabled={busy} onClick={() => { setRefresh((value) => value + 1); }}>{c('刷新', 'Refresh')}</Button></div>
    <Tabs<'knowledge' | 'activity'> label={c('知识页面', 'Knowledge pages')} choices={[[ 'knowledge', c('本地知识', 'Local knowledge') ], [ 'activity', c('处理活动', 'Activity') ]]} value={tab} change={(next) => { setData(undefined); setTab(next); }}>
    <p style={muted}>{c('浏览不会同步收件或调用模型。已完成本地处理不等于团队上传完成。', 'Browsing does not sync or call a model. Local completion does not imply team delivery.')}</p>
    {message && <p role="status">{message}</p>}{busy && <p role="status">{c('正在读取…', 'Loading…')}</p>}
    {data && <p style={muted}>{c('等待团队投递', 'Pending team delivery')}: Claim {data.pendingClaims} · Dispute {data.pendingDisputes}</p>}
    {tab === 'knowledge' ? <div>
      <div style={{ display: 'flex', gap: 12, margin: '16px 0', flexWrap: 'wrap' }}><Select aria-label={c('知识类型', 'Knowledge type')} value={kind} onChange={(event) => { setKind(event.target.value === 'trace' ? 'trace' : event.target.value === 'dispute' ? 'dispute' : 'claim'); setOffset(0); }}><option value="claim">Claim</option><option value="dispute">Dispute</option><option value="trace">Trace</option></Select><input aria-label={c('搜索知识', 'Search knowledge')} placeholder={c('搜索名称、范围或正文', 'Search names, scopes, or content')} style={{ ...inputStyle, flex: '1 1 240px' }} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></div>
      {data?.items.length === 0 && <p style={muted}>{c('暂无符合条件的知识。复盘可能没有产出，也可能更新已有知识。', 'No matching knowledge. A recap may update existing knowledge or produce no changes.')}</p>}
      {data?.items.map((item) => <details key={`${key}:${kind}:${item.id}`} style={{ padding: '13px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)' }}><summary style={{ cursor: 'pointer' }}><strong>{item.name}</strong> <span style={muted}>{item.status} · {item.id}</span></summary><KnowledgeDetail text={item.detail} c={c} openClaim={(id) => { setKind('claim'); setQuery(id); setOffset(0); }} /></details>)}
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}><Button disabled={busy || offset === 0} onClick={() => { setOffset(Math.max(0, offset - 30)); }}>{c('上一页', 'Previous')}</Button><Button disabled={busy || !data?.omitted} onClick={() => { setOffset(offset + 30); }}>{c('下一页', 'Next')}</Button></div>
    </div> : <div>
      <div style={{ display: 'flex', gap: 16, margin: '16px 0', alignItems: 'center', flexWrap: 'wrap' }}><label><input type="checkbox" checked={attention} onChange={(event) => { setAttention(event.target.checked); }} /> {c('只看需要处理', 'Needs attention')}</label><input style={{ ...inputStyle, width: 'auto' }} aria-label={c('来源会话筛选', 'Filter source session')} placeholder={c('按来源会话 ID 筛选', 'Source session ID')} value={sourceOnly} onChange={(event) => { setSourceOnly(event.target.value); }} /></div>
      {data && activities.length === 0 && <p style={muted}>{c('暂无处理活动。', 'No activity.')}</p>}
      {activities.map((item) => <details key={item.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)' }}><summary style={{ cursor: 'pointer' }}>{item.kind} · {stateLabel(item.state)} <span style={muted}>{new Date(item.updatedAt).toLocaleString()}</span></summary><p>{item.summary}</p>{item.error && <p role="alert">{item.error}</p>}<p style={muted}>{item.id} · {c('尝试次数', 'Attempts')}: {item.attempts}</p>{item.sessionId && <p style={muted}>{c('来源会话', 'Source session')}: {item.sessionId}{openSource && <Button onClick={() => { openSource(item.sessionId ?? ''); }}>{c('打开会话', 'Open session')}</Button>}</p>}{(item.state === 'failed' || item.state === 'paused') && <Button disabled={busy} onClick={() => { void retry(item.id); }}>{c('重试任务', 'Retry task')}</Button>}</details>)}
    </div>}
    </Tabs>
  </div>;
}
