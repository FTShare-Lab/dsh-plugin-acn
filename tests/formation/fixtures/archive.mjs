// 在归档 intent、暂停持久化和任务入队后真实中断进程，验证冻结边界不会丢失或扩张。
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Knowledge from '../../../lib/plugins/knowledge.js';
import { AcnFormation } from '../../../lib/formation.js';
import { parse } from 'yaml';

const [root, stage] = process.argv.slice(2);
const ctx = new Context(); await ctx.plugin(Knowledge, { agentId: 'agent-a', home: root });
const formation = new AcnFormation(ctx.acnKnowledge, () => { throw new Error('No model call before recovery'); }, () => '');
const paths = ctx.acnKnowledge.context().paths;
process.on('message', () => {});
const pause = async () => { await new Promise((resolve, reject) => process.send({ stage }, error => error ? reject(error) : resolve())); await new Promise(() => {}); };
formation.capture('session-a', { entry: { seq: 2, type: 'user', text: 'FROZEN_RANGE' }, route: { provider: 'mock', model: 'mock' } });
await formation.flush(); const boundary = await formation.beginArchive('session-a');
formation.capture('session-a', { entry: { seq: 4, type: 'tool_result', text: 'LATE_RANGE' } }); await formation.flush();
if (stage === 'intent') await pause();
const rename = fs.rename; let stopped = false;
fs.rename = async (from, to) => {
  await rename(from, to);
  if (stopped) return;
  const matching = stage === 'archive-pending' && to === paths.sessionState('session-a') && parse(await fs.readFile(to, 'utf8')).archivePending
    || stage === 'archive-queued' && dirname(to) === paths.jobs && to.endsWith('.yaml');
  if (matching) { stopped = true; await pause(); }
};
await formation.archived('session-a', boundary);
