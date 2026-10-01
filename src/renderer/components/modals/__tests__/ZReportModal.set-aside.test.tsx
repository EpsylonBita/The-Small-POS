import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 30/09/2026 (Android 1.0.13 parity, desktop B1). A payment the
// server refused as `already_paid` is set aside: counted nowhere, and the Z is
// held by one `payments_need_review` blocker per payment until someone
// confirms the money was given back to the customer. The confirmation is
// always asked first, then authorized like a money action on this terminal.

const mock = vi.hoisted(() => {
  const generateZReport = vi.fn();
  const submitZReport = vi.fn();
  const resolveSetAsidePayment = vi.fn();
  const confirmPrivilegedAction = vi.fn();
  const bridge = {
    reports: {
      generateZReport,
      submitZReport,
      printZReport: vi.fn(),
      resolvePaymentBlocker: vi.fn(),
    },
    payments: { resolveSetAsidePayment },
    auth: { logout: vi.fn(), confirmPrivilegedAction },
  };
  return {
    bridge,
    generateZReport,
    submitZReport,
    resolveSetAsidePayment,
    confirmPrivilegedAction,
    clearShift: vi.fn(),
    features: {
      isFeatureEnabled: () => true,
      isMainTerminal: true,
      isMobileWaiter: false,
      loading: false,
      parentTerminalId: null,
    },
  };
});

vi.mock('../../../../lib', () => ({
  getBridge: () => mock.bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => ({
    clearShift: mock.clearShift,
    staff: { databaseStaffId: 'staff-manager-1' },
    activeShift: { id: 'shift-1', staff_id: 'staff-manager-1' },
  }),
}));
vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));
vi.mock('../../../hooks/useFeatures', () => ({
  useFeatures: () => mock.features,
}));
vi.mock('../../../services/SyncQueueBridge', () => ({
  getSyncQueueBridge: () => ({ retryModule: vi.fn(), processQueue: vi.fn() }),
}));
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ children, header, isOpen, title }: any) =>
    isOpen ? (
      <div>
        {typeof title === 'string' && title ? <h2>{title}</h2> : null}
        {header}
        {children}
      </div>
    ) : null,
  POSGlassButton: ({ children, onClick, disabled }: any) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  POSGlassInput: (props: any) => <input {...props} />,
}));

import en from '../../../../locales/en.json';
import el from '../../../../locales/el.json';
import de from '../../../../locales/de.json';
import fr from '../../../../locales/fr.json';
import it_ from '../../../../locales/it.json';
import sq from '../../../../locales/sq.json';
import ZReportModal from '../ZReportModal';

const LOCALES = { en, el, de, fr, it: it_, sq } as const;
type Lng = keyof typeof LOCALES;

const createI18n = async (lng: Lng) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: Object.fromEntries(
      Object.entries(LOCALES).map(([code, translation]) => [code, { translation }]),
    ),
    interpolation: { escapeValue: false },
  });
  return instance;
};

/** One blocker per set-aside payment, exactly as the native Z builds it. */
const setAsideFinding = (paymentId: string, amount: number, method: 'cash' | 'card') => ({
  orderId: 'order-dup-1',
  orderNumber: 'A-0042',
  totalAmount: 13,
  settledAmount: 13,
  paymentStatus: 'paid',
  paymentMethod: method,
  reasonCode: 'payments_need_review',
  reasonText:
    'A EUR 13.00 cash payment taken at 2026-09-30T10:05:00Z was set aside as a possible duplicate: the order was already paid. It is not counted.',
  suggestedFix:
    'Give the money back to the customer, then confirm it here. If the payment on the server is the wrong one, contact support before closing the day.',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: { paymentAmount: Math.round(amount * 100) },
  reviewPayment: {
    paymentId,
    method,
    amount,
    amountCents: Math.round(amount * 100),
    currency: 'EUR',
    takenAt: '2026-09-30T10:05:00Z',
    reason: 'already_paid',
  },
});

const reportWith = (findings: unknown[]) => ({
  success: true,
  data: {
    date: '2026-09-30',
    sales: { totalOrders: 1, totalSales: 13, cashSales: 0, cardSales: 13 },
    cashDrawer: {
      totalVariance: 0,
      totalCashDrops: 0,
      unreconciledCount: 0,
      openingTotal: 0,
      driverCashGiven: 0,
      driverCashReturned: 0,
    },
    expenses: { total: 0, items: [], pendingCount: 0 },
    staffReports: [],
    integrity: {
      orderTurnover: 13,
      paymentCoverage: 13,
      difference: 0,
      unexplainedDifference: 0,
      uncoveredAmount: 0,
      excessAmount: 0,
      blockingFindings: findings.length,
      warningFindings: 0,
      findingsByReason: findings.length
        ? [{ reasonCode: 'payments_need_review', orders: findings.length, difference: 0 }]
        : [],
      findings,
      reconciled: findings.length === 0,
    },
  },
});

const renderModal = async (lng: Lng) => {
  const i18n = await createI18n(lng);
  render(
    <I18nextProvider i18n={i18n}>
      <ZReportModal isOpen onClose={() => {}} branchId="branch-1" date="2026-09-30" />
    </I18nextProvider>,
  );
  return i18n;
};

