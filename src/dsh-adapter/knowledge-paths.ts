// 普通文件能力不能读取私有 Agent 根，避免从快照、回执或别名绕过领域工具。
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { FsTarget } from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { createHash } from 'node:crypto';
import type { AcnKnowledge } from '../knowledge/service.js';
import { expandHomePath } from '../store/paths.js';
import { hasCode } from '../store/errors.js';

const fileTools = new Set(['read', 'read_image', 'write', 'edit', 'grep', 'glob', 'str_replace_editor']);
const denial = '普通文件工具不能访问私有 Agent 数据或包含它的搜索根；请使用 Claim 专用工具，或缩小搜索目录。';
const fingerprint = (execution: Readonly<ToolExecution>): string => createHash('sha256').update(JSON.stringify(execution.arguments) ?? 'undefined').digest('hex');
async function* linkedFiles(root: string, signal: AbortSignal): AsyncGenerator<string> {
  const directories = [root];
  while (directories.length > 0) {
    signal.throwIfAborted(); const directory = directories.pop(); if (directory === undefined) break;
    let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error; }
    for (const entry of entries) {
      signal.throwIfAborted();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile()) { try { const info = await fs.lstat(path); if (info.nlink > 1) yield `${info.dev}:${info.ino}`; } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; } }
    }
  }
}
export function protectKnowledgePaths(ctx: Context, knowledge: AcnKnowledge): void {
  const privateHome = resolve(expandHomePath(knowledge.config.home));
  const privateAlias = async (path: string, recursive: boolean, signal: AbortSignal) => {
    const privateLinks = new Set<string>();
    for await (const identity of linkedFiles(privateHome, signal)) privateLinks.add(identity);
    if (privateLinks.size === 0) return false;
    if (recursive) { for await (const identity of linkedFiles(path, signal)) if (privateLinks.has(identity)) return true; }
    else { const info = await fs.lstat(path); return privateLinks.has(`${info.dev}:${info.ino}`); }
    return false;
  };
  const validated = new WeakMap<object, { fingerprint: string; cwd: string }>();
  const targetAllowed = async (target: FsTarget, recursive: boolean, signal?: AbortSignal): Promise<boolean> => {
    const mapped = ctx.fs.processPathFromHostPath(resolve(expandHomePath(knowledge.config.home))); if (mapped === undefined) return true;
    const root = await ctx.fs.resolve(mapped, signal === undefined ? {} : { signal });
    return !ctx.fs.contains(root, target) && !(recursive && ctx.fs.contains(target, root));
  };
  ctx.on('fs/write-intent', async (target, _actor, next) => { if (!await targetAllowed(target, false)) throw new Error(denial); return next(); });
  ctx.on('fs/edit-intent', async (target, _actor, next) => { if (!await targetAllowed(target, false)) throw new Error(denial); return next(); });
  ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next(); if (decision.kind === 'deny' || decision.kind === 'cancel' || !fileTools.has(execution.name)) return decision;
    const args = execution.arguments; if (typeof args !== 'object' || args === null || Array.isArray(args)) return { kind: 'deny', reason: denial };
    const fields = args as Record<string, unknown>; const search = execution.name === 'grep' || execution.name === 'glob';
    const key = 'file_path' in fields ? 'file_path' : 'path' in fields || search ? 'path' : undefined;
    if (key === undefined || fields[key] !== undefined && typeof fields[key] !== 'string') return { kind: 'deny', reason: denial };
    const cwd = execution.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(execution.agent, execution.signal);
    const target = await ctx.fs.resolve(typeof fields[key] === 'string' ? fields[key] : cwd, { cwd, signal: execution.signal });
    const info = await ctx.fs.stat(target, execution.signal);
    if (!await targetAllowed(target, search || info?.type === 'directory', execution.signal)) return { kind: 'deny', reason: denial };
    const path = ctx.fs.processPath(target);
    // 仅拒绝指向私有数据的硬链接，普通项目和构建产物的硬链接不影响搜索。
    if (ctx.fs.processPathFromHostPath(resolve(path)) === path) {
      try { const stat = await fs.lstat(path); if ((stat.isFile() && stat.nlink > 1 || search && stat.isDirectory()) && await privateAlias(path, search && stat.isDirectory(), execution.signal)) return { kind: 'deny', reason: denial }; }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    }
    // 宿主冻结工具参数，不能重写相对路径；最终门禁同时检查实际 cwd 未发生变化。
    validated.set(execution, { fingerprint: fingerprint(execution), cwd }); return decision;
  });
  ctx.tools.guard((execution) => {
    if (!fileTools.has(execution.name)) return;
    const approved = validated.get(execution); const cwd = execution.agent === undefined ? process.cwd() : ctx.workingDirectory.get(execution.agent.session);
    return approved?.fingerprint !== fingerprint(execution) || approved.cwd !== cwd ? denial : undefined;
  });
}
