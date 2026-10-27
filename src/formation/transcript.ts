// 会话投影与游标共用状态锁；先同步正文，再推进游标，截尾损坏仅丢弃未完成行。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { StoreContext } from '../store/context.js';
import { SessionStateStore, VersionedDocumentSchema } from '../store/session-state.js';
import { hasCode } from '../store/errors.js';
import { writeTextAtomic, removeFile } from '../store/atomic.js';
import { JobError } from '../worker/types.js';

export const RouteSchema = z.strictObject({ provider: z.string().min(1), model: z.string().min(1) });
export type Route = z.infer<typeof RouteSchema>;
const seq = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
export const FormationStateSchema = z.object({
  lastSeenSeq: seq.default(-1), recappedThroughSeq: seq.default(-1), finalizedThroughSeq: seq.default(-1),
  lastRoute: RouteSchema.optional(), seenSourceIds: z.array(z.string()).default([]), privateToolCalls: z.array(z.string()).default([]),
  activityAt: z.number().int().nonnegative().default(0), activitySeq: seq.default(-1),
  humanTurn: z.boolean().default(false), completedTurns: z.array(seq).default([]),
  autoPaused: z.boolean().default(false), archivedThroughSeq: seq.nullable().default(null),
  archiveIntent: seq.nullable().default(null), archivePending: z.boolean().default(false),
});
export type FormationState = z.infer<typeof FormationStateSchema>;
export const TranscriptEntrySchema = z.strictObject({ seq: seq.refine((value) => value >= 0), type: z.enum(['user', 'assistant', 'tool_call', 'tool_result']), text: z.string() });
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;
export interface Projection {
  entry?: TranscriptEntry; route?: Route; seenSourceIds?: string[]; privateCallId?: string; resultCallId?: string;
  activity?: { seq: number; at: number; human?: boolean; turn?: 'start' | 'completed' | 'ended' };
}
export const processedThrough = (state: FormationState): number => Math.max(state.recappedThroughSeq, state.finalizedThroughSeq);

