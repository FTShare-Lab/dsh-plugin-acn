// 普通文件能力不能读取私有 Agent 根，避免从快照、回执或别名绕过双文件工具。
import fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { FsTarget } from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { createHash } from 'node:crypto';
import type { AcnKnowledge } from '../knowledge/service.js';
import { agentHomePath } from '../store/paths.js';
import { hasCode } from '../store/errors.js';

const fileTools = new Set(['read', 'read_image', 'write', 'edit', 'grep', 'glob', 'str_replace_editor']);
const denial = '普通文件工具不能访问私有 Agent 数据或包含它的搜索根；请使用 Claim/Memory 专用工具，或缩小搜索目录。';
const fingerprint = (execution: Readonly<ToolExecution>): string => createHash('sha256').update(JSON.stringify(execution.arguments) ?? 'undefined').digest('hex');
async function searchHasAliases(root: string, signal: AbortSignal): Promise<boolean> {
  const directories = [root]; let inspected = 0;
  while (directories.length > 0) {
    signal.throwIfAborted(); const directory = directories.pop(); if (directory === undefined) break;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted(); inspected += 1; if (inspected > 100_000) return true;
      const path = join(directory, entry.name);
      // 搜索器不跟随符号链接；硬链接需要在递归搜索开始前显式拒绝。
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && (await fs.lstat(path)).nlink !== 1) return true;
    }
  }
  return false;
}
export function protectMemoryPaths(ctx: Context, knowledge: AcnKnowledge): void {
  const validated = new WeakMap<object, { fingerprint: string; cwd: string }>();
  const targetAllowed = async (target: FsTarget, recursive: boolean, signal?: AbortSignal): Promise<boolean> => {
    const mapped = ctx.fs.processPathFromHostPath(dirname(dirname(agentHomePath(knowledge.config.home, 'private-root')))); if (mapped === undefined) return true;
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
    // 同机文件的硬链接不由 canonical containment 识别，保守拒绝多链接普通文件。
    if (ctx.fs.processPathFromHostPath(resolve(path)) === path) {
      try { const stat = await fs.lstat(path); if (stat.isFile() && stat.nlink !== 1 || search && stat.isDirectory() && await searchHasAliases(path, execution.signal)) return { kind: 'deny', reason: denial }; }
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
