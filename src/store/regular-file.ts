// 在缺少 O_NOFOLLOW 的平台同样检查路径与已打开文件的身份；不接受别名或特殊文件。
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
export async function openSingleFile(path: string, invalid: () => Error): Promise<fs.FileHandle> {
  const before = await fs.lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw invalid();
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat(); const current = await fs.lstat(path);
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || before.dev !== opened.dev || before.ino !== opened.ino || current.dev !== opened.dev || current.ino !== opened.ino) throw invalid();
    return file;
  } catch (error) { await file.close(); throw error; }
}
