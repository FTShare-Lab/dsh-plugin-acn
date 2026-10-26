// 私有 Memory 的唯一领域入口；普通工具按最新磁盘操作，后台复核另做快照 CAS。
import { createHash } from 'node:crypto';
import type { AcnKnowledge } from '../knowledge/service.js';
import { MemoryFileStore } from '../store/memory.js';
import type { MemoryTransaction } from '../store/memory.js';
import { MemoryArgsSchema, MemoryError, MemoryReportSchema, applyMemoryOps, snapshotTexts } from './operations.js';

export const memoryRevision = (texts: { memory: string; user: string }): string => createHash('sha256').update(JSON.stringify(texts)).digest('hex');
export class AcnMemory {
  readonly files: MemoryFileStore;
  constructor(readonly knowledge: AcnKnowledge) { this.files = new MemoryFileStore(knowledge.context()); }
  private enabled(): void { if (!this.knowledge.config.memory.enabled) throw new MemoryError('validation', 'Private Memory is disabled.'); }
  async snapshot(signal?: AbortSignal) { this.enabled(); return snapshotTexts(await this.files.read(signal), this.knowledge.config.memory); }
  async apply(input: unknown, options: MemoryTransaction & { expectedRevision?: string } = {}) {
    this.enabled(); const { ops } = MemoryArgsSchema.parse(input);
    const receipt = await this.files.transact((texts) => {
      if (options.expectedRevision !== undefined && memoryRevision(texts) !== options.expectedRevision) throw new MemoryError('conflict', 'Memory changed during review; the newer private version is preserved.');
      return applyMemoryOps(texts, this.knowledge.config.memory, ops);
    }, { ...options, fingerprint: createHash('sha256').update(JSON.stringify({ ops, expected: options.expectedRevision ?? null })).digest('hex') });
    if (receipt.conflict) throw new MemoryError('conflict', 'Memory changed during a partial commit; applied and external versions are preserved.');
    return MemoryReportSchema.parse(receipt.result);
  }
}
