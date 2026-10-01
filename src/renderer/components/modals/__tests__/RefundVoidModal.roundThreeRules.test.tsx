/**
 * Round 3 review (01/10/2026), the shared rules on the order's refund screen,
 * the same as Android:
 *
 * - R1: the delivery platform's settlement row is never voided or refunded
 *   at the till: the screen offered Void and Refund on it, and the till wrote
 *   both, synced against the server's canonical settlement payment.
 * - R2: who hands a cash refund back is the till's rule (the courier while
 *   their earning on the order is unsettled, else the drawer), shown and
 *   never chosen: the screen's picker let a cashier book a refund on the
 *   drawer while the courier still held the cash.
 * - R5: a refund always names its tender: an `other` payment's refund was
 *   sent with no tender at all.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // Stable across renders, as the real hooks are: the modal's loaders depend
  // on them.
  t: (key: string, options?: Record<string, unknown>) =>
    typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key,
  shift: {
    staff: { staffId: 'staff-1', databaseStaffId: '11111111-1111-4111-8111-111111111111' },
    activeShift: { id: '22222222-2222-4222-8222-222222222222', staff_id: 'staff-1' },
  },
  bridge: {
    orders: { getById: vi.fn() },
    payments: {
      getOrderPayments: vi.fn(),
      getSettlementSnapshot: vi.fn(),
      voidPayment: vi.fn(),
    },
    refunds: {
      getPaymentBalance: vi.fn(),
      listOrderAdjustments: vi.fn(),
      refundPayment: vi.fn(),
    },
    giftReturns: { authorize: vi.fn(), status: vi.fn(), begin: vi.fn(), recover: vi.fn() },
    terminalConfig: {
      getOrganizationId: vi.fn(async () => 'org-1'),
      getBranchId: vi.fn(async () => 'branch-1'),
      getTerminalId: vi.fn(async () => 'terminal-1'),
    },
  },
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }),
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock('../../../../lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBridge: () => mocks.bridge,
}));

vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => mocks.shift,
}));

vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));

import RefundVoidModal from '../RefundVoidModal';

const payment = (id: string, method: string, extra: Record<string, unknown> = {}) => ({
  id,
  order_id: 'ord-1',
  method,
  amount: 12,
  status: 'completed',
  created_at: '2026-10-01T10:00:00Z',
  ...extra,
});

const openModal = async (rows: unknown[], balance: Record<string, unknown>) => {
  mocks.bridge.payments.getOrderPayments.mockResolvedValue(rows);
  mocks.bridge.orders.getById.mockResolvedValue({ id: 'ord-1', order_type: 'delivery' });
  mocks.bridge.refunds.getPaymentBalance.mockResolvedValue({
    originalAmount: 12,
    totalRefunds: 0,
    remaining: 12,
    ...balance,
  });
  mocks.bridge.refunds.listOrderAdjustments.mockResolvedValue([]);
  mocks.bridge.refunds.refundPayment.mockResolvedValue({ success: true });
  await act(async () => {
    render(<RefundVoidModal isOpen onClose={() => undefined} orderId="ord-1" orderTotal={12} />);
  });
  await waitFor(() => expect(mocks.bridge.payments.getOrderPayments).toHaveBeenCalled());
};

const openRefundForm = async (reason = 'Synthetic refund') => {
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: /^Refund$/ }));
  });
  fireEvent.change(screen.getByPlaceholderText('Enter reason for refund...'), {
    target: { value: reason },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe('the refund screen follows the shared rules (round 3 review)', () => {
  it('never offers to void or refund the platform settlement row (R1)', async () => {
    await openModal([payment('settle-1', 'other', { platformSettlement: true })], {
      defaultRefundMethod: 'other',
      platformSettlement: true,
    });
    await screen.findByTestId('refund-platform-settlement-settle-1');
    expect(screen.queryByRole('button', { name: /^Void$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Refund$/ })).toBeNull();
  });

  it('names an other tender as other, never cash and never nothing (R5)', async () => {
    await openModal([payment('voucher-1', 'other')], { defaultRefundMethod: 'other' });
    await openRefundForm();
    expect(screen.getByRole('button', { name: /Same tender \(other\)/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm Refund/ }));
    });
    await waitFor(() => expect(mocks.bridge.refunds.refundPayment).toHaveBeenCalledTimes(1));
    const sent = mocks.bridge.refunds.refundPayment.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.refundMethod).toBe('other');
    expect('cashHandler' in sent).toBe(false);
  });

  it("shows the rule's cash handler and never sends a chosen one (R2)", async () => {
    await openModal([payment('cash-1', 'cash')], {
      defaultRefundMethod: 'cash',
      cashHandlerByRule: 'driver_shift',
    });
    await openRefundForm();
    const handler = screen.getByTestId('refund-cash-handler');
    expect(handler.textContent).toContain('Driver Cash');
    expect(screen.queryByRole('button', { name: /Cashier Cash/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Driver Cash/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm Refund/ }));
    });
    await waitFor(() => expect(mocks.bridge.refunds.refundPayment).toHaveBeenCalledTimes(1));
    const sent = mocks.bridge.refunds.refundPayment.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.refundMethod).toBe('cash');
    expect('cashHandler' in sent).toBe(false);
  });
});
