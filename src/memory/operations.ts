// 双文件条目操作只在内存中执行；整批验证通过后才交给存储事务发布。
import { z } from 'zod';
import type { ResolvedConfig } from '../config.js';
import type { MemoryTexts } from '../store/memory.js';
import { KnowledgeError } from '../knowledge/errors.js';
import { textSafetyIssue } from '../knowledge/safety.js';

const scalar = z.string().refine((value) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), 'Invalid Unicode scalar.');
export const MemoryTargetSchema = z.enum(['memory', 'user']);
export const MemoryOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), target: MemoryTargetSchema, entry: scalar }),
  z.strictObject({ op: z.literal('replace'), target: MemoryTargetSchema, old_text: scalar, new_text: scalar }),
  z.strictObject({ op: z.literal('remove'), target: MemoryTargetSchema, old_text: scalar }),
]);
export const MemoryArgsSchema = z.strictObject({ ops: z.array(MemoryOpSchema) });
export type MemoryOp = z.infer<typeof MemoryOpSchema>;
export type MemoryTarget = z.infer<typeof MemoryTargetSchema>;
export const MemoryUsageSchema = z.strictObject({ chars: z.number().int().nonnegative(), cap_chars: z.number().int().nonnegative(), percent: z.number().int().min(0).max(100), entry_count: z.number().int().nonnegative() });
export const MemorySnapshotSchema = z.strictObject({ memory_text: z.string(), user_text: z.string(), memory_entries: z.array(z.string()), user_entries: z.array(z.string()), memory_usage: MemoryUsageSchema, user_usage: MemoryUsageSchema });
export type MemorySnapshot = z.infer<typeof MemorySnapshotSchema>;
export const MemoryReportSchema = z.strictObject({ memory_chars: z.number().int().nonnegative(), memory_cap_chars: z.number().int().nonnegative(), memory_percent: z.number().int().nonnegative(), memory_entry_count: z.number().int().nonnegative(), user_chars: z.number().int().nonnegative(), user_cap_chars: z.number().int().nonnegative(), user_percent: z.number().int().nonnegative(), user_entry_count: z.number().int().nonnegative(), target: MemoryTargetSchema.nullable().default(null), target_entries: z.array(z.string()).default([]), no_op: z.boolean().default(false), message: z.string().nullable().default(null) });
export class MemoryError extends KnowledgeError {
  constructor(kind: 'validation' | 'safety' | 'conflict', message: string, readonly details: Record<string, z.infer<ReturnType<typeof z.json>>> = {}) { super(kind, message); this.name = 'MemoryError'; }
}
export const MEMORY_SEPARATOR = '\n\n§\n\n';
const trim = (text: string): string => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
export const entries = (text: string): string[] => [...new Set(text.split('§').map(trim).filter(Boolean))];
export const renderEntries = (values: readonly string[]): string => values.join(MEMORY_SEPARATOR);
const chars = (text: string): number => Array.from(text).length;
export function memoryUsage(values: readonly string[], cap: number): z.infer<typeof MemoryUsageSchema> { const size = chars(renderEntries(values)); return { chars: size, cap_chars: cap, percent: cap === 0 ? 0 : Math.min(100, Math.floor(size * 100 / cap)), entry_count: values.length }; }
export function snapshotTexts(texts: MemoryTexts, config: Pick<ResolvedConfig['memory'], 'memoryCharLimit' | 'userCharLimit'>): MemorySnapshot {
  const memory = entries(texts.memory); const user = entries(texts.user);
  return { memory_text: renderEntries(memory), user_text: renderEntries(user), memory_entries: memory, user_entries: user, memory_usage: memoryUsage(memory, config.memoryCharLimit), user_usage: memoryUsage(user, config.userCharLimit) };
}
export function scanMemoryOps(ops: readonly MemoryOp[]): void {
  for (const op of ops) {
    if (op.op === 'remove') continue;
    const issue = textSafetyIssue(op.op === 'add' ? op.entry : op.new_text);
    if (issue !== null) throw new MemoryError('safety', `Memory safety scan blocked content: ${issue}.`);
  }
}
export function applyMemoryOps(texts: MemoryTexts, config: Pick<ResolvedConfig['memory'], 'memoryCharLimit' | 'userCharLimit' | 'safetyScan'>, ops: readonly MemoryOp[]) {
  if (config.safetyScan) scanMemoryOps(ops);
  const values = { memory: entries(texts.memory), user: entries(texts.user) }; const original = { memory: renderEntries(values.memory), user: renderEntries(values.user) };
  let target: MemoryTarget | null = null; let message: string | null = null;
  for (const op of ops) {
    target = op.target;
    const text = op.op === 'add' ? op.entry : op.op === 'replace' ? op.new_text : undefined;
    if (text !== undefined && (text.includes('§') || trim(text) === '')) throw new MemoryError('validation', 'Memory entry must be nonblank and cannot contain the reserved delimiter §.');
    if (op.op === 'add') {
      const entry = trim(op.entry); const duplicate = values[op.target].includes(entry); if (!duplicate) values[op.target].push(entry);
      message = duplicate ? 'Entry already exists (no duplicate added).' : 'Entry added.';
    } else {
      const needle = trim(op.old_text); const matched = values[op.target].flatMap((entry, index) => needle !== '' && entry.includes(needle) ? [index] : []);
      if (matched.length !== 1 || matched[0] === undefined) throw new MemoryError('validation', 'Memory substring match failed.', { target: op.target, matches: matched.length });
      if (op.op === 'replace') { values[op.target][matched[0]] = trim(op.new_text); message = 'Entry replaced.'; }
      else { values[op.target].splice(matched[0], 1); message = 'Entry removed.'; }
    }
  }
  values.memory = [...new Set(values.memory)]; values.user = [...new Set(values.user)];
  for (const name of ['memory', 'user'] as const) {
    const usage = memoryUsage(values[name], name === 'memory' ? config.memoryCharLimit : config.userCharLimit);
    if (usage.chars > usage.cap_chars) throw new MemoryError('validation', 'Memory capacity exceeded.', { target: name, current: usage.chars, cap: usage.cap_chars, need_free: usage.chars - usage.cap_chars, current_entries: values[name], usage: `${usage.chars}/${usage.cap_chars}` });
  }
  const next = { memory: renderEntries(values.memory), user: renderEntries(values.user) }; const snapshot = snapshotTexts(next, config);
  const result = MemoryReportSchema.parse({ memory_chars: snapshot.memory_usage.chars, memory_cap_chars: snapshot.memory_usage.cap_chars, memory_percent: snapshot.memory_usage.percent, memory_entry_count: snapshot.memory_usage.entry_count, user_chars: snapshot.user_usage.chars, user_cap_chars: snapshot.user_usage.cap_chars, user_percent: snapshot.user_usage.percent, user_entry_count: snapshot.user_usage.entry_count, target, target_entries: target === null ? [] : values[target], no_op: next.memory === original.memory && next.user === original.user, message });
  return { next, result };
}
export function renderMemoryBlock(target: MemoryTarget, values: readonly string[], cap: number): string {
  if (values.length === 0) return '';
  const usage = memoryUsage(values, cap); const count = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ','); const separator = '═'.repeat(46);
  return `${separator}\n${target === 'memory' ? 'MEMORY (your personal notes)' : 'USER PROFILE (who the user is)'} [${usage.percent}% — ${count(usage.chars)}/${count(cap)} chars]\n${separator}\n${renderEntries(values)}`;
}
