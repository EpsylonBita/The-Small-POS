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
import toast from 'react-hot-toast';

const mocks = vi.hoisted(() => ({
  // Stable across renders, as the real hooks are: the modal's loaders depend
  // on them.
  t: (key: string, options?: Record<string, unknown>) =>
    key === 'modals.refund.refunded' ? 'Refunded {{amount}}' :
      key === 'modals.refund.maxRefund' ? `Maximum refundable: ${options?.amount ?? '{{amount}}'}` :
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

const openModal = async (rows: unknown[], balance: Record<string, unknown>, balanceError?: Error, props: Partial<React.ComponentProps<typeof RefundVoidModal>> = {}) => {
  mocks.bridge.payments.getOrderPayments.mockResolvedValue(rows);
  mocks.bridge.orders.getById.mockResolvedValue({ id: 'ord-1', order_type: 'delivery' });
  mocks.bridge.refunds.getPaymentBalance.mockResolvedValue({
    originalAmount: 12,
    totalRefunds: 0,
    remaining: 12,
    ...balance,
  });
  if (balanceError) mocks.bridge.refunds.getPaymentBalance.mockRejectedValue(balanceError);
  mocks.bridge.refunds.listOrderAdjustments.mockResolvedValue([]);
  mocks.bridge.refunds.refundPayment.mockResolvedValue({ success: true });
  await act(async () => {
    render(<RefundVoidModal isOpen onClose={() => undefined} orderId="ord-1" orderTotal={12} {...props} />);
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
  it('blocks refund and void when the canonical balance refresh fails', async () => {
    await openModal([payment('unreadable', 'cash')], {}, new Error('PAYMENT_CANONICAL_REFRESH_REQUIRED'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Refund$/ }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: /^Void$/ }).hasAttribute('disabled')).toBe(true);
    });
    expect(mocks.bridge.refunds.refundPayment).not.toHaveBeenCalled();
  });

  it('shows the cross-till remainder and prevents a full void after the partial return', async () => {
    await openModal([payment('cross-till', 'cash', { amount: 10 })], { originalAmount: 10, totalRefunds: 6, remaining: 4 });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Void$/ }).hasAttribute('disabled')).toBe(true));
    await openRefundForm();
    expect(screen.getByText(/^Maximum refundable:/).textContent).toMatch(/4[,.]00/);
  });

  it('blocks both return actions when a remote final return leaves zero balance', async () => {
    await openModal([payment('remote-void', 'cash')], { remaining: 0 });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Refund$/ }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: /^Void$/ }).hasAttribute('disabled')).toBe(true);
    });
  });

  it('shows the original native receipt timestamp without changing the payment', async () => {
    const createdAt = '2026-10-09T13:35:10Z';
    const original = payment('native-cash', 'cash', { created_at: undefined, createdAt });
    await openModal([original], {});
    const row = await screen.findByTestId('refund-payment-native-cash');
    expect(row.textContent).toContain(new Date(createdAt).toLocaleString());
    expect(row.textContent).not.toContain('Invalid Date');
    expect(original.created_at).toBeUndefined();
    expect(original.amount).toBe(12);
  });

  it('shows an unknown receipt date without inventing a timestamp', async () => {
    await openModal([payment('undated-cash', 'cash', { created_at: '' })], {});
    const row = await screen.findByTestId('refund-payment-undated-cash');
    expect(row.textContent).toContain('—');
    expect(row.textContent).not.toContain('Invalid Date');
  });

  it('shows the partial return amount once with a plain refunded label', async () => {
    await openModal([payment('partially-returned', 'cash')], { totalRefunds: 4, remaining: 8 });
    const row = await screen.findByTestId('refund-payment-partially-returned');
    expect(row.textContent).not.toContain('{{amount}}');
    expect(row.textContent).toContain('Refunded');
  });

  it('interpolates the maximum refundable amount exactly once in the refund form', async () => {
    await openModal([payment('partial-cash', 'cash')], { totalRefunds: 4, remaining: 8 });
    await openRefundForm();
    const hint = screen.getByText(/^Maximum refundable:/).textContent || '';
    expect(hint).not.toContain('{{amount}}');
    expect(hint.match(/8[,.]00/g)).toHaveLength(1);
  });

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


