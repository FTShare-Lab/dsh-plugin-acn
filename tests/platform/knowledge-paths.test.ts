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
async function setup() {
  const f = await flowHarness(new ScriptAdapter([]), { filesystem: true }); active.push(f);
  await f.ctx.plugin(FileTools); await f.ctx.plugin(LocalSubprocess); await f.ctx.plugin(SearchTools, { sampleOverCapGlobResults: false });
  const paths = f.knowledge.context().paths; await fs.mkdir(paths.claims, { recursive: true }); await fs.writeFile(join(paths.claims, 'claim_00000009.yaml'), 'PRIVATE_FILE_MARKER'); await fs.writeFile(join(paths.claims, 'claim_00000008.yaml'), 'PRIVATE_USER_MARKER');
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
    const path = join(f.knowledge.config.home, 'upstreams', 'unused-team', 'agents', 'another-identity', 'claims', 'claim_00000009.yaml');
    await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'UNUSED_TEAM_PRIVATE_MARKER');
    expect(await call('read', { file_path: path })).toMatchObject({ isError: true });
    expect(await call('glob', { path: join(f.knowledge.config.home, 'upstreams'), pattern: '**/*' })).toMatchObject({ isError: true });
    expect(await fs.readFile(path, 'utf8')).toBe('UNUSED_TEAM_PRIVATE_MARKER');
  });
  it('protects read/write/edit/search and permits normal workspace tools', async () => {
    const { call, paths, workspace } = await setup();
    const read = await call('read', { file_path: 'notes.txt' }); expect(read, JSON.stringify(read)).toMatchObject({ isError: false });
    expect(await call('write', { file_path: 'new.txt', content: 'new public example' })).toMatchObject({ isError: false });
    expect(await call('edit', { file_path: 'new.txt', old_string: 'new public', new_string: 'edited public' })).toMatchObject({ isError: false });
    expect(await fs.readFile(join(workspace, 'new.txt'), 'utf8')).toBe('edited public example');
    expect(await call('grep', { pattern: 'public' })).toMatchObject({ isError: false }); expect(await call('glob', { pattern: '*.txt' })).toMatchObject({ isError: false });
    for (const [name, args] of [['read', { file_path: join(paths.claims, 'claim_00000009.yaml') }], ['write', { file_path: join(paths.claims, 'claim_00000008.yaml'), content: 'forbidden' }], ['edit', { file_path: join(paths.claims, 'claim_00000009.yaml'), old_string: 'PRIVATE', new_string: 'changed' }], ['grep', { path: paths.claims, pattern: '.' }], ['glob', { path: paths.claims, pattern: '**/*' }]] as const) {
      const result = await call(name, args); expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).not.toContain('PRIVATE_FILE_MARKER'); expect(JSON.stringify(result)).not.toContain('PRIVATE_USER_MARKER');
    }
    expect(await fs.readFile(join(paths.claims, 'claim_00000009.yaml'), 'utf8')).toBe('PRIVATE_FILE_MARKER'); expect(await fs.readFile(join(paths.claims, 'claim_00000008.yaml'), 'utf8')).toBe('PRIVATE_USER_MARKER');
  });
  it.each(['file-symlink', 'directory-symlink', 'hardlink', 'other-agent', 'snapshot', 'receipt'] as const)('rejects private alias or copy %s', async (kind) => {
    const { paths, workspace, call } = await setup(); let path = join(paths.claims, 'claim_00000009.yaml');
    if (kind === 'file-symlink') { path = join(workspace, 'alias.txt'); await fs.symlink(join(paths.claims, 'claim_00000009.yaml'), path); }
    if (kind === 'directory-symlink') { await fs.symlink(paths.claims, join(workspace, 'alias')); path = join(workspace, 'alias', 'claim_00000009.yaml'); }
    if (kind === 'hardlink') { path = join(workspace, 'alias.txt'); await fs.link(join(paths.claims, 'claim_00000009.yaml'), path); }
    if (kind === 'other-agent') { path = join(dirname(paths.root), 'agent-b', 'claims', 'claim_00000009.yaml'); await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'PRIVATE_OTHER_MARKER'); }
    if (kind === 'snapshot') path = paths.sessionState('session-a');
    if (kind === 'receipt') { path = join(paths.root, 'receipts', 'receipt-a.yaml'); await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'PRIVATE_RECEIPT_MARKER'); }
    const result = await call('read', { file_path: path }); expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_(?:FILE|OTHER|RECEIPT)_MARKER/);
  });
  it('rejects directory reads and recursive search above private data, including default live cwd', async () => {
    const { f, call, paths, agent } = await setup();
    for (const root of [dirname(paths.root), f.root]) { expect(await call('read', { file_path: root })).toMatchObject({ isError: true }); expect(await call('grep', { path: root, pattern: 'PRIVATE' })).toMatchObject({ isError: true }); expect(await call('glob', { path: root, pattern: '**/*' })).toMatchObject({ isError: true }); }
    await f.ctx.workingDirectory.set(agent, paths.claims);
    expect(await call('read', { file_path: 'USER.md' })).toMatchObject({ isError: true }); expect(await call('glob', { pattern: '**/*' })).toMatchObject({ isError: true }); expect(await call('grep', { pattern: 'PRIVATE' })).toMatchObject({ isError: true });
  });
  it('does not authorize a later rewritten path or a policy that bypasses prior guards', async () => {
    const { f, paths, call } = await setup();
    const mutation = f.ctx.on('tools/pre-execute', async (execution, next) => { const decision = await next(); if (execution.name === 'read' && typeof execution.arguments === 'object' && execution.arguments !== null) Object.assign(execution.arguments, { file_path: join(paths.claims, 'claim_00000009.yaml') }); return decision; }, { prepend: true });
    expect(await call('read', { file_path: 'notes.txt' })).toMatchObject({ isError: true }); mutation();
    f.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true }); expect(await call('read', { file_path: join(paths.claims, 'claim_00000009.yaml') })).toMatchObject({ isError: true });
  });
  it('keeps the provider write/edit intent guards active independently of file tools', async () => {
    const { f, paths } = await setup(); const target = await f.ctx.fs.resolve(join(paths.claims, 'claim_00000009.yaml'));
    await expect(f.ctx.waterfall('fs/write-intent', target, undefined, () => undefined)).rejects.toThrow('私有'); await expect(f.ctx.waterfall('fs/edit-intent', target, undefined, () => undefined)).rejects.toThrow('私有');
    expect(await fs.readFile(join(paths.claims, 'claim_00000009.yaml'), 'utf8')).toBe('PRIVATE_FILE_MARKER');
  });
  it('blocks recursive searches over hard-link aliases and rejects cwd changes during an async policy', async () => {
    const { f, paths, workspace, call, agent } = await setup(); await fs.link(join(paths.claims, 'claim_00000009.yaml'), join(workspace, 'linked.txt'));
    expect(await call('grep', { pattern: 'PRIVATE' })).toMatchObject({ isError: true }); expect(await call('glob', { pattern: '**/*' })).toMatchObject({ isError: true });
    await fs.unlink(join(workspace, 'linked.txt'));
    f.ctx.on('tools/pre-execute', async (_execution, next) => { const result = await next(); await f.ctx.workingDirectory.set(agent, paths.claims); return result; }, { prepend: true });
    expect(await call('read', { file_path: 'notes.txt' })).toMatchObject({ isError: true });
  });
  it('allows approved public paths and rechecks cwd after approval; private paths never request approval', async () => {
    const { f, paths, call, agent } = await setup(); await f.ctx.plugin(Approval);
    const ask = vi.spyOn(f.ctx.approval, 'request').mockResolvedValue('allowed-once');
    f.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'ask' }));
    expect(await call('read', { file_path: 'notes.txt' })).toMatchObject({ isError: false }); expect(ask).toHaveBeenCalledTimes(1);
    expect(await call('read', { file_path: join(paths.claims, 'claim_00000009.yaml') })).toMatchObject({ isError: true }); expect(ask).toHaveBeenCalledTimes(1);
    ask.mockImplementation(async () => { await f.ctx.workingDirectory.set(agent, paths.claims); return 'allowed-once'; });
    expect(await call('read', { file_path: 'notes.txt' })).toMatchObject({ isError: true });
  });
});
