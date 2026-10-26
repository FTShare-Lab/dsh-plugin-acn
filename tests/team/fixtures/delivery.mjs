// HTTP 已确认后在本地记账前后强制停住，覆盖跨进程的幂等重送窗口。
import fs from 'node:fs/promises';
import { AgentIdSchema } from '../../../lib/protocol.js';
import { AgentPaths } from '../../../lib/store.js';
import { TeamFacade } from '../../../lib/team.js';
import { UploadDelivery } from '../../../lib/upload.js';
const [root, endpoint, mode] = process.argv.slice(2);
const context = { paths: new AgentPaths(root), agentId: AgentIdSchema.parse('agent-a'), mode: 'team', logger: { warn() {}, debug() {} } };
process.on('message', () => {});
async function pause() { await new Promise((resolve, reject) => process.send({ stage: mode }, (error) => error ? reject(error) : resolve())); await new Promise(() => {}); }
const rename = fs.rename; const unlink = fs.unlink;
fs.rename = async (source, target) => {
  if (mode === 'before-ledger' && target === context.paths.reportedSets) await pause();
  await rename(source, target);
  if (mode === 'after-ledger' && target === context.paths.reportedSets) await pause();
};
fs.unlink = async (path) => { if (mode === 'before-claim-cleanup' && path === context.paths.pendingUploads) await pause(); await unlink(path); };
const config = { routerEndpoint: endpoint, maintainerEndpoint: endpoint, keyEnv: '', timeoutMs: 1000, retryCount: 0, retryBaseDelayMs: 1, retryMaxDelayMs: 1 };
const team = new TeamFacade(config, context.agentId, context.logger);
await new UploadDelivery(context, team).deliver();
await team.close();
