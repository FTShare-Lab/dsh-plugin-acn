// 私有工具只允许主会话使用；领域失败返回规范值，基础设施错误交给宿主处理。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AcnMemory } from '../memory/service.js';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import { MemoryArgsSchema, MemoryError } from '../memory/operations.js';
import { isSubagent } from '../tools/subagent.js';

export function memoryTool(memory: AcnMemory | undefined, resolve?: (header: SessionHeader) => Promise<AcnMemory>): ToolDefinition {
  const tool = defineTool({ name: 'memory', description: "保存跨 session 持久存在的长期信息到 persistent memory。Memory 会注入未来任务上下文，所以应保持紧凑，只保存之后仍然重要的事实。\n\n什么时候保存（应主动判断，不必等用户明确要求）：\n- 用户纠正你，或说“记住这个” / “以后不要再这样”\n- 用户分享偏好/喜好/爱好、习惯、角色、技能背景、沟通风格或协作方式\n- 你发现关于运行环境的稳定事实，例如 OS、已安装工具、项目结构\n- 你学到这个用户环境里的约定、API 特性、工具特性或工作流\n- 你识别出未来 session 仍然有用的稳定事实\n\n优先级：用户偏好和纠正 > 环境事实 > 流程性知识。最有价值的 memory 是能减少用户未来重复提醒或纠正你的内容。\n\n不要保存 task progress、session outcomes、completed-work logs、临时 TODO state、验收 PASS/FAIL、acceptance marker、trace/claim 已能记录的证据、原始数据 dump，或很快会过期的事实。时间日期约束、ddl 和会过期内容必须写成绝对时间。旧 memory 是时间快照，不是实时真相；依赖旧 memory 中的代码、文件、配置或外部系统状态前，先用当前信息验证。\n\n两个 target：\n- 'user'：用户是谁 -- 角色、偏好/喜好/爱好、沟通风格、协作习惯、容易反感的做法等等。USER 永不进入 claim flow。\n- 'memory'：你的工作记忆 -- 环境事实、项目约定、工具特性、API 特性、可复用经验。MEMORY 和 USER 都不进入插件的 Recap/Finalize、Inbox 或 Dream 输入，不作为 Claim 来源，不上传团队。\n\n用 ops 数组批量提交动作：op=add（entry 为新增条目）、op=replace（old_text 唯一定位已有整条，new_text 替换整条）、op=remove（old_text 唯一定位并删除整条）。entry/new_text 不能含保留字符 §；整批校验通过后原子写入。\n\n跳过：琐碎/显而易见的信息、容易从当前代码/文档/git/快速搜索重新发现的信息、原始数据 dump、临时任务状态。完全重复的 add 是 no-op success。工具会立即更新磁盘，但当前 system prompt 中的 memory 冻结快照不会变化。", parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args, exec) => {
    if (exec.agent === undefined || isSubagent(exec.agent.session.header)) return { success: false, error: 'Only a primary agent session may modify private Memory.' };
    try { const selected = resolve === undefined ? memory : await resolve(exec.agent.session.header); if (selected === undefined || !selected.knowledge.config.memory.enabled) return { success: false, error: 'Private Memory is disabled.' }; return { success: true, ...await selected.apply(args, { id: createHash('sha256').update(`${exec.agent.session.id}:${exec.callId}`).digest('hex'), signal: exec.signal }) }; }
    catch (error) { if (error instanceof MemoryError) return { success: false, error: error.message, ...error.details }; if (error instanceof z.ZodError) return { success: false, error: 'Invalid Memory operations.' }; throw error; }
  } });
  return { ...tool, parameters: z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(z.toJSONSchema(MemoryArgsSchema)))) };
}
