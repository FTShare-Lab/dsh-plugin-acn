// 失败投影按会话保留顺序；先修复完整输入，再允许形成任务进入模型。
import { setTimeout as delay } from 'node:timers/promises';
import { StoreError } from '../store/errors.js';
import { JobError } from '../worker/types.js';
import type { TranscriptStore, Projection } from './transcript.js';

export type ProjectionReplay = (id: string) => Promise<readonly Projection[]>;
export type FormationStage = 'projection' | 'replay' | 'route' | 'scan' | 'enqueue';
class ProjectionFailure extends JobError {
  constructor(kind: string, message: string, readonly code: string) { super(kind, message); }
}
const ioCodes = ['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOSPC', 'EDQUOT', 'EIO', 'ENOENT'] as const;
export function formationFault(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    if (current instanceof ProjectionFailure) return current.code;
    const code = 'code' in current ? current.code : undefined;
    if (ioCodes.some((value) => value === code)) return String(code);
    if (current instanceof JobError && ['transcript', 'transcript_limit', 'transcript_source'].includes(current.kind)) return current.kind;
    if (current instanceof StoreError && current.kind !== 'io') return current.kind;
    current = 'cause' in current ? current.cause : undefined;
  }
  return 'unknown';
}
export async function retryFormation<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await action(); }
    catch (error) {
      if (attempt >= 2 || !['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'lock_timeout'].includes(formationFault(error))) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}
export function projectionError(error: unknown, stage: 'projection' | 'replay', seq?: number): JobError {
  const code = formationFault(error);
  const kind = code === 'transcript_limit' ? 'transcript_limit'
    : ['ENOSPC', 'EDQUOT'].includes(code) ? 'transcript_space'
    : ['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'lock_timeout'].includes(code) ? 'transcript_occupied'
    : ['transcript', 'decode', 'conflict'].includes(code) ? 'transcript_corrupt'
    : code === 'transcript_source' ? 'transcript_source' : 'transcript_io';
  const hint = kind === 'transcript_limit' ? '单条投影超过容量限制，无法自动跳过；请保留原会话并联系维护者处理。'
    : kind === 'transcript_space' ? '存储空间或配额不足；请释放空间后重试。'
    : kind === 'transcript_occupied' ? '文件暂不可写或锁等待超时，有限重试仍未恢复；请检查文件占用和目录权限后重试。'
    : kind === 'transcript_corrupt' ? '本地投影存在损坏或冲突，未跳过缺失内容；请保留数据并联系维护者。'
    : kind === 'transcript_source' ? '无法读取原会话日志来补齐投影；请恢复原会话及其工作配置后重试。'
    : '本地会话投影读写失败；请检查本地存储状态后重试。';
  return new ProjectionFailure(kind, `复盘输入尚未完整准备（${stage}${seq === undefined ? '' : `，seq=${seq}`}，${code}）。${hint} 修复后在活动页重试原任务，或再次复盘；本次未调用知识模型。`, code);
}

export class FormationCapture {
  private readonly buffers = new Map<string, Projection[]>();
  private readonly blocked = new Map<string, JobError>();
  private readonly restored = new Set<string>();
  constructor(private readonly transcript: TranscriptStore, private readonly replay?: ProjectionReplay) {}
  add(id: string, projection: Projection): void {
    const rows = this.buffers.get(id) ?? [];
    rows.push(projection); this.buffers.set(id, rows);
  }
  async drain(id: string, retry = false): Promise<void> {
    const failure = this.blocked.get(id);
    if (!retry && failure !== undefined) throw failure;
    const rows = this.buffers.get(id);
    while (rows !== undefined && rows.length > 0) {
      const projection = rows[0]; if (projection === undefined) break;
      try { await retryFormation(() => this.transcript.record(id, projection)); }
      catch (error) {
        const failure = projectionError(error, 'projection', projection.entry?.seq ?? projection.activity?.seq);
        this.blocked.set(id, failure); throw failure;
      }
      rows.shift();
    }
    this.buffers.delete(id); this.blocked.delete(id);
  }
  async prepare(id: string): Promise<void> {
    // 不让后继成功写入掩盖旧缺口；源日志重放也修复旧版本已经越过的缺失 seq。
    await this.drain(id, true);
    if (!this.restored.has(id) && this.replay !== undefined) {
      try {
        const projections = await retryFormation(() => this.replay?.(id) ?? Promise.resolve([]));
        await retryFormation(() => this.transcript.replay(id, projections));
        this.restored.add(id);
      } catch (error) { throw projectionError(error, 'replay'); }
    }
  }
  ids(): string[] { return [...this.buffers.keys()]; }
}
