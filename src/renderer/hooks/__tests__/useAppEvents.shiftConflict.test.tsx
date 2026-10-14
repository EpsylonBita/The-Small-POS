/**
 * The app-level listener of `recovery:shift-conflict`: one toast per refused
 * shift, in the store's language, never on a customer-facing display.
 */
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  toastError: vi.fn(),
  t: (key: string, fallback?: string | { defaultValue?: string }) =>
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
}));

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), {
    error: mocks.toastError, success: vi.fn(), loading: vi.fn(), dismiss: vi.fn(),
  });
  return { toast, default: toast };
});
vi.mock('../../contexts/i18n-context', () => ({ useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: mocks.t }) }));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ printer: { listJobs: vi.fn(async () => ({ success: true, queuePaused: false })) } }),
  onEvent: (channel: string, callback: (payload: unknown) => void) => mocks.handlers.set(channel, callback),
  offEvent: (channel: string) => mocks.handlers.delete(channel),
}));

import { useAppEvents } from '../useAppEvents';

describe('useAppEvents: recovery:shift-conflict', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.toastError.mockReset();
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => cleanup());

  it('tells the cashier once per refused shift', () => {
    renderHook(() => useAppEvents({ onLogout: vi.fn() }));
    const handler = mocks.handlers.get('recovery:shift-conflict');
    expect(handler).toBeTypeOf('function');

    handler?.({ shiftId: 'shift-offline', code: 'OFFLINE_CHECK_IN_CONFLICT', reason: 'active_shift_elsewhere' });
    // The mocked `t` answers each key's default text.
    expect(mocks.toastError).toHaveBeenCalledWith(
      'The server refused a check-in made without a connection: The server could not confirm this check-in. The shift stays on this till for review in Sync.',
      expect.objectContaining({ id: 'shift-conflict-shift-offline' }),
    );

    handler?.({ unexpected: true });
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });

  it('stays silent on a customer-facing display', () => {
    window.history.replaceState({}, '', '/?externalDisplay=customer');
    renderHook(() => useAppEvents({ onLogout: vi.fn() }));
    mocks.handlers.get('recovery:shift-conflict')?.({ shiftId: 's-1', code: 'SHIFT_CONFLICT' });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
