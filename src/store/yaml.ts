// YAML 只承载经过 schema 校验的规范值；解码错误不泄露文件正文。
import fs from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import type { z } from 'zod';
import type { StoreLogger } from './context.js';
import { writeTextAtomic } from './atomic.js';
import { hasCode, StoreError } from './errors.js';

export function encodeJson<T>(schema: z.ZodType<T>, value: unknown): string { return JSON.stringify(schema.parse(value)); }
export function encodeYaml<T>(schema: z.ZodType<T>, value: unknown): string {
  try {
    const wire: unknown = JSON.parse(encodeJson(schema, value));
    return stringify(wire, { indent: 2, indentSeq: false, lineWidth: 0 });
  } catch { throw new StoreError('encode', 'Cannot encode YAML value.'); }
}
export function decodeYaml<T>(schema: z.ZodType<T>, text: string): T {
  try { const value: unknown = parse(text, { maxAliasCount: 100 }); return schema.parse(value); }
  catch { throw new StoreError('decode', 'Invalid YAML document.'); }
}
export async function readYaml<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let text: string;
  try { text = await fs.readFile(path, 'utf8'); }
  catch (error) { throw new StoreError('io', `Cannot read file: ${path}`, { cause: error }); }
  try { return decodeYaml(schema, text); }
  catch { throw new StoreError('decode', `Invalid YAML document: ${path}`); }
}
export async function readYamlOr<T, F>(path: string, schema: z.ZodType<T>, fallback: () => F): Promise<T | F> {
  try { return await readYaml(path, schema); }
  catch (error) { if (error instanceof StoreError && hasCode(error.cause, 'ENOENT')) return fallback(); throw error; }
}
export async function writeYamlAtomic<T>(path: string, value: unknown, schema: z.ZodType<T>, logger: StoreLogger): Promise<void> {
  await writeTextAtomic(path, encodeYaml(schema, value), logger);
}
