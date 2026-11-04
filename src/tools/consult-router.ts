// Router 查询是可降级的只读领域工具；只记录实际返回正文的候选 ID。
import { z } from 'zod';
import { validationMessage } from './validation.js';
import type { AcnKnowledge } from '../knowledge/service.js';
import { SessionStateStore } from '../store/session-state.js';
import { TeamError } from '../team/errors.js';

export const CONSULT_ROUTER_DESCRIPTION = "Consult the team router. Use mode='overview' to list available team claim scopes before choosing a query boundary. Use mode='query' with a non-empty scope to retrieve candidate claims and related disputes. Overview is only a map of available scopes; query returns concrete claim content.";
export const ConsultRouterArgsSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('overview') }),
  z.strictObject({ mode: z.literal('query'), scope: z.string().trim().min(1), semantic_query: z.string().trim().nullish() }),
]);
export async function executeConsultRouter(knowledge: AcnKnowledge, args: unknown, sessionId: string, signal?: AbortSignal): Promise<unknown> {
  const parsed = ConsultRouterArgsSchema.safeParse(args);
  if (!parsed.success) return { error: { kind: 'validation', message: validationMessage(parsed.error) } };
  const team = knowledge.team;
  if (team === null) return { error: { kind: 'unconfigured', message: 'Team router is not configured.' } };
  try {
    if (parsed.data.mode === 'overview') {
      const snapshot = await team.request('router', () => team.router.overview(signal));
      return { mode: 'overview', available: true, scopes: snapshot.scopes };
    }
    const { scope, semantic_query } = parsed.data;
    const result = await team.request('router', () => team.router.query({ scope, semantic_query: semantic_query || null }, signal));
    signal?.throwIfAborted();
    const ids = result.candidate_claims.map((claim) => claim.id);
    await new SessionStateStore(knowledge.context()).update(sessionId, (current) => {
      const seen = z.array(z.string()).parse(current?.['seenSourceIds'] ?? []);
      return { ...current, schemaVersion: 1, seenSourceIds: [...new Set([...seen, ...ids])] };
    });
    return { mode: 'query', available: true, candidate_claims: result.candidate_claims, disputes: result.disputes };
  } catch (error) {
    if (!(error instanceof TeamError)) throw error;
    return { mode: parsed.data.mode, available: false, error: { kind: error.kind, message: error.message } };
  }
}
