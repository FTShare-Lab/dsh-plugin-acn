// 重放真实复核失败类别，确认结构反馈可定位，领域约束不放宽且失败可恢复。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ValidationSchema } from '../../src/dream/schema.js';
import { validateSelfReview } from '../../src/dream/review.js';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { waitJob } from '../formation/helpers.js';
import { claims, dreamFixture, phaseBackend, reviews, prepared } from './helpers.js';

it('identifies the exact quote field when punctuation was rewritten without accepting the altered quote', () => {
  const input = claims(); const value = prepared(input, 'consolidation');
  const item = value.self_review.preservation.find((item) => item.before.field === 'statement');
  if (item === undefined) throw new Error('Missing review quote.');
  item.before.quote = item.before.quote.replace(/\.$/, '。');
  expect(() => validateSelfReview(value.validation, value.self_review)).toThrow(`before.${item.before.claim_id}.statement 必须是对应字段的逐字非空子串`);
});

it.each([false, true])('rejects malformed, extra-key and retired-carrier reviews without writes; durable retry=%s', async (exhaust) => {
  const input = claims(); const source = input[1]; if (source === undefined) throw new Error('Missing source.');
  source.statement = 'Only virtual v1.2 idempotent reads may retry. Writes and v1.3 remain unverified.';
  source.evidence_summary = 'Only the v1.2 specification was read; no runtime or v1.3 evidence was checked.';
  const ordinary = phaseBackend(input, 'consolidation'); let attempts = 0;
  const f = await dreamFixture(async (...args) => {
    const request = JSON.parse(args[2]) as { phase: string; validation: unknown };
    if (request.phase !== 'review') return ordinary(...args);
    attempts += 1;
    expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(input);
    expect(await new TraceStore(f.knowledge.context()).list()).toEqual([]);
    const validation = ValidationSchema.parse(request.validation);
    const result = { decision: 'apply', reason: 'Conditions and evidence limitations are carried.', reason_kind: 'useful_knowledge', ...reviews(validation) };
    if (attempts === 1) return { text: '{"decision":"apply","semantic":{"claims":[{"claim_00000002","final_name":"example"}]}}' };
    if (attempts === 2) {
      expect(args[1]).toContain('JSON 解析失败');
      return { text: JSON.stringify({ ...result, support: [], self_review: { ...result.self_review, support: result.self_review.support.map((item) => ({ ...item, reason_placeholder: 'PRIVATE_RESPONSE_MARKER' })) } }) };
    }
    if (attempts === 3) {
      expect(args[1]).toContain('$: unrecognized_keys；删除多余字段 ["support"]');
      expect(args[1]).toContain('reason_placeholder');
      const item = result.self_review.preservation.find((item) => item.before.claim_id === source.id);
      if (item === undefined) throw new Error('Missing review item.');
      item.after = [{ claim_id: source.id, field: 'name', quote: source.name }];
    }
    if (attempts === 4 && !exhaust) {
      expect(args[1]).toContain(`after 引用 ${source.id}.name 指向 deprecated Claim`);
      expect(args[1]).toContain('coverage.output_ids');
    }
    return { text: JSON.stringify(result) };
  }, { llm: { structuredRetries: exhaust ? 3 : 4 } }, input);
  try {
    await f.start(); const job = await f.dream.request();
    if (exhaust) {
      const failed = await waitJob(f.worker.queue, job.id, 'failed');
      expect(failed.lastError).toContain('review 阶段'); expect(failed.lastError).toContain('引用或领域约束');
      expect((await f.knowledge.dreamStore().progress(job.id))?.entries[0]?.review).toBeNull();
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(input);
      await f.worker.retry(job.id);
    }
    await waitJob(f.worker.queue, job.id); expect(attempts).toBe(4);
    const context = f.knowledge.context(); const files = await fs.readdir(context.paths.llmCalls);
    const metadata = (await Promise.all(files.filter((file) => file.endsWith('.jsonl')).map((file) => fs.readFile(join(context.paths.llmCalls, file), 'utf8')))).join('\n');
    expect(metadata).toContain('"phase":"review"');
    for (const kind of ['json_syntax', 'schema', 'reference']) expect(metadata).toContain(`"kind":"${kind}"`);
    expect(metadata).toContain('unrecognized_keys');
    for (const privateValue of ['PRIVATE_RESPONSE_MARKER', 'reason_placeholder', source.statement, source.evidence_summary]) expect(metadata).not.toContain(privateValue);
    const stored = await new ClaimStore(context).list();
    expect(stored.find((claim) => claim.status !== 'deprecated')?.evidence_summary).toContain(source.evidence_summary);
    expect(stored.find((claim) => claim.status !== 'deprecated')?.statement).toContain('v1.3 remain unverified');
    expect(await new TraceStore(context).list()).toHaveLength(2);
  } finally { await f.close(); }
});
