// 真实文件检查增量投影、尾行恢复、容量边界及来源正文门禁。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUserMessage, ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { TranscriptStore } from '../../src/formation/transcript.js';
import { SessionStateStore } from '../../src/store/session-state.js';
import { compactionEnd, projectEvent } from '../../src/dsh-adapter/formation.js';
import { context } from '../helpers.js';
import { sampleClaim } from '../knowledge-fixtures.js';

describe('transcript persistence', () => {
  it('recovers matching main/spill duplicates but rejects conflicting copies of one seq', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-transcript-')); const store = new TranscriptStore(context(root));
    try {
      const entry = { seq: 1, type: 'user' as const, text: 'Durable unprocessed task.' }; await store.record('session-a', { entry });
      await fs.mkdir(store.context.paths.transcriptPending('session-a'), { recursive: true });
      const path = join(store.context.paths.transcriptPending('session-a'), '1.json');
      await fs.writeFile(path, JSON.stringify(entry)); expect(await store.read('session-a')).toEqual([entry]);
      await fs.writeFile(path, JSON.stringify({ ...entry, text: 'Conflicting task.' })); await expect(store.read('session-a')).rejects.toMatchObject({ kind: 'transcript' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('repairs an incomplete last line and reconciles append-before-state without duplicate seqs', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-transcript-')); const ctx = context(root); const store = new TranscriptStore(ctx);
    try {
      await new SessionStateStore(ctx).update('session-a', () => ({ schemaVersion: 1, catalog: { text: 'catalog' } }));
      const entry = { seq: 1, type: 'user' as const, text: 'Review the service contract.' };
      await store.record('session-a', { entry });
      const file = await fs.open(ctx.paths.transcript('session-a'), 'a');
      try { await file.writeFile(`${JSON.stringify({ ...entry, seq: 3, text: 'Durable append before state.' })}\n{"seq":`); await file.sync(); } finally { await file.close(); }
      await store.record('session-a', {}); await store.record('session-a', { entry });
      expect((await store.read('session-a')).map((row) => row.seq)).toEqual([1, 3]);
      expect((await store.state('session-a')).lastSeenSeq).toBe(3);
      expect((await new SessionStateStore(ctx).read('session-a'))?.['catalog']).toEqual({ text: 'catalog' });
      await store.advance('session-a', 'recap', 1); expect((await store.read('session-a')).map((row) => row.seq)).toEqual([3]);
      await store.advance('session-a', 'finalize', 3); expect(await store.read('session-a')).toEqual([]);
      expect(await store.state('session-a')).toMatchObject({ lastSeenSeq: 3, recappedThroughSeq: 3, finalizedThroughSeq: 3 });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('spills unprocessed rows without exceeding the file bound, then reclaims processed data', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-transcript-')); const store = new TranscriptStore(context(root), 160);
    try {
      await store.record('session-a', { entry: { seq: 0, type: 'user', text: 'a'.repeat(80) } });
      await store.record('session-a', { entry: { seq: 1, type: 'user', text: 'b'.repeat(80) } });
      expect((await store.read('session-a')).map((row) => row.seq)).toEqual([0, 1]);
      expect((await fs.stat(store.context.paths.transcript('session-a'))).size).toBeLessThanOrEqual(160);
      expect(await fs.readdir(store.context.paths.transcriptPending('session-a'))).toEqual(['1.json']);
      await store.advance('session-a', 'finalize', 0);
      expect((await store.read('session-a')).map((row) => row.seq)).toEqual([1]);
      expect(await fs.readdir(store.context.paths.transcriptPending('session-a'))).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('excludes notices and replacement summaries; truncates tool text and replaces attachments', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'notice' }], source: { kind: 'acn-claim-changes' } });
    const user = { seq: SessionSeq(1), time: 1, type: 'user/message' as const, surfaceOp: 'append' as const, data: message };
    expect(projectEvent(user)).toEqual({});
    expect(projectEvent({ ...user, surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) } })).toEqual({});
    const result = createToolResultMessage({ content: [{ type: 'text', text: '😀'.repeat(4500) }], callId: ToolCallId('call-a'), isError: false });
    const projected = projectEvent({ seq: SessionSeq(2), time: 2, type: 'tool/result', surfaceOp: 'append', data: { turn: 0, step: 0, message: result } });
    expect(Array.from(projected.entry?.text ?? '')).toHaveLength(4000);
    expect(compactionEnd({ type: 'compaction/summary', data: { shadowedRange: { start: 10, end: 3 }, shadowedSeqs: [10, 3] } })).toBe(10);
  });
  it('only complete tool bodies grant source visibility; private memory call results never enter transcript', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'acn-transcript-')); const store = new TranscriptStore(context(root));
    try {
      const toolResult = (content: object, callId = 'call-a') => ({ seq: SessionSeq(3), time: 3, type: 'tool/result' as const, surfaceOp: 'append' as const, data: { turn: 0, step: 0, message: createToolResultMessage({ content: [{ type: 'text' as const, text: JSON.stringify(content) }], callId: ToolCallId(callId), isError: false }) } });
      expect(projectEvent(toolResult({ id: 'claim_deadbeef', name: 'catalog_only', scope: 'example' })).seenSourceIds).toEqual([]);
      expect(projectEvent(toolResult({ ok: true, output: { claim: sampleClaim() } })).seenSourceIds).toEqual(['claim_00000001']);
      await store.record('session-a', projectEvent({ seq: SessionSeq(2), time: 2, type: 'tool/call', data: { turn: 0, step: 0, callId: ToolCallId('private-call'), name: 'memory', arguments: 'private contents' } }));
      await store.record('session-a', projectEvent(toolResult({ private: 'private contents', claim: sampleClaim() }, 'private-call')));
      expect(await store.read('session-a')).toEqual([]); expect((await store.state('session-a')).seenSourceIds).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
