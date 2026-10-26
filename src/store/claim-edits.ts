// 写入方持有知识锁；恢复只补传已落盘正文，不重放尚未成功的本地修订。
import { z } from 'zod';
import { ClaimSchema } from '../protocol/claim.js';
import { claimRevision } from '../protocol/revision.js';
import type { StoreContext } from './context.js';
import { ClaimStore } from './claims.js';
import { withFileLock } from './lock.js';
import { readYamlOr, writeYamlAtomic } from './yaml.js';
import { removeFile } from './atomic.js';
import { StoreError } from './errors.js';
import { UploadStore } from './uploads.js';

export const PendingClaimEditSchema = z.object({ expected_revision: z.string().regex(/^sha256-v1:[0-9a-f]{64}$/), target: ClaimSchema });
export class ClaimEditStore {
  constructor(readonly context: StoreContext) {}
  async write(record: unknown): Promise<void> {
    if (this.context.mode === 'solo') return;
    const parsed = PendingClaimEditSchema.parse(record);
    if (parsed.target.holder !== this.context.agentId) throw new StoreError('ownership', 'Pending edit belongs to another agent.');
    await writeYamlAtomic(this.context.paths.claimEditPending, parsed, PendingClaimEditSchema, this.context.logger);
  }
  async recover(): Promise<'none' | 'discarded' | 'queued'> {
    if (this.context.mode === 'solo') return 'none';
    // 无 pending 时不创建知识目录和锁。
    const load = () => readYamlOr(this.context.paths.claimEditPending, PendingClaimEditSchema, () => null);
    if (await load() === null) return 'none';
    return withFileLock(this.context.paths.knowledgeLock, () => this.recoverLocked(), { timeoutMs: this.context.lockTimeoutMs });
  }
  // 调用者已持知识锁；修订事务必须在同一临界区恢复上一条未完成编辑。
  async recoverLocked(): Promise<'none' | 'discarded' | 'queued'> {
    if (this.context.mode === 'solo') return 'none';
    const pending = await readYamlOr(this.context.paths.claimEditPending, PendingClaimEditSchema, () => null);
    if (pending === null) return 'none';
    const current = await new ClaimStore(this.context).read(pending.target.id);
    if (current.holder !== this.context.agentId) throw new StoreError('ownership', 'Cannot recover another agent’s Claim.');
    const landed = claimRevision(current) === claimRevision(pending.target);
    // 日志只授权自己的精确目标；第三版本可能来自单人修订或未交付的整合。
    if (landed) await new UploadStore(this.context).enqueue([current], [], true);
    else if (claimRevision(current) !== pending.expected_revision) this.context.logger.warn(`Claim ${current.id} 的编辑日志已被其他版本取代，未自动加入团队上传。`);
    await removeFile(this.context.paths.claimEditPending, this.context.logger);
    return landed ? 'queued' : 'discarded';
  }
}
