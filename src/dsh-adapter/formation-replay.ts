// 复用宿主只读日志恢复投影，不启动历史 Agent，也不触发团队网络或模型。
import type { Context } from '@deepseek-ai/cordis';
import { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session';
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-workspace';
import type { ResolvedConfig } from '../config.js';
import type { ProjectionReplay } from '../formation/capture.js';
import { JobError } from '../worker/types.js';
import { isSubagent } from '../tools/subagent.js';
import { projectEvent } from './formation.js';
import { restoreSessionBinding, sessionAllowed } from './session-binding.js';

async function readSession(ctx: Context, id: string): Promise<{ header: SessionHeader; events: readonly SessionEvent[] } | undefined> {
  const sessionId = SessionId(id); const live = ctx.sessions.get(sessionId);
  if (live !== undefined) return { header: live.header, events: live.snapshotEvents() };
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined || await persistence.stat(sessionId) === undefined) return;
  const handle = await persistence.open(sessionId, 'read');
  try { return { header: handle.header, events: (await handle.read()).events }; }
  finally { await handle.close(); }
}
function owned(ctx: Context, config: ResolvedConfig, source: { header: SessionHeader; events: readonly SessionEvent[] }): boolean {
  restoreSessionBinding(source.header, source.events);
  return !isSubagent(source.header) && sessionAllowed(ctx, config, source.header);
}
export function formationOwnership(ctx: Context, config: ResolvedConfig): (id: string) => Promise<boolean> {
  return async (id) => {
    const source = await readSession(ctx, id);
    return source !== undefined && owned(ctx, config, source);
  };
}
export function formationReplay(ctx: Context, config: ResolvedConfig): ProjectionReplay {
  return async (id) => {
    const source = await readSession(ctx, id);
    if (source === undefined) throw new JobError('transcript_source', 'Original session storage is unavailable.');
    if (!owned(ctx, config, source)) throw new JobError('transcript_source', 'Original session ownership does not match.');
    const { events } = source;
    const binding = events.find((event) => {
      const record = pluginRecordOf(event);
      return record?.type === 'plugin:acn/session-binding' || record?.type === 'plugin:acn/team-selection';
    });
    if (binding === undefined) throw new JobError('transcript_source', 'Original session ownership is missing.');
    const workspace = ctx.get('workspaceRegistry');
    return [...events.filter((event) => event.seq >= binding.seq).map(projectEvent).filter((projection) => Object.keys(projection).length > 0), {
      sourceSeq: events.at(-1)?.seq ?? -1,
      ...(workspace === undefined ? {} : { sourceArchived: workspace.archivedSessionIds.includes(SessionId(id)) }),
    }];
  };
}
