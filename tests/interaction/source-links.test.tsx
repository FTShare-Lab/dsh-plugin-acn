// @vitest-environment jsdom
// 链接验证失败保留详情；成功后才交给宿主打开会话。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceSessionLink } from '../../src/client/SourceSessionLink.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
afterEach(cleanup);
const c = (value: string) => value;
it('does not navigate when a previously available source has disappeared', async () => {
  const open = vi.fn(); const api: InteractionApi = { read: vi.fn(), save: vi.fn(), interact: vi.fn().mockResolvedValue({ ok: false, message: '', sourceSession: { id: 'source-a', available: false } }) };
  render(<SourceSessionLink api={api} source={{ id: 'source-a', title: '来源示例', available: true }} c={c} open={open} />);
  fireEvent.click(screen.getByRole('button', { name: '来源示例' })); await screen.findByText('来源会话不可用。'); expect(open).not.toHaveBeenCalled();
});
it('opens a checked source and shows an unavailable source as plain text', async () => {
  const open = vi.fn(); const api: InteractionApi = { read: vi.fn(), save: vi.fn(), interact: vi.fn().mockResolvedValue({ ok: true, message: '', sourceSession: { id: 'source-a', available: true } }) };
  const view = render(<SourceSessionLink api={api} source={{ id: 'source-a', available: true }} c={c} open={open} />);
  fireEvent.click(screen.getByRole('button', { name: 'source-a' })); await waitFor(() => { expect(open).toHaveBeenCalledWith('source-a'); });
  view.rerender(<SourceSessionLink api={api} source={{ id: 'removed-source', available: false }} c={c} open={open} />);
  expect(screen.queryByRole('button')).toBeNull(); expect(screen.getByText('removed-source（不可用）')).toBeDefined();
});
