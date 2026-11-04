// 连接检查使用紧凑结果弹窗，不在编辑表单中保留状态占位。
import type { InteractionResult } from '../interaction.js';
import { displayMessage } from '../interaction-messages.js';
import { Button, Modal } from './interaction-ui.js';
import type { Copy } from './interaction-ui.js';

export type ConnectionCheckResult = { message: string; checks: InteractionResult['checks']; failed: boolean };
export function ConnectionCheckDialog({ result, close, c }: { result: ConnectionCheckResult; close: () => void; c: Copy }) {
  return <Modal compact title={c('连接检查结果', 'Connection check results')} closeLabel={c('关闭检查结果', 'Close check results')} close={close}>
    {result.checks?.length ? <div className="acn-status-list" aria-label={c('团队连接检查结果', 'Team connection results')}>{(['maintainer', 'router'] as const).map((service) => {
      const item = result.checks?.find((check) => check.service === service);
      return <div className="acn-status-row" key={service} role={item?.state === 'failed' ? 'alert' : 'status'}><span className="acn-status-icon" aria-hidden="true">{item?.state === 'ok' ? '✅' : item?.state === 'failed' ? '❌' : '❓'}</span><strong>{service === 'router' ? 'Router' : 'Maintainer'}</strong><span>{item === undefined ? c('检查未完成', 'Check incomplete') : displayMessage(item.message, c)}</span></div>;
    })}</div> : <p className="acn-confirm-message" role={result.failed ? 'alert' : 'status'}>{result.message}</p>}
    <div className="acn-confirm-actions"><Button primary onClick={close}>{c('确认', 'Confirm')}</Button></div>
  </Modal>;
}
