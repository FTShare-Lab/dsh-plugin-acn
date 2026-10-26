// receipt ACK 只确认本地快照已持久化，与后续内化成败相互独立。
import type { TeamFacade } from '../team/service.js';
import { TeamError } from '../team/errors.js';
import { InboxStore } from '../store/inbox.js';
import type { StoreContext } from '../store/context.js';
import type { InboxId } from '../protocol/ids.js';

export interface SyncReport { pulled: number; accepted: number; acknowledged: number; warnings: string[] }
export async function syncInbox(context: StoreContext, team: TeamFacade | null, signal?: AbortSignal): Promise<SyncReport> {
  const report: SyncReport = { pulled: 0, accepted: 0, acknowledged: 0, warnings: [] };
  if (context.mode === 'solo' || team === null) return report;
  let messages;
  try { messages = await team.request('maintainer', () => team.maintainer.pull(signal)); }
  catch (error) { if (!(error instanceof TeamError)) throw error; report.warnings.push(error.message); return report; }
  report.pulled = messages.length;
  const store = new InboxStore(context);
  const accepted: InboxId[] = [];
  for (const message of messages) {
    signal?.throwIfAborted();
    try { await store.acceptPulled(message); if (!accepted.includes(message.id)) accepted.push(message.id); }
    catch { report.warnings.push('Inbox 快照持久化失败；已保存的前缀仍会确认并处理。'); break; }
  }
  report.accepted = accepted.length;
  if (accepted.length > 0) {
    try { await team.request('maintainer', () => team.maintainer.ack(accepted, signal)); report.acknowledged = accepted.length; }
    catch (error) { if (!(error instanceof TeamError)) throw error; report.warnings.push(error.message); }
  }
  return report;
}
