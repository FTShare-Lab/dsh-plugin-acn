// Maintainer 的收件 ACK 只确认持久收件，知识应用和完成状态由本地服务决定。
import { z } from 'zod';
import { InboxMessageSchema, InboxAckRequestSchema } from '../protocol/inbox.js';
import type { InboxMessage } from '../protocol/inbox.js';
import type { InboxId } from '../protocol/ids.js';
import { ClaimSchema } from '../protocol/claim.js';
import type { Claim } from '../protocol/claim.js';
import { validateAgentReport } from '../protocol/dispute.js';
import type { Dispute } from '../protocol/dispute.js';
import { HealthResponseSchema } from '../protocol/auth.js';
import type { TeamHttp } from './http.js';

export class MaintainerClient {
  constructor(readonly http: TeamHttp) {}
  pull(signal?: AbortSignal): Promise<InboxMessage[]> { return this.http.post('/inbox/pull', { agent_id: this.http.agentId }, z.array(InboxMessageSchema), signal); }
  ack(ids: readonly InboxId[], signal?: AbortSignal): Promise<void> { return this.http.post('/inbox/ack', InboxAckRequestSchema.parse({ agent_id: this.http.agentId, inbox_ids: ids }), undefined, signal); }
  upload(claim: Claim, signal?: AbortSignal): Promise<void> { return this.http.post('/claims/upload', ClaimSchema.parse(claim), undefined, signal); }
  report(dispute: Dispute, signal?: AbortSignal): Promise<void> { return this.http.post('/disputes/report', validateAgentReport(dispute), undefined, signal); }
  health(signal?: AbortSignal) { return this.http.post('/health', {}, HealthResponseSchema, signal); }
}
