/**
 * `recovery:shift-conflict` (Rust `emit_shift_conflicts`) had no renderer
 * listener and no event-bridge mapping, so a shift the server refused, and
 * now a check-in made without a connection it refused on replay
 * (`OFFLINE_CHECK_IN_CONFLICT`), reached nobody. The bridge now delivers it
 * and the cashier sees it in the store's language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  unlisten: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../../lib/platform-detect', () => ({ isTauri: () => true }));

import { offEvent, onEvent, stopEventBridge } from '../../../lib/event-bridge';
import {
  SHIFT_CONFLICT_CHANNEL,
  describeShiftConflict,
  readShiftConflictNotice,
} from '../shiftConflictNotice';

const t = ((key: string, fallback?: string | { defaultValue?: string }) =>
  `[${key}|${typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? ''}]`) as unknown as TFunction;

describe('recovery:shift-conflict', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.listen.mockReset();
    mocks.unlisten.mockReset();
    mocks.listen.mockImplementation(async (event: string, callback: (event: { payload: unknown }) => void) => {
      mocks.handlers.set(event, callback);
      return mocks.unlisten;
    });
  });
  afterEach(() => stopEventBridge());

  it('reaches a renderer listener through the native event bridge', async () => {
    const listener = vi.fn();
    const payload = { shiftId: 'shift-1', code: 'OFFLINE_CHECK_IN_CONFLICT', reason: 'waiter_terminal' };
    onEvent(SHIFT_CONFLICT_CHANNEL, listener);
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledWith('recovery:shift-conflict', expect.any(Function)));
    mocks.handlers.get('recovery:shift-conflict')?.({ payload });
    expect(listener).toHaveBeenCalledWith(payload);
    offEvent(SHIFT_CONFLICT_CHANNEL, listener);
  });

  it('reads only machine codes and a known reason', () => {
    expect(readShiftConflictNotice({ shiftId: ' s-1 ', code: 'OFFLINE_CHECK_IN_CONFLICT', reason: 'active_shift_elsewhere' }))
      .toEqual({ shiftId: 's-1', code: 'OFFLINE_CHECK_IN_CONFLICT', reason: 'active_shift_elsewhere' });
    expect(readShiftConflictNotice({ shiftId: 's-1', code: 'SHIFT_CONFLICT', reason: '<script>' }))
      .toEqual({ shiftId: 's-1', code: 'SHIFT_CONFLICT', reason: null });
    for (const invalid of [null, 'x', [], { code: 'SHIFT_CONFLICT' }, { shiftId: 's', code: 'OTHER' }]) {
      expect(readShiftConflictNotice(invalid)).toBeNull();
    }
  });

  it("words a refused offline check-in with the server's reason and where to review it", () => {
    const text = describeShiftConflict(
      { shiftId: 's-1', code: 'OFFLINE_CHECK_IN_CONFLICT', reason: 'active_shift_elsewhere' },
      t,
    );
    expect(text).toContain('modals.staffShift.syncConflict.offlineTitle');
    expect(text).toContain('modals.staffShift.syncConflict.reason.active_shift_elsewhere');
    expect(text).toContain('modals.staffShift.syncConflict.review');
    expect(describeShiftConflict({ shiftId: 's-1', code: 'OFFLINE_CHECK_IN_CONFLICT', reason: null }, t))
      .toContain('modals.staffShift.syncConflict.reason.unknown');
    expect(describeShiftConflict({ shiftId: 's-2', code: 'SHIFT_CONFLICT', reason: null }, t))
      .toContain('modals.staffShift.syncConflict.shiftBody');
  });
});
