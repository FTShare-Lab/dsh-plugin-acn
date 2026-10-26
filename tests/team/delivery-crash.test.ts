// 真正终止投递进程，验证网络确认与本地队列/台账提交之间的恢复行为。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { UploadDelivery } from '../../src/upload/deliver.js';
import { UploadStore } from '../../src/store/uploads.js';
import { ClaimStore } from '../../src/store/claims.js';
import { ReportedSetStore } from '../../src/store/reported-sets.js';
import { DisputeSchema } from '../../src/protocol/dispute.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { inboxFixture, teamServer } from './helpers.js';
async function ageLocks(root: string): Promise<void> {
  const expired = new Date(Date.now() - 60_000);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory()) {
    const path = join(root, entry.name); if (entry.name.endsWith('.lock')) await fs.utimes(path, expired, expired); else await ageLocks(path);
  }
}
describe('upload process recovery', () => {
  it.each(['before-ledger', 'after-ledger', 'before-claim-cleanup'])('SIGKILL at %s recovers by exact ID or skips an already recorded report', async (stage) => {
    const server = await teamServer(() => ({})); const fixture = await inboxFixture(undefined, { team: { routerEndpoint: server.endpoint, maintainerEndpoint: server.endpoint, retryCount: 0 } }); const context = fixture.knowledge.context();
    const dispute = DisputeSchema.parse({ id: 'dispute_00000001', name: 'scope_conflict', claims: ['claim_00000001', 'claim_00000002'], summary: 'Conflicting scope evidence.', reporter_agent_id: 'agent-a', status: 'open', created_at: '2026-01-02T00:00:00Z' });
    if (stage === 'before-claim-cleanup') await new ClaimStore(context).write(sampleClaim());
    await new UploadStore(context).enqueue(stage === 'before-claim-cleanup' ? [sampleClaim()] : [], stage === 'before-claim-cleanup' ? [] : [dispute], true);
    const child = fork(new URL('./fixtures/delivery.mjs', import.meta.url), [context.paths.root, server.endpoint, stage], { silent: true }); let stderr = ''; child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    try {
      await new Promise<void>((resolve, reject) => { child.once('message', () => { resolve(); }); child.once('error', reject); child.once('exit', (code) => { if (code !== null) reject(new Error(`Delivery process exited ${code}: ${stderr}`)); }); });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; await ageLocks(context.paths.root);
      expect(server.requests).toHaveLength(1); await new UploadDelivery(context, fixture.knowledge.team).deliver();
      expect(server.requests).toHaveLength(stage === 'after-ledger' ? 1 : 2); if (server.requests.length === 2) expect(server.requests[0]?.body).toEqual(server.requests[1]?.body);
      expect((await new UploadStore(context).read()).claims).toEqual([]); expect((await new UploadStore(context).read()).disputes).toEqual([]);
      if (stage !== 'before-claim-cleanup') expect(await new ReportedSetStore(context).contains(dispute.claims)).toBe(true);
    } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } await fixture.close(); await server.close(); }
  });
});
