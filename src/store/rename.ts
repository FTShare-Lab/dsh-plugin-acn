// Windows 扫描程序可能短暂占用文件；仅重试原子 rename，不删除或复制目标。
import fs from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { hasCode } from './errors.js';

export async function renameFile(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].some((code) => hasCode(error, code))) throw error;
      await setTimeout(10 * 2 ** attempt);
    }
  }
}