// The first case pays for the modal's first render and a full locale bundle;
// on a busy machine that alone can pass the default 5 s.
describe('ZReportModal payments set aside for review', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mock.generateZReport.mockReset();
    mock.submitZReport.mockReset();
    mock.resolveSetAsidePayment.mockReset();
    mock.confirmPrivilegedAction.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it.each(Object.keys(LOCALES) as Lng[])(
    'lists each set-aside payment in %s from its code, never from the native English',
    async (lng) => {
      mock.generateZReport.mockResolvedValue(
        reportWith([setAsideFinding('pay-cash-1', 13, 'cash'), setAsideFinding('pay-cash-2', 5, 'cash')]),
      );
      const i18n = await renderModal(lng);

      const first = await screen.findByTestId('set-aside-payment-pay-cash-1');
      const second = screen.getByTestId('set-aside-payment-pay-cash-2');
      for (const card of [first, second]) {
        const text = card.textContent ?? '';
        expect(text).toContain('A-0042');
        expect(text).not.toContain('was set aside as a possible duplicate');
        expect(text).not.toMatch(/\{\{\w+\}\}/);
        expect(
          within(card).getByRole('button', {
            name: i18n.t('paymentIntegrity.setAsideReturnedAction'),
          }),
        ).toBeTruthy();
        // Money to give back, never money to take: no collect buttons.
        expect(
          within(card).queryByRole('button', {
            name: new RegExp(i18n.t('modals.zReport.resolveBlockerCash', { amount: '' }).trim().slice(0, 8)),
          }),
        ).toBeNull();
      }
      const sentence = i18n.t('paymentIntegrity.reasonCodes.payments_need_review', {
        paymentAmount: '§',
        paymentMethod: '§',
        orderNumber: '§',
      });
      expect(sentence.length).toBeGreaterThan(20);
      if (lng !== 'en') {
        expect(first.textContent).not.toContain('after it was already paid');
      }
    },
  );

  it('asks for confirmation first, then records it given back and reads the report again', async () => {
    mock.generateZReport
      .mockResolvedValueOnce(reportWith([setAsideFinding('pay-cash-1', 13, 'cash')]))
      .mockResolvedValue(reportWith([]));
    mock.resolveSetAsidePayment.mockResolvedValue({
      success: true,
      paymentId: 'pay-cash-1',
      orderId: 'order-dup-1',
      outcome: 'returned_to_customer',
      alreadyResolved: false,
      resolvedAt: '2026-09-30T18:00:00Z',
      remainingSetAsidePayments: 0,
    });
    const i18n = await renderModal('el');

    const card = await screen.findByTestId('set-aside-payment-pay-cash-1');
    await act(async () => {
      fireEvent.click(
        within(card).getByRole('button', { name: i18n.t('paymentIntegrity.setAsideReturnedAction') }),
      );
    });

    // One stray tap decides nothing: the dialog asks first.
    expect(mock.resolveSetAsidePayment).not.toHaveBeenCalled();
    expect(screen.getByText(i18n.t('modals.zReport.setAsideConfirmTitle'))).toBeTruthy();
    const readsBefore = mock.generateZReport.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.setAsideConfirmAction') }));
    });

    await waitFor(() =>
      expect(mock.resolveSetAsidePayment).toHaveBeenCalledWith({
        paymentId: 'pay-cash-1',
        outcome: 'returned_to_customer',
        resolvedBy: 'staff-manager-1',
      }),
    );
    expect(await screen.findByText(i18n.t('modals.zReport.setAsideResolved'))).toBeTruthy();
    // The blocker leaves only after a fresh read no longer finds it.
    await waitFor(() =>
      expect(mock.generateZReport.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    await waitFor(() => expect(screen.queryByTestId('set-aside-payment-pay-cash-1')).toBeNull());
  });

  it('records nothing when the confirmation is cancelled', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([setAsideFinding('pay-cash-1', 13, 'cash')]));
    const i18n = await renderModal('en');

    const card = await screen.findByTestId('set-aside-payment-pay-cash-1');
    await act(async () => {
      fireEvent.click(
        within(card).getByRole('button', { name: i18n.t('paymentIntegrity.setAsideReturnedAction') }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('common.actions.cancel') }));
    });

    expect(mock.resolveSetAsidePayment).not.toHaveBeenCalled();
    expect(screen.getByTestId('set-aside-payment-pay-cash-1')).toBeTruthy();
  });

  it('asks for the PIN when the approval needs a fresh confirmation, then retries', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([setAsideFinding('pay-cash-1', 13, 'cash')]));
    mock.resolveSetAsidePayment
      .mockRejectedValueOnce({ code: 'REAUTH_REQUIRED', scope: 'cash_drawer_control', reason: 'Fresh PIN confirmation required' })
      .mockResolvedValueOnce({ success: true, alreadyResolved: false, remainingSetAsidePayments: 0 });
    mock.confirmPrivilegedAction.mockResolvedValue({ success: true });
    const i18n = await renderModal('en');

    const card = await screen.findByTestId('set-aside-payment-pay-cash-1');
    await act(async () => {
      fireEvent.click(
        within(card).getByRole('button', { name: i18n.t('paymentIntegrity.setAsideReturnedAction') }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.setAsideConfirmAction') }));
    });

    // The desktop's money-action approval: the cashier or manager PIN.
    expect(await screen.findByText(i18n.t('modals.zReport.setAsideApprovalTitle'))).toBeTruthy();
    expect(screen.getByText(i18n.t('modals.zReport.setAsideApprovalSubtitle'))).toBeTruthy();
    expect(mock.resolveSetAsidePayment).toHaveBeenCalledTimes(1);
  });
});
