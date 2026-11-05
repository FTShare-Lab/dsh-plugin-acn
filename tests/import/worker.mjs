// 子进程在真实独占发布后暂停，供父进程强杀。
import fs from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import Knowledge from '../../lib/plugins/knowledge.js';
import { importCommand } from '../../lib/plugins/commands.js';
const [home, source, stage] = process.argv.slice(2); const ctx = new Context();
await ctx.plugin(Knowledge, { home, agentId: 'agent-a' }); const paths = ctx.acnKnowledge.context().paths;
process.on('message', () => {});
async function pause() { await new Promise((resolve, reject) => process.send({ stage }, (error) => error ? reject(error) : resolve())); await new Promise(() => {}); }
const link = fs.link; fs.link = async (from, to) => { await link(from, to); if (stage === 'claim' && to === paths.claim('claim_00000001') || stage === 'trace' && to === paths.trace('trace_00000001')) await pause(); };
await importCommand(ctx.acnKnowledge, JSON.stringify(source), false);
throw new Error('Import crash boundary was not reached.');
