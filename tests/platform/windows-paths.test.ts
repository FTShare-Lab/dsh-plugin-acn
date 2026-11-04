// 在所有 CI 平台直接执行 Windows 路径实现；不把路径模拟当作 Windows 文件系统验收。
import { describe, expect, it, vi } from 'vitest';
vi.mock('node:path', async () => { const path = await vi.importActual<typeof import('node:path')>('node:path'); return path.win32; });
vi.mock('node:os', () => ({ homedir: () => 'C:\\Users\\user' }));
import { agentHomePath, expandHomePath } from '../../src/store/paths.js';
import { resolveUpstream } from '../../src/upstreams.js';
import { resolveConfig } from '../../src/config.js';

describe('Windows home paths', () => {
  it.each(['~/.acn-dsh', '~\\.acn-dsh'])('expands %s after upstream selection without a cwd-relative tilde directory', (home) => {
    const config = resolveConfig({ home, upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } } });
    const selected = resolveUpstream(config, 'coding'); if (!selected) throw new Error('Missing upstream.');
    expect(agentHomePath(selected.home, selected.agentId)).toBe('C:\\Users\\user\\.acn-dsh\\coding\\data\\agents\\agent-a');
  });
  it.each([
    ['base', undefined, 'C:\\Users\\user\\.acn-dsh\\agents\\agent-a'],
    ['personal', undefined, 'C:\\Users\\user\\.acn-dsh\\personal\\agents\\agent-a'],
    ['connection', 'previous', 'C:\\Users\\user\\.acn-dsh\\connections\\previous\\agents\\agent-a'],
  ] as const)('keeps the %s legacy mapping', (legacyStorage, legacyKey, expected) => {
    const config = resolveConfig({ upstream: 'coding', upstreams: { coding: { agentId: 'agent-a', legacyStorage, ...(legacyKey === undefined ? {} : { legacyKey }) } } });
    const selected = resolveUpstream(config, 'coding'); if (!selected) throw new Error('Missing upstream.');
    expect(agentHomePath(selected.home, selected.agentId)).toBe(expected);
  });
  it('preserves absolute drive and UNC homes, spaces and non-ASCII directories', () => {
    expect(agentHomePath('D:\\ACN data\\知识', 'agent-a')).toBe('D:\\ACN data\\知识\\agents\\agent-a');
    expect(agentHomePath('\\\\server\\share\\ACN', 'agent-a')).toBe('\\\\server\\share\\ACN\\agents\\agent-a');
    expect(expandHomePath('~someone')).toBe('~someone');
  });
});
