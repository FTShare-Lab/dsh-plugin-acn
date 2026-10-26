// 故障注入与真实 SIGKILL 覆盖多成员 journal、部分应用、陈旧计划和完成标记。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InboxEffectSchema, InboxEffectStore, prepareInbox } from '../../src/inbox/index.js';
import { ClaimStore } from '../../src/store/claims.js';
import { TraceStore } from '../../src/store/traces.js';
import { DisputeStore } from '../../src/store/disputes.js';
import { InboxStore } from '../../src/store/inbox.js';
import { UploadStore } from '../../src/store/uploads.js';
import { InboxMessageSchema } from '../../src/protocol/inbox.js';
import { writeYamlAtomic, readYaml } from '../../src/store/yaml.js';
import { STALE_PLAN_WARNING } from '../../src/knowledge/alignment.js';
import { withFileLock } from '../../src/store/lock.js';
import { inboxFixture, inboxMessage, emptyInternalize } from '../team/helpers.js';
import { newDraft, waitJob } from '../formation/helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';

const control = () => ({ signal: new AbortController().signal, prepared() {} });
async function ageOrphanLocks(directory: string): Promise<void> {
  const old = new Date(Date.now() - 60_000);
  for (const item of await fs.readdir(directory, { withFileTypes: true })) if (item.isDirectory()) {
    const path = join(directory, item.name); if (item.name.endsWith('.lock')) await fs.utimes(path, old, old); else await ageOrphanLocks(path);
  }
}
describe('Inbox durable recovery', () => {
  it.each(['prepared', 'after-ref', 'after-claim', 'after-progress', 'after-trace', 'after-upload', 'after-applied', 'before-done', 'after-done'])('SIGKILL at %s restores exact effects, refs, upload queue and done without another model call', async (stage) => {
    const fixture = await inboxFixture(undefined, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1', retryCount: 0 } });
    const context = fixture.knowledge.context(); await new ClaimStore(context).write(sampleClaim());
    const child = fork(new URL('./fixtures/worker.mjs', import.meta.url), [context.paths.root, stage], { silent: true });
    let stderr = ''; child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    try {
      await new Promise<void>((resolve, reject) => { child.once('message', () => { resolve(); }); child.once('error', reject); child.once('exit', (code) => { if (code !== null) reject(new Error(`Crash fixture exited ${code}: ${stderr}`)); }); });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; await ageOrphanLocks(context.paths.root);
      const before = await readYaml(context.paths.inboxEffect('inbox_00000001'), InboxEffectSchema);
      await fixture.knowledge.initialize(); await fixture.knowledge.initialize();
      const restored = await readYaml(context.paths.inboxEffect('inbox_00000001'), InboxEffectSchema);
      expect(restored.status).toBe('applied'); expect(restored.trace?.id).toBe(before.trace?.id); expect(restored.appliedClaims).toHaveLength(3);
      expect(await new ClaimStore(context).list()).toHaveLength(3); expect(await new DisputeStore(context).list()).toHaveLength(1); expect(await new TraceStore(context).list()).toHaveLength(1);
      const pending = await new UploadStore(context).read(); expect(pending.claims).toHaveLength(3); expect(pending.disputes).toHaveLength(1);
      expect(await new InboxStore(context).listPending()).toEqual([]);
      expect((await fs.readdir(context.paths.inbox)).filter((name) => name.endsWith('.done.yaml'))).toHaveLength(2);
      expect(await fs.readFile(join(context.paths.root, 'model-calls'), 'utf8')).toBe('one');
    } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } await fixture.close(); }
  });
  it.each(['dangling', 'mismatched', 'mutated-member', 'changed-inbox'])('rejects %s journal integrity before applying any Claim', async (fault) => {
    const fixture = await inboxFixture();
    const context = fixture.knowledge.context(); const message = inboxMessage(); const other = InboxMessageSchema.parse({ ...message, id: 'inbox_00000002' });
    const original = fs.rename.bind(fs); let stopped = false;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => { await original(source, target); if (String(target) === context.paths.inboxEffect(message.id) && !stopped) { stopped = true; throw new Error('Stop after canonical prepared.'); } });
    try {
      await new InboxStore(context).acceptPulled(message); await new InboxStore(context).acceptPulled(other);
      const prepared = prepareInbox({ ...emptyInternalize(), new_claims: [newDraft()] }, context.agentId, [message, other], []);
      await expect(new InboxEffectStore(context).commit([message, other], [], prepared, control())).rejects.toThrow(); spy.mockRestore();
      const effect = await readYaml(context.paths.inboxEffect(message.id), InboxEffectSchema);
      if (fault === 'dangling') { await new InboxEffectStore(context).recover(); await fs.rm(context.paths.inboxEffect(message.id)); }
      else if (fault === 'changed-inbox') await writeYamlAtomic(context.paths.pendingInbox(message.id), { ...message, policy: { ...message.policy, statement: 'Conflicting incoming snapshot.' } }, InboxMessageSchema, context.logger);
      else if (fault === 'mutated-member') { const member = effect.members[0]; if (member !== undefined) member.message.policy.statement = 'Mutated journal context.'; await writeYamlAtomic(context.paths.inboxEffect(message.id), effect, InboxEffectSchema, context.logger); }
      else await writeYamlAtomic(context.paths.inboxEffect(other.id), { schemaVersion: 1, type: 'ref', id: other.id, canonicalId: message.id, batchHash: '0'.repeat(64), messageHash: '0'.repeat(64) }, z.unknown(), context.logger);
      const count = (await new ClaimStore(context).list()).length;
      await expect(new InboxEffectStore(context).recover()).rejects.toMatchObject({ kind: 'conflict' }); expect(await new ClaimStore(context).list()).toHaveLength(count);
    } finally { spy.mockRestore(); await fixture.close(); }
  });
  it('preserves already-applied partial results and external changes while discarding a stale remainder', async () => {
    const fixture = await inboxFixture(); const context = fixture.knowledge.context(); const local = sampleClaim(); await new ClaimStore(context).write(local);
    const message = inboxMessage(); const prepared = prepareInbox({ ...emptyInternalize(), new_claims: [newDraft()], updated_claims: [{ ...newDraft(), id: local.id, status: 'stale' }] }, context.agentId, [message], [local]);
    const rename = fs.rename.bind(fs); let stopped = false;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => { await rename(source, target); if (String(target).startsWith(context.paths.claims) && !stopped) { stopped = true; throw new Error('Disk interrupted.'); } });
    try {
      await new InboxStore(context).acceptPulled(message); await expect(new InboxEffectStore(context).commit([message], [local], prepared, control())).rejects.toThrow(); spy.mockRestore();
      await new ClaimStore(context).write({ ...local, statement: 'External edit after prepare.' });
      await fixture.knowledge.initialize(); const restored = await readYaml(context.paths.inboxEffect(message.id), InboxEffectSchema);
      expect(restored.warnings).toContain(STALE_PLAN_WARNING); expect(restored.appliedClaims).toHaveLength(1); expect(restored.preparedClaims).toEqual([]);
      expect((await new ClaimStore(context).read(local.id)).statement).toBe('External edit after prepare.'); expect((await new TraceStore(context).list())[0]?.output_claims).toEqual(restored.appliedClaims.map((claim) => claim.id));
    } finally { spy.mockRestore(); await fixture.close(); }
  });
  it('resumes a prepared prefix before planning later CAU and does not replay the first model call', async () => {
    let calls = 0; const fixture = await inboxFixture((_route, _system, input) => { calls += 1; expect(input).toContain('bounded_retry_0'); return Promise.resolve({ text: JSON.stringify(emptyInternalize()) }); });
    const context = fixture.knowledge.context(); const base = inboxMessage(); const message = InboxMessageSchema.parse({ ...base, message_type: 'claim_attribute_update', policy: { ...base.policy, message_type: 'claim_attribute_update' } }); const next = InboxMessageSchema.parse({ ...message, id: 'inbox_00000002', policy: { ...message.policy, created_at: '2026-01-03T00:00:00Z' } });
    const rename = fs.rename.bind(fs); let stopped = false;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => { await rename(source, target); if (String(target) === context.paths.inboxEffect(message.id) && !stopped) { stopped = true; throw new Error('Stop after prepare.'); } });
    try {
      await new InboxStore(context).acceptPulled(message); const prepared = prepareInbox({ ...emptyInternalize(), new_claims: [newDraft()] }, context.agentId, [message], []);
      await expect(new InboxEffectStore(context).commit([message], [], prepared, control())).rejects.toThrow(); spy.mockRestore(); await new InboxStore(context).acceptPulled(next);
      const jobs = fixture.knowledge.jobs; if (jobs === null) throw new Error('No worker.'); await jobs.start(); const job = await fixture.inbox.enqueue(); await waitJob(jobs.queue, job.id); expect(calls).toBe(1); expect(await new InboxStore(context).listPending()).toEqual([]);
    } finally { spy.mockRestore(); await fixture.close(); }
  });
  it.each(['active', 'deprecated'] as const)('stages %s changes before releasing the knowledge lock', async (status) => {
    const fixture = await inboxFixture(undefined, { team: { routerEndpoint: 'http://127.0.0.1:1', maintainerEndpoint: 'http://127.0.0.1:1', retryCount: 0 } }); const context = fixture.knowledge.context();
    const message = inboxMessage(); const local = sampleClaim(); await new ClaimStore(context).write(local);
    let verified = false; const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => { await rename(source, target); if (String(target) === context.paths.pendingUploads) { await expect(withFileLock(context.paths.knowledgeLock, async () => {}, { timeoutMs: 0 })).rejects.toMatchObject({ kind: 'lock_order' }); verified = true; } });
    try {
      await new InboxStore(context).acceptPulled(message); const prepared = prepareInbox({ ...emptyInternalize(), updated_claims: [{ ...newDraft(), id: local.id, status }] }, context.agentId, [message], [local]);
      await new InboxEffectStore(context).commit([message], [local], prepared, control()); expect(verified).toBe(true); expect((await new UploadStore(context).read()).claims[0]?.status).toBe(status);
    } finally { spy.mockRestore(); await fixture.close(); }
  });
});
