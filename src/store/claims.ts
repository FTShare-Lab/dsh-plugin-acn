// 本地 Claim 正文只允许当前 holder 写入。
import { ClaimSchema, type Claim } from '../protocol/claim.js';
import { ClaimIdSchema } from '../protocol/ids.js';
import type { StoreContext } from './context.js';
import { EntityStore } from './entities.js';
import { StoreError } from './errors.js';

export class ClaimStore extends EntityStore<Claim> {
  constructor(context: StoreContext) { super(context, context.paths.claims, ClaimSchema, ClaimIdSchema); }
  override async write(value: unknown): Promise<Claim> {
    const claim = ClaimSchema.parse(value);
    if (claim.holder !== this.context.agentId) throw new StoreError('ownership', 'Cannot write a Claim held by another agent.');
    return super.write(claim);
  }
}
