// 工作区内的普通文本文件才可查证；排除私有目录、凭据、符号链接与硬链接。
import fs from 'node:fs/promises';
import { openSingleFile } from '../store/regular-file.js';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { requireDream, DreamValidationError } from './schema.js';
import type { Receipt } from './evidence.js';
import { hasCode } from '../store/errors.js';

export const within = (root: string, path: string): boolean => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
// 文件名和每层目录名共用规则；覆盖单复数凭据名称，保留词边界以免误拦 tokenizer 等普通源码。
const blocked = (part: string): boolean => part.startsWith('.') || /^(?:memory\.md|user\.md|export_env\.sh|node_modules|memories)$/i.test(part) || /(?:^|[._-])(?:secrets?|credentials?|private[-_]?keys?|tokens?)(?:[._-]|$)/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part);
export async function authorizeFile(workspace: string, privateHome: string, input: string): Promise<string> {
  requireDream(isAbsolute(workspace) && relative(await fs.realpath(workspace), workspace) === '', '查证工作区已变化。');
  const path = resolve(workspace, input);
  requireDream(within(workspace, path) && !within(await fs.realpath(privateHome), path), '查证路径必须位于工作区且不能进入私有数据目录。');
  const parts = relative(workspace, path).split(sep);
  requireDream(parts.every((part) => part !== '' && !blocked(part)) && !blocked(basename(workspace)), '查证不能读取私有、隐藏或凭据路径。');
  let current = workspace;
  for (const part of parts) { current = resolve(current, part); requireDream(!(await fs.lstat(current)).isSymbolicLink(), '查证不跟随符号链接。'); }
  requireDream(relative(await fs.realpath(path), path) === '', '查证文件路径已变化。'); return path;
}
export async function readEvidenceFile(workspace: string, privateHome: string, input: string, maxBytes: number): Promise<{ path: string; content: string; revision: Receipt['output']['file_version']['revision'] }> {
  const path = await authorizeFile(workspace, privateHome, input);
  const file = await openSingleFile(path, () => new DreamValidationError('查证仅接受单链接普通文件，不跟随符号链接。'));
  try {
    const before = await file.stat();
    requireDream(before.isFile() && before.nlink === 1 && before.size <= maxBytes, '查证仅接受预算内的单链接普通文件。');
    // 固定长度读取避免文件在读取中增长造成无界分配；多读一字节可识别并发增长。
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, length); if (read.bytesRead === 0) break; length += read.bytesRead; }
    const after = await file.stat(); const current = await fs.lstat(path);
    requireDream(length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === current.ino && before.dev === current.dev && after.nlink === 1 && !current.isSymbolicLink(), '查证读取期间文件发生变化。');
    await authorizeFile(workspace, privateHome, input);
    const bytes = buffer.subarray(0, length); let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new DreamValidationError('查证仅接受 UTF-8 文本。'); }
    requireDream(!content.includes('\0'), '查证不读取二进制内容。');
    return { path, content, revision: { sha256: createHash('sha256').update(bytes).digest('hex'), byte_len: length } };
  } finally { await file.close(); }
}
export async function receiptCurrent(receipt: Receipt, workspace: string, privateHome: string): Promise<boolean> {
  try {
    const { path, revision } = receipt.output.file_version;
    if (path !== receipt.input.path) return false;
    const file = await readEvidenceFile(workspace, privateHome, path, revision.byte_len);
    return file.revision.sha256 === revision.sha256 && file.revision.byte_len === revision.byte_len;
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR') || hasCode(error, 'ELOOP') || error instanceof DreamValidationError) return false;
    // 校验失败表示过期；真实 I/O 故障必须阻止恢复，不能当作可忽略的缺失。
    throw error;
  }
}
export function discoverable(name: string): boolean { return !blocked(name); }
