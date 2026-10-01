import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 30/09/2026 (Android 1.0.13 parity). A card charged on this till
// whose payment could not be saved is kept as a durable record that holds the
// Z (`payments_not_saved`, one blocker per record). The Z offers "Save payment
// again" (the same write, no new charge) and the manager's way out, "Money
// given back to the customer": always a confirmation first, then the money
// action approval, then a fresh read of the report.

const mock = vi.hoisted(() => {
  const generateZReport = vi.fn();
  const submitZReport = vi.fn();
  const saveUnsavedPayments = vi.fn();
  const resolveUnsavedPayment = vi.fn();
  const confirmPrivilegedAction = vi.fn();
  const bridge = {
    reports: {
      generateZReport,
      submitZReport,
      printZReport: vi.fn(),
      resolvePaymentBlocker: vi.fn(),
    },
    payments: { saveUnsavedPayments, resolveUnsavedPayment, resolveSetAsidePayment: vi.fn() },
    auth: { logout: vi.fn(), confirmPrivilegedAction },
  };
  return {
    bridge,
    generateZReport,
    submitZReport,
    saveUnsavedPayments,
    resolveUnsavedPayment,
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
import sq from '../../../../locales/sq.json';
import ZReportModal from '../ZReportModal';

const LOCALES = { en, el, sq } as const;
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

const KEY = 'terminal-card:txn-not-saved';

/** One blocker per charged payment not saved, as the native Z builds it. */
const notSavedFinding = (canSaveAgain = true) => ({
  orderId: 'order-unsaved-1',
  orderNumber: 'A-0077',
  totalAmount: 13,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'card',
  reasonCode: 'payments_not_saved',
  reasonText:
    'A EUR 13.00 card payment charged at 2026-09-30T10:05:00Z is not saved on this till yet. The customer was charged; do not charge again.',
  suggestedFix: canSaveAgain
    ? 'Save the payment again. If it cannot be saved, give the money back to the customer and confirm it here.'
    : 'This payment cannot be saved on this till. Give the money back to the customer, then confirm it here.',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: { paymentAmount: 1300 },
  ...(canSaveAgain ? {} : { reasonVariant: 'cannot_save' }),
  unsavedPayment: {
    idempotencyKey: KEY,
    method: 'card',
    amount: 13,
    amountCents: 1300,
    currency: 'EUR',
    capturedAt: '2026-09-30T10:05:00Z',
    kind: 'single',
    attempts: 4,
    canSaveAgain,
  },
});

const reportWith = (findings: unknown[]) => ({
  success: true,
  data: {
    date: '2026-09-30',
    sales: { totalOrders: 1, totalSales: 13, cashSales: 0, cardSales: 0 },
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
      paymentCoverage: 0,
      difference: 13,
      unexplainedDifference: 0,
      uncoveredAmount: 13,
      excessAmount: 0,
      blockingFindings: findings.length,
      warningFindings: 0,
      findingsByReason: findings.length
        ? [{ reasonCode: 'payments_not_saved', orders: findings.length, difference: 0 }]
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

describe('ZReportModal charged payments not saved', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mock.generateZReport.mockReset();
    mock.saveUnsavedPayments.mockReset();
    mock.resolveUnsavedPayment.mockReset();
    mock.confirmPrivilegedAction.mockReset();
  });

  afterEach(() => cleanup());

  it('lists the record in the store language with Save payment again and the way out', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([notSavedFinding()]));
    const i18n = await renderModal('el');

    const card = await screen.findByTestId(`unsaved-payment-${KEY}`);
    const text = card.textContent ?? '';
    expect(text).toContain('A-0077');
    expect(text).not.toContain('is not saved on this till yet');
    expect(
      within(card).getByRole('button', { name: i18n.t('paymentIntegrity.unsavedSaveAgainAction') }),
    ).toBeTruthy();
    expect(
      within(card).getByRole('button', { name: i18n.t('paymentIntegrity.unsavedReturnedAction') }),
    ).toBeTruthy();
    // Money already taken is never offered to be taken again.
    expect(
      within(card).queryByRole('button', {
        name: new RegExp(i18n.t('modals.zReport.resolveBlockerCard', { amount: '' }).trim().slice(0, 8)),
      }),
    ).toBeNull();
  });

  it('Save payment again replays the same record and reads the report again', async () => {
    mock.generateZReport
      .mockResolvedValueOnce(reportWith([notSavedFinding()]))
      .mockResolvedValue(reportWith([]));
    mock.saveUnsavedPayments.mockResolvedValue({
      success: true,
      saved: 1,
      setAside: [],
      unsaved: [],
      results: [],
    });
    const i18n = await renderModal('en');

    const card = await screen.findByTestId(`unsaved-payment-${KEY}`);
    const readsBefore = mock.generateZReport.mock.calls.length;
    await act(async () => {
      fireEvent.click(
        within(card).getByRole('button', { name: i18n.t('paymentIntegrity.unsavedSaveAgainAction') }),
      );
    });

    await waitFor(() =>
      expect(mock.saveUnsavedPayments).toHaveBeenCalledWith({ idempotencyKey: KEY }),
    );
    expect(await screen.findByText(i18n.t('modals.zReport.unsavedSaved'))).toBeTruthy();
    await waitFor(() =>
      expect(mock.generateZReport.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    await waitFor(() => expect(screen.queryByTestId(`unsaved-payment-${KEY}`)).toBeNull());
  });

  it('asks for confirmation first, then records the money given back and reads the report again', async () => {
    mock.generateZReport
      .mockResolvedValueOnce(reportWith([notSavedFinding(false)]))
      .mockResolvedValue(reportWith([]));
    mock.resolveUnsavedPayment.mockResolvedValue({
      success: true,
      idempotencyKey: KEY,
      orderId: 'order-unsaved-1',
      outcome: 'returned_to_customer',
      result: 'resolved',
      resolvedAt: '2026-09-30T18:00:00Z',
      remainingUnsavedPayments: 0,
    });
    const i18n = await renderModal('sq');

    const card = await screen.findByTestId(`unsaved-payment-${KEY}`);
    // A record no save can help any more offers only the way out.
    expect(
      within(card).queryByRole('button', { name: i18n.t('paymentIntegrity.unsavedSaveAgainAction') }),
    ).toBeNull();
    await act(async () => {
      fireEvent.click(
        within(card).getByRole('button', { name: i18n.t('paymentIntegrity.unsavedReturnedAction') }),
      );
    });

    // One stray tap decides nothing: the dialog asks first.
    expect(mock.resolveUnsavedPayment).not.toHaveBeenCalled();
    expect(screen.getByText(i18n.t('modals.zReport.unsavedConfirmTitle'))).toBeTruthy();
    const readsBefore = mock.generateZReport.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.unsavedConfirmAction') }));
    });

    await waitFor(() =>
      expect(mock.resolveUnsavedPayment).toHaveBeenCalledWith({
        idempotencyKey: KEY,
        outcome: 'returned_to_customer',
        resolvedBy: 'staff-manager-1',
      }),
    );
    expect(await screen.findByText(i18n.t('modals.zReport.unsavedResolved'))).toBeTruthy();
    await waitFor(() =>
      expect(mock.generateZReport.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    await waitFor(() => expect(screen.queryByTestId(`unsaved-payment-${KEY}`)).toBeNull());
  });

  it('asks for the PIN when the approval needs a fresh confirmation', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([notSavedFinding()]));
    mock.resolveUnsavedPayment
      .mockRejectedValueOnce({ code: 'REAUTH_REQUIRED', scope: 'cash_drawer_control', reason: 'Fresh PIN confirmation required' })
      .mockResolvedValueOnce({ success: true, result: 'resolved', remainingUnsavedPayments: 0 });
    mock.confirmPrivilegedAction.mockResolvedValue({ success: true });
    const i18n = await renderModal('en');

    const card = await screen.findByTestId(`unsaved-payment-${KEY}`);
    await act(async () => {
      fireEvent.click(
        within(card).getByRole('button', { name: i18n.t('paymentIntegrity.unsavedReturnedAction') }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.unsavedConfirmAction') }));
    });

    expect(await screen.findByText(i18n.t('modals.zReport.unsavedApprovalTitle'))).toBeTruthy();
    expect(mock.resolveUnsavedPayment).toHaveBeenCalledTimes(1);
  });
});
