// 重复知识的草稿失败必须给出可操作反馈，且修复或保留之前不得产生知识变更。
import { describe, expect, it } from 'vitest';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { waitJob } from '../formation/helpers.js';
import { claims, consolidationDraft, dreamFixture, phaseBackend } from './helpers.js';

describe('Dream consolidation draft recovery', () => {
  it.each(['repair', 'keep'] as const)('recovers from retiring duplicates without a rewritten survivor via %s', async (decision) => {
    const input = claims().map((claim) => ({ ...claim, statement: 'For synthetic v1.2 reads only, expire snapshots after 60 seconds; writes and v1.3 remain unverified.', evidence_summary: 'Only the synthetic v1.2 read specification was checked; runtime behavior remains unverified.' }));
    const [carrier] = input; if (!carrier) throw new Error('Missing carrier.');
    const invalid = consolidationDraft(input);
    invalid.operations = input.map((claim) => ({ id: claim.id, action: claim.id === carrier.id ? 'keep' : 'deprecate', changes: {} }));
    invalid.change_basis = invalid.change_basis.filter((basis) => basis.claim_id !== carrier.id);
    const backend = phaseBackend(input, 'consolidation'); let drafts = 0; let reviewCalls = 0;
    const f = await dreamFixture(async (...args) => {
      const request = JSON.parse(args[2]) as { phase: string; before?: unknown };
      if (request.phase === 'draft') {
        drafts += 1;
        if (drafts === 1) return { text: JSON.stringify({ action: 'stage', group: invalid }) };
        expect(request.before).toEqual(input);
        const feedback = args[1].slice(args[1].lastIndexOf('\n上次响应未通过校验：'));
        expect(feedback).toContain('operations[].changes.statement');
        expect(feedback).toContain('no_consolidation_benefit');
        expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(input);
        expect(await new TraceStore(f.knowledge.context()).list()).toEqual([]);
        if (decision === 'keep') return { text: JSON.stringify({ action: 'keep', reason_kind: 'no_consolidation_benefit', reason: 'The duplicate already contains the complete rule; no useful safe rewrite was identified.' }) };
      }
      if (request.phase === 'review') reviewCalls += 1;
      return backend(...args);
    }, {}, input);
    try {
      await f.start(); const job = await f.dream.request(); await waitJob(f.worker.queue, job.id);
      expect(drafts).toBe(2); expect(reviewCalls).toBe(decision === 'repair' ? 1 : 0);
      const local = await new ClaimStore(f.knowledge.context()).list();
      if (decision === 'keep') { expect(local).toEqual(input); expect(await new TraceStore(f.knowledge.context()).list()).toMatchObject([{ input_claims: [], output_claims: [] }]); }
      else { expect(local.filter((claim) => claim.status === 'deprecated')).toHaveLength(1); expect(local.find((claim) => claim.id === carrier.id)?.statement).toContain(carrier.statement); }
    } finally { await f.close(); }
  });
});
