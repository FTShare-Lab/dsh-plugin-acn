// 团队拉取和本地处理共享持久 worker；外部调用在知识锁外，prepared 后只补本地效果。
import type { AcnKnowledge } from '../knowledge/service.js';
import type { StructuredBackend } from '../llm/structured.js';
import { resolveRoute, structuredCall } from '../llm/structured.js';
import { InboxStore } from '../store/inbox.js';
import { InboxEffectStore } from './effects.js';
import { InternalizeOutputSchema, inboxContext, prepareInbox } from './prepare.js';
import { deprecatePolicyClaims } from './cascade.js';
import { syncInbox } from './sync.js';
import type { JobControl } from '../worker/worker.js';
import type { Job } from '../worker/types.js';
import { JobError } from '../worker/types.js';
import { ensureKnowledgeReady } from '../knowledge/alignment.js';
import { UploadDelivery } from '../upload/deliver.js';
import type { InboxMessage } from '../protocol/inbox.js';

export class AcnInbox {
  private readonly unregister: () => void;
  private readonly stopping = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  constructor(readonly knowledge: AcnKnowledge, private readonly backend: StructuredBackend, private readonly render: (name: string, context: object) => string) {
    if (knowledge.jobs === null) throw new JobError('unconfigured', '请先配置 agentId。');
    this.unregister = knowledge.jobs.register('inbox', (job, control) => this.track(() => this.run(job, { ...control, signal: AbortSignal.any([control.signal, this.stopping.signal]) })));
  }
  private async track<T>(operation: () => Promise<T>): Promise<T> {
    this.stopping.signal.throwIfAborted();
    const pending = operation(); this.active.add(pending);
    try { return await pending; } finally { this.active.delete(pending); }
  }
  enqueue(synchronize = true, sessionId?: string): Promise<Job> {
    this.stopping.signal.throwIfAborted();
    if (this.knowledge.jobs === null) throw new JobError('unconfigured', '请先配置 agentId。');
    return this.knowledge.jobs.enqueue('inbox', { synchronize }, sessionId);
  }
  async request(signal?: AbortSignal, sessionId?: string) {
    return this.track(async () => {
      const report = await syncInbox(this.knowledge.context(), this.knowledge.team, signal === undefined ? this.stopping.signal : AbortSignal.any([signal, this.stopping.signal]));
      const job = await this.enqueue(false, sessionId);
      return { ...report, pending: (await new InboxStore(this.knowledge.context()).listPending()).length, jobId: job.id };
    });
  }
  async start(): Promise<void> {
    await new InboxEffectStore(this.knowledge.context()).recover();
    // 重启也补处理已持久化但尚未领取的消息，不依赖某个会话再次启动。
    if (await new InboxStore(this.knowledge.context()).hasUnfinished()) await this.enqueue();
  }
  private async prepare(messages: InboxMessage[], analysisClaims: Awaited<ReturnType<AcnKnowledge['snapshot']>>['claims'], job: Job, control: JobControl) {
    const first = messages[0];
    if (first === undefined) throw new JobError('validation', 'Inbox 批次为空。');
    if (first.message_type === 'policy_update' && first.policy.status === 'deprecated') {
      const syncClaims = deprecatePolicyClaims(first.policy.id, analysisClaims);
      // 已废弃条目只补传；不伪造一次新的本地修订或任务产出。
      return { claims: syncClaims.filter((target) => analysisClaims.some((before) => before.id === target.id && before.status !== 'deprecated')), syncClaims, disputes: [], usedClaimIds: [], warnings: [] };
    }
    const context = inboxContext(this.knowledge.context().agentId, messages, analysisClaims);
    const route = await resolveRoute(this.knowledge.config.llm, this.knowledge.context());
    return structuredCall({ backend: this.backend, context: this.knowledge.context(), config: this.knowledge.config.llm, route, jobId: job.id,
      system: this.render(first.message_type === 'policy_update' ? 'inbox_policy_update_internalize.j2' : 'inbox_claim_attribute_update_internalize.j2', {}), input: JSON.stringify(context.input), schema: InternalizeOutputSchema,
      parse: (value) => prepareInbox(value, this.knowledge.context().agentId, messages, analysisClaims), signal: control.signal });
  }
  private async run(job: Job, control: JobControl): Promise<Job['result']> {
    const context = this.knowledge.context();
    await ensureKnowledgeReady(context.paths.root);
    await new InboxEffectStore(context).recover();
    control.signal.throwIfAborted();
    const sync = job.payload['synchronize'] === false ? { pulled: 0, accepted: 0, acknowledged: 0, warnings: [] } : await syncInbox(context, this.knowledge.team, control.signal);
    await ensureKnowledgeReady(context.paths.root);
    const store = new InboxStore(context, this.knowledge.config.inbox.processingStaleAfterSecs);
    // 该入口只由单持有者 worker 调用；模型前崩溃遗留的租约可立即安全回收。
    await store.recoverOrphans();
    const claimed = await store.claimPending();
    let applied = 0;
    let handled = 0;
    try {
      for (let offset = 0; offset < claimed.length;) {
        const first = claimed[offset];
        if (first === undefined) break;
        const batch = [first];
        offset += 1;
        if (!(first.message.message_type === 'policy_update' && first.message.policy.status === 'deprecated')) while (offset < claimed.length) {
          const next = claimed[offset];
          if (next === undefined || next.message.message_type !== first.message.message_type || next.message.message_type === 'policy_update' && next.message.policy.status === 'deprecated') break;
          batch.push(next); offset += 1;
        }
        control.signal.throwIfAborted();
        // 此处 snapshot 先恢复 prepared 前缀，再为后面的新批次构造模型输入。
        const analysisClaims = (await this.knowledge.snapshot()).claims;
        const messages = batch.map((item) => item.message);
        const prepared = await this.prepare(messages, analysisClaims, job, control);
        const result = await this.knowledge.applyInboxEffect(messages, analysisClaims, prepared, control);
        // prepared 只保护本批固定提交；卸载期间完成该批后不得启动下一批或投递。
        control.committed?.();
        applied += result.applied; handled += messages.length;
        control.signal.throwIfAborted();
      }
    } finally { for (const item of claimed) await store.release(item); }
    control.signal.throwIfAborted();
    const delivery = await new UploadDelivery(context, this.knowledge.team).deliver(control.signal);
    if ((await store.listPending()).length > 0) await this.enqueue();
    return { ...sync, applied, handled, uploadedClaims: delivery.deliveredClaims, reportedDisputes: delivery.deliveredDisputes, warnings: [...sync.warnings, ...delivery.warnings] };
  }
  async close(): Promise<void> {
    this.stopping.abort(new JobError('suspended', 'Inbox 已暂停，未完成消息保留。')); this.unregister();
    await Promise.allSettled([...this.active]);
  }
}
