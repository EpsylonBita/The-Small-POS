import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 06/10/2026. A cashier-confirmed TWINT receipt whose save met a
// lasting refusal could never leave the Z: TWINT is never "money given back"
// at the till. A manager now records it as returned through TWINT outside the
// POS, with their own PIN and a reference; nothing is charged or refunded,
// and the Z shows it apart from sales, TWINT and drawer cash.

const mock = vi.hoisted(() => {
  const generateZReport = vi.fn();
  const resolveReturned = vi.fn();
  const listReturned = vi.fn();
  const bridge = {
    reports: {
      generateZReport,
      submitZReport: vi.fn(),
      printZReport: vi.fn(),
      resolvePaymentBlocker: vi.fn(),
    },
    payments: { saveUnsavedPayments: vi.fn(), resolveUnsavedPayment: vi.fn(), resolveSetAsidePayment: vi.fn() },
    auth: { logout: vi.fn(), confirmPrivilegedAction: vi.fn() },
  };
  return {
    bridge,
    generateZReport,
    resolveReturned,
    listReturned,
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
    clearShift: vi.fn(),
    staff: { databaseStaffId: 'staff-manager-1' },
    activeShift: null,
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
vi.mock('../../../services/TwintReceiptRecoveryService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/TwintReceiptRecoveryService')>()),
  resolveReturnedTwintReceipt: mock.resolveReturned,
  listTwintReturnedOutsidePos: mock.listReturned,
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
import ZReportModal from '../ZReportModal';

const LOCALES = { en, el } as const;
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

const KEY = 'manual-twint-key';
const PERIOD_START = '2026-10-06T06:00:00.000Z';

/** A retained TWINT receipt whose save met a lasting refusal. */
const twintFinding = (canSaveAgain = false) => ({
  orderId: 'order-twint-1',
  orderNumber: 'A-0412',
  totalAmount: 12.35,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'twint',
  reasonCode: 'payments_not_saved',
  reasonText: 'A TWINT receipt is confirmed but its payment is not saved.',
  suggestedFix: 'Keep the original manual TWINT receipt for a manager to reconcile.',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: { paymentAmount: 1235 },
  ...(canSaveAgain ? {} : { reasonVariant: 'cannot_save' }),
  unsavedPayment: {
    idempotencyKey: KEY,
    method: 'twint',
    kind: 'manual_twint_payment',
    amount: 12.35,
    amountCents: 1235,
    currency: 'CHF',
    capturedAt: '2026-10-06T10:05:00Z',
    attempts: 2,
    canSaveAgain,
    manualReceiptConfirmed: true,
    manualScope: 'org|branch|terminal',
  },
});

const reportWith = (findings: unknown[]) => ({
  success: true,
  data: {
    date: '2026-10-06',
    period: { start: PERIOD_START, end: '2026-10-06T18:00:00.000Z' },
    sales: { totalOrders: 1, totalSales: 12.35, cashSales: 0, cardSales: 0 },
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
      orderTurnover: 12.35,
      paymentCoverage: 0,
      difference: 12.35,
      unexplainedDifference: 0,
      uncoveredAmount: 12.35,
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
      <ZReportModal isOpen onClose={() => {}} branchId="branch-1" date="2026-10-06" />
    </I18nextProvider>,
  );
  return i18n;
};

describe('ZReportModal TWINT receipt returned outside the POS', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mock.generateZReport.mockReset();
    mock.resolveReturned.mockReset();
    mock.listReturned.mockReset();
    mock.listReturned.mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it('needs a reference, then records it under a manager and reads the report again', async () => {
    mock.generateZReport
      .mockResolvedValueOnce(reportWith([twintFinding()]))
      .mockResolvedValue(reportWith([]));
    mock.resolveReturned.mockResolvedValue({
      success: true,
      idempotencyKey: KEY,
      orderId: 'order-twint-1',
      outcome: 'twint_returned_to_customer',
      result: 'resolved',
      resolvedAt: '2026-10-06T18:00:00Z',
      remainingUnsavedPayments: 0,
    });
    const i18n = await renderModal('el');

    const card = await screen.findByTestId(`unsaved-payment-${KEY}`);
    // TWINT is never "money given back" at the till.
    expect(
      within(card).queryByRole('button', { name: i18n.t('paymentIntegrity.unsavedReturnedAction') }),
    ).toBeNull();
    const button = within(card).getByTestId(`twint-returned-${KEY}`);
    expect(button).toHaveTextContent(i18n.t('twintPayment.returned.button'));
    await act(async () => {
      fireEvent.click(button);
    });

    // The dialog asks first, in the store language, and a reference is required.
    expect(screen.getByText(i18n.t('twintPayment.returned.title'))).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('twintPayment.returned.confirm') }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('twintPayment.returned.referenceRequired'));
    expect(mock.resolveReturned).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('twint-return-reference'), { target: { value: '  TW-REF-0412 ' } });
    // And a manager's own PIN, given with this one decision.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('twintPayment.returned.confirm') }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('twintPayment.returned.pinRequired'));
    expect(mock.resolveReturned).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('twint-return-manager-pin'), { target: { value: '24x68' } });
    expect(screen.getByTestId('twint-return-manager-pin')).toHaveValue('2468');
    const readsBefore = mock.generateZReport.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('twintPayment.returned.confirm') }));
    });

    await waitFor(() =>
      expect(mock.resolveReturned).toHaveBeenCalledWith({
        idempotencyKey: KEY,
        reference: 'TW-REF-0412',
        resolvedBy: 'staff-manager-1',
        managerPin: '2468',
      }),
    );
    expect(await screen.findByText(i18n.t('twintPayment.returned.success'))).toBeTruthy();
    await waitFor(() =>
      expect(mock.generateZReport.mock.calls.length).toBeGreaterThan(readsBefore),
    );
  });

  it('is never offered while the original receipt can still be saved', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([twintFinding(true)]));
    await renderModal('en');
    await screen.findByTestId(`unsaved-payment-${KEY}`);
    expect(screen.queryByTestId(`twint-returned-${KEY}`)).toBeNull();
  });

  it.each([
    ['a PIN of no one who may approve it', 'Invalid PIN'],
    ['no manager approval', 'TWINT_RETURN_MANAGER_APPROVAL_REQUIRED: a manager confirms it with their own PIN'],
  ])('records nothing and says so for %s', async (_case, refusal) => {
    mock.generateZReport.mockResolvedValue(reportWith([twintFinding()]));
    mock.resolveReturned.mockRejectedValue(new Error(refusal));
    const i18n = await renderModal('el');
    fireEvent.click(await screen.findByTestId(`twint-returned-${KEY}`));
    fireEvent.change(screen.getByTestId('twint-return-reference'), { target: { value: 'TW-REF-1' } });
    fireEvent.change(screen.getByTestId('twint-return-manager-pin'), { target: { value: '1357' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('twintPayment.returned.confirm') }));
    });
    expect(await screen.findByText(i18n.t('twintPayment.returned.wrongPin'))).toBeTruthy();
    expect(screen.getByTestId(`unsaved-payment-${KEY}`)).toBeTruthy();
  });

  it('shows the receipts returned in this Z window apart from sales and drawer cash', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([]));
    mock.listReturned.mockResolvedValue([
      { idempotencyKey: 'a', orderId: 'o-1', kind: 'manual_twint_payment', amountCents: 1235, currency: 'CHF', capturedAt: 'x', resolvedAt: 'y', resolvedBy: 'staff-manager-1', reference: 'TW-1' },
      { idempotencyKey: 'b', orderId: 'o-2', kind: 'manual_twint_checkout', amountCents: 500, currency: 'CHF', capturedAt: 'x', resolvedAt: 'y', resolvedBy: 'staff-manager-1', reference: 'TW-2' },
    ]);
    const i18n = await renderModal('el');
    const line = await screen.findByTestId('z-twint-returned-outside-pos');
    expect(mock.listReturned).toHaveBeenCalledWith(PERIOD_START);
    expect(line).toHaveTextContent(i18n.t('twintPayment.returned.zLine'));
    expect(line).toHaveTextContent(i18n.t('twintPayment.returned.zNote'));
    expect(line.textContent).toMatch(/2 · .*17[.,]35/);
  });
});
