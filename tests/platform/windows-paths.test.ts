// 在所有平台验证 Windows 路径定位；实际文件系统的长路径用例交给 Windows CI。
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('node:path', async () => { const path = await vi.importActual<typeof import('node:path')>('node:path'); return path.win32; });
vi.mock('node:os', () => ({ homedir: () => 'C:\\Users\\user' }));
import { agentHomePath, expandHomePath } from '../../src/store/paths.js';
import { resolveUpstream } from '../../src/upstreams.js';
import { resolveConfig } from '../../src/config.js';

const digest = createHash('sha256').update('agent\0agent-a').digest('hex');
describe('Windows account directory paths', () => {
  it.each(['~/.acn-dsh', '~\\.acn-dsh'])('expands %s and retains upstream separation', (home) => {
    const config = resolveConfig({ home, upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' }, review: { agentId: 'agent-a' } } });
    for (const key of ['coding', 'review']) {
      const selected = resolveUpstream(config, key); if (!selected) throw new Error('Missing upstream.');
      expect(agentHomePath(selected.home, selected.agentId, selected.upstream)).toBe(`C:\\Users\\user\\.acn-dsh\\upstreams\\${key}\\agents\\${digest}`);
    }
  });
  it('preserves absolute drive and UNC roots, spaces and non-ASCII directories', () => {
    expect(agentHomePath('D:\\ACN data\\知识', 'agent-a')).toBe(`D:\\ACN data\\知识\\upstreams\\personal\\agents\\${digest}`);
    expect(agentHomePath('\\\\server\\share\\ACN', 'agent-a')).toBe(`\\\\server\\share\\ACN\\upstreams\\personal\\agents\\${digest}`);
    expect(expandHomePath('~someone')).toBe('~someone');
  });
});
