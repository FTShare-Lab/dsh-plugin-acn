// 状态优先列出未解决任务，分页保留恢复所需 ID，不回显 endpoint 或凭据。
import type { AcnKnowledge } from '../knowledge/service.js';
import { UploadStore } from '../store/uploads.js';
import { JobQueue } from '../worker/queue.js';
import { allActivities } from '../activities.js';
export async function statusCommand(knowledge: AcnKnowledge, options: { failed?: boolean; page?: number } = {}): Promise<string> {
  if (!knowledge.configured) return 'ACN 未配置。打开 DSH「设置 → ACN 插件设置 → 工作配置」，新建配置并填写 Agent ID；网页保存后生效，无需手改 YAML 或重启。\nACN is not configured. Open DSH Settings → ACN settings → Work configurations, then create an Agent ID. Web saves apply without editing YAML or restarting. Advanced/headless setup: see docs/config.md.';
  const claims = await knowledge.listClaims({ includeDeprecated: true, limit: 100 });
  const traces = await knowledge.listTraces({ limit: 100 });
  const queue = await new UploadStore(knowledge.context()).read();
  const jobs = await new JobQueue(knowledge.context()).list();
  const activities = await allActivities(knowledge);
  const paused = new Set(activities.filter((item) => item.state === 'paused').map((item) => item.id));
  const outstanding = (job: typeof jobs[number]) => job.state === 'failed' || job.payload['paused'] === true || paused.has(job.id);
  const sorted = jobs.filter((job) => !options.failed || outstanding(job)).sort((a, b) => Number(outstanding(b)) - Number(outstanding(a)) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const page = options.page ?? 1; const shown = sorted.slice((page - 1) * 10, page * 10);
  const team = knowledge.teamStatus();
  const deliveries = activities.filter((item) => item.kind === 'delivery' && item.requiresAttention);
  return [
    `ACN: ${knowledge.mode}`, `agentId: ${knowledge.agentId}`, `数据目录 / Data directory: ${knowledge.context().paths.root}`,
    `Claim: ${claims.items.length + claims.omitted}`, `Trace: ${traces.items.length + traces.omitted}`,
    `待上传 / Pending Claim: ${queue.claims.length}; Dispute: ${queue.disputes.length}`,
    knowledge.mode === 'solo' ? '团队连接: 单人模式，不请求团队服务。 / Solo: no team requests.' : `团队连接 / Team: Router=${team.router.state}; Maintainer=${team.maintainer.state}`,
    ...[team.router.error, team.maintainer.error].filter((error) => error !== undefined),
    `后台任务 / Tasks: queued=${jobs.filter((job) => job.state === 'queued').length} running=${jobs.filter((job) => job.state === 'running').length} failed=${jobs.filter((job) => job.state === 'failed').length}`,
    `页 / Page ${page}/${Math.max(1, Math.ceil(sorted.length / 10))}; ${options.failed ? '失败与暂停 / Failed and paused' : '未解决任务优先 / Unresolved tasks first'}`,
    ...shown.map((job) => `${job.id} ${job.kind} ${job.state} attempts=${job.attempts}${job.payload['paused'] === true || paused.has(job.id) ? ' — 已暂停 / paused' : ''}${job.lastError === undefined ? '' : ` — ${job.lastError}`}`),
    ...(sorted.length > page * 10 ? [`下一页 / Next: /acn-status ${options.failed ? 'failed' : 'all'} ${page + 1}`] : []),
    ...(jobs.some(outstanding) ? ['查看全部失败与暂停 / List failures: /acn-status failed [page]', '重试任务 / Retry: /acn-status retry <job_id>'] : []),
    ...(deliveries.length === 0 ? [] : [`团队投递异常 / Delivery issues: ${deliveries.length}. 打开 ACN「知识与活动」查看实体 ID、原因和恢复操作。 / Open ACN Knowledge and activity for entity IDs and recovery actions.`]),
  ].join('\n');
}
