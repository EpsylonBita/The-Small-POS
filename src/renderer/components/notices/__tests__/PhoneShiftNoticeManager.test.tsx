/**
 * The Main's notice for a closed phone shift (founder rule 13/10/2026):
 * who, which phone, orders and sales, and the cash handover state.
 */
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PhoneShiftNoticeManager,
  phoneShiftNoticeText,
  showPhoneShiftNotice,
} from '../PhoneShiftNoticeManager';
import { PHONE_SHIFT_STAFF_OPEN_EVENT } from '../../../hooks/usePhoneShiftNotices';
import type { UnitClosedShift } from '../../../utils/unit-shift-readiness';
import { formatCurrency } from '../../../utils/format';

const mocks = vi.hoisted(() => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
  unitReadiness: vi.fn(),
}));
vi.mock('react-hot-toast', () => ({ toast: mocks.toast, default: mocks.toast }));
vi.mock('../../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isMainTerminal: true, isMobileWaiter: false, parentTerminalId: null, loading: false }),
}));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ shifts: { unitReadiness: mocks.unitReadiness } }) }));

/** English defaults with their values, like the real `t` without a bundle. */
const t = (key: string, options: Record<string, unknown> = {}) =>
  String(options.defaultValue ?? key).replace(/{{(\w+)}}/g, (_, name: string) => String(options[name]));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t }),
}));

function shift(overrides: Partial<UnitClosedShift> = {}): UnitClosedShift {
  return {
    id: 'shift-1', staff_id: 'staff-maria', staff_name: 'Maria', role_type: 'waiter', terminal_id: 'phone-1',
    terminal_name: 'Phone 1', terminal_active: true, check_in_time: '2026-10-14T08:00:00.000Z', currency: 'EUR',
    opening_cash_amount: 0, status: 'closed', check_out_time: '2026-10-14T16:00:00.000Z', closing_cash_amount: 42.5,
    expected_cash_amount: 42.5, cash_variance: 0, total_orders_count: 7, total_sales_amount: 120.4, total_cash_sales: 42.5,
    total_card_sales: 77.9, handover: 'pending', closed_by: 'phone', received_at: null, receivable: true, ...overrides,
  };
}

/** The toast as react-hot-toast would render it. */
function renderToast(callIndex = 0) {
  const [renderNotice, options] = mocks.toast.custom.mock.calls[callIndex];
  return { ui: render(<>{renderNotice({ id: options.id, visible: true })}</>), options };
}

beforeEach(() => {
  mocks.toast.custom.mockReset();
  mocks.toast.dismiss.mockReset();
  mocks.unitReadiness.mockReset();
  localStorage.clear();
});
afterEach(() => cleanup());

describe('phoneShiftNoticeText', () => {
  it('names the staff, the phone, orders and sales, and the cash still to receive', () => {
    expect(phoneShiftNoticeText(shift(), t)).toEqual({
      title: 'Maria closed their shift on Phone 1',
      summary: `Orders: 7 · Sales: ${formatCurrency(120.4, 'EUR')}`,
      handover: `Cash to receive: ${formatCurrency(42.5, 'EUR')}`,
    });
  });

  it('says the register received a till the Main closed', () => {
    const text = phoneShiftNoticeText(shift({ handover: 'received', closed_by: 'main', received_at: '2026-10-14T16:01:00.000Z' }), t);
    expect(text.title).toBe("Maria's shift on Phone 1 was closed at the register");
    expect(text.handover).toBe(`Received by the register: ${formatCurrency(42.5, 'EUR')}`);
    expect(phoneShiftNoticeText(shift({ handover: 'received', closing_cash_amount: 0 }), t).handover)
      .toBe('Received by the register');
  });

  it('says when there is nothing to hand over, and when the till was not counted', () => {
    expect(phoneShiftNoticeText(shift({ handover: 'none', closing_cash_amount: 0 }), t).handover).toBe('Nothing to hand over');
    expect(phoneShiftNoticeText(shift({ handover: 'not_counted', status: 'abandoned' }), t).handover).toBe('Not counted');
  });

  it('uses the shift currency, else the store default, and marks a deactivated phone', () => {
    const chf = phoneShiftNoticeText(shift({ currency: 'chf', terminal_active: false, total_orders_count: null }), t);
    expect(chf.summary).toBe(`Orders: 0 · Sales: ${formatCurrency(120.4, 'CHF')}`);
    expect(chf.title).toBe('Maria closed their shift on Phone 1 (phone deactivated)');
    expect(phoneShiftNoticeText(shift({ currency: null }), t).handover).toBe(`Cash to receive: ${formatCurrency(42.5)}`);
    expect(phoneShiftNoticeText(shift({ terminal_active: null, terminal_name: null }), t).title)
      .toBe('Maria closed their shift on phone-1 (phone removed)');
  });
});

