// 独立进程使用发布存储入口修改正文，验证其他进程的目录变更检测。
import { ClaimStore, AgentPaths } from '../../../lib/store.js';
import { AgentIdSchema } from '../../../lib/protocol.js';

const [root, id, name] = process.argv.slice(2);
if (root === undefined || id === undefined || name === undefined) throw new Error('Expected root, id and name.');
const store = new ClaimStore({ paths: new AgentPaths(root), agentId: AgentIdSchema.parse('agent-a'), mode: 'solo', logger: { warn() {}, debug() {} } });
const claim = await store.read(id);
await store.write({ ...claim, name });
