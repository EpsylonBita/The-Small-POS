import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import { TauriBridge } from '../ipc-adapter';

describe('original table cancellation native IPC boundary', () => {
  beforeEach(() => { mocks.invoke.mockReset(); });

  it('sends only the selected event with the Rust named argument envelope', async () => {
    const result = { state: 'applied' };
    mocks.invoke.mockResolvedValue(result);
    const bridge = new TauriBridge();
    const input = { clientEventId: 'original-event', request: { forged: true }, actorId: 'renderer-actor' };
    expect(await bridge.tableAttemptRecovery.confirmOriginal(input)).toBe(result);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      'table_attempt_recovery_confirm_original', { clientEventId: 'original-event' },
    );
  });

  it('preserves native rejection without a retry or a fresh cancellation', async () => {
    const error = new Error('CANONICAL_RECEIPT_IDENTITY_CHANGED');
    mocks.invoke.mockRejectedValue(error);
    await expect(new TauriBridge().tableAttemptRecovery.confirmOriginal({ clientEventId: 'original-event' }))
      .rejects.toBe(error);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('preserves the legacy positional transport for unrelated commands', async () => {
    mocks.invoke.mockResolvedValue({});
    await new TauriBridge().invoke('orders:get-by-id', 'order-id', undefined);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('orders_get_by_id', { arg0: 'order-id' });
  });
});
