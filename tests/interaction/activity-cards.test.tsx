// 活动直接暴露可用产物，来源经过可用性校验，展开详情不阻碍主要跳转。
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivityCard } from '../../src/client/ActivityCard.js';
import { ActivitySchema } from '../../src/interaction.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
afterEach(cleanup);
it('shows delivery confirmation and public entity links without offering an unavailable source', () => {
  const openClaim = vi.fn();
  const api: InteractionApi = { read: vi.fn(), save: vi.fn(), interact: vi.fn() };
  render(<ActivityCard api={api} item={ActivitySchema.parse({ id: 'delivery-a', kind: 'delivery', state: 'succeeded', attempts: 1, updatedAt: 1, summary: '', entityIds: ['claim_00000001', 'dispute_00000001'], sessionId: 'old-session', source: { id: 'old-session', available: false } })} runtimeKey="example" busy={false} c={(zh) => zh} action={vi.fn()} openClaim={openClaim} openSource={vi.fn()} />);
  expect(screen.getByText('已确认上传')).toBeDefined(); expect(screen.queryByRole('button', { name: '查看来源会话' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'dispute_00000001' })); expect(openClaim).toHaveBeenCalledWith('dispute_00000001', '团队投递');
  expect(screen.getByText('执行详情').closest('details')?.open).toBe(false);
});
it('rechecks an available source before navigating', async () => {
  const openSource = vi.fn(); const api: InteractionApi = { read: vi.fn(), save: vi.fn(), interact: vi.fn().mockResolvedValue({ ok: false, message: '' }) };
  render(<ActivityCard api={api} item={ActivitySchema.parse({ id: 'job-a', kind: 'recap', state: 'succeeded', attempts: 1, updatedAt: 1, summary: '', sessionId: 'example-session', source: { id: 'example-session', available: true, title: 'Example session' } })} runtimeKey="example" busy={false} c={(zh) => zh} action={vi.fn()} openClaim={vi.fn()} openSource={openSource} />);
  fireEvent.click(screen.getByRole('button', { name: '查看来源会话' })); await waitFor(() => { expect(api.interact).toHaveBeenCalled(); }); expect(openSource).not.toHaveBeenCalled();
});
