// @vitest-environment jsdom
// 真实表单覆盖单人新建、原身份接入团队、离线保存、草稿和模型检查。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamSettingsPage } from '../../src/client/TeamSettingsPage.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
import { configurationValues } from '../../src/configuration.js';
import type { ConfigurationSnapshot, SaveConfiguration, ConfigurationResult } from '../../src/configuration.js';
import type { InteractionResult } from '../../src/interaction.js';
import { en, zh } from '../../src/client/locales.js';
import { KnowledgePanel } from '../../src/client/KnowledgePanel.js';
afterEach(cleanup);
const t = (key: keyof typeof zh) => zh[key];
const c = (chinese: string) => chinese;
const profile = { name: '开发', agentId: 'agent-a' };
const snapshot: ConfigurationSnapshot = { revision: 'first', values: configurationValues({ upstream: 'coding', upstreams: { coding: profile }, llm: { provider: 'example', model: 'old-model' } }), models: [{ provider: 'example', providerName: 'Example', id: 'old-model', name: 'Old model' }, { provider: 'example', providerName: 'Example', id: 'new-model', name: 'New model' }], active: true, dataDirectory: '', upstreamPending: { coding: 3 } };
function setup(current = snapshot, translate = t) {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(current), save: vi.fn((request: SaveConfiguration): Promise<ConfigurationResult> => Promise.resolve({ ok: true, snapshot: { ...current, revision: 'next', values: request.values } })), interact: vi.fn().mockResolvedValue({ ok: true, message: '检查通过。' }) };
  const open = vi.fn(); render(<TeamSettingsPage api={api} t={translate} openKnowledge={open} />); return { api, open };
}
describe('upstream settings', () => {
  it('deduplicates the default selector label and knowledge identity selector', async () => {
    const current = { ...snapshot, values: configurationValues({ upstream: 'agent-a', upstreams: { 'agent-a': { name: '', agentId: 'agent-a' } } }) };
    const { api } = setup(current);
    const selector = await screen.findByRole('combobox', { name: '全局默认配置' });
    expect(selector.querySelector('option[value="agent-a"]')?.textContent).toBe('agent-a');
    cleanup(); render(<KnowledgePanel api={api} initialKey="agent-a" c={c} />);
    await waitFor(() => { expect(screen.getByRole('combobox', { name: '知识身份' }).querySelector('option[value="agent-a"]')?.textContent).toBe('agent-a'); });
  });
  it('shows a unified configuration entry and browsing never synchronizes', async () => {
    const { api, open } = setup();
    expect((await screen.findByRole('tab', { name: '工作配置' })).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull(); expect(screen.getByTitle(zh.reloadHint)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '知识与活动' })); expect(open).toHaveBeenCalledWith('coding'); expect(api.interact).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: '知识与模型' })); expect(screen.getByLabelText(zh.home)).toBeDefined();
  });
  it('creates a solo upstream using only an Agent ID and makes the first one the real default', async () => {
    const { api } = setup({ ...snapshot, values: configurationValues({ upstreams: {} }) });
    fireEvent.click(await screen.findByRole('button', { name: '新建工作配置' }));
    fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'coding' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => { expect(api.save).toHaveBeenCalled(); });
    expect(vi.mocked(api.save).mock.calls[0]?.[0].values).toMatchObject({ upstream: 'coding', upstreams: { coding: { name: 'coding', agentId: 'coding', routerEndpoint: '', maintainerEndpoint: '' } } });
    expect(api.interact).not.toHaveBeenCalled();
  });
  it.each([zh, en])('offers deployment help and connects the existing identity without creating another member', async (locale) => {
    const english = locale === en; const { api } = setup(snapshot, (key) => locale[key]);
    const guide = english ? 'ACN deployment guide (GitHub)' : 'ACN 部署说明（GitHub）';
    const link = await screen.findByRole('link', { name: guide }); expect(link.getAttribute('href')).toBe('https://github.com/FTShare-Lab/agent-claim-network'); expect(link.getAttribute('rel')).toContain('noreferrer');
    fireEvent.click(screen.getByRole('button', { name: english ? 'Configure' : '配置' }));
    fireEvent.click(screen.getByRole('switch', { name: english ? 'Connect team services' : '连接团队服务' }));
    expect(screen.getAllByLabelText('Agent ID')).toHaveLength(1);
    for (const [label, value] of [[locale.router, 'https://router.example.org'], [locale.maintainer, 'https://maintainer.example.org'], [locale.keyEnv, 'EXAMPLE_TEAM_TOKEN']]) fireEvent.change(screen.getByLabelText(label ?? ''), { target: { value } });
    fireEvent.click(screen.getByRole('link', { name: guide }));
    expect(screen.getByLabelText<HTMLInputElement>(locale.router).value).toBe('https://router.example.org'); expect(api.save).not.toHaveBeenCalled(); expect(api.interact).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: english ? 'Save configuration' : '保存配置' }));
    await waitFor(() => { expect(api.save).toHaveBeenCalled(); });
    expect(vi.mocked(api.save).mock.calls[0]?.[0].values.upstreams?.['coding']).toMatchObject({ agentId: 'agent-a', routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org', keyEnv: 'EXAMPLE_TEAM_TOKEN' });
    expect(api.interact).not.toHaveBeenCalled();
  });
  it('keeps a draft while changing tabs and discards it only on explicit reload', async () => {
    const { api } = setup(); fireEvent.click(await screen.findByRole('button', { name: '配置' }));
    fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'draft-agent' } });
    fireEvent.click(screen.getByRole('tab', { name: '知识与模型' })); fireEvent.click(screen.getByRole('switch', { name: '显示知识处理结果' }));
    await waitFor(() => { expect(api.save).toHaveBeenCalled(); }); expect(vi.mocked(api.save).mock.calls[0]?.[0].values.upstreams?.['coding']?.agentId).toBe('agent-a');
    fireEvent.click(screen.getByRole('tab', { name: '工作配置' })); expect(screen.getByLabelText<HTMLInputElement>('Agent ID').value).toBe('draft-agent');
    fireEvent.click(screen.getByRole('button', { name: zh.reload })); await screen.findByText('已重新加载，未保存的修改已丢弃。');
    fireEvent.click(screen.getByRole('button', { name: '配置' })); expect(screen.getByLabelText<HTMLInputElement>('Agent ID').value).toBe('agent-a');
  });
  it('shows the pending-record consequence when changing team addresses', async () => {
    setup({ ...snapshot, values: configurationValues({ upstream: 'coding', upstreams: { coding: { ...profile, routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org' } } }) });
    fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.change(screen.getByLabelText(zh.router), { target: { value: 'https://other.example.org' } });
    expect(screen.getByText(/当前有 3 项团队待投记录/)).toBeDefined();
  });
  it('retains the profile draft after a save conflict', async () => {
    const { api } = setup(); vi.mocked(api.save).mockResolvedValueOnce({ ok: false, code: 'conflict', fields: [] });
    fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.change(screen.getByLabelText('显示名称（可选）'), { target: { value: '保留草稿' } }); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText(zh.conflict); expect(screen.getByLabelText<HTMLInputElement>('显示名称（可选）').value).toBe('保留草稿');
  });
  it('saves model selection only after a successful probe and ignores a cancelled late result', async () => {
    const { api } = setup(); vi.mocked(api.interact).mockResolvedValueOnce({ ok: false, message: '模型不可用。' });
    fireEvent.click(await screen.findByRole('tab', { name: '知识与模型' })); const choose = () => { fireEvent.change(screen.getByLabelText('知识处理模型'), { target: { value: JSON.stringify(['example', 'new-model']) } }); }; choose();
    await screen.findByText('模型不可用。'); expect(api.save).not.toHaveBeenCalled();
    let finish: ((result: InteractionResult) => void) | undefined; vi.mocked(api.interact).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })); choose();
    fireEvent.click(await screen.findByRole('button', { name: '取消检查' })); finish?.({ ok: true, message: 'late' }); await Promise.resolve(); expect(api.save).not.toHaveBeenCalled();
    choose(); await waitFor(() => { expect(vi.mocked(api.save).mock.calls[0]?.[0].values.model).toBe('new-model'); });
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
