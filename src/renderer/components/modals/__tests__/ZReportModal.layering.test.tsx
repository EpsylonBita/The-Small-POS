import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix 14/10/2026. The Z window opens with `recoveryAccess`, which puts its glass modal on the
// recovery layer (z-index 2147483100). The dialogs it opens (set-aside, unsaved and TWINT-return
// confirms, Record cash/card, the manager PIN) render BESIDE that modal, so they only reached the
// recovery layer when an ancestor provided it: GlobalCashierGate does on the locked-day path, but
// the main layout and the Reports page do not. There they sat at the default modal layer (20000),
// under the Z window. The Z window now wraps its whole output in CashierRecovery.

const mock = vi.hoisted(() => {
  const generateZReport = vi.fn();
  const bridge = {
    reports: {
      generateZReport,
      submitZReport: vi.fn(),
      printZReport: vi.fn(),
      resolvePaymentBlocker: vi.fn(),
    },
    payments: { resolveSetAsidePayment: vi.fn() },
    auth: { logout: vi.fn(), confirmPrivilegedAction: vi.fn() },
  };
  return {
    bridge,
    generateZReport,
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
// The glass modal reduced to the one decision under test: the layer it opens on, exactly as
// LiquidGlassModal decides it (its own `recoveryAccess`, else the inherited recovery context).
vi.mock('../../ui/pos-glass-components', async () => {
  const ReactModule = await import('react');
  const { CashierRecoveryContext } = await import('../../../contexts/cashier-gate-context');
  return {
    LiquidGlassModal: ({ children, header, footer, isOpen, title, ariaLabel, recoveryAccess }: any) => {
      const inherited = ReactModule.useContext(CashierRecoveryContext);
      if (!isOpen) return null;
      const recovery = Boolean(recoveryAccess || inherited);
      return (
        <div
          role="dialog"
          aria-label={ariaLabel || (typeof title === 'string' ? title : undefined)}
          data-layer={recovery ? 'recovery' : 'default'}
        >
          <CashierRecoveryContext.Provider value={recovery}>
            {typeof title === 'string' && title ? <h2>{title}</h2> : null}
            {header}
            {children}
            {footer}
          </CashierRecoveryContext.Provider>
        </div>
      );
    },
    POSGlassButton: ({ children, onClick, disabled }: any) => (
      <button type="button" onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    POSGlassInput: (props: any) => <input {...props} />,
  };
});

import en from '../../../../locales/en.json';
import ZReportModal from '../ZReportModal';

const setAsideFinding = {
  orderId: 'order-dup-1',
  orderNumber: 'A-0042',
  totalAmount: 13,
  settledAmount: 13,
  paymentStatus: 'paid',
  paymentMethod: 'cash',
  reasonCode: 'payments_need_review',
  reasonText: 'set aside',
  suggestedFix: 'give it back',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: { paymentAmount: 1300 },
  reviewPayment: {
    paymentId: 'pay-cash-1',
    method: 'cash',
    amount: 13,
    amountCents: 1300,
    currency: 'EUR',
    takenAt: '2026-09-30T10:05:00Z',
    reason: 'already_paid',
  },
};

const report = {
  success: true,
  data: {
    date: '2026-09-30',
    sales: { totalOrders: 1, totalSales: 13, cashSales: 0, cardSales: 13 },
    cashDrawer: { totalVariance: 0, totalCashDrops: 0, unreconciledCount: 0, openingTotal: 0, driverCashGiven: 0, driverCashReturned: 0 },
    expenses: { total: 0, items: [], pendingCount: 0 },
    staffReports: [],
    integrity: {
      orderTurnover: 13,
      paymentCoverage: 13,
      difference: 0,
      unexplainedDifference: 0,
      uncoveredAmount: 0,
      excessAmount: 0,
      blockingFindings: 1,
      warningFindings: 0,
      findingsByReason: [{ reasonCode: 'payments_need_review', orders: 1, difference: 0 }],
      findings: [setAsideFinding],
      reconciled: false,
    },
  },
};

describe('ZReportModal dialog layering', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mock.generateZReport.mockReset();
    mock.generateZReport.mockResolvedValue(report);
  });

  afterEach(() => {
    cleanup();
  });

  it('opens its confirm dialogs on the Z window layer when no ancestor provides it', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
    // The main layout and the Reports page mount the Z window like this: no GlobalCashierGate.
    render(
      <I18nextProvider i18n={i18n}>
        <ZReportModal isOpen onClose={() => {}} branchId="branch-1" date="2026-09-30" />
      </I18nextProvider>,
    );

    const card = await screen.findByTestId('set-aside-payment-pay-cash-1');
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: i18n.t('paymentIntegrity.setAsideReturnedAction') }));
    });

    const confirm = screen.getByRole('dialog', { name: i18n.t('modals.zReport.setAsideConfirmTitle') });
    expect(confirm.getAttribute('data-layer')).toBe('recovery');
    // Every glass dialog of the Z window, the window itself included, is on the same layer.
    for (const dialog of screen.getAllByRole('dialog')) {
      expect(dialog.getAttribute('data-layer')).toBe('recovery');
    }
  });
});
