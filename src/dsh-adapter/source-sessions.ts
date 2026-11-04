// 来源检查只读会话与标题；打开会话仍交给宿主导航，不为校验恢复 Agent。
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { z } from 'zod';
import type { SourceSession } from '../interaction.js';

export async function sourceSession(ctx: Context, id: string, signal?: AbortSignal): Promise<SourceSession> {
  try {
    const sessionId = SessionId(id); const live = ctx.sessions.get(sessionId);
    let events: readonly SessionEvent[];
    if (live !== undefined) events = live.snapshotEvents();
    else {
      const controller = ctx.get('sessionController'); const persistence = ctx.get('sessionPersistence');
      if (controller !== undefined) events = (await controller.inspect(sessionId, signal)).events;
      else if (persistence !== undefined) {
        const handle = await persistence.open(sessionId, 'read');
        try { events = (await handle.read()).events; } finally { await handle.close(); }
      } else return { id, available: false };
    }
    signal?.throwIfAborted();
    const latest = [...events].reverse().find((event) => String(event.type) === 'session/title');
    const title = z.object({ title: z.string() }).safeParse(latest?.data);
    return { id, available: true, ...(title.success ? { title: title.data.title } : {}) };
  } catch { return { id, available: false }; }
}
