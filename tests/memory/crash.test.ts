// SIGKILL 覆盖双文件 WAL、完成回执、review 固定操作及窗口 outbox 的恢复边界。
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryFixture, reviewTurn } from './helpers.js';
import { waitJob } from '../formation/helpers.js';
import { AcnMemory } from '../../src/memory/service.js';
import { MemorySessions } from '../../src/memory/sessions.js';

const active: Awaited<ReturnType<typeof memoryFixture>>[] = [];
async function setup() { const f = await memoryFixture({ memory: { review: { intervalTurns: 1 } } }, () => Promise.reject(new Error('Prepared recovery must not invoke a model.'))); active.push(f); await f.memory.files.write({ memory: 'old memory', user: 'old user' }); return f; }
afterEach(async () => { await Promise.all(active.splice(0).map((f) => f.close())); });
async function expire(root: string): Promise<void> { const old = new Date(Date.now() - 60_000); for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory()) { const path = join(root, entry.name); if (entry.name.endsWith('.lock')) await fs.utimes(path, old, old); else await expire(path); } }
async function kill(child: ChildProcess) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
async function crash(home: string, stage: string, id?: string) {
  const child = fork(new URL('./fixtures/worker.mjs', import.meta.url), [home, stage, ...id === undefined ? [] : [id]], { silent: true }); let stderr = ''; child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  try { await new Promise<void>((resolve, reject) => { child.once('message', () => { resolve(); }); child.once('error', reject); child.once('exit', (code) => { reject(new Error(`Memory crash worker exited ${code}: ${stderr}`)); }); }); }
  catch (error) { if (child.exitCode === null && child.signalCode === null) await kill(child); throw error; }
  await kill(child); await expire(home);
}
const ops = [{ op: 'replace', target: 'memory', old_text: 'old memory', new_text: 'new memory' }, { op: 'replace', target: 'user', old_text: 'old user', new_text: 'new user' }];

describe('private Memory SIGKILL recovery', () => {
  it('resumes a durably published frozen snapshot after process death and later file changes', async () => {
    const f = await setup(); await crash(f.root, 'snapshot'); await f.memory.files.write({ memory: 'newer disk memory', user: 'newer disk profile' });
    const sessions = new MemorySessions(f.memory, (_name, context) => JSON.stringify(context)); await sessions.freeze('frozen-crash', 'resume'); expect(sessions.text('frozen-crash')).toContain('old memory'); expect(sessions.text('frozen-crash')).not.toContain('newer disk');
  });
  it.each(['pending', 'memory', 'user', 'receipt', 'pending-removed'])('finishes a fixed dual-file target after %s and replays the same call once', async (stage) => {
    const f = await setup(); await crash(f.root, stage); const restarted = new AcnMemory(f.knowledge); await restarted.files.recover(); await restarted.files.recover();
    expect(await restarted.files.read()).toEqual({ memory: 'new memory', user: 'new user' }); expect(await restarted.apply({ ops }, { id: 'crash-call' })).toMatchObject({ no_op: false });
  });
  it.each(['pending', 'memory'])('preserves external third versions and stops remaining publication after %s', async (stage) => {
    const f = await setup(); await crash(f.root, stage); const paths = f.knowledge.context().paths; await fs.writeFile(paths.user, 'external user edit'); await f.memory.files.recover();
    expect(await f.memory.files.read()).toEqual({ memory: stage === 'memory' ? 'new memory' : 'old memory', user: 'external user edit' });
    await expect(f.memory.apply({ ops }, { id: 'crash-call' })).rejects.toMatchObject({ kind: 'conflict' });
  });
  it('honors a completed receipt even when files change before pending cleanup', async () => {
    const f = await setup(); await crash(f.root, 'receipt'); await fs.writeFile(f.knowledge.context().paths.memory, 'post-commit edit'); await f.memory.files.recover();
    expect(await f.memory.files.read()).toEqual({ memory: 'post-commit edit', user: 'new user' }); expect(await f.memory.apply({ ops }, { id: 'crash-call' })).toMatchObject({ no_op: false });
  });
  it.each(['review-prepared', 'pending', 'memory', 'receipt', 'review-applied'])('recovers private review after %s without calling the model or replaying replace', async (stage) => {
    const f = await setup(); await reviewTurn(f.review); const job = (await f.worker.queue.list())[0]; if (!job) throw new Error('Missing review task.'); await crash(f.root, stage, job.id);
    await f.memory.files.recover(); await f.worker.start(); await waitJob(f.worker.queue, job.id);
    expect(await f.memory.files.read()).toEqual({ memory: 'new memory', user: 'new user' }); expect(await fs.readFile(join(f.root, 'model-calls'), 'utf8')).toBe('one\n');
    expect(await f.worker.queue.read(job.id)).toMatchObject({ result: { applied: true, changed: true, skipped: false } });
  });
  it.each(['outbox', 'enqueued'])('recovers a review request killed at %s without duplicate jobs', async (stage) => {
    const f = await setup(); await crash(f.root, stage); await f.review.start(); await f.review.start(); const jobs = await f.worker.queue.list(); expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ kind: 'memory_review', sessionId: 'session-outbox' }); expect(typeof jobs[0]?.payload['request_id']).toBe('string');
  });
});
