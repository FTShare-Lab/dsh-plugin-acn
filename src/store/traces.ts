// 本地 Trace 文件存储；不参与团队上传。
import { TraceSchema, type Trace } from '../protocol/trace.js';
import { TraceIdSchema } from '../protocol/ids.js';
import type { StoreContext } from './context.js';
import { EntityStore } from './entities.js';

export class TraceStore extends EntityStore<Trace> {
  constructor(context: StoreContext) { super(context, context.paths.traces, TraceSchema, TraceIdSchema); }
}
