// @vitest-environment jsdom
// 页面轮询保留筛选与展开状态；成功反馈不引导用户检查设置，报告可复制。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { KnowledgePanel } from '../../src/client/KnowledgePanel.js';
import { KnowledgeDetail } from '../../src/client/KnowledgeDetail.js';
import { TeamSettingsPage } from '../../src/client/TeamSettingsPage.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
import { configurationValues } from '../../src/configuration.js';
import { knowledgeStatus } from '../../src/client/knowledge-labels.js';
import { zh } from '../../src/client/locales.js';
const c = (zh: string) => zh;
const snapshot = { revision: 'initial', active: true, dataDirectory: '', models: [], values: configurationValues({ upstream: 'coding', upstreams: { coding: { agentId: 'agent-a' } } }) };
const base = { key: 'coding', name: 'Example', items: [], omitted: 0, pendingClaims: 0, pendingDisputes: 0 };
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
  const copy = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  render(<KnowledgePanel api={api} initialKey="coding" initialTab="activity" c={c} />);
  const summary = await screen.findByLabelText('dream · 正在处理'); const details = summary.closest('details'); if (details) details.open = true;
  finished = true;
  await screen.findByLabelText('dream · 本地处理完成', {}, { timeout: 3500 }); expect(details?.open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '复制报告路径' })); await screen.findByText('已复制报告路径'); expect(copy).toHaveBeenCalledWith('/example/dream/report.md');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); fireEvent.click(screen.getByRole('button', { name: '复制报告路径' })); await screen.findByText('复制失败，请选择上方路径手动复制。');
  const count = vi.mocked(api.interact).mock.calls.length; await new Promise((resolve) => setTimeout(resolve, 2200)); expect(api.interact).toHaveBeenCalledTimes(count);
});
it('shows field-specific configuration errors and keeps the draft', async () => {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn().mockResolvedValue({ ok: false, code: 'invalid', fields: ['upstreams.coding.timeoutMs'] }), interact: vi.fn() };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '配置' }));
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'Invalid ID' } }); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Agent ID：只能使用小写字母'); expect(api.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-a' } }); fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('团队请求超时：必须为正整数'); }); expect(screen.getByLabelText<HTMLInputElement>('Agent ID').value).toBe('agent-a');
});
it('uses dashboard terms, preserves content and leaves undefined enum mappings unchanged', () => {
  render(<KnowledgeDetail text={JSON.stringify({ id: 'claim_00000001', status: 'stale', statement: 'Original English content', scope: 'service / reads', evidence_summary: 'Original evidence', confidence: 'high', holder: 'agent-a' })} c={c} openClaim={vi.fn()} />);
  expect(screen.getByText('正文')).toBeDefined(); expect(screen.getByText('证据摘要')).toBeDefined(); expect(screen.getByText('状态: 陈旧')).toBeDefined(); expect(screen.getByText('Original English content')).toBeDefined();
  expect(knowledgeStatus('deprecated', c)).toBe('废弃'); expect(knowledgeStatus('high', c)).toBe('high'); expect(knowledgeStatus('active', (_zh, en) => en)).toBe('active');
});
it('exposes the default configuration and all six advanced preferences without a redundant component action', async () => {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn<InteractionApi['save']>().mockImplementation((request) => Promise.resolve({ ok: true, snapshot: { ...snapshot, revision: 'next', values: request.values } })), interact: vi.fn() };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} openPlugins={vi.fn()} />);
  fireEvent.click(await screen.findByRole('tab', { name: '偏好' }));
  expect(screen.getByRole('combobox', { name: '默认工作配置' })).toBeDefined();
  fireEvent.click(screen.getByText('高级参数'));
  for (const label of ['Inbox 过期处理时间（秒）', 'Router 查询超时（秒）', 'HTTP 单次超时（秒）', '额外重试次数', '重试基础等待（毫秒）', '重试最长等待（毫秒）']) expect(screen.getByLabelText(label)).toBeDefined();
  fireEvent.change(screen.getByLabelText('额外重试次数'), { target: { value: '0' } }); fireEvent.click(screen.getByRole('button', { name: '保存高级参数' }));
  await waitFor(() => { expect(api.save).toHaveBeenCalled(); }); expect(vi.mocked(api.save).mock.calls[0]?.[0].values.advanced?.httpRetryCount).toBe(0);
  expect(screen.queryByRole('button', { name: '管理 ACN 组件' })).toBeNull(); expect(api.interact).not.toHaveBeenCalled();
});
it('clears check marks after changing a checked identity and shows unchecked status again', async () => {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact: vi.fn().mockResolvedValue({ ok: false, message: 'Partial', checks: [{ service: 'router', state: 'ok', message: '连接与认证通过' }, { service: 'maintainer', state: 'failed', message: '连接超时，请检查服务状态和网络后重试。' }] }) };
  render(<TeamSettingsPage api={api} t={(key) => zh[key]} openKnowledge={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '配置' })); fireEvent.click(screen.getByRole('switch', { name: '连接团队服务' }));
  fireEvent.change(screen.getByLabelText(zh.router), { target: { value: 'https://router.example.org' } }); fireEvent.change(screen.getByLabelText(zh.maintainer), { target: { value: 'https://maintainer.example.org' } });
  expect(screen.getAllByText('❓')).toHaveLength(2); fireEvent.click(screen.getByRole('button', { name: '检查连接' })); await screen.findByText('✅'); expect(screen.getByText('❌')).toBeDefined();
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'agent-b' } }); await waitFor(() => { expect(screen.getAllByText('❓')).toHaveLength(2); }); expect(screen.queryByText('✅')).toBeNull(); expect(screen.queryByText('Partial')).toBeNull();
});
it('explains an inactive handler without offering an executable continue action', async () => {
  const api: InteractionApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(), interact: vi.fn<InteractionApi['interact']>().mockResolvedValue({ ok: true, message: '', knowledge: { ...base, activities: [{ id: 'job-a', kind: 'dream', state: 'paused', attempts: 0, updatedAt: 1, unseen: false, summary: '', error: '对应后台组件未启用，请在插件管理中启用后等待任务继续。', errorInfo: { code: 'task.handler_inactive' } }] } }) };
  render(<KnowledgePanel api={api} initialKey="coding" initialTab="activity" c={c} />);
  fireEvent.click(await screen.findByLabelText('dream · 已暂停'));
  const button = screen.getByRole('button', { name: '启用组件后继续' }); expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button);
  expect(vi.mocked(api.interact).mock.calls.some(([request]) => request.action === 'retry')).toBe(false);
});
