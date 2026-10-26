// 会话创建时冻结私有双文件；resume/compact/fork 沿用快照，clear 和新会话才读取最新内容。
import { z } from 'zod';
import type { AcnMemory } from './service.js';
import { MemorySnapshotSchema, renderMemoryBlock } from './operations.js';
import { SessionStateStore } from '../store/session-state.js';

export const MemorySessionSchema = z.strictObject({ snapshot: MemorySnapshotSchema, text: z.string() });
export class MemorySessions {
  private readonly states: SessionStateStore;
  private readonly snapshots = new Map<string, z.infer<typeof MemorySessionSchema>>();
  constructor(readonly memory: AcnMemory, private readonly render: (name: string, context: object) => string) { this.states = new SessionStateStore(memory.knowledge.context()); }
  async freeze(id: string, source: 'startup' | 'resume' | 'compact' | 'clear', parentId?: string): Promise<void> {
    const current = await this.states.read(id); let frozen = current?.['memory'] === undefined ? undefined : MemorySessionSchema.parse(current['memory']);
    if (frozen === undefined && parentId !== undefined && source !== 'clear') { const parent = await this.states.read(parentId); if (parent?.['memory'] !== undefined) frozen = MemorySessionSchema.parse(parent['memory']); }
    if (frozen === undefined || source === 'clear' || source === 'startup' && parentId === undefined) {
      const snapshot = await this.memory.snapshot(); const config = this.memory.knowledge.config.memory;
      frozen = { snapshot, text: this.render('memory.j2', { memory_md: renderMemoryBlock('memory', snapshot.memory_entries, config.memoryCharLimit), user_md: renderMemoryBlock('user', snapshot.user_entries, config.userCharLimit) }) };
    }
    const accepted = frozen;
    const saved = await this.states.update(id, (latest) => {
      // 两个宿主同时恢复同一 session 时，后到者接受已保存的冻结版本。
      const existing = latest?.['memory'];
      return { ...latest, schemaVersion: 1, memory: source === 'clear' || source === 'startup' && parentId === undefined || existing === undefined ? accepted : MemorySessionSchema.parse(existing) };
    });
    this.snapshots.set(id, MemorySessionSchema.parse(saved['memory']));
  }
  text(id: string): string { return this.snapshots.get(id)?.text ?? ''; }
  forget(id: string): void { this.snapshots.delete(id); }
}
