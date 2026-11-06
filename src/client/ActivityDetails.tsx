// 展示本地处理、未完成项和投递结果，恢复操作只面向当前可执行的动作。
import { SourceSessionLink } from './SourceSessionLink.js';
import type { InteractionApi } from './TeamSettingsPage.js';
import type { Activity, InteractionRequest } from '../interaction.js';
import { displayMessage } from '../interaction-messages.js';
import { Button, muted } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
export function activityKind(kind: string, c: Copy): string { return ({ recap: c('会话复盘', 'Session recap'), finalize: c('会话收尾', 'Session finalization'), inbox: c('团队收件', 'Team Inbox'), dream: c('Dream 整理', 'Dream'), delivery: c('团队投递', 'Team delivery'), history: c('历史知识处理', 'Historical knowledge processing') })[kind] ?? kind; }
export function activityState(item: Activity, c: Copy): string {
  if (item.state === 'succeeded' && item.incompleteCandidates?.length) return c('部分完成，有未完成项', 'Partially completed; unfinished items');
  if (item.state === 'succeeded' && item.budgetLimited) return c('已按额度收尾', 'Closed at the request budget');
  if (item.state === 'succeeded' && item.warnings?.length) return c('本地完成，有警告', 'Locally completed with warnings');
  return ({ queued: c('等待处理', 'Queued'), running: c('正在处理', 'Running'), succeeded: c('本地处理完成', 'Locally completed'), failed: c('处理失败', 'Failed'), paused: c('已暂停', 'Paused'), cancelled: c('已取消', 'Cancelled'), rejected: c('团队拒绝，未投递', 'Rejected; not delivered') })[item.state] ?? item.state;
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
export function ActivityDetails({ item, runtimeKey, busy, c, api, showSummary = true, action, openSource, openClaim, openComponents }: {
  item: Activity; runtimeKey: string; busy: boolean; c: Copy; api: InteractionApi; showSummary?: boolean; action: (request: InteractionRequest) => void;
  openSource?: ((id: string) => void) | undefined; openClaim: (id: string, from: string) => void; openComponents?: (() => void) | undefined;
}) {
  const phaseCounts = item.phase && item.state !== 'succeeded' ? Object.entries(item.counts ?? {}).filter(([key]) => ['modelSteps', 'wrapUpSteps'].includes(key)) : [];
  const handlerInactive = item.errorInfo?.code === 'task.handler_inactive';
  return <div className="acn-activity-detail">
    {item.phase && <p>{c('运行阶段', 'Phase')}: {({ exploration: c('探索与整理', 'Exploration'), wrap_up: c('收尾', 'Closing'), finished: c('已结束', 'Finished') })[item.phase]}</p>}
    {phaseCounts.length > 0 && <div className="acn-counts">{phaseCounts.map(([key, value]) => <span key={key}>{key === 'modelSteps' ? c('探索请求', 'Exploration requests') : c('收尾请求', 'Closing requests')}: {value}</span>)}</div>}
    {showSummary && <p>{activitySummary(item, c)}</p>}
    {showSummary && item.error && <p role="alert">{displayMessage(item.error, c, item.errorInfo)}</p>}
    {item.warnings?.map((warning, index) => <p role="alert" key={index}>{displayMessage(warning, c)}</p>)}
    {item.budgetLimited && <p role="status">{c('本次已按额度结束，未完成项未提交。', 'Request budget reached; unfinished changes were not committed.')}</p>}
    {item.incompleteCandidates?.map((group) => <div key={group.groupId}><strong>{c('未完成组', 'Unfinished group')}: {group.groupId}</strong><p>{c(group.reason || '本组未执行。', 'This group was not completed. Its uncommitted edits were not applied.')}</p>{group.claimIds.map((id) => <Button key={id} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); openClaim(id, group.groupId); }}>{id}</Button>)}</div>)}
    {item.reportPath && <p style={muted}>{c('Dream 报告', 'Dream report')}: <code style={{ overflowWrap: 'anywhere', userSelect: 'text' }}>{item.reportPath}</code></p>}
    {item.entityId?.startsWith('claim_') && <Button onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); openClaim(item.entityId ?? '', c('团队投递', 'Team delivery')); }}>{c('查看当前知识', 'View current claim')}</Button>}
    <p style={muted}>{item.entityId ?? item.id}{(item.kind !== 'delivery' || item.attempts > 0) && <> · {c('尝试次数', 'Attempts')}: {item.attempts}</>}</p>
    {item.sessionId && <div className="acn-source-sessions"><span className="acn-help">{c('来源会话', 'Source session')}</span><SourceSessionLink source={item.source ?? { id: item.sessionId, available: true }} api={api} c={c} open={openSource} /></div>}
    {handlerInactive && openComponents && <div><Button disabled={busy} onClick={openComponents}>{c('前往插件管理', 'Open plugin manager')}</Button></div>}
    {item.kind !== 'delivery' && item.retryable !== false && (item.state === 'failed' || item.state === 'paused') && <Button disabled={busy || handlerInactive} onClick={() => { action({ action: 'retry', key: runtimeKey, id: item.id }); }}>{handlerInactive ? c('启用组件后继续', 'Enable the component to continue') : item.state === 'paused' ? c('继续任务', 'Continue task') : c('重试任务', 'Retry task')}</Button>}
    {item.kind === 'delivery' && item.retryable && <Button disabled={busy} onClick={() => { action({ action: 'retry_delivery', key: runtimeKey }); }}>{c('重试团队投递', 'Retry team delivery')}</Button>}
    {item.state === 'rejected' && !item.acknowledged && <Button disabled={busy} onClick={() => { action({ action: 'ack', key: runtimeKey, id: item.id, version: item.updatedAt }); }}>{c('标记已知悉', 'Mark acknowledged')}</Button>}
    {item.kind === 'dream' && item.state === 'succeeded' && (item.budgetLimited || Boolean(item.incompleteCandidates?.length)) && <Button disabled={busy} title={c('会调用知识模型并读取当前 Claim', 'Uses the knowledge model and reads current claims')} onClick={() => { action({ action: 'dream_again', key: runtimeKey, id: item.id }); }}>{c('重新整理当前知识', 'Start a new Dream')}</Button>}
  </div>;
}