describe('completed order full returns hand off to cancellation', () => {
  it.each(['completed', 'delivered'])('opens the existing cancel flow before returning money on %s', async orderStatus => {
    const onRequestCancellation = vi.fn(async () => true);
    await openModal([payment('cash', 'cash')], {}, undefined, { orderStatus, onRequestCancellation });
    await openRefundForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm Refund/ })); });
    expect(onRequestCancellation).toHaveBeenCalledExactlyOnceWith('ord-1');
    expect(mocks.bridge.refunds.refundPayment).not.toHaveBeenCalled();
  });
  it('hands off the final remaining portion after earlier partial refunds', async () => {
    const onRequestCancellation = vi.fn(async () => true);
    await openModal([payment('cash', 'cash')], { totalRefunds: 8, remaining: 4 }, undefined,
      { orderStatus: 'completed', onRequestCancellation });
    await openRefundForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm Refund/ })); });
    expect(onRequestCancellation).toHaveBeenCalledOnce();
    expect(mocks.bridge.refunds.refundPayment).not.toHaveBeenCalled();
  });
  it('keeps provider returns on their existing path, then promptly offers zero-money cancellation', async () => {
    const onRequestCancellation = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.bridge.payments.getSettlementSnapshot.mockResolvedValue({ success: true, orderId: 'ord-1', netPaid: 0 });
    await openModal([payment('provider-card', 'card')], {}, undefined,
      { orderStatus: 'completed', onRequestCancellation });
    await openRefundForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm Refund/ })); });
    expect(mocks.bridge.refunds.refundPayment).toHaveBeenCalledOnce();
    expect(onRequestCancellation).toHaveBeenCalledTimes(2);
  });
  it('keeps a committed refund successful when the cancellation offer after it fails', async () => {
    // Codex review on #398: an offline table preflight after the money returned showed «Refund failed».
    const onRequestCancellation = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('TABLE_PREFLIGHT_OFFLINE'));
    mocks.bridge.payments.getSettlementSnapshot.mockResolvedValue({ success: true, orderId: 'ord-1', netPaid: 0 });
    await openModal([payment('provider-card', 'card')], {}, undefined,
      { orderStatus: 'completed', onRequestCancellation });
    await openRefundForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm Refund/ })); });
    await waitFor(() => expect(onRequestCancellation).toHaveBeenCalledTimes(2));
    expect(mocks.bridge.refunds.refundPayment).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('Refund recorded successfully');
    expect(toast.error).not.toHaveBeenCalled();
  });
  it('does not fall through to refund when cancellation preflight fails', async () => {
    const onRequestCancellation = vi.fn().mockRejectedValue(new Error('PAYMENT_SYNC_REQUIRED'));
    await openModal([payment('cash', 'cash')], {}, undefined, { orderStatus: 'completed', onRequestCancellation });
    await openRefundForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm Refund/ })); });
    expect(mocks.bridge.refunds.refundPayment).not.toHaveBeenCalled();
  });
  it('keeps a partial refund on the ordinary refund path', async () => {
    const onRequestCancellation = vi.fn(async () => true);
    mocks.bridge.payments.getSettlementSnapshot.mockResolvedValue({ success: true, orderId: 'ord-1', netPaid: 8 });
    await openModal([payment('cash', 'cash')], {}, undefined, { orderStatus: 'completed', onRequestCancellation });
    await openRefundForm();
    fireEvent.change(screen.getByRole('textbox', { name: 'Refund Amount' }), { target: { value: '400' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm Refund/ })); });
    expect(mocks.bridge.refunds.refundPayment).toHaveBeenCalledOnce();
    expect(onRequestCancellation).not.toHaveBeenCalled();
  });
});
