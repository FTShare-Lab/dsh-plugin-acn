// 展示回执在真实磁盘中跨重启保留，旧结果与未读结果不混淆。
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PresentationStore } from '../../src/store/presentation.js';
import { context } from '../helpers.js';

it('keeps its upgrade baseline and acknowledgements across instances without regressing a newer task version', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'acn-presentation-'));
  try {
    const store = new PresentationStore(context(root)); expect(await store.read()).toBeNull();
    await store.initialize(); const baseline = (await store.read())?.baselineAt; expect(baseline).toBeTypeOf('number');
    await Promise.all([store.acknowledge('job-a', 10), store.acknowledge('job-b', 20)]);
    const restarted = new PresentationStore(context(root)); await restarted.initialize();
    expect(await restarted.read()).toEqual({ schemaVersion: 1, baselineAt: baseline, seen: { 'job-a': 10, 'job-b': 20 } });
    await restarted.acknowledge('job-a', 30); await store.acknowledge('job-a', 10);
    expect((await restarted.read())?.seen['job-a']).toBe(30);
    expect((await fs.readFile(join(root, 'presentation.yaml'), 'utf8'))).not.toContain('statement');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
