// 状态输出只包含身份、目录与计数，不回显 endpoint、凭据或私有正文。
import type { AcnKnowledge } from '../knowledge/service.js';
import { UploadStore } from '../store/uploads.js';
import { JobQueue } from '../worker/queue.js';

export async function statusCommand(knowledge: AcnKnowledge): Promise<string> {
  if (!knowledge.configured) return 'ACN 未配置。请在 profile 的 cordis.patch.yml 覆盖 id: acn-knowledge，设置完整 config，其中 agentId 必须为非空的小写字母、数字、下划线或连字符。home 默认为 ~/.acn-dsh。配置后重启 profile。';
  const claims = await knowledge.listClaims({ includeDeprecated: true, limit: 100 });
  const traces = await knowledge.listTraces({ limit: 100 });
  const queue = await new UploadStore(knowledge.context()).read();
  const jobs = (await new JobQueue(knowledge.context()).list()).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  const team = knowledge.teamStatus();
  return [
    `ACN: ${knowledge.mode}`, `agentId: ${knowledge.agentId}`, `数据目录: ${knowledge.context().paths.root}`,
    `Claim: ${claims.items.length + claims.omitted}`, `Trace: ${traces.items.length + traces.omitted}`,
    `待上传 Claim: ${queue.claims.length}；Dispute: ${queue.disputes.length}`,
    knowledge.mode === 'solo' ? '团队连接: 单人模式，不请求团队服务。' : `团队连接: Router=${team.router.state}；Maintainer=${team.maintainer.state}`,
    ...[team.router.error, team.maintainer.error].filter((error) => error !== undefined),
    `后台任务: queued=${jobs.filter((job) => job.state === 'queued').length} running=${jobs.filter((job) => job.state === 'running').length} failed=${jobs.filter((job) => job.state === 'failed').length}`,
    ...jobs.slice(0, 10).map((job) => `${job.id} ${job.kind} ${job.state} attempts=${job.attempts}${job.payload['paused'] === true ? ' — 已暂停' : ''}${job.lastError === undefined ? '' : ` — ${job.lastError}`}`),
    ...(jobs.some((job) => job.state === 'failed') ? ['重试失败任务：/acn-status retry <job_id>'] : []),
  ].join('\n');
}
