// 领域存储只接收所需的路径、身份和日志接口。
import type { AgentId } from '../protocol/ids.js';
import type { AgentPaths } from './paths.js';

export interface StoreLogger { warn(message: string): void; debug(message: string): void }
export interface StoreContext {
  paths: AgentPaths;
  agentId: AgentId;
  mode: 'solo' | 'team';
  logger: StoreLogger;
  lockTimeoutMs?: number;
}
