// 宿主事件只投影必要正文；私有记忆工具、系统指令和压缩替换不进入复盘。
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { ClaimSchema } from '../protocol/claim.js';
import { PolicySchema } from '../protocol/policy.js';
import type { Projection } from '../formation/transcript.js';

function text(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => block.type === 'text' ? block.text : `[${block.type}]`).join('\n');
}
function bodySources(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => bodySources(item));
  if (typeof value !== 'object' || value === null) return [];
  const claim = ClaimSchema.safeParse(value);
  if (claim.success) return [claim.data.id];
  const policy = PolicySchema.safeParse(value);
  if (policy.success) return [policy.data.id];
  return Object.values(value).flatMap((item: unknown) => bodySources(item));
}
function projectContent(event: SessionEvent): Projection {
  switch (event.type) {
    case 'request/header': return { route: { provider: event.data.header.config.provider, model: event.data.header.config.model } };
    case 'user/message':
      if (event.data.source.kind === 'acn-claim-changes' || event.surfaceOp !== 'append' || 'form' in event.data.source && (event.data.source.form === 'instructions' || event.data.source.form === 'catalog')) return {};
      return { entry: { seq: event.seq, type: 'user', text: text(event.data.content) } };
    case 'assistant/message': return { entry: { seq: event.seq, type: 'assistant', text: text(event.data.message.content.filter((block) => block.type === 'text')) } };
    case 'tool/call':
      // 程序封装可能携带私有调用和回显；只投影其实际公共子调用，不保存整段程序。
      if (event.data.name === 'memory' || event.data.name === 'run_code') return { privateCallId: event.data.callId };
      return { entry: { seq: event.seq, type: 'tool_call', text: JSON.stringify({ name: event.data.name, arguments: event.data.arguments }) } };
    case 'tool/ptc-dispatch-start':
      if (event.data.name === 'memory' || event.data.name === 'run_code') return {};
      return { entry: { seq: event.seq, type: 'tool_call', text: JSON.stringify({ name: event.data.name, arguments: event.data.arguments }) } };
    case 'tool/ptc-dispatch': {
      if (event.data.name === 'memory' || event.data.name === 'run_code') return {};
      const content = text(event.data.content); let seenSourceIds: string[] = [];
      try { seenSourceIds = bodySources(JSON.parse(content)); } catch { /* 非 JSON 工具正文没有可验证的实体。 */ }
      return { seenSourceIds, entry: { seq: event.seq, type: 'tool_result', text: Array.from(content).slice(0, 4000).join('') } };
    }
    case 'tool/result': {
      const content = text(event.data.message.content);
      let seenSourceIds: string[] = [];
      try { seenSourceIds = bodySources(JSON.parse(content)); } catch { /* 非 JSON 工具正文没有可验证的实体。 */ }
      return { resultCallId: event.data.message.toolCallId, seenSourceIds, entry: { seq: event.seq, type: 'tool_result', text: Array.from(content).slice(0, 4000).join('') } };
    }
    default: return {};
  }
}
export function projectEvent(event: SessionEvent): Projection {
  const projection = projectContent(event);
  if (event.type === 'turn/start' || event.type === 'turn/end') return { ...projection, activity: {
    seq: event.seq, at: event.time,
    turn: event.type === 'turn/start' ? 'start' : event.data.reason.kind === 'completed' ? 'completed' : 'ended',
  } };
  if (projection.entry !== undefined) return { ...projection, activity: { seq: event.seq, at: event.time,
    ...(event.type === 'user/message' && event.data.source.kind === 'user' && event.surfaceOp === 'append' ? { human: true } : {}),
  } };
  return projection;
}
const compactionSchema = z.object({ type: z.literal('compaction/summary'), data: z.object({ shadowedRange: z.object({ end: z.number().int().nonnegative() }), shadowedSeqs: z.array(z.number().int().nonnegative()).optional() }) });
export function compactionEnd(event: unknown): number | undefined {
  const parsed = compactionSchema.safeParse(event);
  // shadowedRange 是 surface 顺序，重复压缩后起点可大于终点；seq 最大值才是数值游标。
  return parsed.success ? Math.max(parsed.data.data.shadowedRange.end, ...parsed.data.data.shadowedSeqs ?? []) : undefined;
}
