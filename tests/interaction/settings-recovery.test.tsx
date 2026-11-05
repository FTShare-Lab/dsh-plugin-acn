// @vitest-environment jsdom
// 编辑与启用状态分离，未知保存结果核对时保留同一配置和密钥草稿。
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TeamSettingsPage } from '../../src/client/TeamSettingsPage.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
import { configurationValues } from '../../src/configuration.js';
import type { ConfigurationSnapshot, ConfigurationValues } from '../../src/configuration.js';
import { zh, en } from '../../src/client/locales.js';
afterEach(cleanup);
const item = { agentId: 'agent-a', name: 'Example', routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org', keyEnv: 'EXAMPLE_TEAM_REFERENCE' };
function mount(enabled = true, locale = zh) {
  const snapshot: ConfigurationSnapshot = { revision: 'initial', active: true, dataDirectory: '', models: [], values: configurationValues({ upstream: enabled ? 'coding' : '', upstreams: { coding: { ...item, enabled } } }) };
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn<InteractionApi['save']>((request) => Promise.resolve({ ok: true, snapshot: { ...snapshot, revision: 'next', values: request.values } })), interact: vi.fn(), credential: vi.fn().mockResolvedValue({ ok: true, message: '', configured: true, writable: true }) };
  render(<TeamSettingsPage api={api} t={(key) => locale[key]} openKnowledge={vi.fn()} />);return { api, snapshot };
}
it.each([true, false])('cancels unsaved edits and then saves enabled=%s explicitly', async (enabled) => {
  const { api } = mount(enabled);fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText('显示名称（可选）'), { target: { value: 'Unsaved name' } });
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-draft' } });
  fireEvent.change(screen.getByLabelText(zh.router), { target: { value: 'https://draft.example.org' } });
  fireEvent.change(await screen.findByLabelText('团队鉴权密钥'), { target: { value: crypto.randomUUID() } });
  expect(screen.queryByRole('button', { name: /^(停用|启用)/ })).toBeNull();expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
  fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.click(screen.getByRole('switch', { name: '启用此配置' })); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(1); });
  expect(vi.mocked(api.save).mock.calls[0]?.[0].values.upstreams?.['coding']).toMatchObject({ ...item, enabled: !enabled });
  expect(vi.mocked(api.credential as NonNullable<InteractionApi['credential']>).mock.calls.some(([request]) => request.action === 'store')).toBe(false);
});
it.each([zh, en])('shows Agent ID recovery guidance in both languages', async (locale) => {
  mount(true, locale);fireEvent.click(await screen.findByRole('button', { name: locale === zh ? '配置' : 'Configure' }));
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-other' } });
  expect(screen.getByText(locale === zh ? /把 Agent ID 改回原来的值并保存/ : /change the Agent ID back to its original value and save/)).toBeDefined();
});
it('recognizes a newly saved configuration after a lost response without creating another upstream', async () => {
  const snapshot: ConfigurationSnapshot = { revision: 'initial', active: true, dataDirectory: '', models: [], values: configurationValues({ upstreams: {}, upstream: '' }) };
  let stored: ConfigurationValues | undefined;const secrets = new Map<string, string>();
  const api: InteractionApi = {
    read: vi.fn(() => Promise.resolve(stored ? { ...snapshot, revision: 'saved', values: stored } : snapshot)),
    save: vi.fn<InteractionApi['save']>((request) => { stored = request.values;return Promise.reject(new Error('Response lost after save.')); }), interact: vi.fn(),
    credential: vi.fn<NonNullable<InteractionApi['credential']>>((request) => { if (request.action === 'store') secrets.set(request.reference, request.value);return Promise.resolve({ ok: true, message: '', configured: request.action !== 'check' && secrets.has(request.reference), writable: true }); }),
  };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '新建工作配置' }));fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-new' } });
  fireEvent.change(screen.getByLabelText(zh.router), { target: { value: item.routerEndpoint } });fireEvent.change(screen.getByLabelText(zh.maintainer), { target: { value: item.maintainerEndpoint } });
  const input = await screen.findByLabelText<HTMLInputElement>('团队鉴权密钥');const secret = crypto.randomUUID();fireEvent.change(input, { target: { value: secret } });fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByRole('alert');expect(input.value).toBe(secret);
  fireEvent.click(screen.getByRole('button', { name: '刷新并保留草稿' }));await screen.findByText('已刷新远端配置并保留你的修改，请核对后保存。');
  expect(input.value).toBe(secret);expect(screen.getByLabelText<HTMLInputElement>('配置标识').disabled).toBe(true);
  vi.mocked(api.save).mockImplementation((request) => Promise.resolve({ ok: true, snapshot: { ...snapshot, revision: 'confirmed', values: request.values } }));
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(2); });
  const first = vi.mocked(api.save).mock.calls[0]?.[0];const second = vi.mocked(api.save).mock.calls[1]?.[0];
  expect(second?.revision).toBe('saved');expect(Object.keys(second?.values.upstreams ?? {})).toEqual(['agent-new']);
  expect(second?.values.upstreams?.['agent-new']?.keyEnv).toBe(first?.values.upstreams?.['agent-new']?.keyEnv);
  expect(vi.mocked(api.credential as NonNullable<InteractionApi['credential']>).mock.calls.filter(([request]) => request.action === 'store')).toHaveLength(1);
});
it('does not adopt a competing configuration after an unknown first save', async () => {
  const snapshot: ConfigurationSnapshot = { revision: 'initial', active: true, dataDirectory: '', models: [], values: configurationValues({ upstreams: {}, upstream: '' }) };
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), interact: vi.fn(), save: vi.fn<InteractionApi['save']>().mockRejectedValueOnce(new Error('Unknown result.')).mockImplementation((request) => Promise.resolve({ ok: true, snapshot: { ...snapshot, revision: 'next', values: request.values } })) };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '新建工作配置' }));fireEvent.click(screen.getByRole('switch', { name: '连接团队服务' }));fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-new' } });fireEvent.click(screen.getByRole('button', { name: '保存配置' }));await screen.findByRole('alert');
  vi.mocked(api.read).mockResolvedValue({ ...snapshot, revision: 'other', values: configurationValues({ upstream: 'agent-new', upstreams: { 'agent-new': { agentId: 'other-agent' } } }) });
  fireEvent.click(screen.getByRole('button', { name: '刷新并保留草稿' }));await screen.findByText(/该配置标识已被其他配置使用/);
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));expect(api.save).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('配置标识'), { target: { value: 'agent-new-2' } });fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  fireEvent.click(await screen.findByRole('button', { name: '确认' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(2); });expect(vi.mocked(api.save).mock.calls[1]?.[0].values.upstreams).toMatchObject({ 'agent-new': { agentId: 'other-agent' }, 'agent-new-2': { agentId: 'agent-new' } });
});
it('requires a matching key or explicit removal when changing a team identity even without credential storage', async () => {
  const { api } = mount();
  vi.mocked(api.credential as NonNullable<InteractionApi['credential']>).mockResolvedValue({ ok: false, message: 'Credential storage unavailable.', configured: false, writable: false });
  fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-b' } });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存配置' }).disabled).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('原成员密钥可能不匹配');
  fireEvent.click(await screen.findByRole('button', { name: '移除密钥绑定' }));
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(1); });
  expect(vi.mocked(api.save).mock.calls[0]?.[0].values.upstreams?.['coding']).toMatchObject({ agentId: 'agent-b', keyEnv: '' });
});
it('does not merge a locally changed team identity with a remotely rotated key', async () => {
  const { api, snapshot } = mount();
  vi.mocked(api.save).mockResolvedValueOnce({ ok: false, code: 'conflict', fields: [] });
  fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-b' } });
  fireEvent.change(await screen.findByLabelText('团队鉴权密钥'), { target: { value: crypto.randomUUID() } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));await screen.findByRole('button', { name: '刷新并保留草稿' });
  const remote = { ...item, keyEnv: 'ROTATED_TEAM_REFERENCE' };
  vi.mocked(api.read).mockResolvedValue({ ...snapshot, revision: 'remote', values: configurationValues({ upstream: 'coding', upstreams: { coding: remote } }) });
  fireEvent.click(screen.getByRole('button', { name: '刷新并保留草稿' }));
  fireEvent.click(await screen.findByRole('button', { name: '采用已保存的团队连接' }));
  expect(screen.getByLabelText<HTMLInputElement>('Agent ID').value).toBe('agent-a');
  expect(screen.getByLabelText<HTMLInputElement>('团队鉴权密钥').value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(2); });
  expect(vi.mocked(api.save).mock.calls[1]?.[0]).toMatchObject({ revision: 'remote', values: { upstreams: { coding: remote } } });
});
it('drops the previous member binding when a different Agent ID is saved in solo mode', async () => {
  const { api } = mount();fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-b' } });
  fireEvent.click(screen.getByRole('switch', { name: '连接团队服务' }));
  expect(screen.getByText(/不再绑定原成员密钥/)).toBeDefined();expect(screen.queryByText(/修改地址会沿用当前知识库/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(1); });
  expect(vi.mocked(api.save).mock.calls[0]?.[0].values.upstreams?.['coding']).toMatchObject({ agentId: 'agent-b', routerEndpoint: '', maintainerEndpoint: '', keyEnv: '' });
});
it('can retain the complete local identity and key after the other window changes both', async () => {
  const { api, snapshot } = mount();vi.mocked(api.save).mockResolvedValueOnce({ ok: false, code: 'conflict', fields: [] });
  fireEvent.click(await screen.findByRole('button', { name: '配置' }));fireEvent.change(screen.getByLabelText(zh.router), { target: { value: 'https://local.example.org' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));await screen.findByRole('button', { name: '刷新并保留草稿' });
  vi.mocked(api.read).mockResolvedValue({ ...snapshot, revision: 'remote', values: configurationValues({ upstream: 'coding', upstreams: { coding: { ...item, agentId: 'agent-b', keyEnv: 'OTHER_MEMBER_REFERENCE' } } }) });
  fireEvent.click(screen.getByRole('button', { name: '刷新并保留草稿' }));fireEvent.click(await screen.findByRole('button', { name: '保留我的团队连接' }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存配置' }).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(2); });
  expect(vi.mocked(api.save).mock.calls[1]?.[0].values.upstreams?.['coding']).toMatchObject({ ...item, routerEndpoint: 'https://local.example.org' });
});
it('does not discard a key when the panel closes before the key store response returns', async () => {
  const { api } = mount();let release: (() => void) | undefined;const gate = new Promise<void>((resolve) => { release = resolve; });
  const stored = new Set<string>();
  const credential = vi.mocked(api.credential as NonNullable<InteractionApi['credential']>);
  credential.mockImplementation(async (request) => {
    if (request.action === 'store') { await gate;stored.add(request.reference); }
    if (request.action === 'discard') stored.delete(request.reference);
    return { ok: true, message: '', writable: true, configured: request.action !== 'check' && stored.has(request.reference) };
  });
  fireEvent.click(await screen.findByRole('button', { name: '配置' }));fireEvent.change(await screen.findByLabelText('团队鉴权密钥'), { target: { value: crypto.randomUUID() } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(credential.mock.calls.some(([request]) => request.action === 'store')).toBe(true); });
  cleanup();release?.();
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(1); });
  const reference = vi.mocked(api.save).mock.calls[0]?.[0].values.upstreams?.['coding']?.keyEnv;
  expect(reference).toBeDefined();expect(stored.has(reference ?? '')).toBe(true);
  expect(credential.mock.calls.some(([request]) => request.action === 'discard')).toBe(false);
});
