// 独立进程用于竞争写入与可定位的强制终止测试。
import fs from 'node:fs/promises';
import { AgentIdSchema, ClaimSchema } from '../../../lib/protocol.js';
import { claimRevision } from '../../../lib/protocol.js';
import { AgentPaths, ClaimEditStore, ClaimStore, InboxStore, UploadStore, withFileLock } from '../../../lib/store.js';

const [root, mode, number = '0'] = process.argv.slice(2);
const context = { paths: new AgentPaths(root), agentId: AgentIdSchema.parse('agent-a'), mode: 'team', logger: { warn() {}, debug() {} } };
const send = (value) => new Promise((resolve, reject) => process.send(value, (error) => error ? reject(error) : resolve()));
const waitForever = () => { process.on('message', () => {}); return new Promise(() => {}); };
const claim = ClaimSchema.parse(JSON.parse(await fs.readFile(new URL('../../fixtures/protocol/claim-seconds.json', import.meta.url), 'utf8')));

try {
  if (mode === 'before-rename') {
    const original = fs.rename;
    fs.rename = async (source, destination) => {
      if (destination === context.paths.claim(claim.id)) { await send({ kind: 'prepared', temporary: source }); await waitForever(); }
      return original(source, destination);
    };
    await new ClaimStore(context).write({ ...claim, statement: 'replacement that must not become visible' });
  } else if (mode === 'hold-lock') {
    await withFileLock(context.paths.knowledgeLock, async () => { await send({ kind: 'locked' }); await waitForever(); });
  } else if (mode.startsWith('edit-')) {
    await withFileLock(context.paths.knowledgeLock, async () => {
      const target = ClaimSchema.parse({ ...claim, statement: 'landed edit', updated_at: '2026-10-21T01:00:00Z' });
      await new ClaimEditStore(context).write({ expected_revision: claimRevision(claim), target });
      if (mode !== 'edit-journal') await new ClaimStore(context).write(target);
      if (mode === 'edit-queue') await new UploadStore(context).enqueue([target], [], true);
      await send({ kind: 'edit-prepared' }); await waitForever();
    });
  } else if (mode === 'claim-write') {
    const statement = `writer-${number}:` + number.repeat(5000);
    await new ClaimStore(context).write({ ...claim, statement, evidence_summary: statement });
    await send({ kind: 'written' });
  } else if (mode === 'upload') {
    await new UploadStore(context).enqueue([ClaimSchema.parse({ ...claim, id: `claim_${Number(number).toString(16).padStart(8, '0')}` })], []);
    await send({ kind: 'queued' });
  } else if (mode === 'inbox-claim' || mode === 'inbox-crash') {
    const claimed = await new InboxStore(context).claimPending();
    await send({ kind: 'claimed', claimed });
    if (mode === 'inbox-crash') await waitForever();
  } else throw new Error('Unknown worker scenario.');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