describe('showPhoneShiftNotice', () => {
  it('opens the staff modal from the notice and closes the notice', () => {
    const opened = vi.fn();
    window.addEventListener(PHONE_SHIFT_STAFF_OPEN_EVENT, opened);
    showPhoneShiftNotice(shift(), t);
    const { ui, options } = renderToast();
    expect(options).toMatchObject({ id: 'phone-shift-closed:shift-1', duration: 30_000 });
    // The locked-day fence lets a recovery surface through.
    expect(ui.getByTestId('phone-shift-notice-shift-1')).toHaveAttribute('data-cashier-recovery', 'true');
    expect(ui.getByText('Maria closed their shift on Phone 1')).toBeTruthy();
    fireEvent.click(ui.getByTestId('phone-shift-notice-open'));
    expect(opened).toHaveBeenCalledOnce();
    expect(mocks.toast.dismiss).toHaveBeenCalledWith('phone-shift-closed:shift-1');
    window.removeEventListener(PHONE_SHIFT_STAFF_OPEN_EVENT, opened);
  });

  it('closes without opening anything, and stays up shorter when nothing is owed', () => {
    const opened = vi.fn();
    window.addEventListener(PHONE_SHIFT_STAFF_OPEN_EVENT, opened);
    showPhoneShiftNotice(shift({ handover: 'none', closing_cash_amount: 0 }), t);
    const { ui, options } = renderToast();
    expect(options.duration).toBe(12_000);
    fireEvent.click(ui.getByTestId('phone-shift-notice-dismiss'));
    expect(mocks.toast.dismiss).toHaveBeenCalledWith('phone-shift-closed:shift-1');
    expect(opened).not.toHaveBeenCalled();
    window.removeEventListener(PHONE_SHIFT_STAFF_OPEN_EVENT, opened);
  });
});

describe('PhoneShiftNoticeManager', () => {
  it('shows one notice per phone shift that closes after it started', async () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    mocks.unitReadiness.mockResolvedValue({
      success: true,
      data: {
        success: true, main_terminal_id: 'main-1', checked_at: later, since: null, open_shifts: [], pending_returns: [],
        terminals: [{ terminal_id: 'phone-1', name: 'Phone 1', is_active: true, terminal_type: 'mobile_waiter' }],
        closed_shifts: [
          shift({ id: 'earlier', check_out_time: '2026-01-01T00:00:00.000Z' }),
          shift({ id: 'a', check_out_time: later }),
          shift({ id: 'b', check_out_time: later, staff_name: 'Luca', handover: 'none' }),
        ],
      },
    });
    const { container } = render(<PhoneShiftNoticeManager enabled />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(mocks.toast.custom).toHaveBeenCalledTimes(2));
    expect(mocks.toast.custom.mock.calls.map(([, options]) => options.id))
      .toEqual(['phone-shift-closed:a', 'phone-shift-closed:b']);
    expect(renderToast(1).ui.getByText('Luca closed their shift on Phone 1')).toBeTruthy();
  });

  it('shows nothing and asks nothing while no user is logged in', async () => {
    render(<PhoneShiftNoticeManager enabled={false} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.unitReadiness).not.toHaveBeenCalled();
    expect(mocks.toast.custom).not.toHaveBeenCalled();
  });
});
