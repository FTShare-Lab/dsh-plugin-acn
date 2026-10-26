// 使用真实客户端 Gateway 和 Cordis 注入边界，避免表单测试遗漏命名空间接线。
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import type { ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import * as Client from '../../src/plugins/client.js';
import type { ConfigurationPageProps } from '../../src/client/ConfigurationPage.js';
import { configurationValues } from '../../src/configuration.js';
import type { ConfigurationSnapshot } from '../../src/configuration.js';
import { zh } from '../../src/client/locales.js';
import type { ConfigurationText } from '../../src/client/locales.js';

it('mounts and injects its namespace before the page calls the real client Remote', async () => {
  const ctx = new Context();
  let component: (() => ReactElement<ConfigurationPageProps>) | undefined;
  const snapshot: ConfigurationSnapshot = { revision: 'current', values: configurationValues({}), models: [], active: true, dataDirectory: '' };
  const call = vi.fn().mockResolvedValue({ ok: true, value: snapshot });
  // 仅替换网络和界面宿主；服务注册、命名空间授权与参数编码由真实 Gateway 执行。
  ctx.provide('connection', { interactions: 'none', rpc: { call, open: () => { throw new Error('Unexpected stream.'); } } });
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: ConfigurationText) => zh[key] } as unknown as Context['locale']);
  ctx.provide('slots', {
    inject: (_name: string, apply: () => () => void) => apply(),
    register: (_declaration: unknown, render: () => ReactElement<ConfigurationPageProps>) => { component = render; return () => { component = undefined; }; },
  } as unknown as Context['slots']);
  try {
    await ctx.plugin(TypertRegistry);
    await ctx.plugin(Gateway);
    const fiber = ctx.plugin(Client); await fiber;
    await expect.poll(() => component).toBeDefined();
    if (component === undefined) throw new Error('Expected a configuration page.');
    const api = component().props.api;
    expect(await api.read()).toEqual(snapshot);
    expect(call).toHaveBeenCalledWith('/api', 'acnConfiguration/read', { args: {} }, expect.any(AbortSignal));
    call.mockResolvedValueOnce({ ok: true, value: { ok: true, snapshot } });
    const request = { revision: snapshot.revision, values: { ...snapshot.values, agentId: 'agent-a' } };
    expect((await api.save(request)).ok).toBe(true);
    expect(call.mock.calls.at(-1)?.[2]).toEqual({ args: { request } });
    await fiber.dispose();
    expect(component).toBeUndefined();
  } finally { await ctx.fiber.dispose(); }
});
