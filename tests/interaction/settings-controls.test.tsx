// @vitest-environment jsdom
// 默认切换先确认，目录选择只修改草稿，普通反馈不占表单布局。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamSettingsPage } from '../../src/client/TeamSettingsPage.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
import { SettingsToast } from '../../src/client/SettingsToast.js';
import { configurationValues } from '../../src/configuration.js';
import type { ConfigurationSnapshot } from '../../src/configuration.js';
import { zh } from '../../src/client/locales.js';
afterEach(() => { cleanup(); vi.useRealTimers(); });
const snapshot: ConfigurationSnapshot = { revision: 'initial', active: true, dataDirectory: '', models: [], values: configurationValues({ upstream: 'first', upstreams: { first: { name: 'First', agentId: 'agent-a' }, second: { name: 'Second', agentId: 'agent-b', routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org' } } }) };
function mount(tab: 'upstreams' | 'knowledge' = 'upstreams') {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn<InteractionApi['save']>().mockImplementation((request) => Promise.resolve({ ok: true, snapshot: { ...snapshot, revision: 'saved', values: request.values } })), interact: vi.fn().mockResolvedValue({ ok: true, message: '' }), pickDirectory: vi.fn() };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} initialTab={tab} openKnowledge={vi.fn()} />); return api;
}
it('keeps only browse and configure actions in rows and confirms replacement before saving', async () => {
  const api = mount(); const name = await screen.findByText('Second', { selector: 'strong' });
  const row = name.closest<HTMLElement>('.acn-row'); if (!row) throw new Error('Expected configuration row.');
  expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(['知识与活动', '配置']);
  expect(within(row).getByText('团队')).toBeDefined();
  fireEvent.click(within(row).getByRole('button', { name: '配置' }));
  expect(screen.getByRole('button', { name: '返回工作配置' })).toBeDefined();
  fireEvent.click(screen.getByRole('switch', { name: '设为默认' })); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  const confirmation = await screen.findByRole('dialog', { name: '更改默认配置' });
  expect(confirmation.textContent).toContain('First'); expect(confirmation.textContent).toContain('Second'); expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByRole<HTMLInputElement>('switch', { name: '设为默认' }).checked).toBe(false); expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('switch', { name: '设为默认' })); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(1); }); expect(vi.mocked(api.save).mock.calls[0]?.[0].values.upstream).toBe('second');
  await screen.findByRole('button', { name: '新建工作配置' }); expect(screen.getAllByText('默认')).toHaveLength(1);
  const next = screen.getByText('Second', { selector: 'strong' }).closest<HTMLElement>('.acn-row'); if (!next) throw new Error('Expected configuration row.'); expect(within(next).getByText('默认')).toBeDefined();
});
it('selects and opens the draft directory without saving it, and preserves it when picking is cancelled', async () => {
  const api = mount('knowledge'); const selected = String.raw`\\server\share\Team Knowledge\知识`;
  if (!api.pickDirectory) throw new Error('Expected chooser.'); vi.mocked(api.pickDirectory).mockResolvedValueOnce(selected).mockResolvedValueOnce(null);
  fireEvent.click(await screen.findByRole('button', { name: '选择知识目录' }));
  await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>(zh.home).value).toBe(selected); }); expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '打开目录' }));
  await waitFor(() => { expect(api.interact).toHaveBeenCalledWith({ action: 'open_directory', path: selected }); });
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '选择知识目录' }).disabled).toBe(false); });
  fireEvent.click(screen.getByRole('button', { name: '选择知识目录' }));
  await waitFor(() => { expect(api.pickDirectory).toHaveBeenCalledTimes(2); }); expect(screen.getByLabelText<HTMLInputElement>(zh.home).value).toBe(selected); expect(api.save).not.toHaveBeenCalled();
});
it.each([
  { initial: 'first', remote: 'second', toggle: false, expected: 'second', checked: true },
  { initial: 'second', remote: 'first', toggle: false, expected: 'first', checked: false },
  { initial: 'first', remote: '', toggle: true, expected: 'second', checked: true },
  { initial: 'second', remote: 'second', toggle: true, expected: '', checked: false },
])('merges the default choice after a save conflict: %j', async ({ initial, remote, toggle, expected, checked }) => {
  const base = { ...snapshot, values: { ...snapshot.values, upstream: initial } };
  const current = { ...snapshot, revision: 'remote', values: { ...snapshot.values, upstream: remote } };
  const api: InteractionApi = {
    read: vi.fn().mockResolvedValueOnce(base).mockResolvedValue(current), interact: vi.fn(),
    save: vi.fn<InteractionApi['save']>().mockResolvedValueOnce({ ok: false, code: 'conflict', fields: [] }).mockImplementation((request) => Promise.resolve({ ok: true, snapshot: { ...current, revision: 'saved', values: request.values } })),
  };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} />);
  const row = (await screen.findByText('Second', { selector: 'strong' })).closest<HTMLElement>('.acn-row');
  if (!row) throw new Error('Expected configuration row.');
  fireEvent.click(within(row).getByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText('显示名称（可选）'), { target: { value: 'Renamed locally' } });
  if (toggle) fireEvent.click(screen.getByRole('switch', { name: '设为默认' }));
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  const confirmation = screen.queryByRole('dialog', { name: '更改默认配置' });
  if (confirmation) fireEvent.click(within(confirmation).getByRole('button', { name: '确认' }));
  fireEvent.click(await screen.findByRole('button', { name: '刷新并保留草稿' }));
  await screen.findByText('已刷新远端配置并保留你的修改，请核对后保存。');
  expect(screen.getByRole<HTMLInputElement>('switch', { name: '设为默认' }).checked).toBe(checked);
  expect(screen.getByLabelText<HTMLInputElement>('显示名称（可选）').value).toBe('Renamed locally');
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(2); });
  expect(vi.mocked(api.save).mock.calls[1]?.[0]).toMatchObject({ revision: 'remote', values: { upstream: expected, upstreams: { second: { name: 'Renamed locally' } } } });
});
it('shows feedback outside the form and dismisses it automatically', () => {
  vi.useFakeTimers(); const { container } = render(<SettingsToast text="已保存。" />);
  expect(container.contains(screen.getByRole('status'))).toBe(false);
  act(() => { vi.advanceTimersByTime(5000); }); expect(screen.queryByRole('status')).toBeNull();
});
