// 保留纳秒与闰秒表示，并按 UTC AutoSi 规则序列化时间。
import { z } from 'zod';

const billion = 1_000_000_000n;
const pattern = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

function parts(input: string): { seconds: bigint; nanos: bigint; leap: boolean } {
  const match = pattern.exec(input);
  if (match === null) throw new Error('Expected an RFC 3339 timestamp.');
  const [, yearText = '', monthText = '', dayText = '', hourText = '', minuteText = '', secondText = '', fraction = '', zone = ''] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) throw new Error('Incomplete timestamp.');
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 60) throw new Error('Invalid calendar timestamp.');
  const offsetHour = zone.length > 1 ? Number(zone.slice(1, 3)) : 0;
  const offsetMinute = zone.length > 1 ? Number(zone.slice(4, 6)) : 0;
  if (offsetHour > 23 || offsetMinute > 59) throw new Error('Invalid timestamp offset.');
  const offset = (zone.startsWith('-') ? -1 : 1) * (offsetHour * 3600 + offsetMinute * 60);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  const epochMs = date.getTime();
  if (!Number.isFinite(epochMs)) throw new Error('Timestamp is outside the supported calendar range.');
  return { seconds: BigInt(epochMs / 1000 - offset), nanos: BigInt(fraction.slice(0, 9).padEnd(9, '0')), leap: second === 60 };
}

export function normalizeTimestamp(input: string): string {
  const value = parts(input);
  const date = new Date(Number(value.seconds) * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error('Timestamp is outside the supported calendar range.');
  const pad = (number: number) => String(number).padStart(2, '0');
  const year = date.getUTCFullYear();
  // 参考实现不能读回扩展年份，拒绝生成这种持久化文本。
  if (year < 0 || year > 9999) throw new Error('UTC year must remain within four digits.');
  const yearText = String(year).padStart(4, '0');
  const fractionLength = value.nanos === 0n ? 0 : value.nanos % 1_000_000n === 0n ? 3 : value.nanos % 1000n === 0n ? 6 : 9;
  const fraction = fractionLength === 0 ? '' : `.${value.nanos.toString().padStart(9, '0').slice(0, fractionLength)}`;
  return `${yearText}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${value.leap ? '60' : pad(date.getUTCSeconds())}${fraction}Z`;
}

export function timestampNanos(input: string): bigint {
  const value = parts(input);
  return value.seconds * billion + value.nanos + (value.leap ? billion : 0n);
}

export function nowSeconds(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

export const TimestampSchema = z.string().transform((value, ctx) => {
  try { return normalizeTimestamp(value); }
  catch { ctx.addIssue({ code: 'custom', message: 'Invalid RFC 3339 timestamp.' }); return z.NEVER; }
});
