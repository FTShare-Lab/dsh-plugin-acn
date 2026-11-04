// 同时保留原有命令转义与原生目录分隔符，真实平台用例交给对应 CI 执行。
import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { commandWords } from '../../src/commands/claim.js';
import { expandHomePath } from '../../src/store/paths.js';
import { portableLocalName } from '../../src/local-name.js';
import { resolveConfig } from '../../src/config.js';

describe('native directory arguments', () => {
  it.each([String.raw`C:\Users\user\agent`, String.raw`C:\Work Folder\知识\agent`, String.raw`\\server\share\Work Folder\agent`, 'C:\\Work Folder\\'])('keeps quoted separators for %s', (path) => {
    const words = commandWords(`--dry-run "${path}"`, true);
    expect(words).toEqual(['--dry-run', path]); expect(win32.normalize(words[1] ?? '')).toBe(win32.normalize(path));
  });
  it('keeps existing escaped whitespace and quoted revisions for other commands', () => {
    expect(commandWords(String.raw`/tmp/work\ folder 'expected_revision=sha256-v1:123'`)).toEqual(['/tmp/work folder', 'expected_revision=sha256-v1:123']);
  });
  it.each(['con', 'CON', 'nul', 'NUL.txt', 'prn', 'aux', 'com1', 'LPT9'])('recognizes reserved local component %s', (name) => { expect(portableLocalName(name)).toBe(false); });
  it.each(['agent-a', 'con-team', 'console', 'company', 'lpt10'])('accepts ordinary component %s', (name) => { expect(portableLocalName(name)).toBe(true); });
  it.runIf(process.platform === 'win32')('expands a backslash home prefix and rejects reserved configuration directories', () => {
    expect(expandHomePath(String.raw`~\Work Folder\知识`)).toBe(join(homedir(), 'Work Folder', '知识'));
    expect(() => resolveConfig({ agentId: 'con' })).toThrow();
    expect(() => resolveConfig({ upstreams: { nul: { agentId: 'agent-a' } } })).toThrow();
  });
  it.skipIf(process.platform === 'win32')('preserves previously valid names on other platforms', () => { expect(resolveConfig({ agentId: 'con' }).agentId).toBe('con'); });
});
