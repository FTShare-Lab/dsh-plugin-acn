// 后台任务的版本化文件存储；调度与状态转换在 worker 阶段实现。
import type { StoreContext } from './context.js';
import { VersionedFileStore } from './session-state.js';

export class JobStore extends VersionedFileStore {
  constructor(context: StoreContext) { super(context, (id) => context.paths.job(id)); }
}
