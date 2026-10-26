// 本地争议正文与上报台账分文件保存。
import { DisputeSchema, type Dispute } from '../protocol/dispute.js';
import { DisputeIdSchema } from '../protocol/ids.js';
import type { StoreContext } from './context.js';
import { EntityStore } from './entities.js';

export class DisputeStore extends EntityStore<Dispute> {
  constructor(context: StoreContext) { super(context, context.paths.disputes, DisputeSchema, DisputeIdSchema); }
}
