// 将任务与投递台账投影为公开活动；先筛选后分页，不读取私有 Memory 内容。
import type { AcnKnowledge } from './knowledge/service.js';
import { JobQueue } from './worker/queue.js';
import { DeliveryStatusStore } from './store/delivery-status.js';
import { RejectedDisputeStore } from './store/rejected-disputes.js';
import { PresentationStore } from './store/presentation.js';
import { UploadStore } from './store/uploads.js';
import { messageInfo } from './interaction-messages.js';
import type { JobKind } from './worker/types.js';
import type { Activity } from './interaction.js';
import { z } from 'zod';
import { ClaimIdSchema } from './protocol/ids.js';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { hasCode } from './store/errors.js';

const Incomplete = z.object({ groupId: z.string(), claimIds: z.array(ClaimIdSchema), reason: z.string() });
const labels: Record<string, string> = { claimCount: '更新 Claim', disputeCount: '形成争议', traceCount: '形成来源', applied: '更新 Claim', handled: '处理收件', uploadedClaims: '已投递 Claim', reportedDisputes: '已上报争议', modelSteps: '探索请求', wrapUpSteps: '收尾请求' };
const publicResult = (result: unknown): Record<string, unknown> => result !== null && typeof result === 'object' ? result as Record<string, unknown> : {};
export function activityDetails(result: unknown) {
  const value = publicResult(result);
  const counts = Object.fromEntries(Object.keys(labels).flatMap((key) => typeof value[key] === 'number' ? [[key, value[key]]] : []));
  if (Array.isArray(value['updatedClaimIds'])) counts['claimCount'] = value['updatedClaimIds'].length;
  const incomplete = z.array(Incomplete).safeParse(value['incompleteCandidates']);
  const warnings = z.array(z.string()).safeParse(value['warnings']);
  const texts = Object.entries(counts).map(([key, count]) => `${labels[key]}: ${count}`);
  if (value['skipped'] === true || typeof value['skipped'] === 'string') texts.push('没有需要新增处理的内容');
  if (value['changed'] === false) texts.push('没有新增记忆');
  if (value['applied'] === true) texts.push('本地处理完成');
  if (value['budgetLimited'] === true) texts.push('本次已按额度收尾；未完成项未执行，再次整理将读取当前知识');
  const skipped = Array.isArray(value['skipped']) ? value['skipped'].filter((id): id is string => typeof id === 'string') : [];
  if (skipped.length > 0) texts.push(`跳过 ${skipped.length} 组`);
  return { counts, summary: texts.join('；') || (result == null ? '尚无处理结果' : '处理完成，可能未产生新知识'), warnings: warnings.success ? warnings.data : [], incompleteCandidates: incomplete.success ? incomplete.data : [], budgetLimited: value['budgetLimited'] === true };
}
export function emptyInbox(result: unknown): boolean {
  const value = publicResult(result);
  return ['pulled', 'accepted', 'acknowledged', 'applied', 'handled', 'uploadedClaims', 'reportedDisputes'].every((key) => value[key] === 0) && Array.isArray(value['warnings']) && value['warnings'].length === 0;
}
export async function allActivities(knowledge: AcnKnowledge, supports: (kind: JobKind) => boolean = (kind) => knowledge.jobs?.supports(kind) ?? true): Promise<Activity[]> {
  const context = knowledge.context(); const presentation = await new PresentationStore(context).read();
  const jobs = await new JobQueue(context).list();
  const rows: Activity[] = await Promise.all(jobs.map(async (job) => {
    const details = activityDetails(job.result);
    let reportPath: string | undefined; let phase: Activity['phase'];
    if (job.kind === 'dream') {
      const progress = await knowledge.dreamStore().progress(job.id);
      if (progress !== null) {
        phase = progress.finished ? 'finished' : progress.autonomy?.wrap_up === undefined ? 'exploration' : 'wrap_up';
        if (progress.autonomy !== undefined) { details.counts['modelSteps'] = progress.autonomy.steps; details.counts['wrapUpSteps'] = progress.autonomy.wrap_up?.steps ?? 0; }
      }
      const path = join(context.paths.dreamJob(job.id), 'report.md');
      try { if ((await fs.lstat(path)).isFile()) reportPath = path; } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    }
    const inactive = job.state === 'queued' && !supports(job.kind);
    if (job.kind === 'dream' && job.state === 'succeeded' && details.incompleteCandidates.length === 0) {
      const progress = await knowledge.dreamStore().progress(job.id);
      details.incompleteCandidates = progress?.entries.filter((entry) => entry.status === 'skipped').map((entry) => ({ groupId: entry.candidate.group_id, claimIds: entry.candidate.claim_ids, reason: entry.reason ?? '' })) ?? [];
    }
    return { id: job.id, kind: job.kind, state: inactive || job.payload['paused'] === true ? 'paused' : job.state, attempts: job.attempts, updatedAt: job.updatedAt,
      unseen: !(job.kind === 'inbox' && job.state === 'succeeded' && emptyInbox(job.result)) && presentation !== null && job.updatedAt >= presentation.baselineAt && presentation.seen[job.id] !== job.updatedAt,
      ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }), ...details,
      ...(reportPath === undefined ? {} : { reportPath }), ...(phase === undefined ? {} : { phase }),
      requiresAttention: inactive || job.state === 'failed' || job.payload['paused'] === true || details.warnings.length > 0 || details.incompleteCandidates.length > 0,
      ...(inactive ? { error: '对应后台组件未启用，请在插件管理中启用后等待任务继续。', errorInfo: { code: 'task.handler_inactive' } } : job.lastError === undefined ? {} : { error: job.lastError, errorInfo: messageInfo(job.lastError, job.lastErrorKind) }),
    };
  }));
  const pending = await new UploadStore(context).read();
  const status = await new DeliveryStatusStore(context).read();
  for (const issue of Object.values(status.issues)) {
    if (issue.reason === 'rejected' || !(issue.kind === 'claim' ? pending.claims : pending.disputes).some((item) => item.id === issue.id)) continue;
    const waiting = issue.reason === 'dependency';
    const message = issue.reason === 'version' ? '待投版本与本地不同。请查看当前知识，在团队会话中让 Agent 核对后通过正常修订或 Dream 同步复核重新共享。'
      : waiting ? '等待整合承接确认，依赖就绪后自动投递。'
      : issue.reason === 'auth' ? '团队投递鉴权失败，请在 ACN 设置检查成员 ID 和团队鉴权密钥，再重试投递。'
      : '团队投递未完成。请检查团队地址、连接、权限和服务版本，再重试投递。';
    rows.push({ id: `delivery-${issue.kind}-${issue.id}`, kind: 'delivery', state: waiting ? 'queued' : issue.reason === 'version' ? 'paused' : 'failed', attempts: issue.attempts, updatedAt: issue.updatedAt,
      entityId: issue.id, summary: message, summaryInfo: { code: `delivery.${issue.reason}`, entityId: issue.id, ...(issue.status === undefined ? {} : { status: issue.status }) },
      requiresAttention: !waiting, retryable: !waiting && issue.reason !== 'version', unseen: false,
    });
  }
  // 拒绝先落盘再出队；即使在两者之间崩溃，页面也必须解释终止原因。
  for (const [version, rejection] of Object.entries(await new RejectedDisputeStore(context).read(true))) {
    const id = `delivery-rejected-${version}`; const updatedAt = Date.parse(rejection.rejected_at); const acknowledged = presentation?.seen[id] === updatedAt;
    rows.push({ id, kind: 'delivery', state: 'rejected', entityId: rejection.dispute_id, attempts: rejection.attempts, updatedAt, unseen: false, acknowledged,
      requiresAttention: !acknowledged, retryable: false, summary: '团队拒绝此版本的争议（409），已停止自动重试，并未成功投递。请核对关联知识，由 Agent 根据当前版本形成新的争议。', summaryInfo: { code: 'delivery.rejected', entityId: rejection.dispute_id, status: 409 } });
  }
  return rows.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}
export interface ActivityPage { attentionOnly?: boolean; sourceSession?: string; kind?: string; state?: string; offset?: number }
export function activityPage(rows: Activity[], options: ActivityPage = {}) {
  const matching = rows.filter((row) => (!options.attentionOnly || (row.requiresAttention ?? (row.state === 'failed' || row.state === 'paused'))) && (!options.sourceSession || row.sessionId === options.sourceSession) && (!options.kind || row.kind === options.kind) && (!options.state || row.state === options.state));
  const offset = options.offset ?? 0;
  return { activities: matching.slice(offset, offset + 30), activitiesOmitted: Math.max(0, matching.length - offset - 30) };
}
