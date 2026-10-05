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
import { resolvePlatformPaymentPresentation } from '../../../../../../shared/platforms/payment-presentation';

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

describe('OrderCard platform payment ownership', () => {
  const platformOrder = (food_delivery: unknown, overrides: Record<string, unknown> = {}) =>
    makeOrder({
      plugin: 'efood', payment_status: 'paid', payment_method: 'other',
      ghost_metadata: { food_delivery }, ...overrides,
    });

  it.each([
    { prepaid: false, payment_method: 'cash', delivery_provider: 'platform_delivery' },
    { prepaid: true, payment_method: 'online', delivery_provider: 'platform_delivery' },
    { payment_method: 'unknown', delivery_provider: 'platform_delivery' },
    { delivery_provider: 'platform_delivery' },
    { prepaid: true, payment_method: 'cash', delivery_provider: 'platform_delivery' },
  ])('shows the same platform-settled indicator regardless of customer tender: %j', disposition => {
    const order = platformOrder(disposition);
    renderCard(order);
    expect(screen.getByTestId('order-card-platform-payment').textContent).toBe('PLATFORM PAYMENT');
    expect(screen.getByRole('img', { name: 'Payment settled by platform; the store does not collect' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Card' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'Cash' })).toBeNull();
    expect(order.payment_method).toBe('other');
    expect(order.payment_status).toBe('paid');
  });

  it('keeps store-driver prepaid money platform-settled', () => {
    renderCard(platformOrder({ prepaid: true, payment_method: 'online', delivery_provider: 'vendor_delivery' }));
    expect(screen.getByTestId('order-card-platform-payment').textContent).toBe('PLATFORM PAYMENT');
  });

  it('accepts normalized source and JSON per-order ownership from local sync', () => {
    renderCard(platformOrder(null, {
      plugin: ' E-Food ',
      ghost_metadata: JSON.stringify({ food_delivery: { delivery_provider: ' Platform_Delivery ' } }),
    }));
    expect(screen.getByTestId('order-card-platform-payment').textContent).toBe('PLATFORM PAYMENT');
  });

  it.each([
    null, [], {},
    { prepaid: true, payment_method: 'online' },
    { prepaid: true, payment_method: 'online', delivery_provider: 'unknown' },
    { delivery_provider: true },
    { payment_method: 'cash', delivery_provider: 'vendor_delivery', prepaid: false },
    { prepaid: true, payment_method: 'cash', delivery_provider: 'vendor_delivery' },
    { prepaid: false, payment_method: 'online', delivery_provider: 'vendor_delivery' },
    { prepaid: 'true', payment_method: 'online', delivery_provider: 'vendor_delivery' },
  ])('keeps missing ownership or store-collected other unknown: %j', disposition => {
    renderCard(platformOrder(disposition));
    expect(screen.queryByTestId('order-card-platform-payment')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Cash' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'Card' })).toBeNull();
  });

  it('keeps pending ledger status ahead of any settlement badge', () => {
    renderCard(platformOrder({ delivery_provider: 'platform_delivery' }, { payment_status: 'pending' }));
    expect(screen.getByTestId('order-card-payment-pending').textContent).toBe('PAY PENDING');
    expect(screen.queryByTestId('order-card-platform-payment')).toBeNull();
  });

  it.each([
    ['cash', 'Cash'], ['card', 'Card'], ['split', 'Split Payment'], ['twint', 'TWINT'],
  ])('preserves canonical %s for store collection', (method, label) => {
    renderCard(platformOrder({ payment_method: method, delivery_provider: 'vendor_delivery' }, { payment_method: method }));
    expect(screen.queryByTestId('order-card-platform-payment')).toBeNull();
    expect(screen.getByRole('img', { name: label })).toBeTruthy();
  });

  it.each(['pos', 'unknown_marketplace', 'stripe', null])('does not trust ownership for source %s', plugin => {
    expect(resolvePlatformPaymentPresentation(platformOrder({ delivery_provider: 'platform_delivery' }, { plugin }))).toBeNull();
  });

  it.each(['not-json', '[]', 'null'])('keeps malformed or missing metadata unknown: %s', ghost_metadata => {
    expect(resolvePlatformPaymentPresentation(platformOrder(null, { ghost_metadata }))).toBeNull();
  });
});
