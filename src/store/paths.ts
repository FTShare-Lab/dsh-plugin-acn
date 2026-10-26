// 集中生成本地路径；实体 ID 和会话标识必须先校验再拼接。
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentIdSchema, ClaimIdSchema, DisputeIdSchema, InboxIdSchema, TraceIdSchema } from '../protocol/ids.js';

export function agentHomePath(home: string, agentId: string): string {
  const expanded = home === '~' ? homedir() : home.startsWith('~/') ? join(homedir(), home.slice(2)) : home;
  return join(resolve(expanded), 'agents', AgentIdSchema.parse(agentId));
}
export function safeKey(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid local document identifier.');
  return value;
}
export class AgentPaths {
  readonly root: string;
  constructor(agentHome: string) { this.root = resolve(agentHome); }
  get claims(): string { return join(this.root, 'claims'); }
  get traces(): string { return join(this.root, 'traces'); }
  get disputes(): string { return join(this.root, 'disputes'); }
  get inbox(): string { return join(this.root, 'inbox'); }
  get uploads(): string { return join(this.root, 'maintainer_uploads'); }
  get pendingUploads(): string { return join(this.uploads, 'pending.yaml'); }
  get pendingUploadsLock(): string { return join(this.uploads, 'pending.lock'); }
  get deliveryLock(): string { return join(this.uploads, 'delivery.lock'); }
  get knowledgeLock(): string { return join(this.root, 'knowledge_apply.lock'); }
  get claimEditPending(): string { return join(this.root, 'claim_edit_pending.yaml'); }
  get reportedSets(): string { return join(this.disputes, 'reported_claim_sets.yaml'); }
  get memories(): string { return join(this.root, 'memories'); }
  get memory(): string { return join(this.memories, 'MEMORY.md'); }
  get user(): string { return join(this.memories, 'USER.md'); }
  get memoryPending(): string { return join(this.memories, 'pending.yaml'); }
  memoryReceipt(id: string): string { return join(this.memories, 'receipts', `${safeKey(id)}.yaml`); }
  get memoryWindows(): string { return join(this.memories, 'windows'); }
  memoryWindow(id: string): string { return join(this.memoryWindows, `${safeKey(id)}.yaml`); }
  get memoryRequests(): string { return join(this.memories, 'requests'); }
  memoryRequest(id: string): string { return join(this.memoryRequests, `${safeKey(id)}.yaml`); }
  memoryReview(id: string): string { return join(this.memories, 'reviews', `${safeKey(id)}.yaml`); }
  get jobs(): string { return join(this.root, 'jobs'); }
  get workerLock(): string { return join(this.jobs, 'worker.lock'); }
  get jobQueueLock(): string { return join(this.jobs, 'queue.lock'); }
  get sessions(): string { return join(this.root, 'sessions'); }
  get lastRoute(): string { return join(this.root, 'runtime', 'last_route.yaml'); }
  get dreamWorkspace(): string { return join(this.root, 'runtime', 'dream_workspace.yaml'); }
  get llmCalls(): string { return join(this.root, 'runtime', 'llm-calls'); }
  get dreamRoot(): string { return join(this.root, 'dream'); }
  get dreamState(): string { return join(this.root, 'runtime', 'supervisor', 'dream_state.yaml'); }
  get dreamPending(): string { return join(this.root, 'runtime', 'supervisor', 'dream_pending.yaml'); }
  dreamJob(id: string): string { return join(this.dreamRoot, safeKey(id)); }
  dreamFinal(id: string): string { return join(this.root, 'runtime', 'supervisor', 'dream', `${safeKey(id)}.yaml`); }
  dreamExecution(id: string, validation: string): string { if (!/^[0-9a-f]{64}$/.test(validation)) throw new Error('Invalid Dream validation identifier.'); return join(this.dreamJob(id), 'executions', `${validation}.yaml`); }
  transcript(id: string): string { return join(this.session(id), 'transcript.jsonl'); }
  transcriptPending(id: string): string { return join(this.session(id), 'transcript-pending'); }
  claim(id: string): string { return join(this.claims, `${ClaimIdSchema.parse(id)}.yaml`); }
  trace(id: string): string { return join(this.traces, `${TraceIdSchema.parse(id)}.yaml`); }
  dispute(id: string): string { return join(this.disputes, `${DisputeIdSchema.parse(id)}.yaml`); }
  pendingInbox(id: string): string { return join(this.inbox, `${InboxIdSchema.parse(id)}.yaml`); }
  doneInbox(id: string): string { return join(this.inbox, `${InboxIdSchema.parse(id)}.done.yaml`); }
  inboxEffect(id: string): string { return join(this.inbox, 'effects', `${InboxIdSchema.parse(id)}.yaml`); }
  session(id: string): string { return join(this.root, 'sessions', safeKey(id)); }
  sessionState(id: string): string { return join(this.session(id), 'state.yaml'); }
  finalizeCheckpoint(id: string): string { return join(this.session(id), 'finalize_checkpoint.yaml'); }
  job(id: string): string { return join(this.jobs, `${safeKey(id)}.yaml`); }
}
