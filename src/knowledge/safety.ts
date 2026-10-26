// 写入长期知识前拒绝不可见控制符和明确的指令劫持、凭据外传模式。
import { KnowledgeError } from './errors.js';

const invisibleRanges: readonly (readonly [number, number])[] = [
  [0, 31], [127, 159], [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x06dd, 0x06dd], [0x070f, 0x070f],
  [0x0890, 0x0891], [0x08e2, 0x08e2], [0x180e, 0x180e], [0x1bca, 0x1bcd], [0x1d173, 0x1d17a],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0100, 0xe01ef],
];
function invisible(value: string): boolean {
  return Array.from(value).some((char) => {
    if (['\t', '\n', '\r'].includes(char)) return false;
    const point = char.codePointAt(0);
    return point !== undefined && invisibleRanges.some(([first, last]) => point >= first && point <= last);
  });
}
const patterns: readonly (readonly string[])[] = [
  ['ignore', 'instructions'], ['you are now'], ['do not tell', 'user'], ['system prompt', 'override'],
  ['override', 'previous', 'rules'], ['disregard', 'instructions'], ['disregard', 'rules'],
  ['act as if', 'no', 'restrictions'], ['act as though', 'no', 'rules'],
  ...['key', 'token', 'secret', 'password', 'credential'].map((term) => ['curl', '$', term]),
  ['curl', 'api_key'], ['curl', 'token='],
  ...['key', 'token', 'secret'].map((term) => ['wget', '$', term]),
  ...['.env', 'credentials', 'id_rsa', '.netrc', '.npmrc', '.pypirc'].map((term) => ['curl', term]),
  ...['.env', 'credentials', 'id_rsa'].map((term) => ['wget', term]),
  ...['.env', 'credentials', '.netrc', '.pgpass', '.npmrc', '.pypirc', 'id_rsa', '.aws/config'].map((term) => ['cat', term]),
  ['authorized_keys'], ['$home/.ssh'], ['~/.ssh'],
];
export function validateClaimText(fields: Record<string, string>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (value.trim() === '') throw new KnowledgeError('validation', `Claim ${field} must not be empty.`);
    if (textSafetyIssue(value) !== null) {
      throw new KnowledgeError('safety', `Claim ${field} failed the safety scan.`);
    }
  }
}
export function textSafetyIssue(value: string): 'invisible_unicode' | 'threat_pattern' | null {
  if (invisible(value)) return 'invisible_unicode';
  const normalized = value.toLowerCase().replace(/\s/gu, ' ').replace(/ +/g, ' ');
  return patterns.some((terms) => terms.every((term) => normalized.includes(term))) ? 'threat_pattern' : null;
}
