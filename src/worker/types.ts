// 任务协议只存本地调度事实；错误摘要不包含模型正文或传输凭据。
import { z } from 'zod';

export const JobKindSchema = z.enum(['finalize', 'recap', 'inbox', 'memory_review', 'dream']);
export type JobKind = z.infer<typeof JobKindSchema>;
export const JobSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.string().regex(/^[a-zA-Z0-9_-]+$/), kind: JobKindSchema,
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(), payload: z.record(z.string(), z.json()),
  state: z.enum(['queued', 'running', 'succeeded', 'failed']), attempts: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative().optional(),
  nextRunAt: z.number().int().nonnegative().optional(), lastError: z.string().optional(), result: z.json().optional(),
});
export type Job = z.infer<typeof JobSchema>;
export const jobPriority: Record<JobKind, number> = { finalize: 0, recap: 1, inbox: 2, memory_review: 3, dream: 4 };
export class JobError extends Error {
  constructor(readonly kind: string, message: string, readonly retryable = false) { super(message); }
}
export class Preempted extends JobError { constructor() { super('preempted', 'Recap superseded by Finalize before prepared.'); } }
export class DreamStopped extends JobError { constructor() { super('dream_stopped', 'Dream 已停在可恢复边界，已生效修改保留。'); } }
export class DreamYield extends JobError { constructor() { super('dream_yield', 'Dream 已让位给高优先级任务，草稿和进度保留。'); } }
