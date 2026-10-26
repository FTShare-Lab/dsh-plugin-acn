// 移植 ID、时间、实体缺省值和旧字段兼容用例。
import { describe, expect, it } from 'vitest';
import { AgentIdSchema, AgentQuerySchema, ArbitrationResolutionContextSchema, authRequestSchema, AuthEnvelopeSchema, ClaimIdSchema, ClaimSchema, claimRevision, canonicalJson, deriveClaimId, deriveDisputeId, deriveTraceId, DisputeSchema, HealthRequestSchema, HealthResponseSchema, InboxMessageSchema, normalizeTimestamp, PolicySchema, ResolutionIdSchema, ScopesOverviewSnapshotSchema, SourceIdSchema, TimestampSchema, TraceSchema, validateAgentReport } from '../../src/protocol/index.js';
import { fixture } from '../helpers.js';

describe('typed identifiers', () => {
  it.each(['claim_bad', 'trace_00000001', 'claim_ABCDEF12', 'claim_000000001', '../claim_00000001'])('rejects invalid Claim ID %s', (value) => { expect(ClaimIdSchema.safeParse(value).success).toBe(false); });
  it.each(['', 'Agent-A', 'agent/a', '../user', 'user.name'])('rejects invalid agent ID %s', (value) => { expect(AgentIdSchema.safeParse(value).success).toBe(false); });
  it('accepts Claim and Policy sources and rejects other prefixes', () => {
    expect(SourceIdSchema.parse('claim_00000001')).toBe('claim_00000001');
    expect(SourceIdSchema.parse('policy_00000001')).toBe('policy_00000001');
    expect(SourceIdSchema.safeParse('trace_00000001').success).toBe(false);
    expect(ResolutionIdSchema.parse('arbitration_00000001')).toBe('arbitration_00000001');
  });
  it('derives stable short IDs with explicit salt and distinguishes semantic fields', () => {
    const at = '2026-10-21T00:00:00.123456789Z';
    const id = deriveClaimId(at, 'example', 'scope', '1234');
    expect(id).toMatch(/^claim_[a-f0-9]{8}$/);
    expect(deriveClaimId(at, 'example', 'scope', '1234')).toBe(id);
    expect(deriveClaimId(at.replace('789', '788'), 'example', 'scope', '1234')).not.toBe(id);
    expect(deriveClaimId(at, 'example', 'different', '1234')).not.toBe(id);
    expect(deriveClaimId(at, 'ab', 'c', '1234')).not.toBe(deriveClaimId(at, 'a', 'bc', '1234'));
    expect(deriveTraceId(at, 'trace', ['claim_00000001'], ['claim_00000002'], '1234')).not.toBe(deriveTraceId(at, 'trace', ['claim_00000001', 'claim_00000002'], [], '1234'));
    expect(deriveDisputeId(at, 'example', ['claim_00000001'], 'first', '1234')).not.toBe(deriveDisputeId(at, 'example', ['claim_00000001'], 'second', '1234'));
    expect(() => deriveClaimId(at, 'example', 'scope', 'INVALID')).toThrow();
  });
});

describe('UTC serialization', () => {
  it.each([
    ['2026-10-21T08:00:00+08:00', '2026-10-21T00:00:00Z'],
    ['2026-10-21T00:00:00.1Z', '2026-10-21T00:00:00.100Z'],
    ['2026-10-21T00:00:00.1234Z', '2026-10-21T00:00:00.123400Z'],
    ['2026-10-21T00:00:00.123456789Z', '2026-10-21T00:00:00.123456789Z'],
    ['2026-10-21T00:00:00.123456789123Z', '2026-10-21T00:00:00.123456789Z'],
    ['2026-10-21T00:00:00.000000000Z', '2026-10-21T00:00:00Z'],
    ['2016-12-31T23:59:60.123Z', '2016-12-31T23:59:60.123Z'],
    ['0000-02-29T00:00:00Z', '0000-02-29T00:00:00Z'],
  ])('normalizes %s without losing precision', (input, expected) => { expect(normalizeTimestamp(input)).toBe(expected); });
  it.each(['2026-02-29T00:00:00Z', '2026-10-21T24:00:00Z', '2026-10-21T00:60:00Z', '2026-10-21T00:00:61Z', '2026-10-21T00:00:00+24:00', '2026-10-21'])('rejects invalid time %s', (input) => { expect(TimestampSchema.safeParse(input).success).toBe(false); });
  it.each(['9999-12-31T23:00:00-02:00', '0000-01-01T00:00:00+01:00'])('rejects %s when UTC normalization would be unreadable by the reference implementation', (input) => { expect(TimestampSchema.safeParse(input).success).toBe(false); });
});

