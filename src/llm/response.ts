// 只识别显式推理结束边界后的完整对象；正文内标签和普通说明保持原样。
export function structuredResponseText(text: string): string {
  const trimmed = text.trim();
  if (/^(?:\{|\[|```)/u.test(trimmed)) return text;
  const marker = '</think>'; const end = trimmed.indexOf(marker);
  if (end < 0) return text;
  const suffix = trimmed.slice(end + marker.length).trim();
  const candidate = suffix.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu, '$1');
  try {
    const value: unknown = JSON.parse(candidate);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return candidate;
  } catch { /* 不抽取片段，也不修复不完整或歧义的响应。 */ }
  return text;
}
