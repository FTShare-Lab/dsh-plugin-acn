// 插件私有文档带 schemaVersion；领域字段由所属里程碑的 schema 再校验。
import { z } from 'zod';
import type { StoreContext } from './context.js';
import { withFileLock } from './lock.js';
import { readYamlOr, writeYamlAtomic } from './yaml.js';

export const VersionedDocumentSchema = z.object({ schemaVersion: z.literal(1) }).catchall(z.json());
export type VersionedDocument = z.infer<typeof VersionedDocumentSchema>;
export class VersionedFileStore {
  constructor(readonly context: StoreContext, private readonly resolvePath: (id: string) => string) {}
  read(id: string): Promise<VersionedDocument | null> { return readYamlOr(this.resolvePath(id), VersionedDocumentSchema, () => null); }
  write(id: string, value: unknown): Promise<void> {
    const path = this.resolvePath(id);
    return withFileLock(`${path}.lock`, () => writeYamlAtomic(path, value, VersionedDocumentSchema, this.context.logger), { timeoutMs: this.context.lockTimeoutMs });
  }
}
export class SessionStateStore extends VersionedFileStore {
  constructor(context: StoreContext) { super(context, (id) => context.paths.sessionState(id)); }
  async update(id: string, change: (current: VersionedDocument | null) => VersionedDocument | Promise<VersionedDocument>): Promise<VersionedDocument> {
    const path = this.context.paths.sessionState(id);
    return withFileLock(`${path}.lock`, async () => {
      const next = VersionedDocumentSchema.parse(await change(await this.read(id)));
      await writeYamlAtomic(path, next, VersionedDocumentSchema, this.context.logger);
      return next;
    }, { timeoutMs: this.context.lockTimeoutMs });
  }
}
