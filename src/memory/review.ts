// 最近用户 turn 的私有投影带持久 outbox；模型不持锁，prepared 后只恢复固定 Memory 操作。
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AcnMemory } from './service.js';
import { memoryRevision } from './service.js';
import { MemoryArgsSchema, MemoryError, applyMemoryOps, snapshotTexts } from './operations.js';
import { TranscriptEntrySchema, RouteSchema, type Projection } from '../formation/transcript.js';
import type { StructuredBackend } from '../llm/structured.js';
import { resolveRoute, structuredCall } from '../llm/structured.js';
import { withFileLock } from '../store/lock.js';
import { readYamlOr, writeYamlAtomic } from '../store/yaml.js';
import { hasCode } from '../store/errors.js';
import { JobError, type Job } from '../worker/types.js';
import type { JobControl } from '../worker/worker.js';

const Key = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const Entry = TranscriptEntrySchema.extend({ turn: z.number().int().nonnegative(), truncated: z.boolean().default(false) });
const RequestSchema = z.strictObject({ schemaVersion: z.literal(1), id: Key, session_id: Key, epoch: Key, through_turn: z.number().int().positive(), entries: z.array(Entry), omitted: z.boolean(), route: RouteSchema.optional() });
const WindowSchema = z.strictObject({ schemaVersion: z.literal(1), epoch: Key, last_seq: z.number().int().min(-1), turns: z.number().int().nonnegative(), user: z.boolean(), assistant: z.boolean(), entries: z.array(Entry), omitted: z.boolean(), private_calls: z.array(z.string()), route: RouteSchema.optional(), outbox: z.array(RequestSchema) });
const CheckpointSchema = z.strictObject({ schemaVersion: z.literal(1), request_id: Key, expected_revision: z.string().regex(/^[0-9a-f]{64}$/), ops: MemoryArgsSchema.shape.ops, applied: z.boolean(), skipped: z.boolean(), changed: z.boolean() });
export interface MemoryReviewEvent { seq: number; projection?: Projection; user?: boolean; completed?: boolean; ended?: boolean }
export class MemoryReview {
  private readonly writes = new Map<string, Promise<void>>();
  private readonly unregister: () => void;
  private active: Promise<Job['result']> | undefined;
  private closed = false;
  constructor(readonly memory: AcnMemory, private readonly backend: StructuredBackend, private readonly render: (name: string, context: object) => string) {
    const worker = memory.knowledge.jobs; if (worker === null) throw new JobError('unconfigured', '请先配置 agentId。');
    this.unregister = memory.knowledge.config.memory.enabled && memory.knowledge.config.memory.review.enabled ? worker.register('memory_review', async (job, control) => {
      const run = this.run(job, control); this.active = run;
      try { return await run; } catch (error) { memory.knowledge.logger.warn('Private Memory review could not complete; see the task state after fixing storage or model configuration.'); throw error; } finally { if (this.active === run) this.active = undefined; }
    }) : () => {};
  }
  private initial() { return WindowSchema.parse({ schemaVersion: 1, epoch: randomUUID(), last_seq: -1, turns: 0, user: false, assistant: false, entries: [], omitted: false, private_calls: [], outbox: [] }); }
  private chain(id: string, action: () => Promise<void>): Promise<void> {
    const next = (this.writes.get(id) ?? Promise.resolve()).then(action).catch(() => { this.memory.knowledge.logger.warn('Could not persist private Memory review progress; the durable outbox will be retried.'); }); this.writes.set(id, next); return next;
  }
  async attach(id: string, source: 'startup' | 'resume' | 'compact' | 'clear'): Promise<void> {
    if (!this.memory.knowledge.config.memory.enabled || !this.memory.knowledge.config.memory.review.enabled) return;
    await this.chain(id, async () => { const path = this.memory.knowledge.context().paths.memoryWindow(id); await withFileLock(`${path}.lock`, async () => { const prior = await readYamlOr(path, WindowSchema, () => null); if (prior === null || source === 'clear') { const next = this.initial(); if (prior !== null) next.outbox = prior.outbox; await writeYamlAtomic(path, next, WindowSchema, this.memory.knowledge.logger); } }); await this.drain(id); });
  }
  capture(id: string, event: MemoryReviewEvent): void {
    if (this.closed || !this.memory.knowledge.config.memory.enabled || !this.memory.knowledge.config.memory.review.enabled) return;
    void this.chain(id, async () => {
      const context = this.memory.knowledge.context(); const path = context.paths.memoryWindow(id); const config = this.memory.knowledge.config.memory.review;
      await withFileLock(`${path}.lock`, async () => {
        const state = await readYamlOr(path, WindowSchema, () => this.initial()); if (event.seq <= state.last_seq) return;
        const projection = event.projection ?? {}; if (projection.route !== undefined) state.route = projection.route;
        if (projection.privateCallId !== undefined) state.private_calls.push(projection.privateCallId);
        const privateResult = projection.resultCallId !== undefined && state.private_calls.includes(projection.resultCallId);
        if (projection.resultCallId !== undefined) state.private_calls = state.private_calls.filter((id) => id !== projection.resultCallId);
        if (event.user) state.user = true;
        if (!privateResult && projection.entry !== undefined) { const entry = projection.entry; const text = Array.from(entry.text); state.entries.push({ ...entry, turn: state.turns + 1, text: text.slice(0, config.maxTranscriptChars).join(''), truncated: text.length > config.maxTranscriptChars }); if (entry.type === 'assistant' && entry.text.trim() !== '') state.assistant = true; }
        let completedUserTurn = false;
        if (event.ended) {
          if (event.completed && state.user && state.assistant) { state.turns += 1; completedUserTurn = true; }
          else state.entries = state.entries.filter((entry) => entry.turn <= state.turns);
          state.user = false; state.assistant = false;
        }
        state.entries = state.entries.filter((entry) => entry.turn > state.turns - config.intervalTurns); let chars = state.entries.reduce((total, entry) => total + Array.from(entry.text).length, 0);
        while (chars > config.maxTranscriptChars && state.entries.length > 0) {
          const first = state.entries[0]; if (first === undefined) break;
          const text = Array.from(first.text); const excess = chars - config.maxTranscriptChars;
          if (excess >= text.length) { state.entries.shift(); chars -= text.length; }
          else { first.text = text.slice(excess).join(''); first.truncated = true; chars -= excess; }
          state.omitted = true;
        }
        state.last_seq = event.seq;
        if (completedUserTurn && state.turns % config.intervalTurns === 0 && state.entries.some((entry) => entry.type === 'user') && state.entries.some((entry) => entry.type === 'assistant')) {
          const key = createHash('sha256').update(`${id}:${state.epoch}:${state.turns}`).digest('hex');
          if (!state.outbox.some((request) => request.id === key)) state.outbox.push({ schemaVersion: 1, id: key, session_id: id, epoch: state.epoch, through_turn: state.turns, entries: state.entries, omitted: state.omitted || state.entries.some((entry) => entry.truncated), ...state.route === undefined ? {} : { route: state.route } });
        }
        await writeYamlAtomic(path, state, WindowSchema, context.logger);
      }); await this.drain(id);
    });
  }
  private async drain(id: string): Promise<void> {
    const context = this.memory.knowledge.context(); const path = context.paths.memoryWindow(id); const state = await readYamlOr(path, WindowSchema, () => null);
    for (const request of state?.outbox ?? []) {
      await writeYamlAtomic(context.paths.memoryRequest(request.id), request, RequestSchema, context.logger);
      await this.memory.knowledge.jobs?.enqueue('memory_review', { request_id: request.id }, id);
      await withFileLock(`${path}.lock`, async () => { const latest = await readYamlOr(path, WindowSchema, () => null); if (latest !== null) { latest.outbox = latest.outbox.filter((entry) => entry.id !== request.id); await writeYamlAtomic(path, latest, WindowSchema, context.logger); } });
    }
  }
  async start(): Promise<void> {
    if (!this.memory.knowledge.config.memory.enabled || !this.memory.knowledge.config.memory.review.enabled) return;
    let files: string[];
    try { files = await fs.readdir(this.memory.knowledge.context().paths.memoryWindows); } catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
    for (const file of files.filter((file) => /^[a-zA-Z0-9_-]+\.yaml$/.test(file))) { const id = file.slice(0, -5); await this.chain(id, () => this.drain(id)); }
    this.memory.knowledge.jobs?.wake(true);
  }
  private async run(job: Job, control: JobControl): Promise<Job['result']> {
    const context = this.memory.knowledge.context(); const requestId = Key.parse(job.payload['request_id']);
    const request = await readYamlOr(context.paths.memoryRequest(requestId), RequestSchema, () => null);
    if (request === null || request.id !== requestId || request.session_id !== job.sessionId) throw new JobError('memory_review_request', 'Memory review request is missing or belongs to another session.');
    const path = context.paths.memoryReview(job.id); let checkpoint = await readYamlOr(path, CheckpointSchema, () => null);
    if (checkpoint !== null && checkpoint.request_id !== requestId) throw new JobError('memory_review_request', 'Memory review checkpoint identity differs from the task.');
    if (checkpoint === null) {
      const texts = await this.memory.files.read(control.signal); const config = this.memory.knowledge.config;
      if (!(config.llm.provider && config.llm.model) && request.route === undefined) throw new JobError('memory_review_route', 'Memory review requires this session route or explicit llm.provider/llm.model.');
      const output = await structuredCall({ backend: this.backend, context, config: config.llm, route: await resolveRoute(config.llm, context, request.route), jobId: job.id, system: this.render('memory_review_system.j2', { agent_id: context.agentId }), input: JSON.stringify({ phase: 'memory_review', instruction: this.render('memory_review.j2', {}), transcript: request.entries, omitted: request.omitted, memory: snapshotTexts(texts, config.memory) }), schema: MemoryArgsSchema, parse: (value) => { const result = MemoryArgsSchema.parse(value); applyMemoryOps(texts, config.memory, result.ops); return result; }, signal: control.signal });
      checkpoint = { schemaVersion: 1, request_id: requestId, expected_revision: memoryRevision(texts), ops: output.ops, applied: false, skipped: false, changed: false };
      control.signal.throwIfAborted(); control.prepared(); await writeYamlAtomic(path, checkpoint, CheckpointSchema, context.logger);
    }
    if (!checkpoint.applied) {
      control.prepared();
      try { const report = await this.memory.apply({ ops: checkpoint.ops }, { id: job.id, expectedRevision: checkpoint.expected_revision }); checkpoint.changed = !report.no_op; }
      catch (error) { if (!(error instanceof MemoryError && error.kind === 'conflict')) throw error; checkpoint.skipped = true; }
      checkpoint.applied = true; await writeYamlAtomic(path, checkpoint, CheckpointSchema, context.logger); control.committed?.();
    }
    return { applied: true, changed: checkpoint.changed, skipped: checkpoint.skipped };
  }
  async flush(id?: string): Promise<void> { if (id === undefined) await Promise.all(this.writes.values()); else await this.writes.get(id); }
  async close(): Promise<void> { this.closed = true; await this.flush(); this.unregister(); await this.active?.catch(() => {}); }
}
