// 唯一配置承载行，发布隔离的领域服务；未配置身份时不访问磁盘。
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { resolveConfig } from '../config.js';
import { AcnKnowledge } from '../knowledge/service.js';
import { UploadScheduler } from '../upload/scheduler.js';
import { bindSession, sessionAllowed, sessionChanged } from '../dsh-adapter/session-binding.js';
import { protectMemoryPaths } from '../dsh-adapter/memory-paths.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    acnKnowledge: AcnKnowledge;
  }
}

export const name = 'acn-knowledge';
export const inject: string[] = [];

// 宿主 schema 提供配置发现；严格字段与交叉约束仍由领域解析器统一校验。
const number = (value: number) => Schema.number().default(value);
const boolean = (value: boolean) => Schema.boolean().default(value);
export const Config = Schema.object({
  agentId: Schema.string().default(''), home: Schema.string().default('~/.acn-dsh'), sessionEpoch: number(0),
  team: Schema.object({
    routerEndpoint: Schema.string().default(''), maintainerEndpoint: Schema.string().default(''), keyEnv: Schema.string().default(''),
    timeoutMs: number(15_000), retryCount: number(3), retryBaseDelayMs: number(500), retryMaxDelayMs: number(8000),
  }),
  llm: Schema.object({ provider: Schema.string().default(''), model: Schema.string().default(''), maxOutputTokens: number(32_768), timeoutMs: number(600_000), structuredRetries: number(5) }),
  catalog: Schema.object({ maxClaims: number(200), maxChars: number(24_000) }),
  formation: Schema.object({ recapOnCompaction: boolean(true), idleRecap: boolean(true), recapMinTurns: number(10), recapMinTokens: number(100_000), recapBatchIdleMinutes: number(5), recapTailIdleMinutes: number(60), recapScanSeconds: number(30), finalizeIdleMinutes: number(0), finalizeOnDispose: boolean(false) }),
  inbox: Schema.object({ pullOnSessionStart: boolean(true), processingStaleAfterSecs: number(600) }),
  dream: Schema.object({ enabled: boolean(true), minIntervalHours: number(24), minChangedClaims: number(5), checkIntervalHours: number(4), evidenceCalibration: boolean(false), maxModelSteps: number(24), maxWrapUpSteps: number(3), evidenceMaxCalls: number(32), evidenceMaxSteps: number(24), evidenceMaxBytes: number(1_048_576), evidenceMaxChars: number(16_000), evidenceMaxFiles: number(256) }),
  memory: Schema.object({ enabled: boolean(true), memoryCharLimit: number(1600), userCharLimit: number(1000), safetyScan: boolean(true), review: Schema.object({ enabled: boolean(true), intervalTurns: number(10), maxTranscriptChars: number(32_000) }) }),
});

export async function apply(ctx: Context, input: unknown = {}): Promise<void> {
  const knowledge = new AcnKnowledge(resolveConfig(input), ctx.logger);
  await knowledge.initialize();
  ctx.provide('acnKnowledge', knowledge);
  if (knowledge.configured) void ctx.inject(['fs', 'tools', 'workingDirectory'], (child) => { protectMemoryPaths(child, knowledge); });
  const uploads = knowledge.configured ? new UploadScheduler(knowledge) : null;
  ctx.effect(() => {
    const abort = new AbortController();
    if (knowledge.team !== null) void knowledge.team.health(abort.signal).catch(() => { ctx.logger.warn('Team health check could not complete.'); });
    uploads?.start();
    return async () => { abort.abort(); await uploads?.close(); await knowledge.jobs?.close(); await knowledge.team?.close(); };
  });
  void ctx.inject(['agents', 'sessions', 'tools'], (child) => {
    child.on('agent/pre-step', async ({ agent }, next) => {
      if (!sessionAllowed(child, knowledge.config, agent.session.header)) throw new Error(sessionChanged);
      return next();
    });
    child.tools.guard((execution) => ['claim', 'consult_router', 'memory'].includes(execution.name) && execution.agent !== undefined && !sessionAllowed(child, knowledge.config, execution.agent.session.header) ? sessionChanged : undefined);
    child.on('agent/created', ({ agent }) => { bindSession(child, knowledge.config, agent.session.header); uploads?.kick(); });
    for (const agent of child.agents.list()) bindSession(child, knowledge.config, agent.session.header);
  });
  await knowledge.jobs?.start();
  ctx.logger.info('ACN knowledge plugin activated.');
}

export default { name, Config, inject, apply };
