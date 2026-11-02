// @vitest-environment jsdom
// 设置交互验证实际表单、离线保存、模型探测与多窗口冲突，不伪装未知结果。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamSettingsPage } from '../../src/client/TeamSettingsPage.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
import { configurationValues } from '../../src/configuration.js';
import type { ConfigurationSnapshot, SaveConfiguration, ConfigurationResult } from '../../src/configuration.js';
import type { InteractionResult } from '../../src/interaction.js';
import { zh } from '../../src/client/locales.js';
import { KnowledgePanel } from '../../src/client/KnowledgePanel.js';
afterEach(cleanup);
const t = (key: keyof typeof zh) => zh[key];
const c = (chinese: string) => chinese;
const connection = { id: 'team-a', name: '示例团队', agentId: 'member-a', routerEndpoint: 'http://127.0.0.1:8101', maintainerEndpoint: 'http://127.0.0.1:8102', keyEnv: 'ACN_EXAMPLE_TEAM_TOKEN', timeoutMs: 15000 };
const snapshot: ConfigurationSnapshot = { revision: 'first', values: configurationValues({ agentId: 'personal', llm: { provider: 'example', model: 'old-model' } }), models: [{ provider: 'example', providerName: 'Example', id: 'old-model', name: 'Old model' }, { provider: 'example', providerName: 'Example', id: 'new-model', name: 'New model' }], active: true, dataDirectory: '' };
function setup(current = snapshot) {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(current), save: vi.fn((request: SaveConfiguration): Promise<ConfigurationResult> => Promise.resolve({ ok: true, snapshot: { ...current, revision: 'next', values: request.values } })), interact: vi.fn().mockResolvedValue({ ok: true, message: '检查通过。' }) };
  const open = vi.fn(); render(<TeamSettingsPage api={api} t={t} openKnowledge={open} />); return { api, open };
}
describe('team service settings', () => {
  it('shows grouped settings and keeps local browsing separate from synchronization', async () => {
    const { api, open } = setup();
    await screen.findByLabelText('Agent ID'); expect(screen.getByLabelText(zh.home)).toBeDefined();
    expect(screen.getByRole('tab', { name: '单人设置' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByTitle(zh.reloadHint)).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: '团队连接' })); expect(screen.getByText('尚未添加团队连接')).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: '知识与模型' }));
    fireEvent.click(screen.getByRole('button', { name: '知识与活动' })); expect(open).toHaveBeenCalledWith('personal'); expect(api.interact).not.toHaveBeenCalled();
  });
  it('keeps the personal draft while using another tab and discards it only on explicit reload', async () => {
    const { api } = setup(); fireEvent.change(await screen.findByLabelText('Agent ID'), { target: { value: 'other-name' } });
    fireEvent.keyDown(screen.getByRole('tab', { name: '单人设置' }), { key: 'End' });
    fireEvent.click(screen.getByRole('switch', { name: '显示知识处理结果' }));
    await waitFor(() => { expect(vi.mocked(api.save).mock.calls[0]?.[0].values.agentId).toBe('personal'); });
    fireEvent.click(screen.getByRole('tab', { name: '单人设置' })); expect(screen.getByLabelText<HTMLInputElement>('Agent ID').value).toBe('other-name');
    fireEvent.click(screen.getByRole('button', { name: zh.reload })); await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>('Agent ID').value).toBe('personal'); });
  });
  it('saves a named connection offline and sends only a credential variable name', async () => {
    const { api } = setup(); fireEvent.click(await screen.findByRole('tab', { name: '团队连接' })); fireEvent.click(screen.getByRole('button', { name: '添加连接' }));
    for (const [label, value] of [['连接名称', '示例团队'], ['Agent ID', 'member-a'], [zh.maintainer, connection.maintainerEndpoint], [zh.router, connection.routerEndpoint], [zh.keyEnv, connection.keyEnv]]) fireEvent.change(screen.getByLabelText(label ?? ''), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: zh.save }));
    await waitFor(() => { expect(api.save).toHaveBeenCalled(); });
    const save = vi.mocked(api.save).mock.calls[0]?.[0]; expect(save?.values.connections?.[0]).toMatchObject({ name: connection.name, agentId: connection.agentId, routerEndpoint: connection.routerEndpoint, maintainerEndpoint: connection.maintainerEndpoint, keyEnv: connection.keyEnv, timeoutMs: connection.timeoutMs, enabled: true }); expect(save?.values.mode).toBe('solo'); expect(api.interact).not.toHaveBeenCalled();
  });
  it('does not save a model until its actual probe succeeds, and retains the old model on failure', async () => {
    const { api } = setup(); vi.mocked(api.interact).mockResolvedValueOnce({ ok: false, message: '模型不可用。' });
    fireEvent.click(await screen.findByRole('tab', { name: '知识与模型' })); fireEvent.change(screen.getByLabelText('知识处理模型'), { target: { value: JSON.stringify(['example', 'new-model']) } });
    await screen.findByText('模型不可用。'); expect(api.save).not.toHaveBeenCalled(); expect(screen.getByLabelText<HTMLSelectElement>('知识处理模型').value).toBe(JSON.stringify(['example', 'old-model']));
    fireEvent.change(screen.getByLabelText('知识处理模型'), { target: { value: JSON.stringify(['example', 'new-model']) } });
    await waitFor(() => { expect(vi.mocked(api.save).mock.calls[0]?.[0].values.model).toBe('new-model'); });
  });
  it('ignores a cancelled probe even if its server response arrives late', async () => {
    const { api } = setup(); let finish: ((result: InteractionResult) => void) | undefined;
    vi.mocked(api.interact).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(await screen.findByRole('tab', { name: '知识与模型' })); fireEvent.change(screen.getByLabelText('知识处理模型'), { target: { value: JSON.stringify(['example', 'new-model']) } });
    fireEvent.click(await screen.findByRole('button', { name: '取消检查' })); finish?.({ ok: true, message: 'Late result.' });
    await screen.findByText('已取消，原配置保留。'); expect(api.save).not.toHaveBeenCalled();
  });
  it('keeps the connection draft after a revision conflict and does not enable the global team mode', async () => {
    const current = { ...snapshot, values: configurationValues({ agentId: 'personal', connections: [connection] }) }; const { api } = setup(current);
    vi.mocked(api.save).mockResolvedValueOnce({ ok: false, code: 'conflict', fields: [] });
    fireEvent.click(await screen.findByRole('tab', { name: '团队连接' })); fireEvent.click(screen.getByRole('button', { name: '配置' })); fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '保留草稿' } }); fireEvent.click(screen.getByRole('button', { name: zh.save }));
    await screen.findByText(zh.conflict); expect(screen.getByLabelText<HTMLInputElement>('连接名称').value).toBe('保留草稿'); expect(vi.mocked(api.save).mock.calls[0]?.[0].values.mode).toBe('solo');
  });
  it('requires confirmation before disabling a connection and clears only its default preference', async () => {
    const current = { ...snapshot, values: configurationValues({ agentId: 'personal', connections: [connection], defaultConnection: 'team-a' }) }; const { api } = setup(current);
    fireEvent.click(await screen.findByRole('tab', { name: '团队连接' })); fireEvent.click(screen.getByRole('button', { name: '配置' })); fireEvent.click(screen.getByRole('button', { name: '停用连接' })); expect(api.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认' })); await waitFor(() => { expect(api.save).toHaveBeenCalled(); }); expect(vi.mocked(api.save).mock.calls[0]?.[0].values).toMatchObject({ agentId: 'personal', defaultConnection: '', connections: [expect.objectContaining({ id: 'team-a', enabled: false })] });
  });
});
it('browses knowledge, filters activity and retries explicitly without a sync request', async () => {
  const interact = vi.fn<InteractionApi['interact']>().mockResolvedValue({ ok: true, message: '', knowledge: { key: 'personal', name: '单人模式', items: [{ kind: 'claim', id: 'claim_00000001', name: '示例知识', status: 'active', detail: '{"statement":"可复用事实"}' }], omitted: 0, activities: [{ id: 'job-a', kind: 'recap', state: 'failed', attempts: 1, updatedAt: 1, unseen: true, summary: '', error: '模型暂不可用。', sessionId: 'session-a' }], pendingClaims: 1, pendingDisputes: 0 } });
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact };
  render(<KnowledgePanel api={api} initialKey="personal" c={c} />);
  await screen.findByText('示例知识'); fireEvent.click(screen.getByRole('tab', { name: '处理活动' })); fireEvent.click(await screen.findByRole('button', { name: '重试任务' }));
  await waitFor(() => { expect(interact).toHaveBeenCalledWith({ action: 'retry', key: 'personal', id: 'job-a' }); });
  expect(interact.mock.calls.some(([r]) => r.action === 'activity')).toBe(true); expect(interact.mock.calls.every(([request]) => request.action !== 'sync')).toBe(true); expect(screen.getByText('模型暂不可用。')).toBeDefined();
});
