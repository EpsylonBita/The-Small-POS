// Founder rule 13/10/2026: every till money field takes digit entry in cents —
// typing 100000 shows 1.000,00 — while the handler still receives the plain
// number (1000). Covers the expense amount, the tip amount and the
// post-edit refund amount; the End Shift closing cash is covered in
// StaffShiftModal.gift-close.test.tsx.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  t: (key: string, fallback?: string | { defaultValue?: string }) =>
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  bridge: null as any,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: h.t, i18n: { language: 'en' } }),
}));
vi.mock('react-hot-toast', () => ({ default: h.toast }));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: h.t }) }));
vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => ({ staff: { staffId: 'staff-1', branchId: 'branch-1', terminalId: 'till-1' }, activeShift: null }),
}));
vi.mock('../../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: () => ({ branchId: 'branch-1', terminalId: 'till-1', organizationId: 'org-1', apiKey: '' }),
  refreshTerminalCredentialCache: vi.fn(async () => ({})),
}));
vi.mock('../../../utils/fiscal-integration-entitlement', async (original) => ({
  ...(await original<typeof import('../../../utils/fiscal-integration-entitlement')>()),
  loadFiscalOrderReportingEntitlement: vi.fn(async () => false),
}));
vi.mock('../../../../lib', async (original) => ({
  ...(await original<typeof import('../../../../lib')>()),
  getBridge: () => h.bridge,
}));

import { ExpenseModal } from '../ExpenseModal';
import { TipModal } from '../TipModal';
import { EditOrderRefundSettlementModal } from '../EditOrderRefundSettlementModal';

const CASHIER_SHIFT = {
  id: 'cashier-shift-1', staff_id: 'staff-1', staff_name: 'Cashier Alice', role_type: 'cashier', status: 'active',
  branch_id: 'branch-1', terminal_id: 'till-1', check_in_time: '2026-10-13T08:00:00.000Z', opening_cash_amount: 0,
};

/** Fake IPC: named methods answer, anything else resolves "not available". */
function makeBridge(explicit: Record<string, Record<string, any>>) {
  const namespaces: Record<string, any> = {};
  return new Proxy(explicit, {
    get(target, key) {
      if (typeof key !== 'string' || key === 'then') return undefined;
      if (!namespaces[key]) {
        const methods = target[key] ?? (target[key] = {});
        namespaces[key] = new Proxy(methods, {
          get(inner, name) {
            if (typeof name !== 'string' || name === 'then') return undefined;
            if (!(name in inner)) inner[name] = vi.fn(async () => ({ success: false }));
            return inner[name];
          },
        });
      }
      return namespaces[key];
    },
  }) as any;
}

/** Types into a digit-entry field the way a keyboard edit arrives. */
function typeInto(field: HTMLElement, value: string, inputType = 'insertText') {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(field, value);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  });
}

afterEach(cleanup);

describe('ExpenseModal amount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.bridge = makeBridge({
      shifts: {
        getActiveCashierByTerminal: vi.fn(async () => CASHIER_SHIFT),
        getSyncState: vi.fn(async () => null),
        getExpenses: vi.fn(async () => []),
        getStaffPayments: vi.fn(async () => []),
        recordExpense: vi.fn(async () => ({ success: true })),
      },
      settings: { isConfigured: vi.fn(async () => ({ configured: true })) },
      sync: { getNetworkStatus: vi.fn(async () => ({ isOnline: true })) },
      terminalConfig: { getSettings: vi.fn(async () => ({ terminal: { name: 'Till 1' }, restaurant: { name: 'Shop' } })) },
      staffSchedule: { list: vi.fn(async () => ({ success: true, data: { staff: [] } })) },
    });
  });

  it('shows 100000 as 1.000,00 and records the expense as 1000', async () => {
    render(<ExpenseModal isOpen onClose={vi.fn()} />);
    const amount = await screen.findByRole('textbox', { name: 'Amount' });
    await waitFor(() => expect(amount).toBeEnabled());
    expect(amount).toHaveAttribute('type', 'text');
    expect(amount).not.toHaveAttribute('step');

    fireEvent.change(amount, { target: { value: '100000' } });
    expect(amount).toHaveValue('1.000,00');
    // A typed comma never switches to decimal entry: the digits stay cents.
    fireEvent.change(amount, { target: { value: '1.000,005' } });
    expect(amount).toHaveValue('10.000,05');
    fireEvent.change(amount, { target: { value: '100000' } });

    fireEvent.change(screen.getByPlaceholderText('Explain what left the drawer and why it was needed.'), { target: { value: 'Window cleaner' } });
    fireEvent.click(screen.getByRole('button', { name: /Record expense/ }));
    await waitFor(() => expect(h.bridge.shifts.recordExpense).toHaveBeenCalledTimes(1));
    expect(h.bridge.shifts.recordExpense).toHaveBeenCalledWith(expect.objectContaining({
      shiftId: CASHIER_SHIFT.id, amount: 1000, description: 'Window cleaner',
    }));
  });
});

