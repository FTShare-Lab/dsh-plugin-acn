// 私有记忆测试使用真实临时磁盘，后台模型只由本地脚本代替。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, type ConfigInput } from '../../src/config.js';
import { AcnKnowledge } from '../../src/knowledge/service.js';
import { AcnMemory } from '../../src/memory/service.js';
import { MemoryReview } from '../../src/memory/review.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import type { StructuredBackend } from '../../src/llm/structured.js';
import { logger } from '../helpers.js';

export async function memoryFixture(config: ConfigInput = {}, backend: StructuredBackend = () => Promise.resolve({ text: '{"ops":[]}' })) {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-memory-')); const warnings: string[] = [];
  const knowledge = new AcnKnowledge(resolveConfig({ ...config, agentId: 'agent-a', home: root, llm: { provider: 'mock', model: 'mock', structuredRetries: 2, ...config.llm } }), { ...logger, warn: (message: string) => { warnings.push(message); } });
  await knowledge.initialize(); const memory = new AcnMemory(knowledge); const review = new MemoryReview(memory, backend, await loadPromptRenderer()); const worker = knowledge.jobs; if (!worker) throw new Error('Missing worker.');
  return { root, knowledge, memory, review, worker, warnings, close: async () => { await review.close(); await worker.close(); await knowledge.team?.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
export async function reviewTurn(review: MemoryReview, turn = 1, session = 'session-a', text = 'The user prefers short explanations.') {
  const seq = turn * 10;
  review.capture(session, { seq, user: true, projection: { entry: { seq, type: 'user', text } } });
  review.capture(session, { seq: seq + 1, projection: { entry: { seq: seq + 1, type: 'assistant', text: 'The stable preference is understood.' } } });
  review.capture(session, { seq: seq + 2, ended: true, completed: true }); await review.flush(session);
}
