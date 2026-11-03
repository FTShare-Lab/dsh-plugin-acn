// 终止记录绑定被拒绝的精确争议版本；恢复不重试，也不冒充成功上报台账。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DisputeSchema, type Dispute } from '../protocol/dispute.js';
import { DisputeIdSchema } from '../protocol/ids.js';
import { nowSeconds, TimestampSchema } from '../protocol/time.js';
import type { StoreContext } from './context.js';
import { withFileLock } from './lock.js';
import { readYamlOr, writeYamlAtomic } from './yaml.js';

const RejectionsSchema = z.record(z.string().regex(/^[0-9a-f]{64}$/), z.object({ dispute_id: DisputeIdSchema, status: z.literal(409), attempts: z.number().int().positive().default(1), rejected_at: TimestampSchema }));
export const disputeVersion = (dispute: Dispute): string => createHash('sha256').update(JSON.stringify(DisputeSchema.parse(dispute))).digest('hex');
export class RejectedDisputeStore {
  constructor(readonly context: StoreContext) {}
  async read(includeHistory = false): Promise<z.infer<typeof RejectionsSchema>> {
    if (this.context.mode === 'solo' && !includeHistory) return {};
    return readYamlOr(this.context.paths.rejectedDisputes, RejectionsSchema, () => ({}));
  }
  async contains(dispute: Dispute): Promise<boolean> { return Object.hasOwn(await this.read(), disputeVersion(dispute)); }
  async record(dispute: Dispute, attempts = 1): Promise<void> {
    if (this.context.mode === 'solo') return;
    await withFileLock(`${this.context.paths.rejectedDisputes}.lock`, async () => {
      const records = await this.read(); const key = disputeVersion(dispute);
      if (Object.hasOwn(records, key)) return;
      records[key] = { dispute_id: dispute.id, status: 409, attempts, rejected_at: nowSeconds() };
      await writeYamlAtomic(this.context.paths.rejectedDisputes, records, RejectionsSchema, this.context.logger);
    }, { timeoutMs: this.context.lockTimeoutMs });
  }
}
