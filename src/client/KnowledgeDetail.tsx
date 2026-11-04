// 按公开实体字段展示知识正文和可追踪来源。
import { Button } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
import { knowledgeDate, knowledgeLabels, knowledgeStatus } from './knowledge-labels.js';
export function KnowledgeDetail({ text, c, openClaim }: { text: string; c: Copy; openClaim: (id: string) => void }) {
  let values: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(text); if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return <p>{text}</p>; values = parsed as Record<string, unknown>; } catch { return <p>{text}</p>; }
  const labels = knowledgeLabels(c);
  const primary = ['scope', 'statement', 'summary', 'evidence_summary', 'confidence', 'source_claim_ids', 'claims', 'input_claims', 'output_claims', 'resolution'];
  const entries = Object.entries(values).filter(([key, value]) => !['name', 'status'].includes(key) && value !== null && value !== undefined);
  const fields = (technical: boolean) => <dl className="acn-detail-fields">{entries.filter(([key]) => primary.includes(key) !== technical).sort(([a], [b]) => technical ? 0 : primary.indexOf(a) - primary.indexOf(b)).map(([key, value]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{Array.isArray(value) ? value.length === 0 ? c('无', 'None') : <span className="acn-inline-links">{value.map((part: unknown, index) => typeof part === 'string' && /^(?:claim|trace)_[0-9a-f]{8}$/.test(part) ? <Button key={index} className="acn-text-button" onClick={() => { openClaim(part); }}>{part}</Button> : <span key={index}>{typeof part === 'string' ? part : JSON.stringify(part)} </span>)}</span> : typeof value === 'string' && ['created_at', 'updated_at', 'last_used', 'resolved_at'].includes(key) ? knowledgeDate(value) : typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value, null, 2)}</dd></div>)}</dl>;
  return <>{typeof values['status'] === 'string' && <p className="acn-help" style={{ marginBottom: 16 }}>{labels['status']}: {knowledgeStatus(values['status'], c)}</p>}{fields(false)}<details className="acn-detail-meta"><summary>{c('详细信息', 'Details')}</summary>{fields(true)}</details></>;
}
