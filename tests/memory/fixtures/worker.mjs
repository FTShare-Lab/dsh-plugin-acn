// 在真实原子发布后暂停，父进程强杀；复用构建产物检查恢复不依赖旧进程内存。
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { Context } from '@deepseek-ai/cordis';
import Knowledge from '../../../lib/plugins/knowledge.js';
import { AcnMemory, MemoryReview, MemorySessions } from '../../../lib/memory.js';

const [home, stage, jobId = 'crash-call'] = process.argv.slice(2);
const ctx = new Context(); await ctx.plugin(Knowledge, { home, agentId: 'agent-a', llm: { provider: 'mock', model: 'mock' }, memory: { review: { intervalTurns: 1 } } });
const knowledge = ctx.acnKnowledge; const memory = new AcnMemory(knowledge); const paths = knowledge.context().paths;
process.on('message', () => {});
async function pause() { await new Promise((resolve, reject) => process.send({ stage }, (error) => error ? reject(error) : resolve())); await new Promise(() => {}); }
const rename = fs.rename;
fs.rename = async (source, target) => {
  await rename(source, target);
  let match = stage === 'pending' && target === paths.memoryPending || stage === 'memory' && target === paths.memory || stage === 'user' && target === paths.user || stage === 'receipt' && target === paths.memoryReceipt(jobId);
  match ||= stage === 'snapshot' && target === paths.sessionState('frozen-crash');
  if (target === paths.memoryReview(jobId)) { const checkpoint = parse(await fs.readFile(target, 'utf8')); match ||= stage === 'review-prepared' && !checkpoint.applied || stage === 'review-applied' && checkpoint.applied; }
  if (dirname(target) === paths.memoryWindows) { const window = parse(await fs.readFile(target, 'utf8')); match ||= stage === 'outbox' && window.outbox.length > 0; }
  if (dirname(target) === paths.jobs) match ||= stage === 'enqueued' && parse(await fs.readFile(target, 'utf8')).kind === 'memory_review';
  if (match) await pause();
};
const unlink = fs.unlink;
fs.unlink = async (path) => { await unlink(path); if (stage === 'pending-removed' && path === paths.memoryPending) await pause(); };
const ops = [{ op: 'replace', target: 'memory', old_text: 'old memory', new_text: 'new memory' }, { op: 'replace', target: 'user', old_text: 'old user', new_text: 'new user' }];
if (stage === 'snapshot') await new MemorySessions(memory, (_name, context) => JSON.stringify(context)).freeze('frozen-crash', 'startup');
else if (stage === 'outbox' || stage === 'enqueued') {
  const review = new MemoryReview(memory, () => Promise.resolve({ text: '{"ops":[]}' }), () => 'Private review.');
  review.capture('session-outbox', { seq: 1, user: true, projection: { entry: { seq: 1, type: 'user', text: 'A stable user preference.' } } });
  review.capture('session-outbox', { seq: 2, projection: { entry: { seq: 2, type: 'assistant', text: 'Understood.' } } });
  review.capture('session-outbox', { seq: 3, ended: true, completed: true }); await review.flush();
} else if (jobId !== 'crash-call') {
  const review = new MemoryReview(memory, async () => { await fs.appendFile(join(home, 'model-calls'), 'one\n'); return { text: JSON.stringify({ ops }) }; }, () => 'Private review.');
  await knowledge.jobs.start(); await new Promise(() => {}); await review.close();
} else await memory.apply({ ops }, { id: jobId });
throw new Error('Requested private Memory boundary was not reached.');
