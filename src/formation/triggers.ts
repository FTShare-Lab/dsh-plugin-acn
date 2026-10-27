// 空闲门槛只计算尚未提交的投影与已完成人类轮次，不依赖页面或进程存活时间。
import type { ResolvedConfig } from '../config.js';
import { processedThrough } from './transcript.js';
import type { FormationState, TranscriptEntry } from './transcript.js';

export function idleTrigger(config: ResolvedConfig['formation'], state: FormationState, entries: readonly TranscriptEntry[], now: number): 'batch-idle' | 'tail-idle' | undefined {
  if (!config.idleRecap || state.autoPaused || state.archiveIntent !== null || state.activityAt === 0) return;
  const cursor = processedThrough(state);
  const pending = entries.filter((entry) => entry.seq > cursor);
  if (!pending.some((entry) => entry.text.trim() !== '')) return;
  const elapsed = now - state.activityAt;
  const turns = state.completedTurns.filter((end) => end > cursor).length;
  // 仅用于批处理门槛的近似估算，不代表模型账单或上下文精确容量。
  const tokens = Math.ceil(pending.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text, 'utf8'), 0) / 4);
  if ((turns >= config.recapMinTurns || tokens >= config.recapMinTokens) && elapsed >= config.recapBatchIdleMinutes * 60_000) return 'batch-idle';
  if (elapsed >= config.recapTailIdleMinutes * 60_000) return 'tail-idle';
}
