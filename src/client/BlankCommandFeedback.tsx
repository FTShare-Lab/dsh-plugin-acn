// 空会话的宿主不展示命令流水，使用本次执行回执补充结果；已有对话仍由宿主展示。
import { useEffect, useState } from 'react';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import { Button, Modal } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';
type Listener = (sessionId: string, name: string, result: CommandResult) => void;
const names = new Set(['acn-status', 'claim', 'acn-import', 'recap', 'acn-finalize', 'inbox', 'dream']);
export function BlankCommandFeedback({ sessionId, blank, subscribe, c }: { sessionId: string; blank: boolean; subscribe: (listener: Listener) => () => void; c: Copy }) {
  const [result, setResult] = useState<{ name: string; text: string; failed: boolean }>();
  useEffect(() => {
    if (!blank) return;
    return subscribe((id, name, outcome) => {
      if (id === sessionId && names.has(name) && outcome.text) setResult({ name, text: outcome.text, failed: outcome.kind === 'error' });
    });
  }, [blank, sessionId, subscribe]);
  if (!blank || !result) return null;
  return <Modal compact title={`/${result.name}`} closeLabel={c('关闭命令结果', 'Close command result')} close={() => { setResult(undefined); }}>
    <pre className="acn-command-result" role={result.failed ? 'alert' : 'status'}>{result.text}</pre>
    <div className="acn-confirm-actions"><Button primary onClick={() => { setResult(undefined); }}>{c('确认', 'Confirm')}</Button></div>
  </Modal>;
}
