import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRecoveryOrderPayment, RECOVERY_ORDER_PAYMENT_TARGET_KEY } from '../../services/OrderPaymentRoute';

const { bridge, t } = vi.hoisted(() => ({
  bridge: {
    orders: { getAll: vi.fn(), getById: vi.fn() },
    sync: { fetchOrders: vi.fn() },
  },
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}));

vi.mock('../../../lib', () => ({
  getBridge: () => bridge,
  isBrowser: () => false,
  offEvent: vi.fn(),
  onEvent: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../hooks/useReturnedOrderCancellation', () => ({
  useReturnedOrderCancellation: () => ({ modal: null, requestCancellation: vi.fn() }),
}));
vi.mock('../../hooks/useLocalPreparation', () => ({ useLocalPreparationSnapshot: () => ({}) }));
vi.mock('../../components/modals/OrderDetailsModal', () => ({
  default: ({ isOpen, orderId, openPaymentOnMount, paymentOpenRequest, onClose }: {
    isOpen: boolean;
    orderId: string;
    openPaymentOnMount: boolean;
    paymentOpenRequest: number;
    onClose(): void;
  }) => isOpen && openPaymentOnMount ? (
    <dialog open data-testid="payment-target">
      {orderId}/{paymentOpenRequest}
      <button type="button" onClick={onClose}>Close payment</button>
    </dialog>
  ) : null,
}));

import OrdersPage from '../OrdersPage';

const order = {
  id: 'recovery-order-id', order_number: '301', status: 'delivered', order_type: 'delivery',
  payment_method: 'cash', payment_status: 'pending', total_amount: 6.5, order_items: [],
  created_at: '2026-11-18T06:00:00Z', updated_at: '2026-11-18T06:00:00Z',
};
const target = { screen: 'orderPayment' as const, orderId: order.id, orderNumber: order.order_number };

beforeEach(() => {
  bridge.orders.getAll.mockResolvedValue([
    { ...order, id: 'same-number-different-order', created_at: '2026-11-18T07:00:00Z' },
    order,
  ]);
  bridge.orders.getById.mockResolvedValue({ order });
  bridge.sync.fetchOrders.mockResolvedValue({ success: true, orders: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.removeItem(RECOVERY_ORDER_PAYMENT_TARGET_KEY);
});

describe('the recovery payment route', () => {
  it('delivers a request from another page when Orders mounts', async () => {
    openRecoveryOrderPayment(target);
    render(<OrdersPage />);
    expect(await screen.findByTestId('payment-target')).toHaveTextContent(`${order.id}/1`);
    expect(window.sessionStorage.getItem(RECOVERY_ORDER_PAYMENT_TARGET_KEY)).toBeNull();
  });

  it('delivers repeated requests for the same order to the already-mounted page', async () => {
    render(<OrdersPage />);
    await waitFor(() => expect(bridge.orders.getAll).toHaveBeenCalled());
    act(() => openRecoveryOrderPayment(target));
    expect(await screen.findByTestId('payment-target')).toHaveTextContent(`${order.id}/1`);
    fireEvent.click(screen.getByRole('button', { name: 'Close payment' }));
    expect(screen.queryByTestId('payment-target')).not.toBeInTheDocument();
    act(() => openRecoveryOrderPayment(target));
    expect(await screen.findByTestId('payment-target')).toHaveTextContent(`${order.id}/2`);
  });
});
