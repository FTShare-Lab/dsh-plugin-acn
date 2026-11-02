// 展示回执只保存任务版本；后台成功与用户已看到结果是两个独立事实。
import { join } from 'node:path';
import { z } from 'zod';
import type { StoreContext } from './context.js';
import { readYamlOr, writeYamlAtomic } from './yaml.js';
import { withFileLock } from './lock.js';
const Schema = z.object({ schemaVersion: z.literal(1), baselineAt: z.number(), seen: z.record(z.string(), z.number()) });
export class PresentationStore {
  private readonly path: string;
  constructor(private readonly context: StoreContext) { this.path = join(context.paths.root, 'presentation.yaml'); }
  read() { return readYamlOr(this.path, Schema, () => null); }
  async initialize(): Promise<void> {
    await withFileLock(`${this.path}.lock`, async () => { if (await this.read() === null) await writeYamlAtomic(this.path, { schemaVersion: 1, baselineAt: Date.now(), seen: {} }, Schema, this.context.logger); });
  }
  async acknowledge(id: string, version: number): Promise<void> {
    await withFileLock(`${this.path}.lock`, async () => {
      const current = await this.read() ?? { schemaVersion: 1 as const, baselineAt: Date.now(), seen: {} };
      await writeYamlAtomic(this.path, { ...current, seen: { ...current.seen, [id]: Math.max(version, current.seen[id] ?? 0) } }, Schema, this.context.logger);
    });
  }
}
