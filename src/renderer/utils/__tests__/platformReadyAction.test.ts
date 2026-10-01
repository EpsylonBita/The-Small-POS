import { describe, expect, it, vi } from 'vitest';

// Item D8 (efood late Ready, 01/10/2026): Ready on an order the platform had
// cancelled used to toast "Platform notified — rider is on the way". The
// till now answers `cancelled` (nothing written, queued or sent) and the
// cashier gets the platform's cancellation notice with the order number,
// never a success toast. An order already past Ready gets no message.

import {
  announcePlatformReadyOutcome,
  markPlatformOrdersReady,
} from '../platformReadyAction';

const t = (key: string, options?: Record<string, unknown>) => {
  const fallback = options?.defaultValue;
  const text = typeof fallback === 'string' ? fallback : key;
  return text.replace('{{orderNumber}}', String(options?.orderNumber ?? ''));
};

function toastSpy() {
  return { success: vi.fn(), error: vi.fn() };
}

describe('Ready on platform orders', () => {
  it('announces a cancelled order with the cancellation notice, never as ready', async () => {
    const outcome = await markPlatformOrdersReady(
      [{ id: 'ord-1', displayNumber: '#4711' }],
      async () => ({ success: false, cancelled: true, status: 'cancelled' }),
    );
    const toast = toastSpy();
    announcePlatformReadyOutcome(outcome, t, toast);

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][0]).toBe('Order cancelled by platform: Order #4711');
  });

  it('says nothing for an order already past Ready', async () => {
    const outcome = await markPlatformOrdersReady(
      [{ id: 'ord-2', displayNumber: '#4712' }],
      async () => ({ success: true, alreadyClosed: true, status: 'delivered' }),
    );
    const toast = toastSpy();
    announcePlatformReadyOutcome(outcome, t, toast);

    expect(outcome).toMatchObject({ markedReady: 0, alreadyClosed: 1 });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('marks the open ones ready with the neutral wording', async () => {
    const outcome = await markPlatformOrdersReady(
      [
        { id: 'ord-open', displayNumber: '#4713' },
        { id: 'ord-gone', displayNumber: '#4714' },
      ],
      async (orderId) =>
        orderId === 'ord-gone'
          ? { success: false, cancelled: true }
          : { success: true, status: 'ready' },
    );
    const toast = toastSpy();
    announcePlatformReadyOutcome(outcome, t, toast);

    expect(toast.success).toHaveBeenCalledWith('Marked ready');
    expect(toast.error.mock.calls[0][0]).toContain('#4714');
  });

  it('stops at a failure and names that order', async () => {
    const notify = vi.fn(async () => {
      throw new Error('Invalid status transition');
    });
    const outcome = await markPlatformOrdersReady(
      [
        { id: 'ord-a', displayNumber: '#1' },
        { id: 'ord-b', displayNumber: '#2' },
      ],
      notify,
    );
    const toast = toastSpy();
    announcePlatformReadyOutcome(outcome, t, toast);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('Failed to notify the platform for #1');
    expect(toast.success).not.toHaveBeenCalled();
  });
});