export class TranscriptStore {
  readonly states: SessionStateStore;
  constructor(readonly context: StoreContext, private readonly maxBytes = 50 * 1024 * 1024) { this.states = new SessionStateStore(context); }
  async state(id: string): Promise<FormationState> { return FormationStateSchema.parse(await this.states.read(id) ?? {}); }
  async read(id: string, repair = false): Promise<TranscriptEntry[]> {
    let text = '';
    try { text = await fs.readFile(this.context.paths.transcript(id), 'utf8'); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    const entries = complete.split('\n').filter(Boolean).map((line) => {
      try { return TranscriptEntrySchema.parse(JSON.parse(line)); }
      catch { throw new JobError('transcript', '会话投影存在损坏的完整行；请检查本地 transcript 文件后重试。'); }
    });
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1]; const current = entries[index];
      if (previous !== undefined && current !== undefined && current.seq <= previous.seq) throw new JobError('transcript', '会话投影的 seq 顺序损坏；请检查本地 transcript 后重试。');
    }
    if (repair && complete !== text) { await writeTextAtomic(this.context.paths.transcript(id), complete, this.context.logger); this.context.logger.warn('Repaired incomplete transcript tail.'); }
    // 未处理数据装不下主文件时分片保存；恢复期间重复的完整行按 seq 与正文核对。
    for (const file of await this.pendingFiles(id)) {
      let entry;
      try { entry = TranscriptEntrySchema.parse(JSON.parse(await fs.readFile(join(this.context.paths.transcriptPending(id), file), 'utf8'))); }
      catch { throw new JobError('transcript', '会话投影分片损坏；请检查本地 transcript-pending 后重试。'); }
      if (`${entry.seq}.json` !== file) throw new JobError('transcript', '会话投影分片 seq 与文件名不一致。');
      entries.push(entry);
    }
    const unique = new Map<number, TranscriptEntry>();
    for (const entry of entries) {
      const previous = unique.get(entry.seq);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(entry)) throw new JobError('transcript', '同一 seq 的会话投影内容冲突。');
      unique.set(entry.seq, entry);
    }
    return [...unique.values()].sort((a, b) => a.seq - b.seq);
  }
  private async pendingFiles(id: string): Promise<string[]> {
    try { return (await fs.readdir(this.context.paths.transcriptPending(id))).filter((file) => /^(0|[1-9][0-9]*)\.json$/.test(file)); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
  }
  private async materialize(id: string, entries: TranscriptEntry[]): Promise<number> {
    let main = ''; let bytes = 0; const spill = new Set<string>();
    for (const entry of entries) {
      const line = `${JSON.stringify(entry)}\n`; const size = Buffer.byteLength(line);
      if (size > this.maxBytes) throw new JobError('transcript_limit', '单条会话投影超过 50MB；请缩小单次输入后重试。');
      if (bytes + size <= this.maxBytes) { main += line; bytes += size; }
      else { const file = `${entry.seq}.json`; spill.add(file); await writeTextAtomic(join(this.context.paths.transcriptPending(id), file), line, this.context.logger); }
    }
    // 先持久分片，再替换主文件，最后删除多余副本；中断最多留下可核对的重复行。
    await writeTextAtomic(this.context.paths.transcript(id), main, this.context.logger);
    for (const file of await this.pendingFiles(id)) if (!spill.has(file)) await removeFile(join(this.context.paths.transcriptPending(id), file), this.context.logger);
    return bytes;
  }
  async record(id: string, projection: Projection): Promise<void> {
    await this.states.update(id, async (current) => {
      const state = FormationStateSchema.parse(current ?? {});
      const entries = await this.read(id, true);
      const tail = entries.at(-1)?.seq ?? -1;
      state.lastSeenSeq = Math.max(state.lastSeenSeq, tail);
      if (projection.route !== undefined) state.lastRoute = projection.route;
      if (projection.privateCallId !== undefined && !state.privateToolCalls.includes(projection.privateCallId)) state.privateToolCalls.push(projection.privateCallId);
      const privateResult = projection.resultCallId !== undefined && state.privateToolCalls.includes(projection.resultCallId);
      if (!privateResult) state.seenSourceIds = [...new Set([...state.seenSourceIds, ...projection.seenSourceIds ?? []])];
      const entry = projection.entry;
      if (!privateResult && entry !== undefined && entry.seq > state.lastSeenSeq) {
        const line = `${JSON.stringify(entry)}\n`;
        if (Buffer.byteLength(line) > this.maxBytes) throw new JobError('transcript_limit', '单条会话投影超过 50MB；请缩小单次输入后重试。');
        let bytes = 0;
        try { bytes = (await fs.stat(this.context.paths.transcript(id))).size; } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
        if (bytes + Buffer.byteLength(line) > this.maxBytes) bytes = await this.materialize(id, entries.filter((row) => row.seq > processedThrough(state)));
        if (bytes + Buffer.byteLength(line) > this.maxBytes) await writeTextAtomic(join(this.context.paths.transcriptPending(id), `${entry.seq}.json`), line, this.context.logger);
        else {
          const file = await fs.open(this.context.paths.transcript(id), 'a', 0o600);
          try { await file.writeFile(line); await file.sync(); } finally { await file.close(); }
        }
        state.lastSeenSeq = entry.seq;
      }
      const activity = projection.activity;
      if (!privateResult && activity !== undefined && activity.seq > state.activitySeq) {
        state.activitySeq = activity.seq;
        if (activity.turn === 'start') state.humanTurn = false;
        if (activity.human) {
          state.humanTurn = true;
          // 只有真正准入的用户输入解除暂停；查看历史、撤销归档和迟到工具结果均不解除。
          if (state.archiveIntent === null) state.autoPaused = false;
        }
        if (!state.autoPaused && state.archiveIntent === null) state.activityAt = Math.max(state.activityAt, activity.at);
        if (activity.turn === 'completed' && state.humanTurn && state.lastSeenSeq > processedThrough(state)) state.completedTurns.push(state.lastSeenSeq);
        if (activity.turn === 'completed' || activity.turn === 'ended') state.humanTurn = false;
      }
      // 旧版本投影没有活动元数据；迁移只初始化一次，重启和查看不会刷新时间。
      if (state.activityAt === 0 && state.lastSeenSeq >= 0) state.activityAt = Date.now();
      return VersionedDocumentSchema.parse({ ...current, schemaVersion: 1, ...state });
    });
  }
  async advance(id: string, kind: 'recap' | 'finalize', untilSeq: number): Promise<void> {
    await this.states.update(id, async (current) => {
      const state = FormationStateSchema.parse(current ?? {});
      state.recappedThroughSeq = Math.max(state.recappedThroughSeq, untilSeq);
      state.lastSeenSeq = Math.max(state.lastSeenSeq, untilSeq);
      if (kind === 'finalize') state.finalizedThroughSeq = Math.max(state.finalizedThroughSeq, untilSeq);
      state.completedTurns = state.completedTurns.filter((end) => end > processedThrough(state));
      const remaining = (await this.read(id, true)).filter((entry) => entry.seq > processedThrough(state));
      await this.materialize(id, remaining);
      return VersionedDocumentSchema.parse({ ...current, schemaVersion: 1, ...state });
    });
  }
  async lifecycle(id: string, change: (state: FormationState) => void): Promise<FormationState> {
    return FormationStateSchema.parse(await this.states.update(id, (current) => {
      const state = FormationStateSchema.parse(current ?? {}); change(state);
      return VersionedDocumentSchema.parse({ ...current, schemaVersion: 1, ...state });
    }));
  }
  async sessions(): Promise<string[]> {
    let entries;
    try { entries = await fs.readdir(this.context.paths.sessions, { withFileTypes: true }); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    return entries.filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)).map((entry) => entry.name);
  }
}
