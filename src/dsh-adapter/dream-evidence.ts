// 在子会话发布前安装只读能力、最终执行 guard 与独立提示词；结束时停止并排空子循环。
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { EvidenceTools, type EvidenceTool } from '../dream/evidence-store.js';
import { DreamValidationError } from '../dream/schema.js';
import { abortable } from '../llm/structured.js';
import { JobError } from '../worker/types.js';
import type { EvidenceExplorer } from '../dream/service.js';
import { toolParameters } from './tool-schema.js';

const allowed = (name: string): name is EvidenceTool => Object.hasOwn(EvidenceTools, name);
export function restrictedExplorer(ctx: Context, system: string): EvidenceExplorer {
  return async ({ store, claims, route, config, signal }) => {
    const manifest = await store.read(); if (manifest === null) throw new JobError('evidence_permission', '缺少受限查证授权。');
    const timeout = AbortSignal.timeout(config.timeoutMs); const bounded = AbortSignal.any([signal, timeout]); let completed = false;
    const handle = await ctx.agents.create({ sessionId: SessionId(`acn-evidence-${randomUUID()}`), meta: { cwd: manifest.workspace_root, origin: 'subagent', delegationDepth: 1, agentPreset: 'acn-evidence' }, agentOptions: { ...route, maxTokens: config.maxOutputTokens }, signal: bounded, setup: (child) => {
      child.tools.restrict({ allow: [] }); child.tools.presentAs('native');
      child.tools.guard((execution) => !allowed(execution.name) || !EvidenceTools[execution.name].safeParse(execution.arguments).success ? '受限查证只允许工作区只读 read/grep/glob 和候选 claim list/read。' : undefined);
      for (const name of Object.keys(EvidenceTools).filter(allowed)) {
        const tool = defineTool({ name, description: name === 'read' ? '读取当前工作区文本，必须绑定候选 claim_ids；返回已持久的版本证据 ID。' : name === 'claim' ? '只读当前候选 Claim；不允许更新或读取 Trace、私有记忆。' : `${name} 在工作区做有界字面搜索；结果仅用于定位，必须再 read 才能取得独立证据。`, parameters: {}, output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] }, execute: async (args, execution) => {
          try { return await store.execute(name, args, claims, AbortSignal.any([bounded, execution.signal])); }
          catch (error) { bounded.throwIfAborted(); return { error: error instanceof DreamValidationError ? error.message : '受限读取失败；未产生可引用的新证据。' }; }
        } });
        child.tools.register({ ...tool, parameters: toolParameters(EvidenceTools[name]) });
      }
      child.systemPrompt.suppressRuntimeContext();
      child.systemPrompt.section({ name: 'acn-evidence-only', order: 0, text: system, interpolate: false, complete: true });
      const shadowed = new Set<string>();
      child.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        // 宿主在准入时会重新注入 required context；同名 scoped 空贡献阻止私有环境文本回流。
        for (const context of assembly.contexts) if (!shadowed.has(context.name)) { child.systemPrompt.context({ name: context.name, order: 0, text: '', interpolate: false }); shadowed.add(context.name); }
        return { ...assembly, contexts: [], variables: {}, tools: assembly.tools.filter((tool) => allowed(tool.name)) };
      });
      child.on('agent/pre-step', async (_payload, next) => { bounded.throwIfAborted(); await store.admitStep(bounded); return next(); });
      child.on('session/event', (_session, event) => { if (event.type === 'turn/end') completed = event.data.reason.kind === 'completed'; });
    } });
    const cancel = () => { handle.agent.cancel({ kind: 'parent' }); };
    bounded.addEventListener('abort', cancel, { once: true });
    try {
      bounded.throwIfAborted();
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ task: '查证候选，读取有版本的直接材料；缺少证据则结束并保持原样。不要写入或请求扩大权限。', claims, workspace_root: manifest.workspace_root, limits: manifest.limits }) }], source: { kind: 'acn-formation' } }));
      await abortable(handle.agent.whenIdle(), bounded); bounded.throwIfAborted();
      if (!completed) throw new JobError('evidence_incomplete', '受限查证未完整结束；已有回执和预算保留，未授权 Claim 变更。');
    } catch (error) { signal.throwIfAborted(); if (timeout.aborted) throw new JobError('evidence_timeout', '受限查证超时，已停止子会话。', true); throw error; }
    finally { bounded.removeEventListener('abort', cancel); await handle.dispose(); }
  };
}
