// 持久保存待投递实体的失败或暂停原因；不记录鉴权内容或请求正文。
import { z } from 'zod';
import { ClaimIdSchema, DisputeIdSchema } from '../protocol/ids.js';
import type { StoreContext } from './context.js';
import { withFileLock } from './lock.js';
import { readYamlOr, writeYamlAtomic } from './yaml.js';
export const DeliveryIssueSchema = z.object({
  kind: z.enum(['claim', 'dispute']), id: z.union([ClaimIdSchema, DisputeIdSchema]),
  reason: z.enum(['auth', 'retryable', 'client', 'protocol', 'version', 'dependency', 'rejected']),
  version: z.string().regex(/^[0-9a-f]{64}$/).optional(), status: z.number().int().optional(), attempts: z.number().int().nonnegative().default(0), updatedAt: z.number().int().nonnegative(),
});
export type DeliveryIssue = z.infer<typeof DeliveryIssueSchema>;
const State = z.object({ schemaVersion: z.literal(1), issues: z.record(z.string(), DeliveryIssueSchema) });
export class DeliveryStatusStore {
  constructor(readonly context: StoreContext) {}
  read() { return readYamlOr(this.context.paths.deliveryStatus, State, () => State.parse({ schemaVersion: 1, issues: {} })); }
  async record(input: Omit<DeliveryIssue, 'updatedAt' | 'attempts'>): Promise<void> {
    if (this.context.mode !== 'team') return;
    await withFileLock(`${this.context.paths.deliveryStatus}.lock`, async () => {
      const state = await this.read(); const key = `${input.kind}-${input.id}`; const previous = state.issues[key];
      const attempted = !['version', 'dependency'].includes(input.reason);
      if (!attempted && previous?.reason === input.reason && previous.status === input.status) return;
      state.issues[key] = { ...input, attempts: (previous?.version === input.version ? previous?.attempts ?? 0 : 0) + Number(attempted), updatedAt: Date.now() };
      await writeYamlAtomic(this.context.paths.deliveryStatus, state, State, this.context.logger);
    }, { timeoutMs: this.context.lockTimeoutMs });
  }
  async clear(kind: DeliveryIssue['kind'], id: string): Promise<void> {
    if (this.context.mode !== 'team') return;
    await withFileLock(`${this.context.paths.deliveryStatus}.lock`, async () => {
      const state = await this.read(); const key = `${kind}-${id}`;
      if (state.issues[key] === undefined) return;
      delete state.issues[key]; await writeYamlAtomic(this.context.paths.deliveryStatus, state, State, this.context.logger);
    }, { timeoutMs: this.context.lockTimeoutMs });
  }
}
