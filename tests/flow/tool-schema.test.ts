// 模拟仅保留根字段的模型适配，避免联合动作工具在传输后变成空参数对象。
import { describe, expect, it } from 'vitest';
import { ScriptAdapter } from './adapter.js';
import { flowHarness } from './harness.js';
import { consultRouterTool } from '../../src/dsh-adapter/tools.js';
import { z } from 'zod';

describe('model-visible action tool schemas', () => {
  it('keeps Claim fields and its discriminator after root-only projection', async () => {
    const flow = await flowHarness(new ScriptAdapter([]));
    try {
      const schema = flow.ctx.tools.schemas().find((tool) => tool.name === 'claim')?.parameters;
      const wire = { type: 'object', properties: schema?.properties ?? {}, required: schema?.required ?? [] };
      expect(wire).toMatchObject({ required: ['action'], properties: {
        action: { type: 'string', enum: ['list', 'read', 'update', 'traces', 'read_trace'] },
        id: { type: 'string' }, expected_revision: { type: 'string' },
        statement: { type: 'string' }, scope: { type: 'string' },
        query: { type: 'string' }, claim_id: { type: 'string' },
        offset: { type: 'integer' }, task_offset: { type: 'integer' },
      } });
      expect(schema?.oneOf).toHaveLength(5);
    } finally { await flow.close(); }
  });

  it('keeps Router modes and query fields after root-only projection', async () => {
    const flow = await flowHarness(new ScriptAdapter([]));
    try {
      const schema = consultRouterTool(flow.knowledge).parameters;
      const wire = { type: 'object', properties: schema?.properties ?? {}, required: schema?.required ?? [] };
      expect(wire).toMatchObject({ required: ['mode'], properties: {
        mode: { type: 'string', enum: ['overview', 'query'] },
        scope: { type: 'string', minLength: 1 },
      } });
      expect(z.object({ semantic_query: z.object({ anyOf: z.array(z.unknown()).min(1) }) }).safeParse(schema.properties).success).toBe(true);
      expect(schema?.oneOf).toHaveLength(2);
    } finally { await flow.close(); }
  });
});
