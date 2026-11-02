// 新会话只读同项目最近会话的归属；不恢复历史 Agent，不另存项目偏好。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import { canonicalProjectPath } from '../upstreams.js';
import { isSubagent } from '../tools/subagent.js';
import { restoreSessionBinding, sessionSelection } from './session-binding.js';
import type { SessionSelection } from './session-binding.js';

export async function recentProjectSelection(ctx: Context, current: SessionHeader): Promise<SessionSelection | undefined> {
  if (current.cwd === undefined || isSubagent(current)) return undefined;
  try {
    const persistence = ctx.get('sessionPersistence');
    const headers = new Map<string, SessionHeader>();
    if (persistence !== undefined) for (const snapshot of await persistence.list()) headers.set(snapshot.header.id, snapshot.header);
    // 正在使用的日志优先于磁盘快照，包含尚未关闭的草稿选择。
    for (const session of ctx.sessions.list()) headers.set(session.id, session.header);
    const project = await canonicalProjectPath(current.cwd);
    const paths = new Map<string, string>();
    const candidates = [...headers.values()].filter((header) => header.id !== current.id && header.createdAt <= current.createdAt && header.cwd !== undefined && !isSubagent(header));
    candidates.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    for (const header of candidates) {
      if (header.cwd === undefined) continue;
      let path = paths.get(header.cwd);
      if (path === undefined) { path = await canonicalProjectPath(header.cwd); paths.set(header.cwd, path); }
      if (path !== project) continue;
      const live = ctx.sessions.get(header.id);
      if (live !== undefined) {
        const selection = sessionSelection(ctx, live.header);
        // 并发新建的草稿可能尚未绑定，不能让它遮住此前已确认的选择。
        if (selection === undefined) continue;
        return selection;
      }
      if (persistence === undefined) continue;
      const handle = await persistence.open(header.id, 'read');
      try {
        const { events } = await handle.read();
        restoreSessionBinding(handle.header, events);
        return sessionSelection(ctx, handle.header);
      } finally { await handle.close(); }
    }
  } catch {
    // 历史不可读不阻止创建新会话，也不推断另一个历史身份。
    ctx.logger.warn('Could not read the recent project selection; the global default will be used.');
  }
  return undefined;
}
