// 保证 Claim 修订时间在时钟回拨或同秒编辑时仍严格递增。
import { normalizeTimestamp, timestampNanos } from '../protocol/time.js';

export function nextClaimUpdateAt(now: string, previous: string): string {
  const clock = timestampNanos(`${normalizeTimestamp(now).slice(0, 19)}Z`);
  const successor = timestampNanos(previous) + 1_000_000_000n;
  const nanos = clock > successor ? clock : successor;
  const seconds = nanos >= 0n ? nanos / 1_000_000_000n : (nanos - 999_999_999n) / 1_000_000_000n;
  const fraction = nanos - seconds * 1_000_000_000n;
  return normalizeTimestamp(`${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${fraction.toString().padStart(9, '0')}Z`);
}
