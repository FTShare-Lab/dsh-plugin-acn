// 形成测试使用真实临时磁盘和有界轮询；不访问外部模型或团队服务。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveConfig } from '../../src/config.js';
import type { ConfigInput } from '../../src/config.js';
import { AcnKnowledge } from '../../src/knowledge/service.js';
import { AcnFormation } from '../../src/formation/service.js';
import type { StructuredBackend } from '../../src/llm/structured.js';
import { loadPromptRenderer } from '../../src/prompt/render.js';
import type { JobQueue } from '../../src/worker/queue.js';
import type { Job } from '../../src/worker/types.js';
import { logger } from '../helpers.js';

export const emptyOutput = () => ({ new_claims: [], updated_claims: [], used_claim_ids: [], new_disputes: [] });
export const newDraft = (index = 0) => ({ id: `$new_claim_${index}$`, name: `bounded_retry_${index}`, statement: 'Only retry idempotent requests within an explicit budget.', scope: 'service / retries', confidence: 'high' as const, evidence_summary: 'Verified the retry boundary against the example service contract.', source_claim_ids: [] as string[] });
export async function formationFixture(backend: StructuredBackend, config: ConfigInput = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-formation-'));
  const warnings: string[] = [];
  const knowledge = new AcnKnowledge(resolveConfig({ ...config, agentId: 'agent-a', home: root, formation: { finalizeIdleMinutes: 0, finalizeOnDispose: false, ...config.formation } }), { ...logger, warn: (message: string) => { warnings.push(message); } });
  await knowledge.initialize();
  const formation = new AcnFormation(knowledge, backend, await loadPromptRenderer(), { pollMs: 10, takeoverMs: 20, retryBaseMs: 1 });
  return { root, knowledge, formation, warnings, close: async () => { await formation.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
export async function waitJob(queue: JobQueue, id: string, wanted: Job['state'] = 'succeeded'): Promise<Job> {
  const deadline = Date.now() + 8000;
  let current;
  while (Date.now() < deadline) {
    current = await queue.read(id);
    if (current?.state === wanted) return current;
    if (current?.state === 'failed' && wanted !== 'failed') throw new Error(`Job failed: ${current.lastError}`);
    await delay(10);
  }
  throw new Error(`Job did not reach ${wanted}: ${JSON.stringify(current)}`);
}
