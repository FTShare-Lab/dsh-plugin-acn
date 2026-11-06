// 本地 Windows 名称与导入解析独立验证，macOS 沿用原命令与协议 ID。
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { invalidStorageName } from '../../src/store/path-names.js';
import { agentHomePath } from '../../src/store/paths.js';
import { importWords } from '../../src/commands/import.js';
import { commandWords } from '../../src/commands/claim.js';
import { AgentIdSchema } from '../../src/protocol/ids.js';
import { resolveConfig } from '../../src/config.js';
import { resolveUpstream } from '../../src/upstreams.js';

describe('local directory names', () => {
  it.each(['con', 'PRN', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9', 'nul.txt'])('rejects the Windows device name %s without changing other platforms', (name) => {
    expect(invalidStorageName(name, 'win32')).toBe(true);
    expect(invalidStorageName(name, 'darwin')).toBe(false);
  });
  it.each(['coding', 'agent-a', 'concurrent', 'aux-agent', 'com10', 'lpt0'])('accepts %s on Windows', (name) => { expect(invalidStorageName(name, 'win32')).toBe(false); });
  it('keeps protocol IDs independent of local filesystem validation', () => {
    expect(AgentIdSchema.parse('con')).toBe('con');
    const config = resolveConfig({ upstream: 'nul', upstreams: { nul: { agentId: 'agent-a' } } });
    if (process.platform === 'win32') { expect(agentHomePath('D:/ACN', 'con')).toContain('upstreams'); expect(() => resolveUpstream(config, 'nul')).toThrow(/Windows reserved/); }
    else { expect(agentHomePath('~/.acn-dsh', 'con')).toBe(join(homedir(), '.acn-dsh', 'upstreams', 'personal', 'agents', createHash('sha256').update('agent\0con').digest('hex'))); expect(resolveUpstream(config, 'nul')).toBeDefined(); }
  });
});
describe('Windows import paths', () => {
  it.each([
    [String.raw`D:\ACN\agent-a`, String.raw`D:\ACN\agent-a`],
    [String.raw`"D:\ACN data\知识\agent-a"`, String.raw`D:\ACN data\知识\agent-a`],
    [String.raw`'D:\ACN data\agent-a'`, String.raw`D:\ACN data\agent-a`],
    [String.raw`"D:\temp\new\user"`, String.raw`D:\temp\new\user`],
    [String.raw`"D:\u005cdata"`, String.raw`D:\u005cdata`],
    [String.raw`"D:\"`, 'D:\\'],
    [String.raw`\\server\share\agent-a`, String.raw`\\server\share\agent-a`],
    [String.raw`"\\server\share data\agent-a"`, String.raw`\\server\share data\agent-a`],
    [String.raw`~\data\agent-a`, String.raw`~\data\agent-a`],
    [String.raw`.\data\agent-a`, String.raw`.\data\agent-a`],
    [String.raw`"data folder\agent-a"`, String.raw`data folder\agent-a`],
    ['"D:/ACN data/agent-a"', 'D:/ACN data/agent-a'],
    [JSON.stringify(String.raw`D:\ACN data\agent-a`), String.raw`D:\ACN data\agent-a`],
    [JSON.stringify(String.raw`\\server\share data\agent-a`), String.raw`\\server\share data\agent-a`],
  ])('preserves the import path %s', (input, expected) => { expect(importWords(`--dry-run ${input}`, 'win32')).toEqual(['--dry-run', expected]); });
  it.each(['"D:\\ACN', '"D:\\ACN"suffix'])('rejects invalid quoting in %s', (input) => { expect(() => importWords(input, 'win32')).toThrow(); });
  it('keeps the existing POSIX lexer and Claim text escaping', () => {
    const input = String.raw`--dry-run /tmp/old\ data/agent-a`;
    expect(importWords(input, 'darwin')).toEqual(['--dry-run', '/tmp/old data/agent-a']);
    expect(commandWords(String.raw`set claim_00000001 statement="a \"quoted\" value"`)).toEqual(['set', 'claim_00000001', 'statement=a "quoted" value']);
  });
});
