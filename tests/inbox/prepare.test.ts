// 内化沿用形成占位符并单独验证仲裁、来源归因、持有权和新冲突的语义边界。
import { describe, expect, it } from 'vitest';
import { prepareInbox, inboxContext, validateArbitration } from '../../src/inbox/prepare.js';
import { deprecatePolicyClaims } from '../../src/inbox/cascade.js';
import { InboxMessageSchema } from '../../src/protocol/inbox.js';
import { ClaimIdSchema, PolicyIdSchema, AgentIdSchema } from '../../src/protocol/ids.js';
import { newDraft } from '../formation/helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { arbitrationMessage, inboxMessage, emptyInternalize } from '../team/helpers.js';

const agent = AgentIdSchema.parse('agent-a');
const update = (id = sampleClaim().id, sources: string[] = []) => ({ ...newDraft(), id, source_claim_ids: sources, status: 'active' });
const conflict = (ids: string[]) => ({ id: '$new_dispute_0$', name: 'scope_conflict', summary: 'Conflicting scope evidence.', claims: ids });
describe('Inbox preparation', () => {
  it('only edits own visible Claims, restores direct deprecated Claims and keeps other-holder snapshots read-only', () => {
    const local = sampleClaim({ status: 'deprecated' }); const message = arbitrationMessage(local);
    expect(inboxContext(agent, [message], [local]).editable).toEqual([local]);
    expect(prepareInbox({ ...emptyInternalize(), updated_claims: [update(local.id)] }, agent, [message], [local]).claims[0]).toMatchObject({ id: local.id, holder: agent, status: 'active', source_claim_ids: [message.policy.id] });
    expect(() => prepareInbox({ ...emptyInternalize(), updated_claims: [update(ClaimIdSchema.parse('claim_00000002'))] }, agent, [message], [local])).toThrow(/updated_claims/);
    const foreign = sampleClaim({ holder: AgentIdSchema.parse('agent-b') }); expect(() => inboxContext(agent, [message], [foreign])).toThrow(/持有权/);
  });
  it('allows non-direct active/stale edits but excludes non-direct deprecated Claims', () => {
    const direct = sampleClaim(); const extra = sampleClaim({ id: ClaimIdSchema.parse('claim_11111111'), status: 'stale' }); const message = arbitrationMessage(direct);
    expect(prepareInbox({ ...emptyInternalize(), updated_claims: [update(extra.id)] }, agent, [message], [direct, extra]).claims[0]?.id).toBe(extra.id);
    expect(() => prepareInbox({ ...emptyInternalize(), updated_claims: [update(extra.id)] }, agent, [message], [direct, { ...extra, status: 'deprecated' }])).toThrow(/updated_claims/);
  });
  it('accepts visible historical provenance without promoting history-only Claims to Dispute inputs', () => {
    const history = ClaimIdSchema.parse('claim_11111111'); const historicalPolicy = PolicyIdSchema.parse('policy_11111111');
    const local = sampleClaim({ source_claim_ids: [history, historicalPolicy] }); const message = inboxMessage();
    expect(prepareInbox({ ...emptyInternalize(), new_claims: [{ ...newDraft(), source_claim_ids: [history, historicalPolicy] }] }, agent, [message], [local]).claims[0]?.source_claim_ids).toEqual([history, historicalPolicy]);
    expect(() => prepareInbox({ ...emptyInternalize(), new_disputes: [conflict([local.id, history])] }, agent, [message], [local])).toThrow(/不可见/);
  });
  it.each(['claim_ffffffff', 'policy_ffffffff', 'memory_note'])('rejects invisible or invented provenance: %s', (source) => {
    expect(() => prepareInbox({ ...emptyInternalize(), new_claims: [{ ...newDraft(), source_claim_ids: [source] }] }, agent, [inboxMessage()], [sampleClaim()])).toThrow();
  });
  it('requires relevant Policy attribution in multi-CAU batches while keeping single-Policy compatibility', () => {
    const a = arbitrationMessage(); const b = InboxMessageSchema.parse({ ...a, id: 'inbox_00000002', policy: { ...a.policy, id: 'policy_00000002' } });
    expect(prepareInbox({ ...emptyInternalize(), new_claims: [newDraft()] }, agent, [a], [sampleClaim()]).claims[0]?.source_claim_ids).toEqual([a.policy.id]);
    expect(() => prepareInbox({ ...emptyInternalize(), new_claims: [newDraft()] }, agent, [a, b], [sampleClaim()])).toThrow(/Policy/);
    expect(prepareInbox({ ...emptyInternalize(), new_claims: [{ ...newDraft(), source_claim_ids: [b.policy.id] }] }, agent, [a, b], [sampleClaim()]).claims[0]?.source_claim_ids).toEqual([b.policy.id]);
  });
  it('fully replaces old sources, supports new placeholders, and rejects a Dispute against same-batch deprecation', () => {
    const local = sampleClaim({ source_claim_ids: [PolicyIdSchema.parse('policy_11111111')] }); const message = inboxMessage();
    const prepared = prepareInbox({ ...emptyInternalize(), new_claims: [newDraft()], updated_claims: [update(local.id)], new_disputes: [conflict([local.id, '$new_claim_0$'])] }, agent, [message], [local]);
    expect(prepared.claims[1]?.source_claim_ids).toEqual([]); expect(prepared.disputes[0]?.claims[1]).toBe(prepared.claims[0]?.id);
    expect(() => prepareInbox({ ...emptyInternalize(), new_claims: [newDraft()], updated_claims: [{ ...update(local.id), status: 'deprecated' }], new_disputes: [conflict([local.id, '$new_claim_0$'])] }, agent, [message], [local])).toThrow(/deprecated/);
  });
  it('suppresses unchanged resolved inputs including timestamp-only changes but accepts changed semantics', () => {
    const local = sampleClaim(); const message = arbitrationMessage(local); const output = { ...emptyInternalize(), new_disputes: [conflict([local.id, 'claim_00000002'])] };
    expect(prepareInbox(output, agent, [message], [local]).disputes).toEqual([]);
    expect(prepareInbox(output, agent, [message], [{ ...local, updated_at: '2026-01-02T00:00:00Z' }]).disputes).toEqual([]);
    expect(prepareInbox(output, agent, [message], [{ ...local, statement: 'New direct evidence changes the semantic input.' }]).disputes).toHaveLength(1);
  });
  it('validates complete arbitration coverage and accepts human resolutions without a type', () => {
    const message = arbitrationMessage(); if (message.message_type !== 'claim_attribute_update' || message.arbitration_resolution === undefined) throw new Error('Missing arbitration.');
    const context = message.arbitration_resolution;
    expect(() => validateArbitration(InboxMessageSchema.parse({ ...message, arbitration_resolution: { ...context, resolution_type: undefined } }))).not.toThrow();
    for (const patch of [{ dispute_id: 'dispute_ffffffff' }, { resolution_type: 'unresolved' }, { resolution_basis: 'insufficient_evidence' }, { direct_claim_snapshots: [context.direct_claim_snapshots[0], context.direct_claim_snapshots[0]] }, { claim_assessments: [{ claim_id: 'claim_00000001', recommended_status: 'active', assessment: 'Retain.', reason: 'Checked.' }] }]) {
      expect(() => validateArbitration(InboxMessageSchema.parse({ ...message, arbitration_resolution: { ...context, ...patch } }))).toThrow();
    }
  });
  it('withdrawal changes direct dependents only and preserves monotonically increasing timestamps', () => {
    const policy = PolicyIdSchema.parse('policy_00000001'); const direct = sampleClaim({ source_claim_ids: [policy], updated_at: '2027-01-01T00:00:00Z' }); const already = sampleClaim({ id: ClaimIdSchema.parse('claim_00000002'), status: 'deprecated', source_claim_ids: [policy] }); const indirect = sampleClaim({ id: ClaimIdSchema.parse('claim_00000003'), source_claim_ids: [direct.id] });
    const retired = deprecatePolicyClaims(policy, [direct, already, indirect], '2026-01-01T00:00:00Z');
    expect(retired).toHaveLength(1); expect(retired[0]).toMatchObject({ id: direct.id, status: 'deprecated', updated_at: '2027-01-01T00:00:01Z' });
  });
});
