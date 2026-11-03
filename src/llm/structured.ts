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
type InvalidKind = 'json_syntax' | 'schema' | 'reference' | 'incomplete' | 'output_limit' | 'non_text';
const invalidLabels: Record<InvalidKind, string> = { json_syntax: 'JSON 语法', schema: '字段结构', reference: '引用或领域约束', incomplete: '输出未完整结束', output_limit: '输出 token 上限（MAX_TOKENS）', non_text: '缺少 JSON 文本或返回了工具调用、附件' };
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
  const delay = 'providerRetryAfterMs' in record ? record.providerRetryAfterMs : undefined;
  const retryAfterMs = typeof delay === 'number' && Number.isFinite(delay) && delay > 0 && delay <= 2_147_483_647 ? Math.ceil(delay) : undefined;
  const retry = (kind: string, message: string) => new JobError(kind, message + (retryAfterMs === undefined ? '' : ` 提供商要求至少等待 ${Math.ceil(retryAfterMs / 1000)} 秒。`), true, retryAfterMs);
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return new JobError('context_limit', '后台模型输入超过上下文容量（CONTEXT_WINDOW_EXCEEDED）；请配置更大上下文的模型后重试任务。');
  // 只公开已知分类与固定建议，不转发提供商错误正文或任意 code。
  if (/^(?:AUTH|AUTH_FAILED|INVALID_CREDENTIAL|MISSING_CREDENTIAL)$/.test(code) || status === 401 || status === 403) return new JobError('model_auth', '后台模型鉴权失败（AUTH）；请在 DSH 模型设置中检查提供商的凭据配置后重试。');
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || status === 402) return new JobError('model_quota', '后台模型额度不足（QUOTA）；请检查提供商额度或更换知识处理模型后重试。');
  if (code === 'MALFORMED_RESPONSE') return new JobError('model_response', '后台模型返回的响应格式无效（MALFORMED_RESPONSE）；可稍后重试或更换知识处理模型。');
  if (code === 'NO_ADAPTER') return new JobError('route', '后台模型适配器不可用（NO_ADAPTER）；请检查 DSH 中的提供商与知识处理模型配置。');
  if (code === 'INVALID_REQUEST' || status === 400 || status === 413) return new JobError('model_request', '后台模型拒绝请求（INVALID_REQUEST）；请检查所选模型支持的参数和上下文、输出上限。');
  if (code === 'EMPTY_RESPONSE') return retry('model_empty', '后台模型返回空响应（EMPTY_RESPONSE）；可稍后重试或更换知识处理模型。');
  if (code === 'RATE_LIMIT' || code === 'RATE_LIMITED' || status === 429) return retry('model_rate_limit', '后台模型请求受限（RATE_LIMIT）；请稍后重试或检查提供商并发限制。');
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || code === 'HTTP_408' || status === 408) return retry('timeout', '后台模型调用超时（TIMEOUT）；请检查网络和模型服务，或调整超时后重试。');
  if (code === 'SERVER' || code === 'SERVER_ERROR' || status >= 500 && status <= 599) return retry('model_server', '后台模型服务暂时不可用（SERVER）；请稍后重试或更换知识处理模型。');
  if (/^(?:NETWORK|TRANSPORT|NETWORK_ERROR|CONNECTION_ERROR|ECONNRESET|ECONNREFUSED)$/.test(code)) return retry('transport', '后台模型网络连接失败（TRANSPORT）；请检查网络和模型服务后重试。');
  return new JobError('route', '后台模型调用不可用。请检查 llm.provider、llm.model、适配器及凭据配置后重试任务。');
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
          if (error instanceof JobError && ['structured_output', 'structured_output_limit', 'structured_output_content'].includes(error.kind)) { outcome = 'invalid'; lastInvalid = error.kind === 'structured_output_limit' ? 'output_limit' : error.kind === 'structured_output_content' ? 'non_text' : 'incomplete'; invalid = { kind: lastInvalid }; feedback = `\n上次响应未通过校验：${error.message}\n请重新提交完整 JSON 对象。`; break; }
          const failure = timeout.aborted ? transportError({ code: 'TIMEOUT' }) : transportError(error);
          // 服务要求等待时交给现有持久队列调度，不在这里连发或占住 worker 等待。
          if (!failure.retryable || transport === 3 || failure.retryAfterMs !== undefined) throw failure;
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
