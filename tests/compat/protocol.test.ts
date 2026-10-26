// 用 Rust 生成的报文检查 JSON 字节、YAML 语义和 revision，并准备 Rust 读回数据。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AgentQuerySchema, ArbitrationResolutionContextSchema, AuthEnvelopeSchema, authRequestSchema, ClaimSchema, claimRevision, DisputeSchema, InboxAckRequestSchema, InboxMessageSchema, PolicySchema, RouterQueryResultSchema, ScopesOverviewSnapshotSchema, TraceSchema } from '../../src/protocol/index.js';
import { decodeYaml, encodeJson, encodeYaml, PendingClaimEditSchema, PendingUploadsSchema, ReportedSetsSchema } from '../../src/store/index.js';
import { DreamStateSchema, CheckpointSchema as DreamCheckpointSchema, ValidationSchema } from '../../src/dream/schema.js';
import { valueHash } from '../../src/dream/plan.js';
import { MemoryOpSchema, MemoryReportSchema, MemorySnapshotSchema, MemoryUsageSchema } from '../../src/memory/operations.js';

const directory = new URL('../fixtures/protocol/', import.meta.url);
const manifest = z.object({ acn_version: z.string(), fixtures: z.array(z.object({ name: z.string(), kind: z.string(), revision: z.string().optional() })) }).parse(JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')));
const schemas: Record<string, z.ZodType> = {
  claim: ClaimSchema, trace: TraceSchema, dispute: DisputeSchema, policy: PolicySchema,
  inbox: InboxMessageSchema, arbitration: ArbitrationResolutionContextSchema, router: RouterQueryResultSchema,
  overview: ScopesOverviewSnapshotSchema, auth: AuthEnvelopeSchema, 'auth-query': authRequestSchema(AgentQuerySchema),
  'inbox-ack': InboxAckRequestSchema, uploads: PendingUploadsSchema, 'pending-edit': PendingClaimEditSchema, 'reported-sets': ReportedSetsSchema,
  'dream-state': DreamStateSchema, 'dream-checkpoint': DreamCheckpointSchema, 'dream-validation': ValidationSchema, 'dream-pending': z.string(),
  'memory-ops': z.array(MemoryOpSchema), 'memory-report': MemoryReportSchema, 'memory-snapshot': MemorySnapshotSchema, 'memory-usage': MemoryUsageSchema,
};
const readback = new URL('../../.artifacts/acn-roundtrip/', import.meta.url);
await mkdir(readback, { recursive: true });

describe(`protocol fixtures from ${manifest.acn_version}`, () => {
  it.each(manifest.fixtures)('$name: JSON bytes, YAML semantics and revision agree', async (item) => {
    const schema = schemas[item.kind];
    if (schema === undefined) throw new Error(`Missing fixture schema: ${item.kind}`);
    const originalJson = await readFile(new URL(`${item.name}.json`, directory), 'utf8');
    const originalYaml = await readFile(new URL(`${item.name}.yaml`, directory), 'utf8');
    const value: unknown = JSON.parse(originalJson);
    if (item.kind.startsWith('dream-')) {
      // 整理记录内含通用 JSON Value；参考实现排序对象键，比较语义而非对象键顺序。
      expect(JSON.parse(encodeJson(schema, value))).toEqual(value);
      expect(schema.parse(decodeYaml(schema, originalYaml))).toEqual(schema.parse(value));
      const emitted = encodeYaml(schema, value); expect(schema.parse(decodeYaml(schema, emitted))).toEqual(schema.parse(value));
      if (item.kind === 'dream-validation') { const validation = ValidationSchema.parse(value); expect(valueHash(validation.input)).toBe(validation.validation_id); }
      await writeFile(new URL(`${item.name}.yaml`, readback), emitted); return;
    }
    expect(encodeJson(schema, value)).toBe(originalJson);
    expect(encodeJson(schema, decodeYaml(schema, originalYaml))).toBe(originalJson);
    const emitted = encodeYaml(schema, value);
    expect(encodeJson(schema, decodeYaml(schema, emitted))).toBe(originalJson);
    if (item.revision !== undefined) expect(claimRevision(value)).toBe(item.revision);
    await writeFile(new URL(`${item.name}.yaml`, readback), emitted);
  });
});
