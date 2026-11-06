// 活动行优先展示结果与产物，技术细节折叠，来源跳转只提供给已验证的会话。
import { ActivityDetails, activityKind, activityState, activitySummary } from './ActivityDetails.js';
import type { Activity, InteractionRequest } from '../interaction.js';
import type { InteractionApi } from './TeamSettingsPage.js';
import { Button } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
import { SourceSessionLink } from './SourceSessionLink.js';
import { knowledgeDate } from './knowledge-labels.js';
import { displayMessage } from '../interaction-messages.js';

export function ActivityCard(props: { item: Activity; runtimeKey: string; busy: boolean; c: Copy; api: InteractionApi; action: (request: InteractionRequest) => void; openSource?: ((id: string) => void) | undefined; openClaim: (id: string, from: string) => void; openComponents?: (() => void) | undefined }) {
  const { item, c, api, openSource, openClaim } = props;
  const ids = [...new Set([...(item.entityIds ?? []), ...(item.entityId ? [item.entityId] : [])])].filter((id) => /^(claim|dispute|trace)_[0-9a-f]{8}$/.test(id));
  const summary = item.error ? displayMessage(item.error, c, item.errorInfo) : activitySummary(item, c);
  const source = item.source;
  return <article className="acn-activity-card" aria-label={`${item.kind} · ${activityState(item, c)}`}>
    <header><div className="acn-activity-title"><strong>{activityKind(item.kind, c)}</strong><span className="acn-badge" data-tone={['failed', 'rejected'].includes(item.state) ? 'danger' : item.requiresAttention ? 'warning' : item.state === 'succeeded' ? 'positive' : 'neutral'}>{activityState(item, c)}</span></div>{item.updatedAt > 0 && <time className="acn-time">{knowledgeDate(item.updatedAt)}</time>}</header>
    {item.sessionId && <p className="acn-activity-source">{c('来源会话', 'Source session')}: {source?.title || (source?.available ? item.sessionId : c('不可用', 'Unavailable'))}</p>}
    {summary && <p className="acn-activity-outcome" role={item.error ? 'alert' : undefined}>{summary}</p>}
    {ids.length > 0 && <div className="acn-activity-links">{ids.map((id) => <Button className="acn-text-button" key={id} onClick={() => { openClaim(id, activityKind(item.kind, c)); }}>{id}</Button>)}</div>}
    <ActivityDetails {...props} showSummary={false} />
    {source?.available && openSource && <div className="acn-activity-source-action"><SourceSessionLink source={source} api={api} c={c} open={openSource} label={c('查看来源会话', 'View source session')} /></div>}
  </article>;
}
