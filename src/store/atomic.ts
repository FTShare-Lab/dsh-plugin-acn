// 同目录独占临时文件、同步与 rename；清理只处理过期临时文件。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { StoreLogger } from './context.js';
import { hasCode, StoreError } from './errors.js';
import { renameFile } from './rename.js';

async function syncDirectory(path: string, logger: StoreLogger): Promise<void> {
  try {
    const directory = await fs.open(path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { logger.debug(`Parent directory sync unavailable: ${path}`); }
}

export async function writeTextAtomic(path: string, content: string, logger: StoreLogger): Promise<void> {
  await publishText(path, content, logger, false);
}

// 导入使用独占发布；已有目标连空文件也不覆盖。
export function writeTextAtomicIfAbsent(path: string, content: string, logger: StoreLogger): Promise<boolean> {
  return publishText(path, content, logger, true);
}
async function publishText(path: string, content: string, logger: StoreLogger, exclusive: boolean): Promise<boolean> {
  let temporary: string | undefined;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = join(dirname(path), `${basename(path)}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`);
      let file;
      try { file = await fs.open(candidate, 'wx', 0o600); }
      catch (error) { if (hasCode(error, 'EEXIST')) continue; throw error; }
      temporary = candidate;
      try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
      break;
    }
    if (temporary === undefined) throw new StoreError('io', 'Could not create an exclusive temporary file.');
    if (exclusive) {
      try { await fs.link(temporary, path); }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; await fs.unlink(temporary); return false; }
      await fs.unlink(temporary);
    } else await renameFile(temporary, path);
    await syncDirectory(dirname(path), logger);
    return true;
  } catch (error) {
    if (temporary !== undefined) await fs.rm(temporary, { force: true }).catch(() => { logger.debug(`Could not remove temporary file: ${temporary}`); });
    throw new StoreError('io', `Atomic write failed: ${path}`, { cause: error });
  }
}

export async function removeFile(path: string, logger: StoreLogger): Promise<void> {
  try { await fs.unlink(path); await syncDirectory(dirname(path), logger); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw new StoreError('io', `Cannot remove file: ${path}`, { cause: error }); }
}

export async function cleanupAtomicTemps(root: string, logger: StoreLogger, options: { olderThanMs?: number; nowMs?: number } = {}): Promise<number> {
  const cutoff = (options.nowMs ?? Date.now()) - (options.olderThanMs ?? 3_600_000);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (hasCode(error, 'ENOENT')) return 0; throw error; }
  let removed = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith('.lock')) removed += await cleanupAtomicTemps(path, logger, options);
    else if (entry.isFile() && entry.name.includes('.tmp.')) {
      try {
        if ((await fs.stat(path)).mtimeMs <= cutoff) { await removeFile(path, logger); removed += 1; }
      } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    }
  }
  return removed;
}
