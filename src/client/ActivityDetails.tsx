// 展示本地处理、未完成项和投递结果，恢复操作只面向当前可执行的动作。
import { useState } from 'react';
import type { Activity, InteractionRequest } from '../interaction.js';
import { displayMessage } from '../interaction-messages.js';
import { Button, muted } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
export function activityKind(kind: string, c: Copy): string { return ({ recap: c('会话复盘', 'Session recap'), finalize: c('会话收尾', 'Session finalization'), inbox: c('团队收件', 'Team Inbox'), dream: c('Dream 整理', 'Dream'), memory_review: c('记忆复核', 'Memory review'), delivery: c('团队投递', 'Team delivery') })[kind] ?? kind; }
export function activityState(item: Activity, c: Copy): string {
  if (item.state === 'succeeded' && item.incompleteCandidates?.length) return c('部分完成，有未完成项', 'Partially completed; unfinished items');
  if (item.state === 'succeeded' && item.budgetLimited) return c('已按额度收尾', 'Closed at the request budget');
  if (item.state === 'succeeded' && item.warnings?.length) return c('本地完成，有警告', 'Locally completed with warnings');
  return ({ queued: c('等待处理', 'Queued'), running: c('正在处理', 'Running'), succeeded: c('本地处理完成', 'Locally completed'), failed: c('处理失败', 'Failed'), paused: c('已暂停', 'Paused'), rejected: c('团队拒绝，未投递', 'Rejected; not delivered') })[item.state] ?? item.state;
}
export function activitySummary(item: Activity, c: Copy): string {
  if (c('中文', 'English') === '中文') return item.summary;
  if (item.summaryInfo !== undefined) return displayMessage(item.summary, c, item.summaryInfo);
  const labels: Record<string, string> = { claimCount: 'Claims updated', disputeCount: 'Disputes formed', traceCount: 'Traces formed', applied: 'Claims updated', handled: 'Inbox items handled', uploadedClaims: 'Claims delivered', reportedDisputes: 'Disputes reported', modelSteps: 'Exploration requests', wrapUpSteps: 'Closing requests' };
  const counts = Object.entries(item.counts ?? {}).map(([key, value]) => `${labels[key] ?? key}: ${value}`);
  if (counts.length) return counts.join('; ');
  if (/^[^\u0080-\uFFFF]*$/u.test(item.summary)) return item.summary;
  return item.state === 'queued' || item.state === 'running' || item.state === 'failed' ? 'No completed result yet.' : 'Local processing completed. Review any warnings and unfinished items below.';
}
export function ActivityDetails({ item, runtimeKey, busy, c, showSummary = true, action, openSource, openClaim }: {
  item: Activity; runtimeKey: string; busy: boolean; c: Copy; showSummary?: boolean; action: (request: InteractionRequest) => void;
  openSource?: ((id: string) => void) | undefined; openClaim: (id: string, from: string) => void;
}) {
  const [copyMessage, setCopyMessage] = useState('');
  const handlerInactive = item.errorInfo?.code === 'task.handler_inactive';
  async function copyReport() {
    try { await navigator.clipboard.writeText(item.reportPath ?? ''); setCopyMessage(c('已复制报告路径', 'Report path copied')); }
    catch { setCopyMessage(c('复制失败，请选择上方路径手动复制。', 'Copy failed. Select and copy the path above.')); }
  }
  return <>
    {item.phase && <p>{c('运行阶段', 'Phase')}: {({ exploration: c('探索与整理', 'Exploration'), wrap_up: c('收尾', 'Closing'), finished: c('已结束', 'Finished') })[item.phase]}</p>}
    <div className="acn-counts">{item.phase && item.state !== 'succeeded' && Object.entries(item.counts ?? {}).filter(([key]) => ['modelSteps', 'wrapUpSteps'].includes(key)).map(([key, value]) => <span key={key}>{key === 'modelSteps' ? c('探索请求', 'Exploration requests') : c('收尾请求', 'Closing requests')}: {value}</span>)}</div>
    {showSummary && <p>{activitySummary(item, c)}</p>}
    {showSummary && item.error && <p role="alert">{displayMessage(item.error, c, item.errorInfo)}</p>}
    {item.warnings?.map((warning, index) => <p role="alert" key={index}>{displayMessage(warning, c)}</p>)}
    {item.budgetLimited && <p role="status">{c('本次已结束，失败和修复请求也计入额度。未完成项没有提交；重新整理会读取当前知识，不会沿用旧快照。', 'This Dream has ended. Failed and repair requests count toward its budget. Unfinished items were not committed; a new Dream reads current knowledge instead of resuming the old snapshot.')}</p>}
    {item.incompleteCandidates?.map((group) => <div key={group.groupId}><strong>{c('未完成组', 'Unfinished group')}: {group.groupId}</strong><p>{c(group.reason || '本组未执行。', 'This group was not completed. Its uncommitted edits were not applied.')}</p>{group.claimIds.map((id) => <Button key={id} onClick={() => { openClaim(id, group.groupId); }}>{id}</Button>)}</div>)}
    {item.reportPath && <div><p style={muted}>{c('Dream 报告（本机文件）', 'Dream report (host file)')}: <code style={{ overflowWrap: 'anywhere' }}>{item.reportPath}</code></p><Button onClick={() => { void copyReport(); }}>{c('复制报告路径', 'Copy report path')}</Button>{copyMessage && <p role="status">{copyMessage}</p>}</div>}
    {item.entityId?.startsWith('claim_') && <Button onClick={() => { openClaim(item.entityId ?? '', c('团队投递', 'Team delivery')); }}>{c('查看当前知识', 'View current claim')}</Button>}
    <p style={muted}>{item.entityId ?? item.id}{(item.kind !== 'delivery' || item.attempts > 0) && <> · {c('尝试次数', 'Attempts')}: {item.attempts}</>}</p>
    {item.sessionId && <p style={muted}>{c('来源会话', 'Source session')}: {item.sessionId}{openSource && <Button onClick={() => { openSource(item.sessionId ?? ''); }}>{c('打开会话', 'Open session')}</Button>}</p>}
    {item.kind !== 'delivery' && (item.state === 'failed' || item.state === 'paused') && <Button disabled={busy || handlerInactive} onClick={() => { action({ action: 'retry', key: runtimeKey, id: item.id }); }}>{handlerInactive ? c('启用组件后继续', 'Enable the component to continue') : item.state === 'paused' ? c('继续任务', 'Continue task') : c('重试任务', 'Retry task')}</Button>}
    {item.kind === 'delivery' && item.retryable && <Button disabled={busy} onClick={() => { action({ action: 'retry_delivery', key: runtimeKey }); }}>{c('重试团队投递', 'Retry team delivery')}</Button>}
    {item.state === 'rejected' && <p style={muted}>{c('这是终止拒绝记录，不会自动重试，也不表示团队已接收。', 'This is a terminal rejection, without automatic retries or successful team delivery.')}</p>}
    {item.state === 'rejected' && !item.acknowledged && <Button disabled={busy} onClick={() => { action({ action: 'ack', key: runtimeKey, id: item.id, version: item.updatedAt }); }}>{c('标记已知悉', 'Mark acknowledged')}</Button>}
    {item.kind === 'dream' && item.state === 'succeeded' && (item.budgetLimited || Boolean(item.incompleteCandidates?.length)) && <Button disabled={busy} title={c('会调用知识模型并读取当前 Claim', 'Uses the knowledge model and reads current claims')} onClick={() => { action({ action: 'dream_again', key: runtimeKey, id: item.id }); }}>{c('重新整理当前知识', 'Start a new Dream')}</Button>}
  </>;
}
