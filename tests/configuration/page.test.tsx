// @vitest-environment jsdom
// 界面测试覆盖实际编辑、冲突草稿保留以及无法确认写入结果的提示。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationPage } from '../../src/client/ConfigurationPage.js';
import type { ConfigurationApi } from '../../src/client/ConfigurationPage.js';
import { configurationValues } from '../../src/configuration.js';
import type { ConfigurationSnapshot } from '../../src/configuration.js';
import { zh } from '../../src/client/locales.js';

afterEach(cleanup);
const snapshot: ConfigurationSnapshot = { revision: 'revision-a', values: configurationValues({ agentId: 'agent-a' }), models: [{ provider: 'example', providerName: 'Example', id: 'example-model', name: 'Example model' }], active: true, dataDirectory: '/tmp/example/agents/agent-a' };
const t = (key: keyof typeof zh) => zh[key];
function setup(save: ConfigurationApi['save']) {
  const api: ConfigurationApi = { read: vi.fn().mockResolvedValue(snapshot), save: vi.fn(save) };
  render(<ConfigurationPage api={api} t={t} />);
  return api;
}

describe('configuration page', () => {
  it('tracks unsaved changes through edits, reversions and a confirmed save', async () => {
    let finishSave: ((result: Awaited<ReturnType<ConfigurationApi['save']>>) => void) | undefined;
    const api = setup(() => new Promise((resolve) => { finishSave = resolve; }));
    const input = await screen.findByLabelText(/Agent ID/);
    expect(screen.getByText(zh.saveHint)).toBeDefined();
    expect(screen.getByText(zh.noChanges)).toBeDefined();
    fireEvent.change(input, { target: { value: 'personal' } });
    expect(screen.getByText(zh.unsaved)).toBeDefined();
    expect(api.save).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'agent-a' } });
    expect(screen.getByText(zh.noChanges)).toBeDefined();
    fireEvent.change(input, { target: { value: 'personal' } });
    fireEvent.click(screen.getByRole('button', { name: zh.save }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saving }).disabled).toBe(true);
    expect(screen.getByText(zh.unsaved)).toBeDefined();
    finishSave?.({ ok: true, snapshot: { ...snapshot, revision: 'revision-b', values: { ...snapshot.values, agentId: 'personal' } } });
    await screen.findByText(zh.saved);
    expect(screen.getByText(zh.noChanges)).toBeDefined();
    expect(screen.queryByText(zh.unsaved)).toBeNull();
  });
  it('explains shared local identity in solo mode and team identity when switching modes', async () => {
    setup(vi.fn());
    await screen.findByText(zh.agentSoloHint);
    fireEvent.change(screen.getByLabelText(/^运行模式/), { target: { value: 'team' } });
    expect(screen.getByText(zh.agentTeamHint)).toBeDefined();
    expect(screen.queryByText(zh.agentSoloHint)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^运行模式/), { target: { value: 'solo' } });
    expect(screen.getByText(zh.agentSoloHint)).toBeDefined();
  });
  it('submits selected model and paired team settings with the original revision', async () => {
    const api = setup((request) => Promise.resolve({ ok: true, snapshot: { ...snapshot, revision: 'revision-b', values: request.values } }));
    await screen.findByLabelText(/Agent ID/);
    fireEvent.change(screen.getByRole('combobox', { name: /^ACN 后台模型/ }), { target: { value: JSON.stringify(['example', 'example-model']) } });
    fireEvent.change(screen.getByLabelText(/^运行模式/), { target: { value: 'team' } });
    fireEvent.change(screen.getByLabelText('Router 地址'), { target: { value: 'http://127.0.0.1:8101' } });
    fireEvent.change(screen.getByLabelText('Maintainer 地址'), { target: { value: 'http://127.0.0.1:8102' } });
    fireEvent.change(screen.getByLabelText(/^团队凭据引用名/), { target: { value: 'EXAMPLE_TEAM_TOKEN' } });
    fireEvent.click(screen.getByRole('button', { name: zh.save }));
    await screen.findByText(zh.saved);
    const request = vi.mocked(api.save).mock.calls[0]?.[0];
    expect(request?.revision).toBe('revision-a');
    expect(request?.values).toMatchObject({ provider: 'example', model: 'example-model', mode: 'team', keyEnv: 'EXAMPLE_TEAM_TOKEN' });
  });
  it('retains the edited identity after a concurrent write conflict', async () => {
    const api = setup(() => Promise.resolve({ ok: false, code: 'conflict', fields: [] }));
    const input = await screen.findByLabelText(/Agent ID/);
    fireEvent.change(input, { target: { value: 'agent-b' } });
    fireEvent.click(screen.getByRole('button', { name: zh.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(zh.conflict);
    expect((input as HTMLInputElement).value).toBe('agent-b');
    expect(screen.getByText(zh.unsaved)).toBeDefined();
    const reloadButton = screen.getByRole('button', { name: zh.reload });
    expect(reloadButton.getAttribute('title')).toBe(zh.reloadHint);
    expect(document.getElementById(reloadButton.getAttribute('aria-describedby') ?? '')?.textContent).toBe(zh.reloadHint);
    fireEvent.click(screen.getByRole('button', { name: zh.reload }));
    await waitFor(() => { expect((input as HTMLInputElement).value).toBe('agent-a'); });
    expect(api.read).toHaveBeenCalledTimes(2);
  });
  it('reports an unknown transport result without claiming persistence failed or succeeded', async () => {
    setup(() => Promise.reject(new Error('Transport unavailable')));
    await screen.findByLabelText(/Agent ID/);
    fireEvent.click(screen.getByRole('button', { name: zh.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(zh.errorTransport);
    expect(screen.queryByText(zh.saved)).toBeNull();
  });
  it('shows an unavailable saved model without silently selecting another one', async () => {
    const unavailable = { ...snapshot, values: { ...snapshot.values, provider: 'removed', model: 'old-model' } };
    render(<ConfigurationPage api={{ read: () => Promise.resolve(unavailable), save: vi.fn() }} t={t} />);
    await screen.findByText(`removed / old-model — ${zh.unavailableModel}`);
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: /^ACN 后台模型/ }).value).toBe(JSON.stringify(['removed', 'old-model']));
  });
});