describe('entity compatibility and boundaries', () => {
  it('defaults legacy fields and retains empty arrays while omitting optional nulls', async () => {
    const claim = await fixture('claim-seconds', ClaimSchema);
    const legacy: Record<string, unknown> = { ...claim }; delete legacy.source_claim_ids;
    expect(ClaimSchema.parse({ ...legacy, updated_at: null }).source_claim_ids).toEqual([]);
    expect(canonicalJson({ ...legacy, updated_at: null })).not.toContain('updated_at');
    const policy = await fixture('policy-broadcast', PolicySchema);
    const legacyPolicy: Record<string, unknown> = { ...policy }; delete legacyPolicy.message_type;
    expect(PolicySchema.parse(legacyPolicy).message_type).toBe('policy_update');
    expect(TraceSchema.parse({ ...(await fixture('trace', TraceSchema)), input_claims: undefined, output_claims: undefined }).output_claims).toEqual([]);
  });
  it('hashes normalized field order and keeps nanosecond changes observable', async () => {
    const claim = await fixture('claim-nanos', ClaimSchema);
    expect(claimRevision(Object.fromEntries(Object.entries(claim).reverse()))).toBe(claimRevision(claim));
    expect(claimRevision({ ...claim, created_at: claim.created_at.replace('789', '788') })).not.toBe(claimRevision(claim));
    expect(ClaimSchema.safeParse({ ...claim, statement: String.fromCharCode(0xd800) }).success).toBe(false);
  });
  it('keeps historical Dispute widths separate from report lifecycle checks', async () => {
    const dispute = await fixture('dispute-open', DisputeSchema);
    expect(validateAgentReport({ ...dispute, claims: [dispute.claims[0]] }).status).toBe('open');
    expect(() => validateAgentReport({ ...dispute, status: 'resolved' })).toThrow();
    expect(() => validateAgentReport({ ...dispute, resolved_at: dispute.created_at })).toThrow();
    expect(DisputeSchema.parse({ ...dispute, reporter_agent_id: undefined }).reporter_agent_id).toBe('legacy-agent');
  });
  it('normalizes old arbitration field names, preserves extensions, and rejects duplicate aliases', async () => {
    const resolution = await fixture('arbitration', ArbitrationResolutionContextSchema);
    const { resolution_id, ...rest } = resolution;
    expect(ArbitrationResolutionContextSchema.parse({ ...rest, decision_id: resolution_id, future_field: { enabled: true } }).future_field).toEqual({ enabled: true });
    expect(ArbitrationResolutionContextSchema.safeParse({ ...resolution, decision_id: resolution_id }).success).toBe(false);
    const message = await fixture('inbox-attribute', InboxMessageSchema);
    expect(InboxMessageSchema.parse({ ...message, arbitration_decision: resolution }).message_type).toBe('claim_attribute_update');
  });
  it('enforces strict auth and overview envelopes and reads health probes', () => {
    const auth = { agent_id: 'agent-a', acn_key: '' };
    expect(AuthEnvelopeSchema.safeParse({ ...auth, extra: true }).success).toBe(false);
    expect(authRequestSchema(AgentQuerySchema).safeParse({ auth, data: { scope: 'example' }, extra: true }).success).toBe(false);
    expect(AgentQuerySchema.parse({ scope: 'example' }).semantic_query).toBeNull();
    expect(ScopesOverviewSnapshotSchema.safeParse({ scopes: [], extra: true }).success).toBe(false);
    expect(HealthRequestSchema.parse({}).data).toEqual({});
    expect(HealthResponseSchema.parse({ status: 'ok', team_auth_enabled: false })).toEqual({ status: 'ok', team_auth_enabled: false });
  });
});
