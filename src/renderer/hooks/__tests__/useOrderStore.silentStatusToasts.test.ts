import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store calls getBridge() at module scope; give it an inert bridge and
// inert event plumbing so importing the store has no side effects.
vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn() }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../../services/OrderService', () => ({
  OrderService: {
    getInstance: () => ({ fetchOrders: vi.fn() }),
  },
}));

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: toastSuccess,
    error: toastError,
    dismiss: vi.fn(),
  }),
}));

import { useOrderStore } from '../useOrderStore';

// Regression pin for the bilingual double-toast bug: the store's
// updateOrderStatus used to toast.success('Order status updated') in
// hardcoded English while the calling screen toasted the same action through
// i18n — staff saw every action twice, once per language. The store must not
// toast at all; the screen that owns the action owns the notification.
describe('useOrderStore.updateOrderStatus stays silent', () => {
  beforeEach(() => {
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  it('does not toast on success — the calling screen announces it, localized', async () => {
    useOrderStore.setState({
      updateOrderStatusDetailed: async () => ({ success: true }),
    } as never);

    const ok = await useOrderStore.getState().updateOrderStatus('o-1', 'cancelled');

    expect(ok).toBe(true);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('does not toast on failure either — it only reports the boolean', async () => {
    useOrderStore.setState({
      updateOrderStatusDetailed: async () => ({
        success: false,
        errorMessage: 'nope',
      }),
    } as never);

    const ok = await useOrderStore.getState().updateOrderStatus('o-1', 'pending');

    expect(ok).toBe(false);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
