// 直接执行包的 JavaScript 入口，避免 Windows .cmd 启动依赖 shell 转义。
import { access } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
export async function cliCommand(name, args = []) {
  if (/\.(?:mjs|cjs|js)$/i.test(name)) return [process.execPath, [name, ...args]];
  if (name === 'pnpm' && process.env.npm_execpath) return [process.execPath, [process.env.npm_execpath, ...args]];
  if (process.platform !== 'win32' || /\.exe$/i.test(name)) return [name, args];
  const packagePath = name === 'pnpm' ? ['pnpm', 'bin', 'pnpm.cjs'] : ['@deepseek-ai', 'dsh', 'lib', 'bin.js'];
  const dirs = isAbsolute(name) ? [dirname(name)] : (process.env.PATH ?? '').split(delimiter);
  for (const dir of dirs) {
    const entry = join(dir, 'node_modules', ...packagePath);
    try { await access(entry); return [process.execPath, [entry, ...args]]; } catch { /* 尝试下一个全局包目录。 */ }
  }
  throw new Error(`Cannot resolve ${name} on Windows. Set DSH_BIN to the installed dsh lib/bin.js entry.`);
}
