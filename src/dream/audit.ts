// 审计正文保留整理前后、复核和真实执行结果；审计写失败时不能开始 Claim 提交。
import { join } from 'node:path';
import type { StoreContext } from '../store/context.js';
import { writeTextAtomic } from '../store/atomic.js';
import type { Checkpoint, Progress } from './schema.js';

export async function executionAudit(context: StoreContext, jobId: string, checkpoint: Checkpoint): Promise<void> {
  const id = checkpoint.operation?.validation_id ?? 'final';
  const heading = checkpoint.applied ? '已应用' : 'prepared（尚未确认完成）';
  const note = `# Dream ${heading}\n\n这份记录核对结构、来源和版本，不保证语义正确。\n\n组：${checkpoint.operation?.group_id ?? 'final'}。\n\n${checkpoint.groups.map((group) => `- completed=${group.completed} skipped=${group.skipped}：${group.before.map((claim) => claim.id).join(', ')}`).join('\n')}\n\n实际变更：${Object.keys(checkpoint.self_versions).join(', ') || '无'}\n\n\`\`\`json\n${JSON.stringify(checkpoint, null, 2)}\n\`\`\`\n`;
  await writeTextAtomic(join(context.paths.dreamJob(jobId), 'executions', `${id}.md`), note, context.logger);
}
export async function jobReport(context: StoreContext, jobId: string, progress: Progress, coverage: unknown, records: readonly Checkpoint[]): Promise<void> {
  const note = `# Dream ${progress.finished ? '已完成' : '处理中'}\n\n质量清理：${progress.discovery.review.quality}\n\n证据校准：${progress.discovery.review.evidence}\n\n主题整合：${progress.discovery.review.consolidation}\n\n覆盖：\`${JSON.stringify(coverage)}\`\n\n${progress.entries.map((entry) => `- ${entry.candidate.group_id}：${entry.status}；${entry.reason || entry.candidate.reason}`).join('\n') || '本轮没有需要修改的候选。'}\n\n实际修改 ID：${[...new Set(records.flatMap((record) => Object.keys(record.self_versions)))].join(', ') || '无'}\n\n未探索不代表不存在；保持原样是合法结果。引用原文、保留信息与最终名称已作模型自复核，硬校验不证明语义正确。\n`;
  await writeTextAtomic(join(context.paths.dreamJob(jobId), 'report.md'), note, context.logger);
}
