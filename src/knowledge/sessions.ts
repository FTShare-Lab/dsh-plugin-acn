// 会话目录冻结落盘；仅在消息实际准入后推进变化游标，避免取消导致漏报。
import { z } from 'zod';
import { nowSeconds } from '../protocol/time.js';
import { SessionStateStore, VersionedDocumentSchema } from '../store/session-state.js';
import type { AcnKnowledge } from './service.js';
import { renderCatalog } from './catalog.js';
import { ClaimIndexSchema, changeNotice, claimIndex } from './changes.js';

const VersionSchema = z.object({ claimsDigest: z.string() });
const CatalogSchema = z.object({ text: z.string(), knowledgeVersion: VersionSchema, createdAt: z.string(), baseline: ClaimIndexSchema });
export const KnowledgeSessionStateSchema = z.object({
  schemaVersion: z.literal(1), catalog: CatalogSchema.optional(),
  lastNotifiedVersion: VersionSchema.optional(), knownClaims: ClaimIndexSchema.optional(), seenSourceIds: z.array(z.string()).optional(),
});
export type KnowledgeSessionState = z.infer<typeof KnowledgeSessionStateSchema>;
export interface ChangeAdmission { text: string; version: { claimsDigest: string }; knownClaims: z.infer<typeof ClaimIndexSchema> }

export class KnowledgeSessions {
  private readonly store: SessionStateStore;
  private readonly states = new Map<string, KnowledgeSessionState>();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly knowledge: AcnKnowledge) { this.store = new SessionStateStore(knowledge.context()); }
  async freeze(id: string, source: 'startup' | 'clear' | 'resume' | 'compact', parentId?: string, fetchOverview = true): Promise<void> {
    await this.flush(id);
    const stored = await this.store.read(id);
    let state = KnowledgeSessionStateSchema.parse(stored ?? { schemaVersion: 1 });
    if (state.catalog === undefined && parentId !== undefined && source !== 'clear') {
      await this.flush(parentId);
      const parent = KnowledgeSessionStateSchema.parse(await this.store.read(parentId) ?? { schemaVersion: 1 });
      if (parent.catalog !== undefined) {
        state = { ...state, catalog: parent.catalog, knownClaims: parent.knownClaims ?? parent.catalog.baseline, seenSourceIds: parent.seenSourceIds ?? [] };
        // fork 可能截取父会话较早的历史，不能继承父会话后来推进的通知游标。
        delete state.lastNotifiedVersion;
      }
    }
    if (state.catalog === undefined || source === 'clear' || (source === 'startup' && parentId === undefined)) {
      if (source === 'resume' || source === 'compact') this.knowledge.logger.warn('Missing session Claim catalog; creating a new baseline.');
      const snapshot = await this.knowledge.snapshot();
      const baseline = claimIndex(snapshot.claims);
      state = { ...state, catalog: { text: renderCatalog(snapshot.claims, this.knowledge.config.catalog), knowledgeVersion: snapshot.version, createdAt: nowSeconds(), baseline }, lastNotifiedVersion: snapshot.version, knownClaims: baseline, seenSourceIds: source === 'clear' ? [] : state.seenSourceIds ?? [] };
      const team = this.knowledge.team;
      if (fetchOverview && team !== null && state.catalog !== undefined) {
        try {
          const overview = await team.request('router', () => team.router.overview());
          const lines = overview.scopes.map((item) => `${JSON.stringify(item.scope)} | active=${item.active_claims} | stale=${item.stale_claims} | open_disputes=${item.open_disputes} | resolved_disputes=${item.resolved_disputes}`);
          const overviewText = `\n\nTeam scope overview (discovery only):\n${lines.join('\n') || '(empty)'}`;
          const total = this.knowledge.config.catalog.maxChars;
          const overviewBudget = Math.min(Math.floor(total / 2), Array.from(overviewText).length);
          state.catalog.text = renderCatalog(snapshot.claims, { ...this.knowledge.config.catalog, maxChars: Math.max(1, total - overviewBudget) });
          const remaining = Math.max(0, total - Array.from(state.catalog.text).length);
          state.catalog.text += Array.from(overviewText).slice(0, remaining).join('');
        } catch { state.catalog.text = Array.from(`${state.catalog.text}\n\n团队概览不可用。可通过 consult_router mode=overview 重试。`).slice(0, this.knowledge.config.catalog.maxChars).join(''); }
      }
    }
    const saved = await this.store.update(id, (current) => VersionedDocumentSchema.parse({ ...current, ...state }));
    this.states.set(id, KnowledgeSessionStateSchema.parse(saved));
  }
  catalog(id: string): string { return this.states.get(id)?.catalog?.text ?? ''; }
  async prepare(id: string): Promise<ChangeAdmission | null> {
    await this.flush(id);
    const state = this.states.get(id);
    if (state?.catalog === undefined) return null;
    const snapshot = await this.knowledge.snapshot();
    if (snapshot.version.claimsDigest === state.lastNotifiedVersion?.claimsDigest) return null;
    const current = claimIndex(snapshot.claims);
    return { text: changeNotice(snapshot.version.claimsDigest, state.catalog.baseline, current, state.knownClaims ?? state.catalog.baseline), version: snapshot.version, knownClaims: { ...state.knownClaims, ...current } };
  }
  admitted(id: string, notice: ChangeAdmission): void {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const write = previous.then(async () => {
      const saved = await this.store.update(id, (current) => ({ ...current, schemaVersion: 1, lastNotifiedVersion: notice.version, knownClaims: notice.knownClaims }));
      this.states.set(id, KnowledgeSessionStateSchema.parse(saved));
    }).catch(() => { this.knowledge.logger.warn('Could not persist the session Claim notice cursor; it will be retried.'); });
    this.writes.set(id, write);
  }
  async flush(id?: string): Promise<void> {
    if (id !== undefined) await this.writes.get(id);
    else await Promise.all(this.writes.values());
  }
  async forget(id: string): Promise<void> { await this.flush(id); this.states.delete(id); this.writes.delete(id); }
}
