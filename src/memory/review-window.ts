// 有界窗口优先保留对话信号，工具输出不能挤掉最近的用户和助手正文。
interface Entry { type: string; text: string; truncated: boolean }

export function boundReviewWindow<T extends Entry>(input: readonly T[], maxChars: number): { entries: T[]; omitted: boolean } {
  const entries = input.map((entry) => ({ ...entry }));
  let chars = entries.reduce((total, entry) => total + Array.from(entry.text).length, 0);
  if (chars <= maxChars) return { entries, omitted: false };
  let user: T | undefined; let assistant: T | undefined;
  for (const entry of entries) { if (entry.type === 'user') user = entry; if (entry.type === 'assistant') assistant = entry; }
  const anchors = new Set([user, assistant].filter((entry): entry is T => entry !== undefined));
  const trim = (entry: T) => {
    if (chars <= maxChars) return;
    const text = Array.from(entry.text); const removed = Math.min(text.length, chars - maxChars);
    entry.text = text.slice(removed).join(''); entry.truncated = true; chars -= removed;
  };
  for (const entry of entries) if (entry.type !== 'user' && entry.type !== 'assistant') trim(entry);
  for (const entry of entries) if (!anchors.has(entry)) trim(entry);
  if (chars > maxChars) {
    // 单条对话也可能很长：给两个锚点各留片段，再将剩余额度分配给最新正文。
    const kept = [...anchors]; const limits = kept.map((entry) => Math.min(Array.from(entry.text).length, Math.floor(maxChars / kept.length)));
    let remaining = maxChars - limits.reduce((total, value) => total + value, 0);
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const entry = kept[index]; const limit = limits[index]; if (entry === undefined || limit === undefined) continue;
      const extra = Math.min(remaining, Array.from(entry.text).length - limit); limits[index] = limit + extra; remaining -= extra;
    }
    kept.forEach((entry, index) => { const text = Array.from(entry.text); const limit = limits[index] ?? 0; if (limit < text.length) { entry.text = text.slice(0, limit).join(''); entry.truncated = true; } });
  }
  return { entries: entries.filter((entry) => entry.text.length > 0), omitted: true };
}
