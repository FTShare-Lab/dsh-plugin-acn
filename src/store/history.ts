// 只读投影已有应用、来源与投递账本；历史任务不进入当前队列，也不重放旧结果。
import fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { StoreContext } from './context.js';
import { ClaimSchema } from '../protocol/claim.js';
import { DisputeSchema } from '../protocol/dispute.js';
import { TraceSchema } from '../protocol/trace.js';
import { optional } from '../protocol/schema.js';
import { parse } from 'yaml';
import { hasCode } from './errors.js';

const Session = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const Application = z.object({ schema_version: z.literal(1), state: z.enum(['prepared', 'applied', 'cancelled']), application: z.object({ id: z.string().uuid(), agent: z.string(), knowledge: z.object({ claims: z.array(ClaimSchema), disputes: z.array(DisputeSchema) }), trace: optional(TraceSchema) }) });
const Journal = z.object({ schemaVersion: z.literal(1), scope: z.object({ upstreamId: z.string(), sessionId: Session }), jobs: z.array(z.object({ id: z.string().uuid(), applicationId: z.string().uuid().nullable(), work: z.object({ agentId: z.string() }).nullable(), trigger: z.string(), attempts: z.number().int().nonnegative(), queuedAtMicros: z.number().nonnegative() })), presentationTimes: z.record(z.string(), z.number().nonnegative()).default({}) });
const Entity = z.discriminatedUnion('kind', [z.object({ kind: z.literal('claim'), value: ClaimSchema }), z.object({ kind: z.literal('dispute'), value: DisputeSchema })]);
const Ledger = z.object({ schemaVersion: z.literal(1), scope: z.object({ upstream: z.string(), agent: z.string() }), batches: z.array(z.object({ applicationId: z.string().uuid(), owner: z.object({ sourceSession: Session }), items: z.array(z.object({ entity: Entity, state: z.string(), lastConnectionRevision: optional(z.string()), presentationAtMicros: z.number().nonnegative().default(0) })) })) });
const ConnectionIndex = z.object({ upstreams: z.array(z.object({ summary: z.object({ id: z.string(), agentId: z.string(), maintainerEndpoint: z.string() }), maintainerRevision: z.string().optional() })) });

export interface HistoricalApplication {
  id: string; state: 'prepared' | 'applied' | 'cancelled'; kind: 'recap' | 'finalize' | 'history'; attempts: number; updatedAt: number;
  entityIds: string[]; claimCount: number; disputeCount: number; traceCount: number; sessionId?: string;
}
export interface HistoricalKnowledge {
  applications: HistoricalApplication[];
  sources: Map<string, Set<string>>;
  deliveries: { entity: z.infer<typeof Entity>; endpoint: string; updatedAt: number; sessionId: string }[];
}

async function documents<T extends z.ZodType>(directory: string, schema: T, context: StoreContext): Promise<z.output<T>[]> {
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
  const result: z.output<T>[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.yaml') || name.includes('.tmp.')) continue;
    try { const value = schema.safeParse(parse(await fs.readFile(join(directory, name), 'utf8'))); if (value.success) result.push(value.data); else context.logger.warn('Skipped an invalid historical knowledge record.'); }
    catch (error) { if (hasCode(error, 'ENOENT')) continue; context.logger.warn('Could not read a historical knowledge record.'); }
  }
  return result;
}

export async function historicalKnowledge(context: StoreContext): Promise<HistoricalKnowledge> {
  const result: HistoricalKnowledge = { applications: [], sources: new Map(), deliveries: [] };
  const upstreamRoot = dirname(dirname(context.paths.root)); const upstreamId = basename(upstreamRoot);
  const add = (ids: readonly string[], session: string) => { for (const id of ids) { const sessions = result.sources.get(id) ?? new Set<string>(); sessions.add(session); result.sources.set(id, sessions); } };
  const origins = new Map<string, { sessionId: string; trigger: string; attempts: number; updatedAt: number }>();
  for (const journal of await documents(join(upstreamRoot, 'supervisor', 'journals'), Journal, context)) {
    if (journal.scope.upstreamId !== upstreamId) continue;
    for (const job of journal.jobs) if (job.applicationId !== null && job.work?.agentId === context.agentId) origins.set(job.applicationId, { sessionId: journal.scope.sessionId, trigger: job.trigger, attempts: job.attempts, updatedAt: (journal.presentationTimes[job.id] ?? job.queuedAtMicros) / 1000 });
  }
  for (const record of await documents(join(context.paths.root, 'applications'), Application, context)) {
    const { application } = record;
    if (application.agent !== context.agentId || application.knowledge.claims.some((claim) => claim.holder !== context.agentId) || application.knowledge.disputes.some((dispute) => dispute.reporter_agent_id !== context.agentId) || application.trace && application.trace.agent !== context.agentId) continue;
    const origin = origins.get(application.id);
    const entityIds = [...application.knowledge.claims.map((item) => item.id), ...application.knowledge.disputes.map((item) => item.id), ...application.trace ? [application.trace.id] : []];
    const times = [...application.knowledge.claims.map((item) => item.updated_at ?? item.created_at), ...application.knowledge.disputes.map((item) => item.created_at), ...application.trace ? [application.trace.created_at] : []].map(Date.parse);
    result.applications.push({ id: application.id, state: record.state, kind: origin?.trigger === 'archive' ? 'finalize' : origin === undefined ? 'history' : 'recap', attempts: origin?.attempts ?? 0, updatedAt: origin?.updatedAt ?? Math.max(0, ...times), entityIds, claimCount: application.knowledge.claims.length, disputeCount: application.knowledge.disputes.length, traceCount: Number(application.trace !== undefined), ...(origin === undefined ? {} : { sessionId: origin.sessionId }) });
    if (origin !== undefined && record.state === 'applied') add(entityIds, origin.sessionId);
  }
  try {
    const index = ConnectionIndex.parse(JSON.parse(await fs.readFile(join(dirname(dirname(upstreamRoot)), 'settings.json'), 'utf8')));
    const connection = index.upstreams.find((entry) => entry.summary.id === upstreamId && entry.summary.agentId === context.agentId);
    const ledger = Ledger.parse(parse(await fs.readFile(join(context.paths.uploads, 'ledger.yaml'), 'utf8')));
    if (ledger.scope.upstream !== upstreamId || ledger.scope.agent !== context.agentId) return result;
    for (const batch of ledger.batches) for (const item of batch.items) {
      const own = item.entity.kind === 'claim' ? item.entity.value.holder === context.agentId : item.entity.value.reporter_agent_id === context.agentId;
      if (!own) continue;
      add([item.entity.value.id], batch.owner.sourceSession);
      if (item.state === 'delivered' && connection !== undefined && connection.maintainerRevision !== undefined && item.lastConnectionRevision === connection.maintainerRevision && connection.summary.maintainerEndpoint) result.deliveries.push({ entity: item.entity, endpoint: connection.summary.maintainerEndpoint, updatedAt: item.presentationAtMicros / 1000, sessionId: batch.owner.sourceSession });
    }
  } catch (error) { if (!hasCode(error, 'ENOENT')) context.logger.warn('Could not read historical delivery acknowledgements.'); }
  return result;
}
