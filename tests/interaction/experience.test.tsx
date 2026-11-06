// @vitest-environment jsdom
// 页面轮询保留筛选与展开状态；成功反馈不引导用户检查设置，报告直接展示路径。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { KnowledgePanel } from '../../src/client/KnowledgePanel.js';
import { KnowledgeDetail } from '../../src/client/KnowledgeDetail.js';
import { TeamSettingsPage } from '../../src/client/TeamSettingsPage.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
import { configurationValues } from '../../src/configuration.js';
import { knowledgeStatus } from '../../src/client/knowledge-labels.js';
import { zh } from '../../src/client/locales.js';
import { ClaimIdSchema } from '../../src/protocol/ids.js';
const c = (zh: string) => zh;
const snapshot = { revision: 'initial', active: true, dataDirectory: '', models: [], values: configurationValues({ upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } } }) };
const base = { key: 'coding', name: 'Example', items: [], activities: [], omitted: 0, pendingClaims: 0, pendingDisputes: 0 };
afterEach(cleanup);
it('continues a paused task, explains its disappearance from attention and retains successful feedback', async () => {
  let resumed = false;
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact: vi.fn<InteractionApi['interact']>((request) => {
    if (request.action === 'retry') { resumed = true; return Promise.resolve({ ok: true, message: '任务已重新入队。' }); }
    return Promise.resolve({ ok: true, message: '', knowledge: { ...base, activities: resumed && request.action === 'activity' && request.attentionOnly ? [] : [{ id: 'job-a', kind: 'dream', state: resumed ? 'queued' : 'paused', updatedAt: 1, attempts: 1, unseen: false, summary: 'Waiting' }] } });
  }) };
  render(<KnowledgePanel api={api} initialKey="coding" initialTab="activity" c={c} openSettings={vi.fn()} />);
  fireEvent.click(await screen.findByLabelText('只看需要处理')); fireEvent.click(await screen.findByLabelText('dream · 已暂停'));
  fireEvent.click(screen.getByRole('button', { name: '继续任务' }));
  await screen.findByText('任务已重新入队。'); await screen.findByText(/当前筛选下没有处理活动/);
  expect(screen.queryByRole('button', { name: '检查 ACN 设置' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看全部活动' })); await screen.findByLabelText('dream · 等待处理');
});
it('refreshes visible running activity without replacing expanded details and stops after completion', async () => {
  let finished = false;
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact: vi.fn<InteractionApi['interact']>().mockImplementation(() => Promise.resolve({ ok: true, message: '', knowledge: { ...base, runningCount: finished ? 0 : 1, activities: [{ id: 'job-a', kind: 'dream', state: finished ? 'succeeded' : 'running', phase: finished ? 'finished' : 'exploration', attempts: 1, updatedAt: 1, summary: 'Example', unseen: false, reportPath: '/example/dream/report.md' }] } })) };
  render(<KnowledgePanel api={api} initialKey="coding" initialTab="activity" c={c} />);
  const row = await screen.findByRole('article', { name: 'dream · 正在处理' }); const details = row.querySelector('details'); if (details) details.open = true;
  finished = true;
  await screen.findByLabelText('dream · 已应用到本地', {}, { timeout: 3500 }); expect(details?.open).toBe(true);
  expect(screen.getByText('/example/dream/report.md')).toBeDefined(); expect(screen.queryByRole('button', { name: '复制报告路径' })).toBeNull();
  const count = vi.mocked(api.interact).mock.calls.length; await new Promise((resolve) => setTimeout(resolve, 2200)); expect(api.interact).toHaveBeenCalledTimes(count);
});
it('shows field-specific configuration errors and keeps the draft', async () => {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn().mockResolvedValue({ ok: false, code: 'invalid', fields: ['upstreams.coding.timeoutMs'] }), interact: vi.fn() };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'Invalid ID' } }); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Agent ID：使用小写字母'); expect(api.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-a' } }); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('团队请求超时：必须为正整数'); }); expect(screen.getByLabelText<HTMLInputElement>('Agent ID').value).toBe('agent-a');
});
it('uses dashboard terms, preserves content and leaves undefined enum mappings unchanged', () => {
  render(<KnowledgeDetail text={JSON.stringify({ id: 'claim_00000001', status: 'stale', statement: 'Original English content', scope: 'service / reads', evidence_summary: 'Original evidence', confidence: 'high', holder: 'agent-a' })} c={c} openClaim={vi.fn()} />);
  expect(screen.getByText('正文')).toBeDefined(); expect(screen.getByText('证据摘要')).toBeDefined(); expect(screen.getByText('状态: 陈旧')).toBeDefined(); expect(screen.getByText('Original English content')).toBeDefined();
  expect(screen.getByText('高')).toBeDefined();
  expect(knowledgeStatus('deprecated', c)).toBe('废弃'); expect(knowledgeStatus('high', c)).toBe('high'); expect(knowledgeStatus('active', (_zh, en) => en)).toBe('active');
});
it('exposes all six advanced preferences without duplicate default or component actions', async () => {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn<InteractionApi['save']>().mockImplementation((request) => Promise.resolve({ ok: true, snapshot: { ...snapshot, revision: 'next', values: request.values } })), interact: vi.fn() };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} openPlugins={vi.fn()} />);
  fireEvent.click(await screen.findByRole('tab', { name: '偏好' }));
  expect(screen.queryByRole('combobox', { name: '默认工作配置' })).toBeNull();
  fireEvent.click(screen.getByText('高级参数'));
  for (const label of ['Inbox 过期处理时间（秒）', 'Router 查询超时（秒）', 'HTTP 单次超时（秒）', '额外重试次数', '重试基础等待（毫秒）', '重试最长等待（毫秒）']) expect(screen.getByLabelText(label)).toBeDefined();
  fireEvent.change(screen.getByLabelText('额外重试次数'), { target: { value: '0' } }); fireEvent.click(screen.getByRole('button', { name: '保存高级参数' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalled(); }); expect(vi.mocked(api.save).mock.calls[0]?.[0].values.advanced?.httpRetryCount).toBe(0);
  expect(screen.queryByRole('button', { name: '管理 ACN 组件' })).toBeNull(); expect(api.interact).not.toHaveBeenCalled();
});
it('shows independent connection results in a dismissible dialog without form placeholders', async () => {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact: vi.fn().mockResolvedValue({ ok: false, message: 'Partial', checks: [{ service: 'router', state: 'ok', message: '连接与认证通过' }, { service: 'maintainer', state: 'failed', message: '连接超时，请检查服务状态和网络后重试。' }] }) };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.click(screen.getByRole('switch', { name: '连接团队服务' }));
  fireEvent.change(screen.getByLabelText(zh.router), { target: { value: 'https://router.example.org' } }); fireEvent.change(screen.getByLabelText(zh.maintainer), { target: { value: 'https://maintainer.example.org' } });
  expect(screen.queryByLabelText('团队连接检查结果')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: '检查连接' }));
  const dialog = await screen.findByRole('dialog', { name: '连接检查结果' });
  expect(dialog.contains(screen.getByText('✅'))).toBe(true); expect(dialog.contains(screen.getByText('❌'))).toBe(true);
  expect(screen.queryByText('Partial')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '确认' })); expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByLabelText('团队连接检查结果')).toBeNull(); expect(screen.getByLabelText<HTMLInputElement>('Agent ID').value).toBe('agent-a');
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-b' } }); expect(screen.queryByText('✅')).toBeNull(); expect(api.save).not.toHaveBeenCalled();
});
it('explains an inactive handler without offering an executable continue action', async () => {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact: vi.fn<InteractionApi['interact']>().mockResolvedValue({ ok: true, message: '', knowledge: { ...base, activities: [{ id: 'job-a', kind: 'dream', state: 'paused', attempts: 0, updatedAt: 1, unseen: false, summary: '', error: '对应后台组件未启用，请在插件管理中启用后等待任务继续。', errorInfo: { code: 'task.handler_inactive' } }] } }) };
  const openComponents = vi.fn();
  render(<KnowledgePanel api={api} initialKey="coding" initialTab="activity" c={c} openComponents={openComponents} />);
  fireEvent.click(await screen.findByLabelText('dream · 已暂停'));
  const button = screen.getByRole('button', { name: '启用组件后继续' }); expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button);
  expect(vi.mocked(api.interact).mock.calls.some(([request]) => request.action === 'retry')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '前往插件管理' })); expect(openComponents).toHaveBeenCalledOnce();
});
it('focuses source navigation and returns to the originating reference without losing the expanded record', async () => {
  const item = { kind: 'trace' as const, id: 'trace_00000001', name: 'Example trace', status: '', detail: JSON.stringify({ input_claims: ['claim_00000001'] }) };
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact: vi.fn<InteractionApi['interact']>((request) => Promise.resolve(request.action === 'reference'
    ? { ok: true, message: '', reference: { key: 'coding', id: ClaimIdSchema.parse(request.id), ...(request.id === 'claim_00000001' ? { item: { kind: 'claim' as const, id: 'claim_00000001', name: 'Source claim', status: 'active', detail: JSON.stringify({ confidence: 'medium', statement: 'Source content', source_claim_ids: ['claim_00000002'] }) } } : {}) } }
    : { ok: true, message: '', knowledge: { ...base, items: [item] } })) };
  render(<KnowledgePanel api={api} initialKey="coding" c={c} />);
  fireEvent.click(await screen.findByLabelText(/^Example trace/));
  const origin = await screen.findByRole('button', { name: 'claim_00000001' }); fireEvent.click(origin);
  await screen.findByText('Source content'); expect(document.activeElement).toBe(screen.getByRole('button', { name: '返回上一条详情' })); expect(screen.getByText('中')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'claim_00000002' })); await screen.findByText('此来源未保存在当前知识库。');
  fireEvent.click(screen.getByRole('button', { name: '返回上一条详情' })); await screen.findByText('Source content');
  fireEvent.click(screen.getByRole('button', { name: '返回上一条详情' }));
  await waitFor(() => { expect(document.activeElement).toBe(origin); }); expect(origin.closest('details')?.open).toBe(true);
});
it('uses source titles in activity filters and lets keyboard users switch knowledge types', async () => {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact: vi.fn().mockResolvedValue({ ok: true, message: '', knowledge: { ...base, activitySources: ['session-example'], activities: [{ id: 'job-a', kind: 'recap', state: 'succeeded', attempts: 1, updatedAt: 1, unseen: false, summary: '', sessionId: 'session-example', source: { id: 'session-example', title: 'Example session', available: true } }] } }) };
  render(<KnowledgePanel api={api} initialKey="coding" c={c} />);
  const claim = await screen.findByRole('tab', { name: 'Claim' }); fireEvent.keyDown(claim, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Dispute' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: '处理活动' }));
  expect(await screen.findByRole('option', { name: 'Example session' })).toBeDefined();
});
