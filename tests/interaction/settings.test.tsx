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
import { ClaimIdSchema } from '../../src/protocol/ids.js';
import { KnowledgePanel } from '../../src/client/KnowledgePanel.js';
afterEach(cleanup);
const t = (key: keyof typeof zh) => zh[key];
const c = (chinese: string) => chinese;
const profile = { name: '开发', agentId: 'agent-a' };
const snapshot: ConfigurationSnapshot = { revision: 'first', values: configurationValues({ upstream: 'coding', upstreams: { coding: profile }, llm: { provider: 'example', model: 'old-model' } }), models: [{ provider: 'example', providerName: 'Example', id: 'old-model', name: 'Old model' }, { provider: 'example', providerName: 'Example', id: 'new-model', name: 'New model' }], active: true, dataDirectory: '', upstreamPending: { coding: 3 } };
function setup(current = snapshot, translate = t) {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(current), save: vi.fn((request: SaveConfiguration): Promise<ConfigurationResult> => Promise.resolve({ ok: true, snapshot: { ...current, revision: 'next', values: request.values } })), interact: vi.fn().mockResolvedValue({ ok: true, message: '检查通过。' }), credential: vi.fn().mockResolvedValue({ ok: true, message: '', configured: true, writable: true }) };
  const open = vi.fn(); render(<TeamSettingsPage api={api} t={translate} openKnowledge={open} />); return { api, open };
}
describe('upstream settings', () => {
  it('deduplicates the default selector label and knowledge identity selector', async () => {
    const current = { ...snapshot, values: configurationValues({ upstream: 'agent-a', upstreams: { 'agent-a': { name: '', agentId: 'agent-a' } } }) };
    const { api } = setup(current);
    fireEvent.click(await screen.findByRole('tab', { name: '偏好' }));
    const selector = await screen.findByRole('combobox', { name: '默认工作配置' });
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
  it.each([
    ['routerEndpoint', 'not-a-url', 'Router'],
    ['routerEndpoint', 'ftp://router.example.org', 'Router'],
    ['routerEndpoint', 'https://router.example.org?token=example', 'Router'],
    ['routerEndpoint', 'https://router.example.org#section', 'Router'],
    ['routerEndpoint', (() => { const url = new URL('https://router.example.org'); url.username = 'member'; return url.href; })(), 'Router'],
    ['routerEndpoint', '', 'Router'],
    ['maintainerEndpoint', 'not-a-url', 'Maintainer'],
    ['maintainerEndpoint', '', 'Maintainer'],
  ])('identifies an invalid %s before checking or saving a draft', async (field, value, service) => {
    const { api } = setup({ ...snapshot, values: configurationValues({ upstream: 'coding', upstreams: { coding: { ...profile, routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org' } } }) });
    fireEvent.click(await screen.findByRole('button', { name: '配置' }));
    const label = field === 'routerEndpoint' ? zh.router : zh.maintainer;
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: '检查连接' }));
    expect(screen.getByRole('alert').textContent).toContain(`有效的 ${service} 地址`);
    expect(screen.getByRole('alert').closest('form')).toBe(screen.getByRole('button', { name: '检查连接' }).closest('form'));
    expect(screen.getByLabelText<HTMLInputElement>(label).value).toBe(value);
    expect(api.interact).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
    if (api.credential === undefined) throw new Error('Expected credential API.');
    expect(vi.mocked(api.credential).mock.calls.some(([request]) => ['check', 'store'].includes(request.action))).toBe(false);
  });
  it('trims valid path-prefixed addresses for checks and retains input after a transport failure', async () => {
    const { api } = setup({ ...snapshot, values: configurationValues({ upstream: 'coding', upstreams: { coding: { ...profile, routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org' } } }) });
    fireEvent.click(await screen.findByRole('button', { name: '配置' }));
    fireEvent.change(screen.getByLabelText(zh.router), { target: { value: ' https://router.example.org/team-a/ ' } });
    vi.mocked(api.interact).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: '检查连接' }));
    await screen.findByText('未能完成连接检查，请稍后重试。本次检查不会保存配置，输入已保留。');
    expect(vi.mocked(api.interact).mock.calls[0]?.[0]).toMatchObject({ action: 'check', connection: { routerEndpoint: 'https://router.example.org/team-a/' } });
    expect(vi.mocked(api.interact).mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(screen.getByLabelText<HTMLInputElement>(zh.router).value).toBe('https://router.example.org/team-a/');
    expect(api.save).not.toHaveBeenCalled();
  });
  it.each([zh, en])('offers deployment help and connects the existing identity without creating another member', async (locale) => {
    const english = locale === en; const { api } = setup({ ...snapshot, values: configurationValues({ upstream: 'coding', upstreams: { coding: { ...profile, keyEnv: 'EXAMPLE_TEAM_TOKEN' } } }) }, (key) => locale[key]);
    const guide = english ? 'ACN deployment guide (GitHub)' : 'ACN 部署说明（GitHub）';
    const link = await screen.findByRole('link', { name: guide }); expect(link.getAttribute('href')).toBe('https://github.com/FTShare-Lab/agent-claim-network'); expect(link.getAttribute('rel')).toContain('noreferrer');
    fireEvent.click(screen.getByRole('button', { name: english ? 'Configure' : '配置' }));
    fireEvent.click(screen.getByRole('switch', { name: english ? 'Connect team services' : '连接团队服务' }));
    expect(screen.getAllByLabelText('Agent ID')).toHaveLength(1);
    for (const [label, value] of [[locale.router, 'https://router.example.org'], [locale.maintainer, 'https://maintainer.example.org']]) fireEvent.change(screen.getByLabelText(label ?? ''), { target: { value } });
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
    fireEvent.click(screen.getByRole('tab', { name: '偏好' })); fireEvent.click(screen.getByRole('switch', { name: '显示知识处理结果' }));
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
  it('explains a Windows reserved name rejection and keeps the editable draft', async () => {
    const { api } = setup(); vi.mocked(api.save).mockResolvedValueOnce({ ok: false, code: 'invalid', fields: ['windowsStorageName'] });
    fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'con' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText(/Windows 不能使用 CON/); expect(screen.getByLabelText<HTMLInputElement>('Agent ID').value).toBe('con');
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
  await waitFor(() => { expect(interact).toHaveBeenCalledWith({ action: 'retry', key: 'personal', id: 'job-a' }, expect.any(AbortSignal)); });
  expect(interact.mock.calls.some(([r]) => r.action === 'activity')).toBe(true); expect(interact.mock.calls.every(([request]) => request.action !== 'sync')).toBe(true); expect(screen.getByText('模型暂不可用。')).toBeDefined();
});

it.each(['inbox', 'dream', 'recap', 'finalize', 'memory_review'] as const)('shows the persisted model failure and an explicit retry action for %s', async (kind) => {
  const error = '后台模型返回的响应格式无效（MALFORMED_RESPONSE）；可稍后重试或更换知识处理模型。';
  const interact = vi.fn<InteractionApi['interact']>().mockResolvedValue({ ok: true, message: '', knowledge: { key: 'personal', name: '示例配置', items: [], omitted: 0, activities: [{ id: 'failed-model-job', kind, state: 'failed', attempts: 1, updatedAt: 1, unseen: true, summary: '', error }], pendingClaims: 0, pendingDisputes: 0 } });
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact };
  render(<KnowledgePanel api={api} initialKey="personal" initialTab="activity" c={c} />);
  fireEvent.click(await screen.findByLabelText(`${kind} · 处理失败`, { exact: false, selector: 'summary' }));
  expect(screen.getByRole('alert').textContent).toBe(error);
  fireEvent.click(screen.getByRole('button', { name: '重试任务' }));
  await waitFor(() => { expect(interact).toHaveBeenCalledWith({ action: 'retry', key: 'personal', id: 'failed-model-job' }, expect.any(AbortSignal)); });
  expect(interact.mock.calls.every(([request]) => request.action !== 'sync')).toBe(true);
});

it('disables and enables the saved configuration from the list without editing its fields', async () => {
  const { api } = setup();
  fireEvent.click(await screen.findByRole('button', { name: '停用配置 开发' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(1); });
  expect(vi.mocked(api.save).mock.calls[0]?.[0].values).toMatchObject({ upstream: '', upstreams: { coding: { name: '开发', agentId: 'agent-a', enabled: false } } });
  fireEvent.click(await screen.findByRole('button', { name: '启用配置 开发' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(2); });
  expect(vi.mocked(api.save).mock.calls[1]?.[0].values).toMatchObject({ upstream: '', upstreams: { coding: { name: '开发', agentId: 'agent-a', enabled: true } } });
});

it.each([false, true])('opens exact source details, explains missing team sources and preserves original details (local=%s)', async (local) => {
  const origin = { kind: 'trace' as const, id: 'trace_00000001', name: '来源任务', status: '', detail: JSON.stringify({ task: '保留原详情', input_claims: ['claim_00000002'] }) };
  const interact = vi.fn<InteractionApi['interact']>().mockImplementation((request) => Promise.resolve(request.action === 'reference' ? { ok: true, message: '', reference: { key: 'coding', id: ClaimIdSchema.parse(request.id), ...(local ? { item: { kind: 'claim', id: request.id, name: '本地来源', status: 'active', detail: JSON.stringify({ statement: '来源正文' }) } } : {}) } } : { ok: true, message: '', knowledge: { key: 'coding', name: '开发', items: [origin], omitted: 0, activities: [], pendingClaims: 0, pendingDisputes: 0 } }));
  render(<KnowledgePanel api={{ read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact }} initialKey="coding" c={c} />);
  const name = await screen.findByText('来源任务', { selector: 'strong' }); const details = name.closest('details'); if (!details) throw new Error('Expected origin details.'); fireEvent.click(name); details.open = true;
  fireEvent.click(screen.getByRole('button', { name: 'claim_00000002' }));
  if (local) await screen.findByText('来源正文'); else await screen.findByText(/尚未内化的团队知识/);
  expect(screen.queryByText('暂无符合条件的知识。')).toBeNull();
  expect(interact.mock.calls.filter(([request]) => request.action === 'reference')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '返回上一条详情' }));
  expect(details.open).toBe(true); expect(screen.getByText('保留原详情')).toBeDefined();
  expect(interact.mock.calls.every(([request]) => ['knowledge', 'reference'].includes(request.action))).toBe(true);
});

it('saves the knowledge directory before creating the first identity', async () => {
  const { api } = setup({ ...snapshot, values: configurationValues({}) });
  fireEvent.click(await screen.findByRole('tab', { name: '知识与模型' }));
  fireEvent.change(screen.getByLabelText('知识目录'), { target: { value: '/tmp/example/first-knowledge' } });
  fireEvent.click(screen.getByRole('button', { name: '保存目录' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalled(); });
  expect(vi.mocked(api.save).mock.calls[0]?.[0].values).toMatchObject({ home: '/tmp/example/first-knowledge', upstream: '', upstreams: {} });
});

it.each([zh, en])('accepts the key directly with visibility controls and saves only a generated reference to YAML', async (locale) => {
  const english = locale === en; const value = crypto.randomUUID(); let stored = false;
  const credential = vi.fn<NonNullable<InteractionApi['credential']>>().mockImplementation((request) => { if (request.action === 'store') stored = true; return Promise.resolve({ ok: true, message: '', configured: stored, writable: true }); });
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn().mockImplementation((request: SaveConfiguration) => Promise.resolve({ ok: true, snapshot: { ...snapshot, values: request.values } })), interact: vi.fn(), credential };
  render(<TeamSettingsPage api={api} t={(key) => locale[key]} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: english ? 'Configure' : '配置' })); fireEvent.click(screen.getByRole('switch', { name: english ? 'Connect team services' : '连接团队服务' }));
  const input = await screen.findByLabelText<HTMLInputElement>(english ? 'Team authentication key' : '团队鉴权密钥'); expect(input.type).toBe('password');
  expect(screen.queryByLabelText(locale.keyEnv)).toBeNull();
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: english ? 'Show key' : '显示密钥' })); expect(input.type).toBe('text'); expect(input.value).toBe(value);
  fireEvent.click(screen.getByRole('button', { name: english ? 'Hide key' : '隐藏密钥' })); expect(input.type).toBe('password');
  fireEvent.change(screen.getByLabelText(locale.router), { target: { value: 'https://router.example.org/team-a' } }); fireEvent.change(screen.getByLabelText(locale.maintainer), { target: { value: 'https://maintainer.example.org/team-a' } });
  fireEvent.click(screen.getByRole('button', { name: english ? 'Save configuration' : '保存配置' })); await waitFor(() => { expect(api.save).toHaveBeenCalled(); });
  const reference = vi.mocked(api.save).mock.calls[0]?.[0].values.upstreams?.['coding']?.keyEnv;
  expect(reference).toMatch(/^ACN_TEAM_[0-9A-F]{32}$/); expect(credential).toHaveBeenCalledWith({ action: 'store', reference, value });
  expect(JSON.stringify(vi.mocked(api.save).mock.calls)).not.toContain(value);
  fireEvent.click(screen.getByRole('button', { name: english ? 'Configure' : '配置' }));
  const reopened = await screen.findByLabelText<HTMLInputElement>(english ? 'Team authentication key' : '团队鉴权密钥');
  await waitFor(() => { expect(reopened.placeholder).toContain('••••'); }); expect(reopened.value).toBe(''); expect(reopened.type).toBe('password');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: english ? 'Show key' : '显示密钥' }).disabled).toBe(true);
});

it('checks a draft key without storing it and retains the saved key when the field is empty', async () => {
  const { api } = setup({ ...snapshot, values: configurationValues({ upstream: 'coding', upstreams: { coding: { ...profile, routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org', keyEnv: 'EXAMPLE_TEAM_TOKEN' } } }) });
  if (api.credential === undefined) throw new Error('Expected credential API.');
  const credential = vi.mocked(api.credential);
  fireEvent.click(await screen.findByRole('button', { name: '配置' })); const input = await screen.findByLabelText('团队鉴权密钥'); const value = crypto.randomUUID();
  fireEvent.change(input, { target: { value } }); fireEvent.click(screen.getByRole('button', { name: '检查连接' }));
  await waitFor(() => { expect(api.credential).toHaveBeenCalledWith(expect.objectContaining({ action: 'check', value }), expect.any(AbortSignal)); });
  expect(credential.mock.calls.some(([request]) => request.action === 'store')).toBe(false); expect(api.save).not.toHaveBeenCalled();
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存配置' }).disabled).toBe(false); });
  fireEvent.change(input, { target: { value: '' } }); fireEvent.click(screen.getByRole('button', { name: '保存配置' })); await waitFor(() => { expect(api.save).toHaveBeenCalled(); });
  expect(vi.mocked(api.save).mock.calls[0]?.[0].values.upstreams?.['coding']?.keyEnv).toBe('EXAMPLE_TEAM_TOKEN');
});

it('does not update configuration if key storage fails and explains a later configuration conflict', async () => {
  const { api } = setup();
  if (api.credential === undefined) throw new Error('Expected credential API.');
  const credential = vi.mocked(api.credential);
  fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.click(screen.getByRole('switch', { name: '连接团队服务' }));
  fireEvent.change(screen.getByLabelText(zh.router), { target: { value: 'https://router.example.org' } }); fireEvent.change(screen.getByLabelText(zh.maintainer), { target: { value: 'https://maintainer.example.org' } });
  const input = await screen.findByLabelText<HTMLInputElement>('团队鉴权密钥'); fireEvent.change(input, { target: { value: crypto.randomUUID() } });
  credential.mockResolvedValueOnce({ ok: false, message: '无法保存密钥。' }); fireEvent.click(screen.getByRole('button', { name: '保存配置' })); await screen.findByText('无法保存密钥。'); expect(api.save).not.toHaveBeenCalled(); expect(input.value).not.toBe('');
  vi.mocked(api.save).mockResolvedValueOnce({ ok: false, code: 'conflict', fields: [] }); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText((text) => text.includes(zh.conflict)); expect(screen.getByRole('alert').textContent).toContain('本次密钥替换尚未生效'); expect(input.value).not.toBe(''); expect(screen.getByRole('button', { name: '刷新并保留草稿' })).toBeDefined();
});

it.each(['EXAMPLE_TEAM_TOKEN', `ACN_TEAM_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`])('retains the saved key reference through solo mode and team reactivation: %s', async (reference) => {
  const { api } = setup({ ...snapshot, values: configurationValues({ upstream: 'coding', upstreams: { coding: { ...profile, routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org', keyEnv: reference } } }) });
  fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.click(screen.getByRole('switch', { name: '连接团队服务' })); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(1); });
  expect(vi.mocked(api.save).mock.calls[0]?.[0].values.upstreams?.['coding']).toMatchObject({ routerEndpoint: '', maintainerEndpoint: '', keyEnv: reference });
  fireEvent.click(screen.getByRole('button', { name: '配置' })); fireEvent.click(screen.getByRole('switch', { name: '连接团队服务' }));
  const input = await screen.findByLabelText<HTMLInputElement>('团队鉴权密钥'); await waitFor(() => { expect(input.placeholder).toContain('••••'); });
  fireEvent.change(screen.getByLabelText(zh.router), { target: { value: 'https://router.example.org' } }); fireEvent.change(screen.getByLabelText(zh.maintainer), { target: { value: 'https://maintainer.example.org' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' })); await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(2); });
  expect(vi.mocked(api.save).mock.calls[1]?.[0].values.upstreams?.['coding']?.keyEnv).toBe(reference);
  if (api.credential === undefined) throw new Error('Expected credential API.');
  expect(vi.mocked(api.credential).mock.calls.some(([request]) => request.action === 'store')).toBe(false);
});

it.each(['readonly', 'describe-failed', 'unmanaged'])('allows a draft connection check when credential storage is %s', async (mode) => {
  const { api } = setup(); if (api.credential === undefined) throw new Error('Expected credential API.');
  vi.mocked(api.credential).mockImplementation((request) => Promise.resolve(request.action === 'describe' ? mode === 'readonly' ? { ok: true, message: '', configured: false, writable: false } : { ok: false, message: '托管状态不可用。' } : { ok: true, message: '临时检查通过。' }));
  fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.click(screen.getByRole('switch', { name: '连接团队服务' }));
  const input = await screen.findByLabelText<HTMLInputElement>('团队鉴权密钥'); await screen.findByText(/仍可输入密钥检查连接/); expect(input.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText(zh.router), { target: { value: 'https://router.example.org' } }); fireEvent.change(screen.getByLabelText(zh.maintainer), { target: { value: 'https://maintainer.example.org' } }); fireEvent.change(input, { target: { value: crypto.randomUUID() } });
  fireEvent.click(screen.getByRole('button', { name: '检查连接' })); await screen.findByText('临时检查通过。'); expect(api.save).not.toHaveBeenCalled();
});
