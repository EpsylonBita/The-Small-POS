import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tomikro #00055 (28/10/2026): four refused card collections of a paid edit
// stayed held after the order was cancelled, and every Z was blocked by
// `edit_settlement_not_saved`. The editor that offers the manager's close can
// never be reopened for a cancelled order, so the Z checks offer it for that
// case only: the money action approval, then a fresh read of the report.

const mock = vi.hoisted(() => {
  const generateZReport = vi.fn();
  const submitZReport = vi.fn();
  const applyEditSettlement = vi.fn();
  const confirmPrivilegedAction = vi.fn();
  const bridge = {
    reports: {
      generateZReport,
      submitZReport,
      printZReport: vi.fn(),
      resolvePaymentBlocker: vi.fn(),
    },
    payments: { saveUnsavedPayments: vi.fn(), resolveUnsavedPayment: vi.fn(), resolveSetAsidePayment: vi.fn() },
    orders: { applyEditSettlement },
    auth: { logout: vi.fn(), confirmPrivilegedAction },
  };
  return {
    bridge,
    generateZReport,
    submitZReport,
    applyEditSettlement,
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

/** A held correction as the native Z builds it; `cancelled` adds the variant. */
const heldEdit = (orderId: string, orderNumber: string, cancelled: boolean) => ({
  orderId,
  orderNumber,
  totalAmount: 13.2,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'pending',
  reasonCode: 'edit_settlement_not_saved',
  reasonText: 'native English reason',
  suggestedFix: 'native English fix',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: {},
  ...(cancelled ? { reasonVariant: 'order_cancelled' } : {}),
});

const reportWith = (findings: unknown[]) => ({
  success: true,
  data: {
    date: '2026-10-27',
    sales: { totalOrders: 1, totalSales: 13.2, cashSales: 0, cardSales: 0 },
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
      orderTurnover: 0,
      paymentCoverage: 0,
      difference: 0,
      unexplainedDifference: 0,
      uncoveredAmount: 0,
      excessAmount: 0,
      blockingFindings: findings.length,
      warningFindings: 0,
      findingsByReason: findings.length
        ? [{ reasonCode: 'edit_settlement_not_saved', orders: findings.length, difference: 0 }]
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
      <ZReportModal isOpen onClose={() => {}} branchId="branch-1" date="2026-10-27" />
    </I18nextProvider>,
  );
  return i18n;
};

describe('ZReportModal held correction of a cancelled order', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mock.generateZReport.mockReset();
    mock.applyEditSettlement.mockReset();
    mock.confirmPrivilegedAction.mockReset();
  });

  afterEach(() => cleanup());

  it('offers the manager close only for the cancelled order, in the store language', async () => {
    mock.generateZReport.mockResolvedValue(
      reportWith([heldEdit('order-55', '00055', true), heldEdit('order-live', '00060', false)]),
    );
    const i18n = await renderModal('el');

    const close = await screen.findByTestId('close-held-edit-order-55');
    expect(close.textContent).toContain(i18n.t('paymentIntegrity.heldEditCloseAction'));
    expect(screen.queryByTestId('close-held-edit-order-live')).toBeNull();
    const page = document.body.textContent ?? '';
    expect(page).toContain(i18n.t('paymentIntegrity.reasonCodes.edit_settlement_not_saved__order_cancelled'));
    expect(page).toContain(i18n.t('paymentIntegrity.fixCodes.edit_settlement_not_saved'));
    expect(page).not.toContain('native English');
  });

  it('closes every held correction of that order without money and reads the report again', async () => {
    mock.generateZReport
      .mockResolvedValueOnce(reportWith([heldEdit('order-55', '00055', true)]))
      .mockResolvedValue(reportWith([]));
    mock.applyEditSettlement.mockResolvedValue({
      success: true,
      state: 'reconciled',
      orderId: 'order-55',
      closedEvents: ['edit-1', 'edit-2'],
    });
    const i18n = await renderModal('en');

    const close = await screen.findByTestId('close-held-edit-order-55');
    const readsBefore = mock.generateZReport.mock.calls.length;
    await act(async () => {
      fireEvent.click(close);
    });

    await waitFor(() => expect(mock.applyEditSettlement).toHaveBeenCalledTimes(1));
    const request = mock.applyEditSettlement.mock.calls[0][0];
    expect(request.orderId).toBe('order-55');
    expect(request.client_event_id).toBeUndefined();
    expect(request.reconcile).toMatchObject({ decision: 'close_without_money', scope: 'order' });
    expect(request.action).toEqual({ type: 'none' });
    expect(await screen.findByText(i18n.t('modals.zReport.heldEditClosed'))).toBeTruthy();
    await waitFor(() =>
      expect(mock.generateZReport.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    await waitFor(() => expect(screen.queryByTestId('close-held-edit-order-55')).toBeNull());
  });

  it('keeps the correction held when native cannot prove it never applied', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([heldEdit('order-55', '00055', true)]));
    mock.applyEditSettlement.mockRejectedValue(new Error('EDIT_RECONCILIATION_NOT_PROVEN'));
    const i18n = await renderModal('sq');

    const close = await screen.findByTestId('close-held-edit-order-55');
    await act(async () => {
      fireEvent.click(close);
    });

    expect(await screen.findByText(i18n.t('modals.zReport.heldEditCloseFailed'))).toBeTruthy();
    expect(await screen.findByTestId('close-held-edit-order-55')).toBeTruthy();
  });

  it('asks for the PIN when the approval needs a fresh confirmation', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([heldEdit('order-55', '00055', true)]));
    mock.applyEditSettlement
      .mockRejectedValueOnce({ code: 'REAUTH_REQUIRED', scope: 'cash_drawer_control', reason: 'Fresh PIN confirmation required' })
      .mockResolvedValueOnce({ success: true, state: 'reconciled', orderId: 'order-55', closedEvents: ['edit-1'] });
    mock.confirmPrivilegedAction.mockResolvedValue({ success: true });
    const i18n = await renderModal('en');

    const close = await screen.findByTestId('close-held-edit-order-55');
    await act(async () => {
      fireEvent.click(close);
    });

    expect(await screen.findByText(i18n.t('modals.zReport.heldEditApprovalTitle'))).toBeTruthy();
    expect(mock.applyEditSettlement).toHaveBeenCalledTimes(1);
  });
});
