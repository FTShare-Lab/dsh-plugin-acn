// 用真实文件、链接、并发短锁与持久预算验证查证的权限和泄露边界。
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceStore } from '../../src/dream/evidence-store.js';
import { z } from 'zod';
import { evidenceFixture, material } from './evidence-helpers.js';
import { ClaimIdSchema } from '../../src/protocol/ids.js';

describe('restricted workspace evidence', () => {
  it.each(['MEMORY.md', 'USER.md', 'export_env.sh', '.env', '.env.example', 'credentials.json', '.ssh/id', '.aws/config', '.git/config', 'client.key', 'access-token.txt', 'node_modules/example/index.js', 'memories/example.txt'])('rejects protected path %s without creating a receipt', async (path) => {
    const f = await evidenceFixture();
    try { const target = join(f.workspace, path); await fs.mkdir(dirname(target), { recursive: true }); await fs.writeFile(target, 'PRIVATE_DATA_MARKER'); await expect(f.read(undefined, path)).rejects.toThrow(); expect((await f.store.read())?.receipts).toEqual({}); }
    finally { await f.close(); }
  });
  it.each(['outside', 'traversal', 'symlink-file', 'symlink-directory', 'hardlink', 'private-home', 'directory', 'binary', 'invalid-utf8'])('rejects unsafe filesystem access: %s', async (mode) => {
    const f = await evidenceFixture(); const outside = join(f.root, 'outside.txt');
    try {
      await fs.writeFile(outside, 'PRIVATE_DATA_MARKER'); let path = 'source.txt';
      if (mode === 'outside') path = outside;
      if (mode === 'traversal') path = `../${f.root.split('/').at(-1) ?? ''}/outside.txt`;
      if (mode === 'symlink-file') { path = 'link.txt'; await fs.symlink(outside, join(f.workspace, path)); }
      if (mode === 'symlink-directory') { await fs.symlink(f.root, join(f.workspace, 'link')); path = 'link/outside.txt'; }
      if (mode === 'hardlink') { path = 'hard.txt'; await fs.link(outside, join(f.workspace, path)); }
      if (mode === 'private-home') path = f.knowledge.context().paths.memory;
      if (mode === 'directory') { path = 'directory'; await fs.mkdir(join(f.workspace, path)); }
      if (mode === 'binary') await fs.writeFile(join(f.workspace, path), Buffer.from([0, 1, 2]));
      if (mode === 'invalid-utf8') await fs.writeFile(join(f.workspace, path), Buffer.from([255, 254]));
      await expect(f.read(undefined, path)).rejects.toThrow(); expect((await f.store.read())?.receipts).toEqual({});
    } finally { await f.close(); }
  });
  it('searches literal content with explicit truncation and excludes protected directories', async () => {
    const f = await evidenceFixture();
    try {
      await fs.writeFile(join(f.workspace, 'USER.md'), 'PRIVATE_DATA_MARKER'); await fs.mkdir(join(f.workspace, '.hidden')); await fs.writeFile(join(f.workspace, '.hidden', 'other.txt'), 'PRIVATE_DATA_MARKER');
      const signal = new AbortController().signal;
      const paths = await f.store.execute('glob', { query: '.txt' }, f.initial, signal); expect(JSON.stringify(paths)).toContain('source.txt'); expect(JSON.stringify(paths)).not.toContain('USER');
      const matches = await f.store.execute('grep', { query: 'verified rule' }, f.initial, signal); expect(JSON.stringify(matches)).toContain(material); expect(JSON.stringify(matches)).not.toContain('PRIVATE_DATA_MARKER'); expect((await f.store.read())?.receipts).toEqual({});
      const literal = await f.store.execute('grep', { query: '.*' }, f.initial, signal); expect(literal).toMatchObject({ matches: [], independent_evidence: false });
    } finally { await f.close(); }
  });
  it('only lists and reads the frozen candidate Claims, never Trace or private memory', async () => {
    const f = await evidenceFixture(); const signal = new AbortController().signal;
    try {
      expect(await f.store.execute('claim', { action: 'list' }, f.initial, signal)).toEqual(f.initial);
      expect(await f.store.execute('claim', { action: 'read', id: f.initial[0]?.id }, f.initial, signal)).toEqual(f.initial[0]);
      for (const action of ['update', 'traces', 'read_trace']) await expect(f.store.execute('claim', { action }, f.initial, signal)).rejects.toThrow();
      await expect(f.store.execute('claim', { action: 'read', id: 'claim_99999999' }, f.initial, signal)).rejects.toThrow();
      await expect(f.read(ClaimIdSchema.parse('claim_99999999'))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it('persists call and byte budgets across restart and failed requests', async () => {
    const f = await evidenceFixture({ config: { dream: { evidenceMaxCalls: 2, evidenceMaxBytes: 256 } } });
    try {
      await expect(f.read(undefined, 'USER.md')).rejects.toThrow(); await f.read();
      const resumed = new EvidenceStore(f.knowledge.context(), 'evidence-job', 'group-a'); await resumed.initialize(f.workspace, f.initial, f.knowledge.config.dream);
      await expect(resumed.execute('read', { path: 'source.txt', claim_ids: f.initial.map((claim) => claim.id) }, f.initial, new AbortController().signal)).rejects.toThrow('预算');
      expect((await resumed.read())?.calls).toBe(2); expect((await resumed.read())?.bytes_read).toBe(Buffer.byteLength(material) + 1);
    } finally { await f.close(); }
  });
  it('caps total bytes, returned characters, file discovery and model steps', async () => {
    const f = await evidenceFixture({ config: { dream: { evidenceMaxBytes: 40, evidenceMaxFiles: 1, evidenceMaxSteps: 1 } } });
    try {
      await expect(f.read()).rejects.toThrow('预算');
      expect(await f.store.execute('glob', {}, f.initial, new AbortController().signal)).toMatchObject({ truncated: false });
      await fs.writeFile(join(f.workspace, 'extra.txt'), 'short'); expect(await f.store.execute('glob', {}, f.initial, new AbortController().signal)).toMatchObject({ truncated: true });
      await f.store.admitStep(new AbortController().signal); await expect(f.store.admitStep(new AbortController().signal)).rejects.toThrow('步数');
    } finally { await f.close(); }
  });
  it('returns only complete lines within the character cap while versioning the full file', async () => {
    const f = await evidenceFixture({ config: { dream: { evidenceMaxChars: 10 } } });
    try {
      await fs.writeFile(join(f.workspace, 'source.txt'), 'one\nA line that is too long.'); const value = await f.read(); const receipt = (await f.store.read())?.receipts[value.evidence_id];
      expect(receipt?.output.content).toBe('one'); expect(receipt?.output.page).toMatchObject({ returned_start: 1, returned_end: 1, truncated: true }); expect(receipt?.output.file_version.revision.byte_len).toBe(Buffer.byteLength('one\nA line that is too long.'));
    } finally { await f.close(); }
  });
  it('serializes parallel tool receipts without losing budget or versions, then seals the manifest', async () => {
    const f = await evidenceFixture();
    try {
      const values = await Promise.all(Array.from({ length: 4 }, () => f.read())); const manifest = await f.store.read();
      expect(new Set(values.map((value) => value.evidence_id)).size).toBe(4); expect(Object.keys(manifest?.receipts ?? {})).toHaveLength(4); expect(manifest?.calls).toBe(4);
      await f.store.complete(new AbortController().signal); await expect(f.read()).rejects.toThrow('结束');
      const raw = z.record(z.string(), z.json()).parse(manifest?.receipts); expect(await f.store.authorize(raw, f.workspace, f.initial)).toBe(true);
      await fs.writeFile(join(f.workspace, 'source.txt'), `${material} Changed.`); expect(await f.store.authorize(raw, f.workspace, f.initial)).toBe(false);
    } finally { await f.close(); }
  });
  it('binds receipts to exact file bytes, workspace, group and Claim version; rejects forged receipts', async () => {
    const f = await evidenceFixture();
    try {
      await f.read(); await f.store.complete(new AbortController().signal); const manifest = await f.store.read(); const receipts = z.record(z.string(), z.json()).parse(manifest?.receipts);
      await expect(f.store.authorize(receipts, f.root, f.initial)).rejects.toThrow('授权');
      await expect(f.store.authorize(receipts, f.workspace, f.initial.map((claim) => ({ ...claim, confidence: 'high' })))).rejects.toThrow('版本');
      const id = Object.keys(receipts)[0]; if (!id) throw new Error('Missing receipt.'); receipts[id] = { tool: 'file_read', input: { path: 'source.txt' }, output: { content: 'Forged evidence.' } }; await expect(f.store.authorize(receipts, f.workspace, f.initial)).rejects.toThrow('并非');
      await expect(f.store.initialize(f.root, f.initial, f.knowledge.config.dream)).rejects.toThrow('工作区');
    } finally { await f.close(); }
  });
});
