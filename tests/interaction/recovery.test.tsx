// @vitest-environment jsdom
// 通过实际控件验证失败保存、解绑、冲突恢复及不干扰宿主聊天的降级。
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TeamSettingsPage } from '../../src/client/TeamSettingsPage.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
import { SessionToolbar } from '../../src/client/SessionToolbar.js';
import { KnowledgePanel } from '../../src/client/KnowledgePanel.js';
import { configurationValues } from '../../src/configuration.js';
import type { ConfigurationSnapshot, SaveConfiguration } from '../../src/configuration.js';
import { zh, en } from '../../src/client/locales.js';
import { executeInteraction } from '../../src/dsh-adapter/interaction-service.js';
import { SessionViewSchema } from '../../src/interaction.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const c = (chinese: string) => chinese;
const profile = { name: 'Example', agentId: 'agent-a', routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org', keyEnv: 'EXAMPLE_TEAM_REFERENCE' };
const snapshot: ConfigurationSnapshot = { revision: 'initial', values: configurationValues({ upstream: 'coding', upstreams: { coding: profile } }), models: [], active: true, dataDirectory: '' };
function settings(code?: 'busy' | 'conflict') {
  const old = crypto.randomUUID(); const next = crypto.randomUUID(); const stored = new Map<string, string>([[profile.keyEnv, old]]);
  const api: InteractionApi = {
    read: vi.fn().mockResolvedValue(snapshot), interact: vi.fn(),
    save: vi.fn((request: SaveConfiguration) => Promise.resolve(code ? { ok: false as const, code, fields: [] } : { ok: true as const, snapshot: { ...snapshot, values: request.values } })),
    credential: vi.fn<NonNullable<InteractionApi['credential']>>((request) => {
      if (request.action === 'store') stored.set(request.reference, request.value);
      if (request.action === 'discard') stored.delete(request.reference);
      return Promise.resolve({ ok: true, message: '', configured: request.action !== 'check' && stored.has(request.reference), writable: true });
    }),
  };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} />);
  return { api, stored, old, next };
}
it.each(['busy', 'conflict'] as const)('retains the old key and entered draft when configuration save returns %s', async (code) => {
  const f = settings(code); fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'new-member' } });
  const input = await screen.findByLabelText<HTMLInputElement>('团队鉴权密钥'); fireEvent.change(input, { target: { value: f.next } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByRole('alert'); await waitFor(() => { expect(f.stored.size).toBe(1); });
  expect(f.stored.get(profile.keyEnv)).toBe(f.old); expect(input.value).toBe(f.next);
  const staged = vi.mocked(f.api.save).mock.calls[0]?.[0].values.upstreams?.['coding']?.keyEnv;
  expect(staged).toMatch(/^ACN_TEAM_[0-9A-F]{32}$/); expect(staged).not.toBe(profile.keyEnv);
  expect(JSON.stringify(vi.mocked(f.api.save).mock.calls)).not.toContain(f.next);
  expect(f.api.credential).toHaveBeenCalledWith({ action: 'discard', reference: staged });
});
it('removes only the current configuration key binding and supports undo before save', async () => {
  const f = settings(); fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.click(await screen.findByRole('button', { name: '移除密钥绑定' }));
  expect(screen.getByText(/保存后新启动的会话不再发送团队密钥/)).toBeDefined(); expect(screen.queryByText('已设置密钥。留空保留现有密钥，输入新密钥可替换。')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '撤销移除' }));
  fireEvent.click(screen.getByRole('button', { name: '移除密钥绑定' })); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(f.api.save).toHaveBeenCalled(); });
  expect(vi.mocked(f.api.save).mock.calls[0]?.[0].values.upstreams?.['coding']?.keyEnv).toBe('');
  expect(f.stored.get(profile.keyEnv)).toBe(f.old);
  expect(vi.mocked(f.api.credential as NonNullable<InteractionApi['credential']>).mock.calls.some(([request]) => request?.action === 'discard')).toBe(false);
});
it('refreshes a conflicted version while keeping edits and incorporating untouched remote fields', async () => {
  const f = settings('conflict'); fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText('显示名称（可选）'), { target: { value: 'My draft' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' })); await screen.findByRole('alert');
  const latest = { ...snapshot, revision: 'remote', values: configurationValues({ upstream: 'coding', upstreams: { coding: { ...profile, routerEndpoint: 'https://updated.example.org' } } }) };
  vi.mocked(f.api.read).mockResolvedValue(latest);
  vi.mocked(f.api.save).mockImplementation((request) => Promise.resolve({ ok: true, snapshot: { ...latest, values: request.values } }));
  fireEvent.click(screen.getByRole('button', { name: '刷新并保留草稿' })); await screen.findByText('已刷新远端配置并保留你的修改，请核对后保存。');
  expect(screen.getByLabelText<HTMLInputElement>('显示名称（可选）').value).toBe('My draft');
  expect(screen.getByLabelText<HTMLInputElement>(zh.router).value).toBe('https://updated.example.org');
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(vi.mocked(f.api.save).mock.calls[1]?.[0]).toMatchObject({ revision: 'remote', values: { upstreams: { coding: { name: 'My draft', routerEndpoint: 'https://updated.example.org' } } } }); });
});
it('keeps rejected retry feedback visible after a successful activity refresh and offers settings', async () => {
  const data = { key: 'coding', name: 'Example', items: [], omitted: 0, pendingClaims: 0, pendingDisputes: 0, activities: [{ id: 'job-a', kind: 'inbox', state: 'failed', attempts: 1, updatedAt: 1, unseen: false, summary: 'Failed' }] };
  const reason = '连接已停用或删除，不能重试。'; const open = vi.fn();
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact: vi.fn<InteractionApi['interact']>((request) => Promise.resolve(request.action === 'retry' ? { ok: false, message: reason } : { ok: true, message: '', knowledge: data })) };
  render(<KnowledgePanel api={api} initialKey="coding" initialTab="activity" c={c} openSettings={open} />);
  fireEvent.click(await screen.findByLabelText('inbox · 处理失败')); fireEvent.click(screen.getByRole('button', { name: '重试任务' }));
  await screen.findByText(reason); fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => { expect(vi.mocked(api.interact).mock.calls.filter(([request]) => request.action === 'activity')).toHaveLength(2); });
  expect(screen.getByText(reason)).toBeDefined(); fireEvent.click(screen.getByRole('button', { name: '检查 ACN 设置' })); expect(open).toHaveBeenCalled();
});
const useSession = ((select: (value: { running: boolean; subagent: null }) => unknown) => select({ running: false, subagent: null })) as unknown as ComponentProps<typeof SessionToolbar>['useSession'];
it.each([
  ['blocked', 'bound_identity', '工作配置已停用、缺失或 Agent ID 已改变；请在设置中恢复同一配置及原 Agent ID，或使用新会话。', 'The work configuration is disabled, missing, or its Agent ID changed. Restore the same configuration and original Agent ID, or start a new session.'],
  ['syncing', 'sync_wait', '正在同步团队收件并准备本地知识…', 'Synchronizing the team Inbox and preparing local knowledge…'],
] as const)('localizes the actual composer block reason in English for %s', async (phase, code, message, expected) => {
  const block = vi.fn();
  const view = SessionViewSchema.parse({ sessionId: 'example-session', key: 'coding', name: 'Example', locked: true, available: false, needsPreparation: true, phase, message, messageInfo: { code }, defaultConnection: '', choices: [], showCompletion: true });
  const api: InteractionApi = { read: vi.fn(), save: vi.fn(), interact: vi.fn().mockResolvedValue({ ok: true, message: '', session: view }) };
  render(<SessionToolbar api={api} c={(_zh, english) => english} block={block} sessionId={SessionId('example-session')} useSession={useSession} openSettings={vi.fn()} openKnowledge={vi.fn()} />);
  await waitFor(() => { expect(block).toHaveBeenLastCalledWith('example-session', expected); });
});
it('keeps chat usable when the knowledge component is missing, but still blocks a verified identity mismatch', async () => {
  const host = new Context(); const block = vi.fn();
  const api: InteractionApi = { read: vi.fn(), save: vi.fn(), interact: vi.fn<InteractionApi['interact']>((request, signal) => executeInteraction(host, request, undefined, signal)) };
  try {
    render(<SessionToolbar api={api} c={c} block={block} sessionId={SessionId('example-session')} useSession={useSession} openSettings={vi.fn()} openKnowledge={vi.fn()} />);
    await waitFor(() => { expect(block.mock.calls.at(-1)?.[1]).toBeUndefined(); });
    fireEvent.click(screen.getByRole('button', { name: /ACN/ })); fireEvent.click(await screen.findByRole('menuitem', { name: '重试读取状态' }));
    await waitFor(() => { expect(api.interact).toHaveBeenCalledTimes(2); }); expect(block.mock.calls.at(-1)?.[1]).toBeUndefined();
    cleanup();
    const rejected = SessionViewSchema.parse({ sessionId: 'example-session', key: 'coding', name: 'Example', locked: true, available: false, phase: 'blocked', message: 'Restore original identity.', defaultConnection: '', choices: [], showCompletion: true });
    vi.mocked(api.interact).mockResolvedValue({ ok: true, message: '', session: rejected });
    render(<SessionToolbar api={api} c={c} block={block} sessionId={SessionId('example-session')} useSession={useSession} openSettings={vi.fn()} openKnowledge={vi.fn()} />);
    await waitFor(() => { expect(block).toHaveBeenLastCalledWith('example-session', rejected.message); });
  } finally { cleanup(); await host.fiber.dispose(); }
});
it('automatically rereads a recovered service without rebinding the session', async () => {
  vi.useFakeTimers(); vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  let active = false;
  const view = SessionViewSchema.parse({ sessionId: 'example-session', key: 'coding', name: 'Example', locked: false, available: true, phase: 'ready', message: '', defaultConnection: '', choices: [], showCompletion: true });
  const api: InteractionApi = { read: vi.fn(), save: vi.fn(), interact: vi.fn<InteractionApi['interact']>(() => Promise.resolve(active ? { ok: true, message: '', session: view } : { ok: false, message: '知识组件尚未启用，聊天仍可继续。', serviceAvailable: false })) };
  const block = vi.fn();
  render(<SessionToolbar api={api} c={c} block={block} sessionId={SessionId('example-session')} useSession={useSession} openSettings={vi.fn()} openKnowledge={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); active = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(screen.getByRole('button', { name: /ACN.*Example/ })).toBeDefined(); expect(block.mock.calls.at(-1)?.[1]).toBeUndefined();
  expect(vi.mocked(api.interact).mock.calls.every(([request]) => request.action !== 'select')).toBe(true);
});
it.each([zh, en])('provides a real plugin management entry when the knowledge component is inactive', async (locale) => {
  const open = vi.fn(); const api: InteractionApi = { read: vi.fn().mockResolvedValue({ ...snapshot, active: false }), save: vi.fn(), interact: vi.fn() };
  render(<TeamSettingsPage api={api} t={(key) => locale[key]} openKnowledge={vi.fn()} openPlugins={open} />);
  fireEvent.click(await screen.findByRole('button', { name: locale === zh ? '前往插件管理' : 'Open plugin manager' })); expect(open).toHaveBeenCalled();
});
it('keeps budget closure, unfinished groups and terminal delivery distinct in English', async () => {
  const { ActivityDetails } = await import('../../src/client/ActivityDetails.js');
  const { ActivitySchema } = await import('../../src/interaction.js'); const action = vi.fn();
  const partial = ActivitySchema.parse({ id: 'dream-a', kind: 'dream', state: 'succeeded', attempts: 1, updatedAt: 1, summary: '额度收尾', budgetLimited: true, counts: { modelSteps: 2 }, incompleteCandidates: [{ groupId: 'group-a', claimIds: ['claim_00000001'], reason: '额度已耗尽' }] });
  const copy = (_zh: string, english: string) => english;
  const mounted = render(<ActivityDetails api={{ read: vi.fn(), save: vi.fn(), interact: vi.fn() }} item={partial} runtimeKey="coding" busy={false} c={copy} action={action} openClaim={vi.fn()} />);
  expect(mounted.container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  fireEvent.click(screen.getByRole('button', { name: 'Start a new Dream' })); expect(action).toHaveBeenCalledWith({ action: 'dream_again', key: 'coding', id: 'dream-a' });
  mounted.unmount();
  const rejected = ActivitySchema.parse({ id: 'delivery-a', kind: 'delivery', state: 'rejected', attempts: 0, updatedAt: 1, summary: '团队拒绝，未投递', summaryInfo: { code: 'delivery.rejected', entityId: 'dispute_00000001', status: 409 } });
  render(<ActivityDetails api={{ read: vi.fn(), save: vi.fn(), interact: vi.fn() }} item={rejected} runtimeKey="coding" busy={false} c={copy} action={action} openClaim={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Retry task' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Retry team delivery' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Mark acknowledged' })); expect(action).toHaveBeenCalledWith({ action: 'ack', key: 'coding', id: 'delivery-a', version: 1 });
});

it('merges an untouched team toggle and key reference changed by another window', async () => {
  const solo = { ...profile, routerEndpoint: '', maintainerEndpoint: '', keyEnv: '' };
  const initial = { ...snapshot, values: configurationValues({ upstream: 'coding', upstreams: { coding: solo } }) };
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(initial), save: vi.fn().mockResolvedValue({ ok: false, code: 'conflict', fields: [] }), interact: vi.fn(), credential: vi.fn().mockResolvedValue({ ok: true, message: '', configured: true, writable: true }) };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.change(screen.getByLabelText('显示名称（可选）'), { target: { value: 'Draft name' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' })); await screen.findByRole('alert');
  vi.mocked(api.read).mockResolvedValue({ ...snapshot, revision: 'new-team' });
  fireEvent.click(screen.getByRole('button', { name: '刷新并保留草稿' })); await screen.findByLabelText('团队鉴权密钥');
  expect(screen.getByRole<HTMLInputElement>('switch', { name: '连接团队服务' }).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(vi.mocked(api.save).mock.calls[1]?.[0].values.upstreams?.['coding']).toMatchObject({ name: 'Draft name', routerEndpoint: profile.routerEndpoint, keyEnv: profile.keyEnv }); });
});
it('retains a staged key when the save outcome is unknown rather than racing the server commit', async () => {
  const f = settings(); vi.mocked(f.api.save).mockRejectedValue(new Error('Connection closed.'));
  fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  const input = await screen.findByLabelText<HTMLInputElement>('团队鉴权密钥');fireEvent.change(input, { target: { value: f.next } });fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByRole('alert');expect(input.value).toBe(f.next);expect(f.stored.size).toBe(2);
  expect(vi.mocked(f.api.credential as NonNullable<InteractionApi['credential']>).mock.calls.some(([request]) => request.action === 'discard')).toBe(false);
});

it('requires choosing a complete connection when both windows changed it', async () => {
  const f = settings('conflict');fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText(zh.router), { target: { value: 'https://local.example.org' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));await screen.findByRole('alert');
  vi.mocked(f.api.read).mockResolvedValue({ ...snapshot, revision: 'remote-team', values: configurationValues({ upstream: 'coding', upstreams: { coding: { ...profile, routerEndpoint: 'https://remote.example.org', keyEnv: 'OTHER_TEAM_REFERENCE' } } }) });
  fireEvent.click(screen.getByRole('button', { name: '刷新并保留草稿' }));await screen.findByRole('button', { name: '保留我的团队连接' });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存配置' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '保留我的团队连接' }));fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(vi.mocked(f.api.save).mock.calls[1]?.[0].values.upstreams?.['coding']).toMatchObject({ routerEndpoint: 'https://local.example.org', keyEnv: profile.keyEnv }); });
});
it('reuses the staged reference after the key store response is lost', async () => {
  const f = settings();const credential = vi.mocked(f.api.credential as NonNullable<InteractionApi['credential']>);const handler = credential.getMockImplementation();let interrupted = false;
  credential.mockImplementation(async (request, signal) => { if (!handler) throw new Error('Missing mock.'); const result = await handler(request, signal);if (request.action === 'store' && !interrupted) { interrupted = true;throw new Error('Response lost after store.'); }return result; });
  fireEvent.click(await screen.findByRole('button', { name: '配置' }));fireEvent.change(await screen.findByLabelText('团队鉴权密钥'), { target: { value: f.next } });fireEvent.click(screen.getByRole('button', { name: '保存配置' }));await screen.findByRole('alert');
  expect(f.api.save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button', { name: '保存配置' }));await waitFor(() => { expect(f.api.save).toHaveBeenCalledTimes(1); });
  const stored = credential.mock.calls.filter(([request]) => request.action === 'store');expect(stored).toHaveLength(1);
  const original = stored[0]?.[0];if (original?.action !== 'store') throw new Error('Expected store.');
  expect(vi.mocked(f.api.save).mock.calls[0]?.[0].values.upstreams?.['coding']?.keyEnv).toBe(original.reference);
});
