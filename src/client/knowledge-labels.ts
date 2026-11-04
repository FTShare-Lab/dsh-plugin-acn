// 术语、状态与时间格式沿用 ACN Maintainer Dashboard 的 i18n/status、zh 和 lib/format。
import type { Copy } from './interaction-ui.js';
const statuses: Record<string, string> = { active: '活跃', stale: '陈旧', deprecated: '废弃', deprecate: '废弃', open: '待处理', resolved: '已处理', live: '最近活跃', lagging: '最近未同步', idle: '长期未同步' };
export function knowledgeStatus(value: string, c: Copy): string { return c(statuses[value.toLowerCase()] ?? value, value); }
// 置信度沿用桌面知识页的高、中、低；不改变状态枚举和知识正文。
export function knowledgeConfidence(value: string, c: Copy): string { return c(({ high: '高', medium: '中', low: '低' })[value.toLowerCase()] ?? value, value); }
const formatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export function knowledgeDate(value: string | number): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : formatter.format(date).replace(',', ''); }
export function knowledgeLabels(c: Copy): Record<string, string> {
  return { statement: c('正文', 'Statement'), scope: c('适用范围', 'Scope'), evidence_summary: c('证据摘要', 'Evidence Summary'), confidence: c('置信度', 'Confidence'), source_claim_ids: c('来源 ID', 'Source IDs'), holder: c('所属 Agent', 'Holder Agent'), created_at: c('创建时间', 'Created At'), updated_at: c('更新时间', 'Updated At'), last_used: c('最近使用', 'Last used'), resolved_at: c('处理时间', 'Resolved At'), summary: c('摘要', 'Summary'), claims: c('相关 Claim', 'Related Claims'), reporter_agent_id: c('上报 Agent', 'Reporter Agent'), task: c('来源任务', 'Source task'), agent: c('所属 Agent', 'Agent'), input_claims: c('输入 Claim', 'Input Claims'), output_claims: c('输出 Claim', 'Output Claims'), resolution: c('当前处理结论', 'Current Resolution'), status: c('状态', 'Status'), id: 'ID', name: c('名称', 'Name') };
}
