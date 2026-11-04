// 实际文件工具与搜索工具经过最终门禁；canonical 别名、硬链接及其他 Agent 均受保护。
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import Approval from '@deepseek-ai/dsh-user-approval';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptAdapter } from '../flow/adapter.js';
import { flowHarness } from '../flow/harness.js';

const active: Awaited<ReturnType<typeof flowHarness>>[] = [];
async function setup(disabled = false) {
  const f = await flowHarness(new ScriptAdapter([]), { memory: true, filesystem: true, config: { memory: { enabled: !disabled } } }); active.push(f);
  await f.ctx.plugin(FileTools); await f.ctx.plugin(LocalSubprocess); await f.ctx.plugin(SearchTools, { sampleOverCapGlobResults: false });
  const paths = f.knowledge.context().paths; await fs.mkdir(paths.memories, { recursive: true }); await fs.writeFile(paths.memory, 'PRIVATE_FILE_MARKER'); await fs.writeFile(paths.user, 'PRIVATE_USER_MARKER');
  const workspace = join(f.root, 'workspace'); await fs.mkdir(workspace); await fs.writeFile(join(workspace, 'notes.txt'), 'public example');
  const agent = await f.create(); await f.ctx.workingDirectory.set(agent, workspace);
  const call = (name: string, args: unknown) => f.ctx.tools.execute({ name, arguments: args, agent, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
  return { f, paths, workspace, agent, call };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(active.splice(0).map((f) => f.close())); });

describe('private filesystem permissions', () => {
  it('permits public hardlinks and project searches even with linked build artifacts', async () => {
    const { workspace, call } = await setup();
    await fs.mkdir(join(workspace, 'target')); await fs.writeFile(join(workspace, '.gitignore'), 'target/\n');
    await fs.writeFile(join(workspace, 'target', 'build-a'), 'public build');
    await fs.link(join(workspace, 'target', 'build-a'), join(workspace, 'target', 'build-b'));
    await fs.link(join(workspace, 'notes.txt'), join(workspace, 'public-link.txt'));
    expect(await call('read', { file_path: 'public-link.txt' })).toMatchObject({ isError: false });
    expect(await call('glob', { pattern: '*.txt' })).toMatchObject({ isError: false });
    expect(await call('grep', { pattern: 'public' })).toMatchObject({ isError: false });
  });
  it('protects stored private files of a connection before its runtime has ever been activated', async () => {
    const { call, f } = await setup();
    const path = join(f.knowledge.config.home, 'connections', 'unused-team', 'agents', 'member-b', 'memories', 'USER.md');
    await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'UNUSED_TEAM_PRIVATE_MARKER');
    expect(await call('read', { file_path: path })).toMatchObject({ isError: true });
    expect(await call('glob', { path: join(f.knowledge.config.home, 'connections'), pattern: '**/*' })).toMatchObject({ isError: true });
    expect(await fs.readFile(path, 'utf8')).toBe('UNUSED_TEAM_PRIVATE_MARKER');
  });
  it.each([false, true])('protects read/write/edit/search with Memory disabled=%s and permits normal workspace tools', async (disabled) => {
    const { call, paths, workspace } = await setup(disabled);
    const read = await call('read', { file_path: 'notes.txt' }); expect(read, JSON.stringify(read)).toMatchObject({ isError: false });
    expect(await call('write', { file_path: 'new.txt', content: 'new public example' })).toMatchObject({ isError: false });
    expect(await call('edit', { file_path: 'new.txt', old_string: 'new public', new_string: 'edited public' })).toMatchObject({ isError: false });
    expect(await fs.readFile(join(workspace, 'new.txt'), 'utf8')).toBe('edited public example');
    expect(await call('grep', { pattern: 'public' })).toMatchObject({ isError: false }); expect(await call('glob', { pattern: '*.txt' })).toMatchObject({ isError: false });
    for (const [name, args] of [['read', { file_path: paths.memory }], ['write', { file_path: paths.user, content: 'forbidden' }], ['edit', { file_path: paths.memory, old_string: 'PRIVATE', new_string: 'changed' }], ['grep', { path: paths.memories, pattern: '.' }], ['glob', { path: paths.memories, pattern: '**/*' }]] as const) {
      const result = await call(name, args); expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).not.toContain('PRIVATE_FILE_MARKER'); expect(JSON.stringify(result)).not.toContain('PRIVATE_USER_MARKER');
    }
    expect(await fs.readFile(paths.memory, 'utf8')).toBe('PRIVATE_FILE_MARKER'); expect(await fs.readFile(paths.user, 'utf8')).toBe('PRIVATE_USER_MARKER');
  });
  it.each(['file-symlink', 'directory-symlink', 'hardlink', 'other-agent', 'snapshot', 'receipt'] as const)('rejects private alias or copy %s', async (kind) => {
    const { paths, workspace, call } = await setup(); let path = paths.memory;
    if (kind === 'file-symlink') { path = join(workspace, 'alias.txt'); await fs.symlink(paths.memory, path); }
    if (kind === 'directory-symlink') { await fs.symlink(paths.memories, join(workspace, 'alias')); path = join(workspace, 'alias', 'MEMORY.md'); }
    if (kind === 'hardlink') { path = join(workspace, 'alias.txt'); await fs.link(paths.memory, path); }
    if (kind === 'other-agent') { path = join(dirname(paths.root), 'agent-b', 'memories', 'USER.md'); await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'PRIVATE_OTHER_MARKER'); }
    if (kind === 'snapshot') path = paths.sessionState('session-a');
    if (kind === 'receipt') { path = paths.memoryReceipt('receipt-a'); await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'PRIVATE_RECEIPT_MARKER'); }
    const result = await call('read', { file_path: path }); expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_(?:FILE|OTHER|RECEIPT)_MARKER/);
  });
  it('rejects directory reads and recursive search above private data, including default live cwd', async () => {
    const { f, call, paths, agent } = await setup();
    for (const root of [dirname(paths.root), f.root]) { expect(await call('read', { file_path: root })).toMatchObject({ isError: true }); expect(await call('grep', { path: root, pattern: 'PRIVATE' })).toMatchObject({ isError: true }); expect(await call('glob', { path: root, pattern: '**/*' })).toMatchObject({ isError: true }); }
    await f.ctx.workingDirectory.set(agent, paths.memories);
    expect(await call('read', { file_path: 'USER.md' })).toMatchObject({ isError: true }); expect(await call('glob', { pattern: '**/*' })).toMatchObject({ isError: true }); expect(await call('grep', { pattern: 'PRIVATE' })).toMatchObject({ isError: true });
  });
  it('does not authorize a later rewritten path or a policy that bypasses prior guards', async () => {
    const { f, paths, call } = await setup();
    const mutation = f.ctx.on('tools/pre-execute', async (execution, next) => { const decision = await next(); if (execution.name === 'read' && typeof execution.arguments === 'object' && execution.arguments !== null) Object.assign(execution.arguments, { file_path: paths.memory }); return decision; }, { prepend: true });
    expect(await call('read', { file_path: 'notes.txt' })).toMatchObject({ isError: true }); mutation();
    f.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true }); expect(await call('read', { file_path: paths.memory })).toMatchObject({ isError: true });
  });
  it('keeps the provider write/edit intent guards active independently of file tools', async () => {
    const { f, paths } = await setup(); const target = await f.ctx.fs.resolve(paths.memory);
    await expect(f.ctx.waterfall('fs/write-intent', target, undefined, () => undefined)).rejects.toThrow('私有'); await expect(f.ctx.waterfall('fs/edit-intent', target, undefined, () => undefined)).rejects.toThrow('私有');
    expect(await fs.readFile(paths.memory, 'utf8')).toBe('PRIVATE_FILE_MARKER');
  });
  it('blocks recursive searches over hard-link aliases and rejects cwd changes during an async policy', async () => {
    const { f, paths, workspace, call, agent } = await setup(); await fs.link(paths.memory, join(workspace, 'linked.txt'));
    expect(await call('grep', { pattern: 'PRIVATE' })).toMatchObject({ isError: true }); expect(await call('glob', { pattern: '**/*' })).toMatchObject({ isError: true });
    await fs.unlink(join(workspace, 'linked.txt'));
    f.ctx.on('tools/pre-execute', async (_execution, next) => { const result = await next(); await f.ctx.workingDirectory.set(agent, paths.memories); return result; }, { prepend: true });
    expect(await call('read', { file_path: 'notes.txt' })).toMatchObject({ isError: true });
  });
  it('allows approved public paths and rechecks cwd after approval; private paths never request approval', async () => {
    const { f, paths, call, agent } = await setup(); await f.ctx.plugin(Approval);
    const ask = vi.spyOn(f.ctx.approval, 'request').mockResolvedValue('allowed-once');
    f.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'ask' }));
    expect(await call('read', { file_path: 'notes.txt' })).toMatchObject({ isError: false }); expect(ask).toHaveBeenCalledTimes(1);
    expect(await call('read', { file_path: paths.memory })).toMatchObject({ isError: true }); expect(ask).toHaveBeenCalledTimes(1);
    ask.mockImplementation(async () => { await f.ctx.workingDirectory.set(agent, paths.memories); return 'allowed-once'; });
    expect(await call('read', { file_path: 'notes.txt' })).toMatchObject({ isError: true });
  });
});
