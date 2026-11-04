// 从已有的已应用事务追溯来源；缺少持久关联时不按时间或名称推断会话。
import type { StoreContext } from '../store/context.js';
import { FormationStore } from '../formation/checkpoint.js';
import { TranscriptStore } from '../formation/transcript.js';
import { DreamStore } from '../dream/checkpoint.js';
import { JobQueue } from '../worker/queue.js';
import { z } from 'zod';
import { ClaimIdSchema } from '../protocol/ids.js';

export async function knowledgeSources(context: StoreContext, entityIds: readonly string[]): Promise<Map<string, string[]>> {
  const wanted = new Set(entityIds); const sources = new Map<string, Set<string>>();
  const add = (ids: readonly string[], session: string) => { for (const id of ids) if (wanted.has(id)) { const values = sources.get(id) ?? new Set<string>(); values.add(session); sources.set(id, values); } };
  if (wanted.size === 0) return new Map();
  const formation = new FormationStore(context);
  for (const session of await new TranscriptStore(context).sessions()) {
    try {
      const record = await formation.read(session);
      if (record?.status === 'applied') add([...record.appliedClaims.filter((claim) => claim.holder === context.agentId).map((claim) => claim.id), ...record.disputes.filter((dispute) => dispute.reporter_agent_id === context.agentId).map((dispute) => dispute.id), ...record.trace?.agent === context.agentId ? [record.trace.id] : []], session);
    } catch { context.logger.warn('Could not read a knowledge source checkpoint.'); }
  }
  const traces = entityIds.some((id) => id.startsWith('trace_')); const dream = new DreamStore(context);
  for (const job of await new JobQueue(context).list()) {
    if (job.sessionId === undefined) continue;
    const result = z.object({ entityIds: z.array(z.string()).default([]), updatedClaimIds: z.array(ClaimIdSchema).default([]) }).safeParse(job.result);
    if (result.success) add([...result.data.entityIds, ...result.data.updatedClaimIds], job.sessionId);
    if (!traces || job.kind !== 'dream') continue;
    try {
      const final = await dream.final(job.id);
      if (final?.applied) add([final.trace_id], job.sessionId);
      for (const { checkpoint } of await dream.records(job.id)) if (checkpoint.applied) add([checkpoint.trace_id], job.sessionId);
    } catch { context.logger.warn('Could not read a knowledge source checkpoint.'); }
  }
  return new Map([...sources].map(([id, sessions]) => [id, [...sessions]]));
}
