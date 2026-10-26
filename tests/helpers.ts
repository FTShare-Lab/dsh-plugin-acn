// 测试共用的基准读取与中性存储上下文。
import { readFile } from 'node:fs/promises';
import type { z } from 'zod';
import { AgentIdSchema } from '../src/protocol/ids.js';
import { AgentPaths, type StoreContext } from '../src/store/index.js';

export const logger = { warn: (): void => {}, debug: (): void => {} };
export function context(root: string, mode: 'solo' | 'team' = 'solo'): StoreContext { return { paths: new AgentPaths(root), agentId: AgentIdSchema.parse('agent-a'), mode, logger }; }
export async function fixture<T>(name: string, schema: z.ZodType<T>): Promise<T> {
  const input: unknown = JSON.parse(await readFile(new URL(`./fixtures/protocol/${name}.json`, import.meta.url), 'utf8'));
  return schema.parse(input);
}
