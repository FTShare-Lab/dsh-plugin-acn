// 在独立临时目录挂载真实工具、命令、提示词和 AgentLoop，清理资源归调用者所有。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Commands from '@deepseek-ai/dsh-commands';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import Knowledge from '../../src/plugins/knowledge.js';
import Tools from '../../src/plugins/tools.js';
import Prompt from '../../src/plugins/prompt.js';
import AcnCommands from '../../src/plugins/commands.js';
import Formation from '../../src/plugins/formation.js';
import Inbox from '../../src/plugins/inbox.js';
import Dream from '../../src/plugins/dream.js';
import type { ConfigInput } from '../../src/config.js';
import { resolveConfig } from '../../src/config.js';
import { ClaimStore } from '../../src/store/claims.js';
import { sampleClaim } from '../knowledge-fixtures.js';
import { ScriptAdapter } from './adapter.js';

export async function flowHarness(adapter: ScriptAdapter, options: { configured?: boolean; persistence?: boolean; workspace?: boolean; formation?: boolean; inbox?: boolean; dream?: boolean; filesystem?: boolean; toolMode?: 'native' | 'ptc'; config?: ConfigInput } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-flow-'));
  const ctx = new Context();
  try {
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: options.toolMode ?? 'native' }, workingDirectory: options.filesystem ?? false });
    await ctx.plugin(Commands);
    if (options.persistence || options.workspace) await ctx.plugin(Persistence, { root: join(root, 'logs') });
    if (options.workspace) {
      await ctx.plugin(Storage);
      await ctx.plugin(StorageJson, { root: join(root, 'storage') });
      await ctx.plugin(StorageDomain, { backend: 'json' });
      await ctx.plugin(WorkspaceRegistry);
    }
    ctx.llm.registerAdapter(['mock'], adapter);
    const knowledgeFiber = await ctx.plugin(Knowledge, resolveConfig({ ...options.config, agentId: options.configured === false ? '' : 'agent-a', home: join(root, 'knowledge') }));
    const promptFiber = await ctx.plugin(Prompt);
    const toolsFiber = await ctx.plugin(Tools);
    const commandsFiber = await ctx.plugin(AcnCommands);
    const harness = await mountAgentLoopTestHarness(ctx);
    const formationFiber = options.formation ? await ctx.plugin(Formation) : undefined;
    const inboxFiber = options.inbox ? await ctx.plugin(Inbox) : undefined;
    const dreamFiber = options.dream ? await ctx.plugin(Dream) : undefined;
    const claim = sampleClaim();
    if (ctx.acnKnowledge.configured) await new ClaimStore(ctx.acnKnowledge.context()).write(claim);
    return {
      root, ctx, harness, claim, knowledge: ctx.acnKnowledge,
      fibers: { knowledge: knowledgeFiber, prompt: promptFiber, tools: toolsFiber, commands: commandsFiber, formation: formationFiber, inbox: inboxFiber, dream: dreamFiber },
      create: (id = 'session-a') => harness.create(SessionId(id), { provider: 'mock', model: 'mock' }),
      close: async () => { try { await ctx.fiber.dispose(); } finally { await fs.rm(root, { recursive: true, force: true }); } },
    };
  } catch (error) { await ctx.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); throw error; }
}
export async function turn(agent: Agent, text = 'Continue the example task.'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await agent.whenIdle();
}
export function callTool(ctx: Context, agent: Agent, args: unknown) {
  return ctx.tools.execute({ name: 'claim', arguments: args, agent, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
}
