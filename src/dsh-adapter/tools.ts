// 宿主工具 DSL 的根对象默认开放；显式替换模型 schema 并由严格动作 schema 再校验。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import type { AcnKnowledge } from '../knowledge/service.js';
import { ClaimToolArgsSchema, CLAIM_DESCRIPTION, executeClaim } from '../tools/claim.js';
import { ConsultRouterArgsSchema, CONSULT_ROUTER_DESCRIPTION, executeConsultRouter } from '../tools/consult-router.js';
import { toolParameters } from './tool-schema.js';

export function claimTool(knowledge: AcnKnowledge): ToolDefinition {
  const tool = defineTool({
    name: 'claim', description: CLAIM_DESCRIPTION,
    parameters: { action: { type: 'string', required: true, enum: ['list', 'read', 'update', 'traces', 'read_trace'] } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const result = await executeClaim(knowledge, args, exec.signal);
      const json: unknown = JSON.parse(JSON.stringify(result));
      return z.json().parse(json);
    },
  });
  return { ...tool, parameters: toolParameters(ClaimToolArgsSchema) };
}
export function consultRouterTool(knowledge: AcnKnowledge): ToolDefinition {
  const tool = defineTool({ name: 'consult_router', description: CONSULT_ROUTER_DESCRIPTION,
    parameters: { mode: { type: 'string', enum: ['overview', 'query'], required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('consult_router requires an agent session.');
      const result = await executeConsultRouter(knowledge, args, exec.agent.session.id, exec.signal);
      return z.json().parse(JSON.parse(JSON.stringify(result)));
    },
  });
  return { ...tool, parameters: toolParameters(ConsultRouterArgsSchema) };
}
