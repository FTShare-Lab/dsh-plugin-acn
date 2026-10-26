// 引用和占位符为纯批次校验；任何非法来源都不能产生部分 I/O。
import { describe, expect, it } from 'vitest';
import { prepareFormation } from '../../src/formation/prepare.js';
import { RecapOutputSchema } from '../../src/formation/schema.js';
import { AgentIdSchema, ClaimIdSchema, PolicyIdSchema } from '../../src/protocol/ids.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { emptyOutput, newDraft } from './helpers.js';

const agent = AgentIdSchema.parse('agent-a');
const local = sampleClaim();
describe('formation preparation', () => {
  it('resolves multi-digit chains, natural-language references and disputes before persistence', () => {
    const drafts = Array.from({ length: 12 }, (_, index) => ({ ...newDraft(index), source_claim_ids: index === 0 ? [] : [`$new_claim_${index - 1}$`] }));
    const prepared = prepareFormation({ ...emptyOutput(), new_claims: drafts, new_disputes: [{ id: '$new_dispute_0$', name: 'retry_conflict', claims: ['$new_claim_0$', '$new_claim_11$'], summary: 'Compare $new_claim_0$ with $new_claim_11$; see $new_dispute_0$.' }] }, agent, [], []);
    expect(new Set(prepared.claims.map((claim) => claim.id)).size).toBe(12);
    expect(prepared.claims[11]?.source_claim_ids).toEqual([prepared.claims[10]?.id]);
    expect(prepared.claims.every((claim) => claim.status === 'active' && claim.updated_at === undefined)).toBe(true);
    expect(prepared.disputes[0]?.summary).toContain(prepared.disputes[0]?.id);
    expect(JSON.stringify(prepared)).not.toContain('$new_');
  });
  it.each(['$new_claim_1$', '$new_claim_$', 'claim_12345678'])('rejects a new real or nonsequential identifier: %s', (id) => {
    expect(() => prepareFormation({ ...emptyOutput(), new_claims: [{ ...newDraft(), id }] }, agent, [], [])).toThrow('占位符');
  });
  it.each(['$new_claim_19$', '$new_dispute_1$'])('rejects undeclared placeholders in any string: %s', (statement) => {
    expect(() => prepareFormation({ ...emptyOutput(), new_claims: [{ ...newDraft(), statement }] }, agent, [], [])).toThrow('未声明');
  });
  it('drops fabricated used IDs, deduplicates known IDs and emits a safe warning', () => {
    const result = prepareFormation({ ...emptyOutput(), used_claim_ids: [local.id, local.id, 'claim_deadbeef', 'invalid'] }, agent, [local], []);
    expect(result.usedClaimIds).toEqual([local.id]); expect(result.warnings).toEqual(['已丢弃 2 个不在本次可见上下文中的 used_claim_ids。']);
  });
  it('uses explicit policy and historical provenance, replaces the complete update sources and advances time', () => {
    const policy = PolicyIdSchema.parse('policy_11111111'); const historical = ClaimIdSchema.parse('claim_22222222');
    const before = { ...local, source_claim_ids: [policy, historical], updated_at: '2099-01-01T00:00:00Z' };
    const update = { ...newDraft(), id: before.id, status: 'stale', source_claim_ids: [policy, historical, historical] };
    const result = prepareFormation({ ...emptyOutput(), updated_claims: [update] }, agent, [before], []);
    expect(result.claims[0]).toMatchObject({ id: before.id, holder: before.holder, created_at: before.created_at, status: 'stale', updated_at: '2099-01-01T00:00:01Z', source_claim_ids: [policy, historical] });
    expect(result.usedClaimIds).toEqual([local.id]);
    expect(prepareFormation({ ...emptyOutput(), updated_claims: [{ ...update, source_claim_ids: [] }] }, agent, [before], []).claims[0]?.source_claim_ids).toEqual([]);
  });
  it.each(['claim_deadbeef', 'policy_deadbeef', '$new_claim_0$'])('rejects invisible or self sources: %s', (source) => {
    expect(() => prepareFormation({ ...emptyOutput(), new_claims: [{ ...newDraft(), source_claim_ids: [source] }] }, agent, [local], [])).toThrow();
  });
  it('accepts bodies explicitly seen in this session and rejects foreign or duplicate updates', () => {
    const source = 'claim_11223344';
    expect(prepareFormation({ ...emptyOutput(), new_claims: [{ ...newDraft(), source_claim_ids: [source, source] }] }, agent, [], [source]).claims[0]?.source_claim_ids).toEqual([source]);
    const update = { ...newDraft(), id: local.id, status: 'active' };
    expect(() => prepareFormation({ ...emptyOutput(), updated_claims: [update] }, agent, [{ ...local, holder: AgentIdSchema.parse('agent-b') }], [])).toThrow('持有');
    expect(() => prepareFormation({ ...emptyOutput(), updated_claims: [update, update] }, agent, [local], [])).toThrow('重复');
    expect(() => prepareFormation({ ...emptyOutput(), updated_claims: [{ ...update, source_claim_ids: [local.id] }] }, agent, [local], [])).toThrow('自身');
  });
  it.each([[local.id, local.id], [local.id, 'claim_deadbeef']])('rejects duplicate or nonexistent dispute references: %j', (...claims) => {
    expect(() => prepareFormation({ ...emptyOutput(), new_disputes: [{ id: '$new_dispute_0$', name: 'conflict', summary: 'Contradictory constraints.', claims }] }, agent, [local], [])).toThrow();
  });
  it('historical provenance alone does not allow dispute or usage attribution', () => {
    const historical = ClaimIdSchema.parse('claim_22222222'); const before = { ...local, source_claim_ids: [historical] };
    expect(prepareFormation({ ...emptyOutput(), used_claim_ids: [historical] }, agent, [before], []).usedClaimIds).toEqual([]);
    expect(() => prepareFormation({ ...emptyOutput(), new_disputes: [{ id: '$new_dispute_0$', name: 'conflict', summary: 'Example conflict.', claims: [local.id, historical] }] }, agent, [before], [])).toThrow('不可见');
    expect(() => prepareFormation({ ...emptyOutput(), new_claims: [{ ...newDraft(), source_claim_ids: [historical] }] }, agent, [{ ...before, status: 'deprecated' }], [])).toThrow('不可见');
  });
  it('enforces strict required fields and new-claim status absence', () => {
    for (const raw of [{ ...emptyOutput(), extra: true }, { new_claims: [] }, { ...emptyOutput(), new_claims: [{ ...newDraft(), status: 'active' }] }, { ...emptyOutput(), new_disputes: [{ id: '$new_dispute_0$', name: 'conflict', summary: 'Example.', claims: [local.id] }] }]) expect(RecapOutputSchema.safeParse(raw).success).toBe(false);
  });
});
