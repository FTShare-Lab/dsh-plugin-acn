// 结构与传输分别计次；反馈指出字段错误，持久审计只保存阶段和失败类别。
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ResolvedConfig } from '../config.js';
import type { StoreContext } from '../store/context.js';
import { withFileLock } from '../store/lock.js';
import { readYamlOr } from '../store/yaml.js';
import { JobError } from '../worker/types.js';
import { RouteSchema } from '../formation/transcript.js';
import type { Route } from '../formation/transcript.js';
import { FormationValidationError } from '../formation/schema.js';
import { KnowledgeError } from '../knowledge/errors.js';

export interface StructuredResponse { text: string; usage?: object }
export type StructuredPhase = 'candidates' | 'draft' | 'review' | 'sync_review' | 'compaction';
type InvalidKind = 'json_syntax' | 'schema' | 'reference' | 'incomplete';
const invalidLabels: Record<InvalidKind, string> = { json_syntax: 'JSON 语法', schema: '字段结构', reference: '引用或领域约束', incomplete: '输出未完整结束或包含非文本内容' };
export type StructuredBackend = (route: Route, system: string, input: string, maxTokens: number, signal: AbortSignal) => Promise<StructuredResponse>;
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { const reason: unknown = signal.reason; reject(reason instanceof Error ? reason : new JobError('aborted', '后台调用已取消。')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); });
  });
}
export async function resolveRoute(config: ResolvedConfig['llm'], context: StoreContext, sessionRoute?: Route): Promise<Route> {
  if (config.provider && config.model) return { provider: config.provider, model: config.model };
  if (sessionRoute !== undefined) return sessionRoute;
  const route = await readYamlOr(context.paths.lastRoute, RouteSchema, () => null);
  if (route === null) throw new JobError('route', '没有可用的模型路由。请先完成一次会话请求，或配置 llm.provider 和 llm.model 后重试任务。');
  return route;
}
export function transportError(error: unknown): JobError {
  if (error instanceof JobError) return error;
  const record = typeof error === 'object' && error !== null ? error : {};
  const code = 'code' in record && typeof record.code === 'string' ? record.code : '';
  const status = 'status' in record && typeof record.status === 'number' ? record.status : 0;
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return new JobError('context_limit', '会话投影超过模型上下文容量；请配置更大上下文的模型后重试任务。');
  const retryable = status === 429 || status >= 500 && status <= 599 || /^(?:TIMEOUT|RATE_LIMIT|SERVER|NETWORK|TRANSPORT|SERVER_ERROR|NETWORK_ERROR|CONNECTION_ERROR|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EMPTY_RESPONSE)$/.test(code);
  return new JobError(retryable ? 'transport' : 'route', retryable ? '后台模型调用暂时失败或超时，将按退避策略重试。' : '后台模型调用不可用。请检查 llm.provider、llm.model、适配器及凭据配置后重试任务。', retryable);
}
export async function structuredCall<T>(options: {
  backend: StructuredBackend; context: StoreContext; config: ResolvedConfig['llm']; route: Route; jobId: string;
  system: string; input: string; schema: z.ZodType; parse(value: unknown): T; signal: AbortSignal;
  phase?: StructuredPhase;
}): Promise<T> {
  const { backend, context, config, route, jobId, signal } = options;
  let feedback = '';
  let lastInvalid: InvalidKind | undefined;
  for (let attempt = 1; attempt <= config.structuredRetries; attempt += 1) {
    signal.throwIfAborted();
    for (let transport = 1; transport <= 3; transport += 1) {
      let response: StructuredResponse | undefined;
      const startedAt = Date.now();
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const callSignal = AbortSignal.any([signal, timeout]);
      let outcome = 'transport_failed';
      let invalid: { kind: InvalidKind; issueCodes?: string[] } | undefined;
      try {
        const schema = JSON.stringify(z.toJSONSchema(options.schema));
        try {
          response = await abortable(backend(route, `${options.system}\n只输出一个 JSON 对象，不调用工具。必须符合此 JSON schema：\n${schema}${feedback}`, options.input, config.maxOutputTokens, callSignal), callSignal);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof JobError && error.kind === 'structured_output') { outcome = 'invalid'; lastInvalid = 'incomplete'; invalid = { kind: lastInvalid }; feedback = `\n上次响应未通过校验：${error.message}\n请重新提交完整 JSON 对象。`; break; }
          const failure = timeout.aborted ? new JobError('timeout', '后台模型调用超时，将按退避策略重试。', true) : transportError(error);
          if (!failure.retryable || transport === 3) throw failure;
          continue;
        }
        try {
          const text = response.text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1');
          const value: unknown = JSON.parse(text);
          const result = options.parse(options.schema.parse(value));
          outcome = 'succeeded'; return result;
        } catch (error) {
          if (!(error instanceof SyntaxError || error instanceof z.ZodError || error instanceof FormationValidationError || error instanceof KnowledgeError)) throw error;
          const summary = error instanceof z.ZodError ? error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || '$'}: ${issue.code}${issue.code === 'unrecognized_keys' ? `；删除多余字段 ${JSON.stringify(issue.keys.slice(0, 8)).slice(0, 400)}` : ''}`).join('; ') : error instanceof FormationValidationError || error instanceof KnowledgeError ? error.message : 'JSON 解析失败：检查字段名后的冒号、逗号、引号和转义；不要输出注释或省略号。';
          lastInvalid = error instanceof z.ZodError ? 'schema' : error instanceof SyntaxError ? 'json_syntax' : 'reference';
          invalid = { kind: lastInvalid, ...error instanceof z.ZodError ? { issueCodes: [...new Set(error.issues.map((issue) => issue.code))] } : {} };
          outcome = 'invalid'; feedback = `\n上次响应未通过校验：${summary}\n请重新提交完整 JSON 对象。`;
          break;
        }
      } finally {
        // append 与 fsync 受本地短锁保护，多个进程不会交错写出半条审计记录。
        const day = new Date(startedAt).toISOString().slice(0, 10);
        const path = join(context.paths.llmCalls, `${day}.jsonl`);
        await withFileLock(`${path}.lock`, async () => {
          await fs.mkdir(context.paths.llmCalls, { recursive: true });
          const file = await fs.open(path, 'a', 0o600);
          try { await file.writeFile(`${JSON.stringify({ jobId, route, ...options.phase === undefined ? {} : { phase: options.phase }, attempt, transport, startedAt, elapsedMs: Date.now() - startedAt, outcome, ...invalid === undefined ? {} : { invalid }, ...response?.usage === undefined ? {} : { usage: response.usage } })}\n`); await file.sync(); } finally { await file.close(); }
        });
      }
    }
  }
  throw new JobError('structured_output', `${options.phase === undefined ? '' : `${options.phase} 阶段：`}连续 ${config.structuredRetries} 次响应未通过结构或引用校验${lastInvalid === undefined ? '' : `（最后失败：${invalidLabels[lastInvalid]}）`}；请检查模型后使用 /acn-status retry 重试任务。`);
}
