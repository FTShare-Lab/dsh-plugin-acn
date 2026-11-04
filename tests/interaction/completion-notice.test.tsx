// @vitest-environment jsdom
// 结果提示开关只改变展示与展示回执，活动读取保持可用。
import type { ComponentProps } from 'react';
import { SessionId } from '@deepseek-ai/dsh-session';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionToolbar } from '../../src/client/SessionToolbar.js';
import { SessionViewSchema } from '../../src/interaction.js';
import type { InteractionApi } from '../../src/client/TeamSettingsPage.js';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const c = (zh: string) => zh;
const useSession = ((select: (value: { running: boolean; subagent: null }) => unknown) => select({ running: false, subagent: null })) as unknown as ComponentProps<typeof SessionToolbar>['useSession'];
it.each([false, true])('controls the completion notice without suppressing activity reads, enabled=%s', async (enabled) => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const view = SessionViewSchema.parse({ sessionId: 'session-a', key: 'personal', name: 'Example', locked: true, available: true, phase: 'ready', message: '', defaultConnection: 'personal', showCompletion: enabled, choices: [{ key: 'personal', name: 'Example', agentId: 'agent-a', enabled: true, mode: 'solo' }] });
  const interact = vi.fn<InteractionApi['interact']>().mockImplementation((request) => Promise.resolve(request.action === 'session' ? { ok: true, message: '', session: view } : request.action === 'activity' ? { ok: true, message: '', knowledge: { key: 'personal', name: 'Example', items: [], omitted: 0, pendingClaims: 0, pendingDisputes: 0, activities: [{ id: 'job-a', kind: 'recap', state: 'succeeded', attempts: 1, updatedAt: 1, sessionId: 'session-a', unseen: true, summary: 'Example completed result' }] } } : { ok: true, message: '' }));
  render(<SessionToolbar api={{ read: vi.fn(), save: vi.fn(), interact }} c={c} block={vi.fn()} sessionId={SessionId('session-a')} useSession={useSession} openSettings={vi.fn()} openKnowledge={vi.fn()} />);
  await waitFor(() => { expect(interact.mock.calls.some(([request]) => request.action === 'activity')).toBe(true); });
  if (enabled) {
    await screen.findByText('Example completed result');
    await waitFor(() => { expect(interact.mock.calls.some(([request]) => request.action === 'ack')).toBe(true); });
  } else {
    expect(screen.queryByText('Example completed result')).toBeNull();
    expect(interact.mock.calls.some(([request]) => request.action === 'ack')).toBe(false);
  }
});
