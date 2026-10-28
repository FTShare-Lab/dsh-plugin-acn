// 真正强杀查证或提交进程，检查预算、回执、证据冲突及部分写入的恢复语义。
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { EvidenceStore } from '../../src/dream/evidence-store.js';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { UploadStore } from '../../src/store/uploads.js';
import { waitJob } from '../formation/helpers.js';
import { evidenceFixture } from './evidence-helpers.js';
import { claims } from './helpers.js';

async function expire(root: string): Promise<void> { const old = new Date(Date.now() - 60_000); for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory()) { const path = join(root, entry.name); if (entry.name.endsWith('.lock')) await fs.utimes(path, old, old); else await expire(path); } }
async function kill(child: ChildProcess) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
async function crash(root: string, workspace: string, job: string, stage: string): Promise<void> {
  const child = fork(new URL('./fixtures/evidence-worker.mjs', import.meta.url), [root, workspace, job, stage], { silent: true }); let stderr = ''; child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  try { await new Promise<void>((resolve, reject) => { child.once('message', () => { resolve(); }); child.once('error', reject); child.once('exit', (code) => { reject(new Error(`Evidence crash worker exited ${code}: ${stderr}`)); }); }); }
  catch (error) { if (child.exitCode === null && child.signalCode === null) await kill(child); throw error; }
  await kill(child); await expire(root);
}
describe('Dream evidence SIGKILL recovery', () => {
  it.each(['permission', 'budget', 'receipt', 'evidence-completed'])('retains the exact manifest and spent budget at %s', async (stage) => {
    const f = await evidenceFixture();
    try {
      await crash(f.knowledge.context().paths.root, f.workspace, 'crash-evidence', stage); const store = new EvidenceStore(f.knowledge.context(), 'crash-evidence', 'group-a'); const manifest = await store.read(); expect(manifest).not.toBeNull(); expect(manifest?.calls).toBe(stage === 'permission' ? 0 : 1); expect(Object.keys(manifest?.receipts ?? {})).toHaveLength(['receipt', 'evidence-completed'].includes(stage) ? 1 : 0); expect(manifest?.completed).toBe(stage === 'evidence-completed');
      expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(f.initial); expect(await new TraceStore(f.knowledge.context()).list()).toEqual([]); await f.knowledge.dreamStore().recover();
    } finally { await f.close(); }
  });
  it.each(['prepared', 'pending', 'first-claim', 'group-completed', 'trace', 'applied', 'state'])('recovers %s with fixed versions and no replay of the model or explorer', async (stage) => {
    const f = await evidenceFixture({ input: claims(2) });
    try {
      const job = await f.worker.queue.enqueue('dream', { manual: true, workspace_root: f.workspace }); await crash(f.knowledge.context().paths.root, f.workspace, job.id, stage); await f.knowledge.dreamStore().recover(); await f.knowledge.dreamStore().recover(); const saved = (await f.knowledge.dreamStore().records(job.id))[0]?.checkpoint;
      expect(saved).toMatchObject({ applied: true, groups: [{ completed: true, skipped: false }] }); expect(Object.keys(saved?.receipts ?? {})).toHaveLength(2); expect((await new ClaimStore(f.knowledge.context()).list()).every((claim) => claim.confidence === 'high')).toBe(true);
      await f.start(); await waitJob(f.worker.queue, job.id); expect(await fs.readFile(join(f.knowledge.context().paths.root, 'model-calls'), 'utf8')).toBe('one'); expect(await new TraceStore(f.knowledge.context()).list()).toHaveLength(2); expect((await new UploadStore(f.knowledge.context()).read()).claims).toEqual([]);
    } finally { await f.close(); }
  });
  it('recovers a prepared group after new evidence access has been disabled', async () => {
    const f = await evidenceFixture({ input: claims(2) });
    try {
      await crash(f.knowledge.context().paths.root, f.workspace, 'revoked-prepared', 'prepared');
      const store = new EvidenceStore(f.knowledge.context(), 'revoked-prepared', 'group-a'); const manifest = await store.read();
      f.knowledge.config.dream.evidenceCalibration = false;
      await f.knowledge.dreamStore().recover(); await f.knowledge.dreamStore().recover();
      const saved = (await f.knowledge.dreamStore().records('revoked-prepared'))[0]?.checkpoint;
      expect(saved).toMatchObject({ applied: true, groups: [{ completed: true, skipped: false }] });
      expect((await new ClaimStore(f.knowledge.context()).list()).every((claim) => claim.confidence === 'high')).toBe(true);
      expect(await store.read()).toEqual(manifest);
    } finally { await f.close(); }
  });
  it.each(['prepared', 'first-claim'])('stale evidence after %s skips remaining writes and preserves applied effects', async (stage) => {
    const f = await evidenceFixture({ input: claims(2) });
    try {
      await crash(f.knowledge.context().paths.root, f.workspace, 'crash-evidence', stage); const before = await new ClaimStore(f.knowledge.context()).list(); await fs.writeFile(join(f.workspace, 'source.txt'), 'New evidence contradicts the old file.'); await f.knowledge.dreamStore().recover();
      const saved = (await f.knowledge.dreamStore().records('crash-evidence'))[0]?.checkpoint; expect(saved).toMatchObject({ applied: true, groups: [{ completed: true, skipped: true }] }); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(before); expect(Object.keys(saved?.self_versions ?? {})).toHaveLength(stage === 'first-claim' ? 1 : 0);
      await f.knowledge.dreamStore().recover(); expect(await new ClaimStore(f.knowledge.context()).list()).toEqual(before);
    } finally { await f.close(); }
  });
});
