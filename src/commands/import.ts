// 导入先验证只读源快照，再逐文件独占发布；中断后重试只补缺失文件。
import fs from 'node:fs/promises';
import { openSingleFile } from '../store/regular-file.js';
import { expandHomePath } from '../store/paths.js';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import type { AcnKnowledge } from '../knowledge/service.js';
import { KnowledgeError } from '../knowledge/errors.js';
import { validateClaimText, textSafetyIssue } from '../knowledge/safety.js';
import { ClaimSchema } from '../protocol/claim.js';
import { TraceSchema } from '../protocol/trace.js';
import { ClaimIdSchema, TraceIdSchema } from '../protocol/ids.js';
import { decodeYaml } from '../store/yaml.js';
import { hasCode } from '../store/errors.js';
import { writeTextAtomicIfAbsent } from '../store/atomic.js';
import { MemoryFileStore } from '../store/memory.js';
import type { MemoryTexts } from '../store/memory.js';
import { withFileLock } from '../store/lock.js';
import { commandWords } from './claim.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
interface SourceFile { path: string; text: string; stamp: string }
export interface ImportReport { dryRun: boolean; claims: string[]; traces: string[]; memories: string[]; skipped: string[] }
function invalid(message: string): never { throw new KnowledgeError('validation', message); }
function stamp(info: Awaited<ReturnType<fs.FileHandle['stat']>>): string { return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }
async function directory(path: string, required = false): Promise<boolean> {
  try { const info = await fs.lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) invalid('Import directories must be regular directories, without symbolic links.'); return true; }
  catch (error) { if (!required && hasCode(error, 'ENOENT')) return false; throw error; }
}
async function readSource(path: string): Promise<SourceFile> {
  const file = await openSingleFile(path, () => new KnowledgeError('validation', 'Import accepts single-link regular UTF-8 files without symbolic links.'));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) invalid('Import accepts single-link regular UTF-8 files up to 16 MiB.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.readFile()); }
    catch (error) { if (error instanceof TypeError) invalid('Import source is not valid UTF-8.'); throw error; }
    const snapshot = stamp(before);
    if (snapshot !== stamp(await file.stat())) invalid('Import source changed while reading; stop source writers and retry.');
    return { path, text, stamp: snapshot };
  } finally { await file.close(); }
}
async function entities<T extends { id: string }>(root: string, name: string, schema: z.ZodType<T>, idSchema: z.ZodType<string>): Promise<{ file: SourceFile; value: T }[]> {
  const path = join(root, name); if (!await directory(path)) return [];
  const values: { file: SourceFile; value: T }[] = [];
  for (const entry of (await fs.readdir(path)).sort()) {
    if (!entry.endsWith('.yaml') || entry.includes('.tmp.')) continue;
    const id = entry.slice(0, -5); if (!idSchema.safeParse(id).success) invalid(`Invalid ${name} filename in import source.`);
    const file = await readSource(join(path, entry));
    let value: T;
    try { value = decodeYaml(schema, file.text); } catch { invalid(`Invalid ${name} document in import source.`); }
    if (value.id !== id) invalid(`Import ${name} ID differs from its filename.`);
    values.push({ file, value });
  }
  return values;
}
function inside(parent: string, child: string): boolean { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); }
export async function importCommand(knowledge: AcnKnowledge, input: string, readOnly: boolean, signal?: AbortSignal): Promise<ImportReport> {
  if (readOnly) throw new KnowledgeError('ownership', 'Subagents cannot import private knowledge.');
  const words = commandWords(input, process.platform === 'win32'); const options = new Set(words.filter((word) => word.startsWith('--')));
  const paths = words.filter((word) => !word.startsWith('--'));
  if (paths.length !== 1 || paths[0] === '' || [...options].some((option) => !['--dry-run', '--without-memory'].includes(option))) invalid('Usage: /acn-import [--dry-run] [--without-memory] <acn_agent_home>');
  const inputPath = paths[0] ?? '';
  const source = resolve(expandHomePath(inputPath)); await directory(source, true);
  const context = knowledge.context(); const canonical = await fs.realpath(source);
  // 目标可能尚未创建；逐级 realpath 保留不存在的末尾，避免父目录别名绕过重叠检查。
  async function actual(path: string): Promise<string> { try { return await fs.realpath(path); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; const parent = resolve(path, '..'); if (parent === path) throw error; return join(await actual(parent), basename(path)); } }
  const target = await actual(context.paths.root);
  if (inside(canonical, target) || inside(target, canonical)) invalid('Import source and target must be separate directories.');
  const claims = await entities(source, 'claims', ClaimSchema, ClaimIdSchema);
  const traces = await entities(source, 'traces', TraceSchema, TraceIdSchema);
  for (const { value } of claims) {
    if (value.holder !== context.agentId) throw new KnowledgeError('ownership', 'Import contains a Claim held by another agent.');
    validateClaimText({ name: value.name, statement: value.statement, scope: value.scope, evidence_summary: value.evidence_summary });
  }
  for (const { value } of traces) if (value.agent !== context.agentId) throw new KnowledgeError('ownership', 'Import contains a Trace owned by another agent.');
  const memoryFiles: Partial<Record<keyof MemoryTexts, SourceFile>> = {};
  if (!options.has('--without-memory') && knowledge.config.memory.enabled && await directory(join(source, 'memories'))) {
    if (claims.length === 0 && traces.length === 0 && basename(source) !== context.agentId) throw new KnowledgeError('ownership', 'A private-only source directory must be named after the current agentId.');
    for (const [key, name] of [['memory', 'MEMORY.md'], ['user', 'USER.md']] as const) {
      try { memoryFiles[key] = await readSource(join(source, 'memories', name)); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      const file = memoryFiles[key]; if (file === undefined) continue;
      if (knowledge.config.memory.safetyScan && textSafetyIssue(file.text) !== null) throw new KnowledgeError('safety', 'Imported private Memory failed the safety scan.');
      if (Array.from(file.text).length > (key === 'memory' ? knowledge.config.memory.memoryCharLimit : knowledge.config.memory.userCharLimit)) invalid('Imported private Memory exceeds the configured character limit; adjust the limit or use --without-memory.');
    }
  }
  const allFiles = [...claims.map((item) => item.file), ...traces.map((item) => item.file), ...Object.values(memoryFiles)];
  if (allFiles.length === 0) invalid('No importable data found. Pass the agent directory containing claims/, traces/ or memories/.');
  for (const file of allFiles) if (file.stamp !== stamp(await fs.lstat(file.path))) invalid('Import source changed; stop source writers and retry.');
  const report: ImportReport = { dryRun: options.has('--dry-run'), claims: [], traces: [], memories: [], skipped: [] };
  const publish = async (path: string, text: string): Promise<boolean> => {
    if (!report.dryRun) return writeTextAtomicIfAbsent(path, text, context.logger);
    try { await fs.lstat(path); return false; } catch (error) { if (hasCode(error, 'ENOENT')) return true; throw error; }
  };
  const apply = async (): Promise<void> => {
    for (const name of ['claims', 'traces', 'memories']) await directory(join(context.paths.root, name));
    for (const [items, category] of [[claims, 'claims'], [traces, 'traces']] as const) {
      for (const { file, value } of items) {
        signal?.throwIfAborted();
        const created = await publish(join(context.paths[category], `${value.id}.yaml`), file.text);
        (created ? report[category] : report.skipped).push(created ? value.id : `${category}/${value.id}`);
      }
    }
    const texts: Partial<MemoryTexts> = Object.fromEntries(Object.entries(memoryFiles).map(([key, file]) => [key, file.text]));
    if (!report.dryRun && Object.keys(texts).length > 0) {
      const memory = await new MemoryFileStore(context).importAbsent(texts, signal);
      report.memories.push(...memory.imported); report.skipped.push(...memory.skipped.map((key) => `memories/${key}`));
    } else for (const key of ['memory', 'user'] as const) if (texts[key] !== undefined) {
      const created = await publish(context.paths[key], texts[key]);
      (created ? report.memories : report.skipped).push(created ? key : `memories/${key}`);
    }
  };
  if (report.dryRun) await apply();
  else {
    await knowledge.initialize();
    await withFileLock(context.paths.knowledgeLock, apply, { signal, timeoutMs: context.lockTimeoutMs });
  }
  return report;
}
export function renderImportReport(report: ImportReport): string {
  return `${report.dryRun ? '导入预览（未写入）' : '导入完成'}：Claim ${report.claims.length}；Trace ${report.traces.length}；私有文件 ${report.memories.length}。\n${report.skipped.length === 0 ? '没有冲突。' : `已跳过 ${report.skipped.length} 个已有目标：${report.skipped.join(', ')}`}\n源目录保持只读；导入不会加入团队上传队列。私有 Memory 在新会话中生效。`;
}
