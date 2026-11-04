// 空会话结果回执仅展示本会话的 ACN 命令，不重复已有对话的宿主记录。
// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BlankCommandFeedback } from '../../src/client/BlankCommandFeedback.js';
afterEach(cleanup);
it('displays only the current blank session command result and releases its listener', () => {
  type Props = ComponentProps<typeof BlankCommandFeedback>;
  let listener: Parameters<Props['subscribe']>[0] | undefined;
  const unsubscribe = vi.fn();
  const subscribe: Props['subscribe'] = (next) => { listener = next; return unsubscribe; };
  const props = { blank: true, sessionId: 'session-a', c: (zh: string) => zh, subscribe };
  const page = render(<BlankCommandFeedback {...props} />);
  act(() => { listener?.('session-b', 'acn-status', { kind: 'success', text: 'Other session' }); listener?.('session-a', 'other-command', { kind: 'success', text: 'Other command' }); });
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => { listener?.('session-a', 'acn-status', { kind: 'success', text: 'ACN: solo\nClaim: 1' }); });
  expect(screen.getByRole('dialog', { name: '/acn-status' }).textContent).toContain('ACN: solo\nClaim: 1');
  fireEvent.click(screen.getByRole('button', { name: '确认' })); expect(screen.queryByRole('dialog')).toBeNull();
  act(() => { listener?.('session-a', 'dream', { kind: 'error', text: '用法：/dream [stop]' }); });
  expect(screen.getByRole('alert').textContent).toContain('/dream [stop]');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
  page.rerender(<BlankCommandFeedback {...props} blank={false} />); expect(unsubscribe).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});
