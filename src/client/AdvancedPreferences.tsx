// 高级偏好保留独立草稿，校验成功后通过既有配置保存接口提交。
import { useEffect, useId, useState } from 'react';
import { advancedConfiguration, AdvancedConfigurationSchema } from '../advanced-configuration.js';
import type { AdvancedConfiguration } from '../advanced-configuration.js';
import { Button, inputStyle } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
const fields = ['inboxProcessingStaleAfterSecs', 'routerQueryTimeoutSecs', 'httpTimeoutSecs', 'httpRetryCount', 'httpRetryBaseDelayMs', 'httpRetryMaxDelayMs'] as const;
const draftOf = (value: AdvancedConfiguration) => Object.fromEntries(fields.map((field) => [field, String(value[field])])) as Record<typeof fields[number], string>;
export function AdvancedPreferences({ value, busy, c, save }: { value: AdvancedConfiguration; busy: boolean; c: Copy; save: (value: AdvancedConfiguration) => Promise<boolean> }) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(value)); const [error, setError] = useState('');
  useEffect(() => { setDraft(draftOf(value)); setError(''); }, [value.inboxProcessingStaleAfterSecs, value.routerQueryTimeoutSecs, value.httpTimeoutSecs, value.httpRetryCount, value.httpRetryBaseDelayMs, value.httpRetryMaxDelayMs]);
  const labels: Record<typeof fields[number], string> = {
    inboxProcessingStaleAfterSecs: c('Inbox 过期处理时间（秒）', 'Inbox processing stale time (seconds)'), routerQueryTimeoutSecs: c('Router 查询超时（秒）', 'Router query timeout (seconds)'),
    httpTimeoutSecs: c('HTTP 单次超时（秒）', 'HTTP request timeout (seconds)'), httpRetryCount: c('额外重试次数', 'Additional retries'),
    httpRetryBaseDelayMs: c('重试基础等待（毫秒）', 'Retry base delay (milliseconds)'), httpRetryMaxDelayMs: c('重试最长等待（毫秒）', 'Maximum retry delay (milliseconds)'),
  };
  const hints: Record<typeof fields[number], string> = {
    inboxProcessingStaleAfterSecs: c('恢复遗留的处理中消息，聊天无需等待这个时间。', 'Recover abandoned processing messages; chat does not wait for this interval.'),
    routerQueryTimeoutSecs: c('查询或范围概览的总等待上限，包含额外重试。', 'Total wait for a query or scope overview, including retries.'),
    httpTimeoutSecs: c('修改后统一现有工作配置的团队请求超时，不影响模型请求。', 'Changing this value updates team timeouts for all configurations; model requests are separate.'),
    httpRetryCount: c('首次失败后的额外尝试次数；0 表示不重试。连接检查不重试。', 'Additional attempts after the first failure; 0 disables retries. Connection checks never retry.'),
    httpRetryBaseDelayMs: c('必须大于 0；作为额外重试的初始等待。', 'Positive initial wait before an additional attempt.'),
    httpRetryMaxDelayMs: c('不得小于基础等待；限制退避等待时间。', 'Must be at least the base delay; caps backoff waits.'),
  };
  const dirty = fields.some((field) => draft[field] !== String(value[field]));
  return <details className="acn-disclosure acn-advanced">
    <summary><span><strong>{c('高级参数', 'Advanced parameters')}</strong><span className="acn-help">{c('新启动的会话和后台实例采用新值，已有会话保留启动配置。', 'New sessions and background instances use saved values; existing sessions retain their startup configuration.')}</span></span></summary>
    <form className="acn-advanced-body" onSubmit={(event) => { event.preventDefault();
      const parsed = AdvancedConfigurationSchema.safeParse(Object.fromEntries(fields.map((field) => [field, draft[field].trim() === '' ? Number.NaN : Number(draft[field])])));
      if (!parsed.success) {
        const issue = parsed.error.issues[0]; const field = issue?.path[0] as typeof fields[number] | undefined;
        const rule = field === 'httpRetryCount' ? c('请填写 0 或正整数。', 'Enter zero or a positive integer.') : field === 'httpTimeoutSecs' || field === 'routerQueryTimeoutSecs' ? c('请填写至少 0.001 秒的有效数值。', 'Enter a valid duration of at least 0.001 seconds.') : c('请填写有效的正整数。', 'Enter a valid positive integer.');
        setError(issue?.code === 'custom' ? hints.httpRetryMaxDelayMs : `${field === undefined ? '' : labels[field]}：${rule}`); return;
      }
      setError(''); void save(parsed.data);
    }}>
      <div className="acn-form-grid">{fields.map((field) => <label className="acn-field" key={field}>{labels[field]}<input style={inputStyle} aria-label={labels[field]} aria-describedby={`${id}-${field}`} inputMode="decimal" disabled={busy} value={draft[field]} onChange={(event) => { setDraft({ ...draft, [field]: event.target.value }); setError(''); }} /><span id={`${id}-${field}`} className="acn-help">{hints[field]}</span></label>)}</div>
      {error && <p role="alert" className="acn-feedback is-error">{error}</p>}
      <div className="acn-actions"><Button primary type="submit" disabled={busy || !dirty}>{c('保存高级参数', 'Save advanced parameters')}</Button><Button disabled={busy || !dirty} onClick={() => { setDraft(draftOf(value)); setError(''); }}>{c('取消', 'Cancel')}</Button><Button className="acn-text-button" disabled={busy} onClick={() => { setDraft(draftOf(advancedConfiguration({}))); setError(''); }}>{c('重置为默认值', 'Reset to defaults')}</Button></div>
    </form>
  </details>;
}
