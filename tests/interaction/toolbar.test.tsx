// @vitest-environment jsdom
// 页面读取保持已有归属；同步失败提示与结果弹层不撑开输入框。
import type { ComponentProps } from 'react';
import { SessionId } from '@deepseek-ai/dsh-session';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionToolbar, composerBlockReason } from '../../src/client/SessionToolbar.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
import { SessionViewSchema } from '../../src/interaction.js';
import type { InteractionResult } from '../../src/interaction.js';

afterEach(cleanup);
const c = (zh: string) => zh;
const useSession = ((select: (value: { running: boolean; subagent: null }) => unknown) => select({ running: false, subagent: null })) as unknown as ComponentProps<typeof SessionToolbar>['useSession'];
it.each([false, true])('keeps an explicit legacy selection after reopening, prepared=%s', async (prepared) => {
  const view = SessionViewSchema.parse({ sessionId: 'session-a', key: 'legacy', name: '原有团队连接', locked: false, available: true, explicitSelection: true, phase: prepared ? 'ready' : 'failed', needsPreparation: !prepared, message: prepared ? '' : '首次同步失败。', defaultConnection: '', showCompletion: true, choices: [] });
  const interact = vi.fn<InteractionApi['interact']>().mockImplementation((request): Promise<InteractionResult> => Promise.resolve({ ok: true, message: '', ...request.action === 'session' ? { session: view } : {} }));
  const api: InteractionApi = { interact, read: vi.fn(), save: vi.fn() }; const block = vi.fn();
  render(<SessionToolbar api={api} c={c} block={block} sessionId={SessionId('session-a')} useSession={useSession} openSettings={vi.fn()} openKnowledge={vi.fn()} />);
  await screen.findByRole('button', { name: /ACN.*原有团队连接/ });
  await waitFor(() => { expect(block).toHaveBeenCalledWith('session-a', composerBlockReason(view)); });
  expect(interact.mock.calls.some(([request]) => request.action === 'select')).toBe(false);
  expect(composerBlockReason(view)).toBeUndefined();
});
const teamChoice = { key: 'team-a', name: '示例团队', mode: 'team', enabled: true, agentId: 'member' };
const soloChoice = { key: 'personal', name: '单人模式', mode: 'solo', enabled: true, agentId: 'example' };
function composer(team: boolean, failed = false) {
  const view = SessionViewSchema.parse({ sessionId: 'session-a', key: team ? 'team-a' : 'personal', name: team ? teamChoice.name : soloChoice.name, locked: team && !failed, available: true, phase: failed ? 'failed' : 'ready', needsPreparation: failed, message: failed ? '首次收件失败。' : '上次操作成功。', choices: [soloChoice, teamChoice], defaultConnection: '', showCompletion: true });
  const interact = vi.fn<InteractionApi['interact']>().mockImplementation((request): Promise<InteractionResult> => {
    if (request.action === 'session') return Promise.resolve({ ok: true, session: view, message: '' });
    if (request.action === 'sync') return Promise.resolve({ ok: true, session: { ...view, phase: 'ready', needsPreparation: false, message: '收件同步完成：拉取 0 条。' }, message: '' });
    return Promise.resolve({ ok: true, message: '没有可复盘的新增内容。' });
  });
  const block = vi.fn(); const openSettings = vi.fn(); const openKnowledge = vi.fn();
  const { container } = render(<SessionToolbar api={{ read: vi.fn(), save: vi.fn(), interact }} sessionId={SessionId('session-a')} useSession={useSession} c={c} block={block} openSettings={openSettings} openKnowledge={openKnowledge} />);
  return { container, block, openSettings, openKnowledge, interact };
}
it('keeps one composer button in solo mode even with saved teams; existing status is not replayed', async () => {
  const { container, interact } = composer(false);
  await waitFor(() => { expect(interact).toHaveBeenCalled(); });
  const button = within(container).getByRole('button'); fireEvent.click(button);
  const menu = await screen.findByRole('menu'); await within(menu).findByRole('menuitemradio', { name: '示例团队 · member' });
  expect(within(menu).queryByText('同步收件')).toBeNull(); expect(screen.queryByText('上次操作成功。')).toBeNull();
  expect(container.contains(menu)).toBe(false); expect(within(container).getAllByRole('button')).toHaveLength(1);
  fireEvent.click(within(menu).getByRole('menuitem', { name: '复盘本次会话' }));
  const feedback = await screen.findByRole('status'); expect(feedback.textContent).toContain('没有可复盘');
  expect(container.contains(feedback)).toBe(false); expect(within(container).getAllByRole('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' })); expect(screen.queryByRole('status')).toBeNull();
  expect(interact.mock.calls.some(([r]) => r.action === 'sync')).toBe(false);
});
it('retries failed first sync from the menu, releases the gate, and renders sync feedback outside the composer', async () => {
  const { container, block, openSettings } = composer(true, true); const button = await screen.findByRole('button', { name: /ACN.*示例团队/ });
  await waitFor(() => { expect(block).toHaveBeenCalledWith('session-a', undefined); });
  fireEvent.keyDown(button, { key: 'ArrowDown' });
  let menu = screen.getByRole('menu'); expect(within(menu).getByRole('alert').textContent).toBe('首次收件失败。');
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'ACN 插件设置' })); expect(openSettings).toHaveBeenCalledWith('upstreams');
  fireEvent.click(button); menu = screen.getByRole('menu'); fireEvent.click(within(menu).getByRole('menuitem', { name: '重试同步' }));
  const feedback = await screen.findByRole('status'); expect(feedback.textContent).toContain('拉取 0 条'); expect(container.contains(feedback)).toBe(false); expect(block).toHaveBeenLastCalledWith('session-a', undefined);
  fireEvent.click(button); menu = screen.getByRole('menu'); fireEvent.keyDown(menu, { key: 'Escape' }); expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(button);
  fireEvent.click(button); fireEvent.pointerDown(document.body); expect(screen.queryByRole('menu')).toBeNull();
});
it('reads a legacy draft without replacing its selected identity or causing network work', async () => {
  const view = SessionViewSchema.parse({ sessionId: 'old-draft', key: 'legacy', name: '原有团队连接', locked: false, available: true, phase: 'ready', message: '', choices: [soloChoice], defaultConnection: '', showCompletion: true });
  const block = vi.fn(); const interact = vi.fn<InteractionApi['interact']>().mockResolvedValue({ ok: true, message: '', session: view });
  render(<SessionToolbar api={{ read: vi.fn(), save: vi.fn(), interact }} sessionId={SessionId('old-draft')} useSession={useSession} c={c} block={block} openSettings={vi.fn()} openKnowledge={vi.fn()} />);
  await waitFor(() => { expect(block).toHaveBeenLastCalledWith('old-draft', undefined); });
  expect(interact.mock.calls.every(([request]) => ['session', 'activity'].includes(request.action))).toBe(true);
});
it('offers multiple solo profiles without exposing a project preference', async () => {
  const view = SessionViewSchema.parse({ sessionId: 'session-a', key: 'coding', name: '开发', locked: false, available: true, phase: 'ready', message: '', choices: [{ ...soloChoice, key: 'coding', name: '开发' }, { ...soloChoice, key: 'review', name: '审查' }], defaultConnection: 'coding', showCompletion: true });
  const interact = vi.fn<InteractionApi['interact']>().mockResolvedValue({ ok: true, message: '', session: view });
  const { container } = render(<SessionToolbar api={{ read: vi.fn(), save: vi.fn(), interact }} sessionId={SessionId('session-a')} useSession={useSession} c={c} block={vi.fn()} openSettings={vi.fn()} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /ACN.*开发/ }));
  expect(screen.getByRole('menuitemradio', { name: /审查.*example/ })).toBeDefined();
  expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
  expect(screen.queryByText('默认 ACN 工作配置')).toBeNull();
  expect(interact.mock.calls.every(([request]) => ['session', 'activity'].includes(request.action))).toBe(true);
  expect(within(container).getAllByRole('button')).toHaveLength(1);
});
it.each(['', 'agent-a', '日常开发'])('does not repeat the Agent ID when its display name is %s', async (name) => {
  const view = SessionViewSchema.parse({ sessionId: 'session-a', key: 'agent-a', name: name || 'agent-a', locked: false, available: true, phase: 'ready', message: '', choices: [{ ...soloChoice, key: 'agent-a', agentId: 'agent-a', name }], defaultConnection: '', showCompletion: true });
  const interact = vi.fn<InteractionApi['interact']>().mockResolvedValue({ ok: true, message: '', session: view });
  render(<SessionToolbar api={{ read: vi.fn(), save: vi.fn(), interact }} sessionId={SessionId('session-a')} useSession={useSession} c={c} block={vi.fn()} openSettings={vi.fn()} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /ACN/ }));
  const choice = screen.getByRole('menuitemradio');
  expect(choice.textContent).toBe(name && name !== 'agent-a' ? '日常开发 · agent-a' : 'agent-a');
});
