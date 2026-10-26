// 用户命令只调用领域接口，不执行 Shell；带空格的修订值由引号包围。
import { ClaimIdSchema } from '../protocol/ids.js';
import { KnowledgeError, RevisionConflict } from '../knowledge/errors.js';
import type { AcnKnowledge } from '../knowledge/service.js';

export function commandWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | undefined;
  let escaped = false;
  let started = false;
  for (const char of input) {
    if (escaped) { current += char; escaped = false; started = true; }
    else if (char === '\\') { escaped = true; started = true; }
    else if (quote !== undefined) { if (char === quote) quote = undefined; else current += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/u.test(char)) { if (started) words.push(current); current = ''; started = false; }
    else { current += char; started = true; }
  }
  if (quote !== undefined || escaped) throw new KnowledgeError('validation', 'Unclosed command quote or escape.');
  if (started) words.push(current);
  return words;
}

export async function claimCommand(knowledge: AcnKnowledge, input: string, readOnly: boolean, signal?: AbortSignal): Promise<string> {
  const words = commandWords(input.trim());
  const action = words[0];
  if (action === 'show') {
    if (words.length !== 2) throw new KnowledgeError('validation', 'Usage: /claim show <id>');
    return JSON.stringify(await knowledge.readClaim(ClaimIdSchema.parse(words[1])), null, 2);
  }
  if (action === 'set') {
    if (readOnly) throw new KnowledgeError('ownership', 'Subagents cannot modify ACN knowledge.');
    if (words.length < 3) throw new KnowledgeError('validation', 'Usage: /claim set <id> <field>=<value> ...');
    const id = ClaimIdSchema.parse(words[1]);
    const fields: Record<string, string> = {};
    for (const word of words.slice(2)) {
      const separator = word.indexOf('=');
      const field = word.slice(0, separator);
      if (separator < 1 || !['name', 'statement', 'scope', 'evidence_summary', 'confidence', 'status'].includes(field) || field in fields) throw new KnowledgeError('validation', 'Use each editable Claim field at most once.');
      fields[field] = word.slice(separator + 1);
    }
    const detail = await knowledge.readClaim(id);
    return JSON.stringify(await knowledge.updateClaim({ ...fields, id, expected_revision: detail.revision }, signal), null, 2);
  }
  const query: string[] = [];
  let offset = 0;
  let limit = 20;
  let includeDeprecated = false;
  const listWords = action === 'list' ? words.slice(1) : words;
  for (let index = 0; index < listWords.length; index += 1) {
    const word = listWords[index];
    if (word === '--include-deprecated') includeDeprecated = true;
    else if (word === '--offset' || word === '--limit') {
      const number = Number(listWords[index + 1]);
      if (word === '--offset') offset = number; else limit = number;
      index += 1;
    } else if (word !== undefined && word.startsWith('--')) throw new KnowledgeError('validation', 'Unknown Claim list option.');
    else if (word !== undefined) query.push(word);
  }
  const result = await knowledge.listClaims({ query: query.join(' '), offset, limit, includeDeprecated });
  const rows = result.items.map((item) => `${item.id} | ${JSON.stringify(item.name.text)} | ${JSON.stringify(item.scope.text)} | ${item.confidence} | ${item.status}`);
  if (rows.length === 0) rows.push('没有匹配的 Claim。');
  if (result.next_offset !== null) rows.push(`另有 ${result.omitted} 条；下一页：/claim list ${JSON.stringify(query.join(' '))} --offset ${result.next_offset} --limit ${result.limit}${includeDeprecated ? ' --include-deprecated' : ''}`);
  return rows.join('\n');
}
export function commandDomainError(error: unknown): string | undefined {
  if (error instanceof RevisionConflict) return `Claim 已改变，请重新读取。当前 revision: ${error.currentRevision}`;
  if (error instanceof KnowledgeError) return error.message;
  return undefined;
}
