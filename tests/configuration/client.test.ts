// 使用真实客户端 Gateway 和 Cordis 注入边界，避免表单测试遗漏命名空间接线。
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import type { ReactElement } from 'react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import * as Client from '../../src/plugins/client.js';
import type { TeamSettingsProps } from '../../src/client/TeamSettingsPage.js';
import { configurationValues } from '../../src/configuration.js';
import type { ConfigurationSnapshot } from '../../src/configuration.js';
import { zh } from '../../src/client/locales.js';
import type { ConfigurationText } from '../../src/client/locales.js';

it('mounts and injects its namespace before the page calls the real client Remote', async () => {
  const ctx = new Context();
  let component: (() => ReactElement) | undefined;
  const snapshot: ConfigurationSnapshot = { revision: 'current', values: configurationValues({}), models: [], active: true, dataDirectory: '' };
  const call = vi.fn().mockResolvedValue({ ok: true, value: snapshot });
  // 仅替换网络和界面宿主；服务注册、命名空间授权与参数编码由真实 Gateway 执行。
  ctx.provide('connection', { interactions: 'none', rpc: { call, open: () => { throw new Error('Unexpected stream.'); } } });
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: ConfigurationText) => zh[key] } as unknown as Context['locale']);
  ctx.provide('slots', {
    inject: (_name: string, apply: () => () => void) => apply(),
    register: (_declaration: unknown, render: () => ReactElement) => { component = render; return () => { component = undefined; }; },
  } as unknown as Context['slots']);
  try {
    await ctx.plugin(TypertRegistry);
    await ctx.plugin(Gateway);
    const fiber = ctx.plugin(Client); await fiber;
    await expect.poll(() => component).toBeDefined();
    if (component === undefined) throw new Error('Expected a configuration page.');
    // 真实渲染由 React 拥有 hooks；只截获注册时的元素，验证其宿主 API 编码。
    let captured: TeamSettingsProps | undefined;
    const react = await import('react-dom/server');
    const original = await import('../../src/client/TeamSettingsPage.js');
    const spy = vi.spyOn(original, 'TeamSettingsPage').mockImplementation((props) => { captured = props; return createElement('div'); });
    try { react.renderToString(createElement(component)); } finally { spy.mockRestore(); }
    if (captured === undefined) throw new Error('Expected team settings.');
    const api = captured.api;
    expect(await api.read()).toEqual(snapshot);
    expect(call).toHaveBeenCalledWith('/api', 'acnConfiguration/read', { args: {} }, expect.any(AbortSignal));
    call.mockResolvedValueOnce({ ok: true, value: { ok: true, snapshot } });
    const request = { revision: snapshot.revision, values: { ...snapshot.values, agentId: 'agent-a' } };
    expect((await api.save(request)).ok).toBe(true);
    expect(call.mock.calls.at(-1)?.[2]).toEqual({ args: { request } });
    if (api.credential === undefined) throw new Error('Expected credential API.');
    const controller = new AbortController();
    call.mockResolvedValueOnce({ ok: true, value: { ok: true, message: '', configured: false, writable: true } });
    await api.credential({ action: 'describe', reference: 'EXAMPLE_TEAM_TOKEN' }, controller.signal);
    const credentialSignal: unknown = call.mock.calls.at(-1)?.[3];
    if (!(credentialSignal instanceof AbortSignal)) throw new Error('Expected a transport signal.');
    controller.abort(); expect(credentialSignal.aborted).toBe(true);
    const checking = new AbortController();
    call.mockResolvedValueOnce({ ok: true, value: { ok: true, message: '' } });
    await api.interact({ action: 'check', connection: { agentId: 'agent-a', routerEndpoint: 'https://router.example.org', maintainerEndpoint: 'https://maintainer.example.org' } }, checking.signal);
    const checkingSignal: unknown = call.mock.calls.at(-1)?.[3];
    if (!(checkingSignal instanceof AbortSignal)) throw new Error('Expected a transport signal.');
    checking.abort(); expect(checkingSignal.aborted).toBe(true);
    await fiber.dispose();
    expect(component).toBeUndefined();
  } finally { await ctx.fiber.dispose(); }
});
