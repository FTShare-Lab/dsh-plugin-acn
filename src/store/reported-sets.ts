// 排序去重后的 Claim 集合作为台账键，首条上报记录保持不变。
import { z } from 'zod';
import { ClaimIdSchema, DisputeIdSchema } from '../protocol/ids.js';
import { TimestampSchema } from '../protocol/time.js';
import type { StoreContext } from './context.js';
import { withFileLock } from './lock.js';
import { readYamlOr, writeYamlAtomic } from './yaml.js';

export const ReportedSetsSchema = z.object({ reported_claim_sets: z.record(z.string(), z.object({ first_dispute_id: DisputeIdSchema, reported_at: TimestampSchema })).default({}).transform((records) => Object.fromEntries(Object.entries(records).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) });
export function reportedClaimSetKey(claims: readonly string[]): string { return [...new Set(claims.map((id) => ClaimIdSchema.parse(id)))].sort().join(' | '); }
export class ReportedSetStore {
  constructor(readonly context: StoreContext) {}
  read(): Promise<z.infer<typeof ReportedSetsSchema>> { return readYamlOr(this.context.paths.reportedSets, ReportedSetsSchema, () => ReportedSetsSchema.parse({})); }
  async contains(claims: readonly string[]): Promise<boolean> { return Object.hasOwn((await this.read()).reported_claim_sets, reportedClaimSetKey(claims)); }
  async record(claims: readonly string[], disputeId: string, reportedAt: string): Promise<void> {
    await withFileLock(`${this.context.paths.reportedSets}.lock`, async () => {
      const value = await this.read();
      const key = reportedClaimSetKey(claims);
      if (Object.hasOwn(value.reported_claim_sets, key)) return;
      value.reported_claim_sets[key] = { first_dispute_id: DisputeIdSchema.parse(disputeId), reported_at: TimestampSchema.parse(reportedAt) };
      await writeYamlAtomic(this.context.paths.reportedSets, value, ReportedSetsSchema, this.context.logger);
    }, { timeoutMs: this.context.lockTimeoutMs });
  }
}
