import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Item F, fix review 30/09/2026 (parity with Android's "Record the payment").
// "Record cash" / "Record card" on a Z blocker records money the customer
// paid and the till never recorded. Recording money no one collected is a
// sensitive action: before, one tap wrote the payment. Now the operator
// confirms first, then the desktop's money approval (a cashier or manager
// shift on this terminal and a fresh PIN) runs, and the record carries the
// confirmed amount so the till keys it `z-record:<order>:<cents>`.

const mock = vi.hoisted(() => {
  const generateZReport = vi.fn();
  const resolvePaymentBlocker = vi.fn();
  const confirmPrivilegedAction = vi.fn();
  const bridge = {
    reports: {
      generateZReport,
      submitZReport: vi.fn(),
      printZReport: vi.fn(),
      resolvePaymentBlocker,
    },
    payments: {
      saveUnsavedPayments: vi.fn(),
      resolveUnsavedPayment: vi.fn(),
      resolveSetAsidePayment: vi.fn(),
    },
    auth: { logout: vi.fn(), confirmPrivilegedAction },
  };
  return {
    bridge,
    generateZReport,
    resolvePaymentBlocker,
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

/** A paid order with no payment row: the till never recorded 13.00. */
const unrecordedFinding = () => ({
  orderId: 'order-unrecorded-1',
  orderNumber: 'A-0120',
  totalAmount: 13,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'cash',
  reasonCode: 'no_persisted_payment',
  reasonText: 'Order A-0120 has no persisted payment.',
  suggestedFix: 'Record the missing payment.',
  severity: 'blocking',
  differenceCents: 1300,
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
      unexplainedDifference: 13,
      uncoveredAmount: 13,
      excessAmount: 0,
      blockingFindings: findings.length,
      warningFindings: 0,
      findingsByReason: findings.length
        ? [{ reasonCode: 'no_persisted_payment', orders: findings.length, difference: 13 }]
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

const recordCashButton = async (i18n: Awaited<ReturnType<typeof createI18n>>) => {
  const label = i18n.t('modals.zReport.resolveBlockerCash', { amount: '' }).trim();
  return screen.findByRole(
    'button',
    { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) },
    { timeout: 5000 },
  );
};

describe('ZReportModal Record cash / Record card', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mock.generateZReport.mockReset();
    mock.resolvePaymentBlocker.mockReset();
    mock.confirmPrivilegedAction.mockReset();
  });

  afterEach(() => cleanup());

  it('asks first, then records the confirmed amount and reads the report again', async () => {
    mock.generateZReport
      .mockResolvedValueOnce(reportWith([unrecordedFinding()]))
      .mockResolvedValue(reportWith([]));
    mock.resolvePaymentBlocker.mockResolvedValue({
      success: true,
      charged: false,
      idempotencyKey: 'z-record:order-unrecorded-1:1300',
      remainingBlockers: [],
    });
    const i18n = await renderModal('el');

    const recordCash = await recordCashButton(i18n);
    await act(async () => {
      fireEvent.click(recordCash);
    });

    // One tap records nothing: the dialog asks, in the store's language.
    expect(mock.resolvePaymentBlocker).not.toHaveBeenCalled();
    const title = screen.getByText(i18n.t('modals.zReport.recordConfirmTitle'));
    expect(title).toBeTruthy();
    expect(document.body.textContent).toContain('A-0120');
    const readsBefore = mock.generateZReport.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.recordConfirmAction') }));
    });

    await waitFor(() =>
      expect(mock.resolvePaymentBlocker).toHaveBeenCalledWith({
        orderId: 'order-unrecorded-1',
        method: 'cash',
        amountCents: 1300,
      }),
    );
    expect(mock.resolvePaymentBlocker).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mock.generateZReport.mock.calls.length).toBeGreaterThan(readsBefore),
    );
  });

  it('records nothing when the operator cancels the confirmation', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    const i18n = await renderModal('en');

    const recordCash = await recordCashButton(i18n);
    await act(async () => {
      fireEvent.click(recordCash);
    });
    expect(screen.getByText(i18n.t('modals.zReport.recordConfirmTitle'))).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('common.actions.cancel') }));
    });

    expect(screen.queryByText(i18n.t('modals.zReport.recordConfirmTitle'))).toBeNull();
    expect(mock.resolvePaymentBlocker).not.toHaveBeenCalled();
  });

  it('asks for the cashier or manager PIN when the approval needs a fresh confirmation', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    mock.resolvePaymentBlocker.mockRejectedValueOnce({
      code: 'REAUTH_REQUIRED',
      scope: 'cash_drawer_control',
      reason: 'Fresh PIN confirmation required',
    });
    const i18n = await renderModal('sq');

    const recordCash = await recordCashButton(i18n);
    await act(async () => {
      fireEvent.click(recordCash);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.recordConfirmAction') }));
    });

    expect(await screen.findByText(i18n.t('modals.zReport.recordApprovalTitle'))).toBeTruthy();
    expect(mock.resolvePaymentBlocker).toHaveBeenCalledTimes(1);
  });

  it('says so when no cashier or manager is checked in, and records nothing', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    mock.resolvePaymentBlocker.mockRejectedValueOnce({
      code: 'UNAUTHORIZED',
      scope: 'cash_drawer_control',
      reason: 'Active cashier or manager shift required on this terminal',
    });
    const i18n = await renderModal('en');

    const recordCash = await recordCashButton(i18n);
    await act(async () => {
      fireEvent.click(recordCash);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.recordConfirmAction') }));
    });

    expect(await screen.findByText(i18n.t('modals.zReport.setAsideShiftRequired'))).toBeTruthy();
  });

  it('tells the operator a record already made was not added twice', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    mock.resolvePaymentBlocker.mockResolvedValue({
      success: true,
      alreadyRecorded: true,
      charged: false,
      idempotencyKey: 'z-record:order-unrecorded-1:1300',
      remainingBlockers: [],
    });
    const i18n = await renderModal('en');

    const recordCash = await recordCashButton(i18n);
    await act(async () => {
      fireEvent.click(recordCash);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.recordConfirmAction') }));
    });

    expect(
      await screen.findByText(
        i18n.t('modals.zReport.recordAlreadyRecorded', {
          orderNumber: 'A-0120',
          method: i18n.t('modals.zReport.cash').toLowerCase(),
        }),
      ),
    ).toBeTruthy();
  });
});
