/**
 * Item D5 (founder rule 30/09 and 01/10/2026: order → payment → grid; an
 * order is never paid without its payment record).
 *
 * The grid card drew the chosen tender (the cash or card icon) whatever the
 * stored payment label said, so an order the till holds as `pending` looked
 * paid in cash. The card now shows the unpaid state first when the label is
 * not settled (`PAY PENDING`, a partly paid one too); the tender is only a hint in the
 * badge's title, never the settled icon. Android parity:
 * orders.paymentBadge.payPending.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const { useTranslationEn } = await import('../../../test/en-translate');
  return {
    useTranslation: useTranslationEn,
    initReactI18next: { type: '3rdParty', init: () => {} },
  };
});

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }),
}));

vi.mock('../../../../lib', () => ({
  getBridge: () => ({
    customers: { lookupByPhone: vi.fn(async () => null) },
  }),
}));

vi.mock('../../../utils/plugin-icons', () => ({
  PluginIcon: () => null,
  isExternalPlatform: () => false,
}));

vi.mock('../OrderStatusControls', () => ({
  OrderStatusControls: () => null,
}));

import OrderCard from '../OrderCard';

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-pay-1',
    order_number: 'POS-20261001-0007',
    status: 'pending',
    order_type: 'pickup',
    customer_name: 'Synthetic Guest',
    total_amount_cents: 900,
    created_at: new Date().toISOString(),
    payment_method: 'cash',
    ...overrides,
  };
}

function renderCard(order: Record<string, unknown>) {
  return render(<OrderCard order={order} isSelected={false} onSelect={() => {}} />);
}

afterEach(() => {
  cleanup();
});

describe('OrderCard payment state', () => {
  it('shows PAY PENDING first, never the cash icon, for a pending cash order', () => {
    renderCard(makeOrder({ payment_status: 'pending' }));

    expect(screen.getByTestId('order-card-payment-pending').textContent).toBe('PAY PENDING');
    expect(screen.queryByRole('img', { name: 'Cash' })).toBeNull();
  });

  // Android parity (round 2 review, 01/10/2026): paymentBadgeShowsTender
  // reads every unsettled label, a partly paid one included, as PAY PENDING.
  it('shows PAY PENDING for a partly paid order, as Android does', () => {
    renderCard(makeOrder({ payment_status: 'partially_paid', payment_method: 'card' }));

    expect(screen.getByTestId('order-card-payment-pending').textContent).toBe('PAY PENDING');
    expect(screen.queryByRole('img', { name: 'Card' })).toBeNull();
  });

  it('keeps the tender icon for a settled order', () => {
    renderCard(makeOrder({ payment_status: 'paid' }));

    expect(screen.queryByTestId('order-card-payment-pending')).toBeNull();
    expect(screen.getByRole('img', { name: 'Cash' })).toBeTruthy();
  });

  it('adds no payment state to a cancelled order or a zero total', () => {
    renderCard(makeOrder({ payment_status: 'pending', status: 'cancelled' }));
    expect(screen.queryByTestId('order-card-payment-pending')).toBeNull();
    cleanup();

    renderCard(makeOrder({ payment_status: 'pending', total_amount_cents: 0 }));
    expect(screen.queryByTestId('order-card-payment-pending')).toBeNull();
  });
});
