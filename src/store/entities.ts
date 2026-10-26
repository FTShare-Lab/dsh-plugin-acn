// 实体正文原子替换；跨实体业务事务的知识锁由上层持有。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { StoreContext } from './context.js';
import { hasCode, StoreError } from './errors.js';
import { removeFile } from './atomic.js';
import { readYaml, writeYamlAtomic } from './yaml.js';

export class EntityStore<T extends { id: string }> {
  constructor(readonly context: StoreContext, readonly directory: string, readonly schema: z.ZodType<T>, private readonly idSchema: z.ZodType<string>) {}
  path(id: string): string { return join(this.directory, `${this.idSchema.parse(id)}.yaml`); }
  async read(id: string): Promise<T> {
    const value = await readYaml(this.path(id), this.schema);
    if (value.id !== id) throw new StoreError('decode', `Entity ID differs from its filename: ${id}`);
    return value;
  }
  async write(value: unknown): Promise<T> {
    const parsed = this.schema.parse(value);
    await writeYamlAtomic(this.path(parsed.id), parsed, this.schema, this.context.logger);
    return parsed;
  }
  async list(): Promise<T[]> {
    let entries;
    try { entries = await fs.readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    const values: T[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.yaml') || entry.name.includes('.tmp.')) continue;
      const id = entry.name.slice(0, -5);
      if (!this.idSchema.safeParse(id).success) continue;
      try { values.push(await this.read(id)); }
      catch (error) {
        if (error instanceof StoreError && error.kind === 'decode') this.context.logger.warn(`Skipped invalid entity file: ${entry.name}`);
        else throw error;
      }
    }
    return values;
  }
  async create(makeId: () => string, makeValue: (id: string) => T): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.idSchema.parse(makeId());
      const path = this.path(id);
      try { const reservation = await fs.open(path, 'wx', 0o600); await reservation.close(); }
      catch (error) { if (hasCode(error, 'EEXIST')) continue; throw error; }
      try {
        const value = makeValue(id);
        if (value.id !== id) throw new StoreError('conflict', 'Reserved entity ID differs from the value.');
        return await this.write(value);
      } catch (error) { await removeFile(path, this.context.logger); throw error; }
    }
    throw new StoreError('conflict', 'Entity ID collisions exceeded eight attempts.');
  }
}
