// 独立进程只通过共享队列写入暂停请求，无法调用持有者的进程内取消控制器。
import { AgentIdSchema } from '../../../lib/protocol.js';
import { AgentPaths } from '../../../lib/store.js';
import { JobQueue } from '../../../lib/formation.js';
const [root] = process.argv.slice(2);
await new JobQueue({ paths: new AgentPaths(root), agentId: AgentIdSchema.parse('agent-a'), mode: 'solo', logger: { warn() {}, debug() {} } }).pauseDream(true);