describe('TipModal amount', () => {
  it('shows 100000 as 1.000,00 and applies a 1000 tip', () => {
    const onApply = vi.fn();
    render(<TipModal isOpen onClose={vi.fn()} baseAmount={20} orderType="pickup" selection={null} onApply={onApply} />);
    const amount = screen.getByRole('textbox', { name: 'Or enter an amount' });
    expect(amount).toHaveAttribute('inputmode', 'numeric');
    fireEvent.change(amount, { target: { value: '100000' } });
    expect(amount).toHaveValue('1.000,00');
    fireEvent.click(screen.getByRole('button', { name: /Apply Tip/ }));
    expect(onApply).toHaveBeenCalledWith({ amount: 1000, recipientRole: 'cashier' });
  });

  it('backspace takes digits off the cents and empties the field after the last one', () => {
    render(<TipModal isOpen onClose={vi.fn()} baseAmount={20} orderType="pickup" selection={null} onApply={vi.fn()} />);
    const amount = screen.getByRole('textbox', { name: 'Or enter an amount' });
    typeInto(amount, '5');
    expect(amount).toHaveValue('0,05');
    typeInto(amount, '0,050');
    expect(amount).toHaveValue('0,50');
    typeInto(amount, '0,5', 'deleteContentBackward');
    expect(amount).toHaveValue('0,05');
    typeInto(amount, '0,0', 'deleteContentBackward');
    expect(amount).toHaveValue('');
    // A typed zero is a real amount, not an empty field.
    typeInto(amount, '0');
    expect(amount).toHaveValue('0,00');
  });

  it('prefills a percentage tip in the grouped money format', () => {
    render(<TipModal isOpen onClose={vi.fn()} baseAmount={12345} orderType="pickup" selection={null} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '10%' }));
    expect(screen.getByRole('textbox', { name: 'Or enter an amount' })).toHaveValue('1.234,50');
  });
});

describe('EditOrderRefundSettlementModal refund amount', () => {
  const preview = {
    success: true, orderId: 'order-1', orderType: 'pickup', isGhostOrder: false,
    originalTotal: 1500, nextTotal: 500, paidTotal: 1500, ledgerPaidTotal: 1500, refundAmount: 1000, delta: -1000,
    paymentStatus: 'paid', paymentMethod: 'cash', requiredAction: 'refund',
    completedPayments: [{ id: 'pay-1', method: 'cash', amount: 1500, remainingRefundable: 1500, createdAt: '2026-10-13T10:00:00Z' }],
    deliverySettlement: { driverCashOwned: false },
  } as any;

  it('shows 100000 as 1.000,00 and settles a 1000 refund', async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(<EditOrderRefundSettlementModal isOpen preview={preview} onConfirm={onConfirm} />);
    const amount = await screen.findByRole('textbox', { name: 'Amount' });
    expect(amount).not.toHaveAttribute('type', 'number');
    // The prefilled allocation shows grouped as well.
    await waitFor(() => expect(amount).toHaveValue('1.000,00'));
    fireEvent.change(amount, { target: { value: '50000' } });
    expect(amount).toHaveValue('500,00');
    fireEvent.change(amount, { target: { value: '100000' } });
    expect(amount).toHaveValue('1.000,00');
    fireEvent.change(screen.getByPlaceholderText('Enter refund reason...'), { target: { value: 'Item removed' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record Refund' }));
    });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ paymentId: 'pay-1', amount: 1000 })]);
  });
});

describe('pasting into a cents field (review 13/10/2026)', () => {
  const paste = (input: HTMLElement, text: string) =>
    fireEvent.paste(input, { clipboardData: { getData: () => text } });

  it('reads a pasted decimal as an amount, not as typed cents', () => {
    const onApply = vi.fn();
    render(<TipModal isOpen onClose={vi.fn()} baseAmount={20} orderType="pickup" selection={null} onApply={onApply} />);
    const amount = screen.getByRole('textbox', { name: 'Or enter an amount' });
    paste(amount, '12.5');
    expect(amount).toHaveValue('12,50');
    paste(amount, '1.234,50');
    expect(amount).toHaveValue('1.234,50');
    // Text that is not an amount is refused; the field keeps its value.
    paste(amount, 'twelve');
    expect(amount).toHaveValue('1.234,50');
    fireEvent.click(screen.getByRole('button', { name: /Apply Tip/ }));
    expect(onApply).toHaveBeenCalledWith({ amount: 1234.5, recipientRole: 'cashier' });
  });
});
