// 私有工具只允许主会话使用；领域失败返回规范值，基础设施错误交给宿主处理。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AcnMemory } from '../memory/service.js';
import { MemoryArgsSchema, MemoryError } from '../memory/operations.js';
import { isSubagent } from '../tools/subagent.js';

export function memoryTool(memory: AcnMemory): ToolDefinition {
  const tool = defineTool({ name: 'memory', description: '用 ops 批量 add/replace/remove 私有长期条目。target=user 保存稳定用户偏好，target=memory 保存稳定环境和可复用经验。不要记录任务进度、日志、测试结果、凭据或短期事实。replace/remove 的 old_text 必须唯一定位整条条目，替换整条而非局部字符；entry/new_text 不能含 §。重复 add 为成功 no-op。工具立即写磁盘，当前会话冻结快照不变，结果返回最新目标条目。私有内容不作为 Claim 来源，不上传团队。', parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args, exec) => {
    if (exec.agent === undefined || isSubagent(exec.agent.session.header)) return { success: false, error: 'Only a primary agent session may modify private Memory.' };
    try { return { success: true, ...await memory.apply(args, { id: createHash('sha256').update(`${exec.agent.session.id}:${exec.callId}`).digest('hex'), signal: exec.signal }) }; }
    catch (error) { if (error instanceof MemoryError) return { success: false, error: error.message, ...error.details }; if (error instanceof z.ZodError) return { success: false, error: 'Invalid Memory operations.' }; throw error; }
  } });
  return { ...tool, parameters: z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(z.toJSONSchema(MemoryArgsSchema)))) };
}
