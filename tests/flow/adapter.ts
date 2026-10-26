// 脚本模型驱动真实 AgentLoop，保留每次请求以检查工具和上下文准入。
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

export function toolResponse(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id);
  const argumentsJson = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

type Entry = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>);
export class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly script: Entry[]) { super(); }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model });
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const entry = this.script.shift();
    if (entry === undefined) throw new Error('Test model script exhausted.');
    for (const chunk of typeof entry === 'function' ? await entry(options) : entry) {
      options.signal?.throwIfAborted();
      yield chunk;
    }
  }
}
