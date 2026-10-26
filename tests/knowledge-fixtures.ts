// 主链路使用不含私有正文的中性样例。
import { ClaimSchema } from '../src/protocol/claim.js';
import type { Claim } from '../src/protocol/claim.js';
export function sampleClaim(overrides: Partial<Claim> = {}): Claim {
  return ClaimSchema.parse({ id: 'claim_00000001', name: 'example_rule', statement: 'A stable example statement.', scope: 'example/scope', holder: 'agent-a', confidence: 'medium', status: 'active', created_at: '2026-01-01T00:00:00Z', evidence_summary: 'A checked example.', ...overrides });
}
