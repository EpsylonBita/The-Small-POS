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

import { onEvent } from '../../../../lib';
import { localeBundles } from '../../../../locales/bundles';
import ZReportModal from '../ZReportModal';

const { en, el, sq } = localeBundles;
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

const confirmRecordCash = async (i18n: Awaited<ReturnType<typeof createI18n>>) => {
  fireEvent.click(await recordCashButton(i18n));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.recordConfirmAction') }));
  });
};

describe('ZReportModal Record cash / Record card', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.mocked(onEvent).mockClear();
    mock.generateZReport.mockReset();
    mock.resolvePaymentBlocker.mockReset();
    mock.confirmPrivilegedAction.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

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

  it.each([
    { recordRefused: false, reloadRejected: true },
    { recordRefused: false, reloadRejected: false },
    { recordRefused: true, reloadRejected: true },
  ])('shows the refresh instruction when reloading fails (record refused: $recordRefused, reload rejected: $reloadRejected)', async ({ recordRefused, reloadRejected }) => {
    const raw = 'SQLITE_BUSY: raw report reload error';
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    mock.resolvePaymentBlocker.mockImplementationOnce(async () => {
      if (reloadRejected) mock.generateZReport.mockRejectedValueOnce(new Error(raw));
      else mock.generateZReport.mockResolvedValueOnce({ success: false, error: raw });
      return recordRefused
        ? { success: false, error: 'Raw record refusal' }
        : { success: true, charged: false, remainingBlockers: [] };
    });
    const i18n = await renderModal('el');
    await confirmRecordCash(i18n);

    expect(await screen.findByText('Η αναφορά δεν ανανεώθηκε. Πατήστε «Ανανέωση αναφοράς».')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(raw);
    expect(screen.getByRole('button', { name: i18n.t('modals.zReport.refresh') })).toBeEnabled();
    expect(mock.resolvePaymentBlocker).toHaveBeenCalledOnce();
  });

  it('shows the localized refresh instruction and logs an exception on the first load', async () => {
    const failure = new Error('SQLITE_BUSY: raw first report load error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.generateZReport.mockRejectedValueOnce(failure);
    const i18n = await renderModal('el');

    expect(await screen.findByText('Η αναφορά δεν φορτώθηκε. Πατήστε «Ανανέωση αναφοράς».')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(failure.message);
    expect(screen.getByRole('button', { name: i18n.t('modals.zReport.refresh') })).toBeEnabled();
    expect(warn).toHaveBeenCalledWith('[ZReportModal] Report load failed:', failure);
  });

  it('shows the localized refresh instruction and logs a refused first load without blockers', async () => {
    const refusal = {
      success: false,
      errorCode: 'UNSETTLED_PAYMENT_BLOCKER',
      error: 'SQLITE_BUSY: raw report refusal',
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.generateZReport.mockResolvedValueOnce(refusal);
    await renderModal('el');

    expect(await screen.findByText('Η αναφορά δεν φορτώθηκε. Πατήστε «Ανανέωση αναφοράς».')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(refusal.error);
    expect(warn).toHaveBeenCalledWith('[ZReportModal] Report load failed:', refusal);
  });

  it('shows a localized banner and blocker wording on the default Review tab after a refused load', async () => {
    const blocker = {
      ...unrecordedFinding(),
      reasonCode: 'future_payment_reason',
      reasonText: 'Native payment row reason.',
      suggestedFix: 'Native ledger repair instruction.',
    };
    const refusal = {
      success: false,
      errorCode: 'UNSETTLED_PAYMENT_BLOCKER',
      error: 'Raw first report refusal with a blocker.',
      blockers: [blocker],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.generateZReport.mockResolvedValue(refusal);
    await renderModal('el');

    expect(await screen.findByText('Η αναφορά δεν φορτώθηκε. Πατήστε «Ανανέωση αναφοράς».')).toBeInTheDocument();
    expect(screen.getByText('Έλεγχος').closest('button')).toHaveClass('bg-(--pos-s-sel-bg)');
    expect(screen.getByText('Η πληρωμή της παραγγελίας A-0120 χρειάζεται έλεγχο.')).toBeInTheDocument();
    expect(screen.getByText('Ενημερώστε τον υπεύθυνο. Αν το πρόβλημα παραμένει, καλέστε την υποστήριξη.')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(blocker.reasonText);
    expect(document.body).not.toHaveTextContent(blocker.suggestedFix);
    expect(document.body).not.toHaveTextContent(refusal.error);
    expect(warn).toHaveBeenCalledWith('[ZReportModal] Report load failed:', refusal);
  });

  it('logs a refused background refresh and keeps the displayed report', async () => {
    const report = reportWith([unrecordedFinding()]);
    const refusal = { success: false, error: 'Raw silent refresh refusal.' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.generateZReport.mockResolvedValue({
      ...report,
      data: { ...report.data, zReportId: 'stored-report-1' },
    });
    const i18n = await renderModal('el');
    const displayedButton = await recordCashButton(i18n);
    const before = document.body.textContent;
    const readsBefore = mock.generateZReport.mock.calls.length;
    const refresh = vi.mocked(onEvent).mock.calls.find(([event]) => event === 'shift-updated')?.[1];
    expect(refresh).toBeTypeOf('function');
    mock.generateZReport.mockResolvedValueOnce(refusal);

    await act(async () => { refresh?.(undefined); });

    expect(mock.generateZReport).toHaveBeenCalledTimes(readsBefore + 1);
    expect(warn).toHaveBeenCalledWith('[ZReportModal] Silent live refresh failed:', refusal);
    expect(document.body.textContent).toBe(before);
    expect(displayedButton).toBeInTheDocument();
  });

  it('shows a generic Review reason and remembers only the current unknown codes', async () => {
    const reasonCode = 'future_payment_reason';
    const otherCode = 'other_reason';
    const newCode = 'changed_reason';
    const reportWithReasons = (...codes: string[]) => {
      const report = reportWith([unrecordedFinding()]);
      report.data.integrity.findingsByReason.push(...codes.map(code => ({
        reasonCode: code, orders: 1, difference: 13,
      })));
      return report;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.generateZReport.mockResolvedValue(reportWithReasons(reasonCode, otherCode));
    const i18n = await renderModal('el');

    expect(await screen.findAllByText('Άλλο θέμα πληρωμής')).toHaveLength(2);
    expect(document.body).not.toHaveTextContent(reasonCode);
    expect(document.body).not.toHaveTextContent('future payment reason');
    const codes = () => warn.mock.calls
      .filter(([message]) => message === '[ZReportModal] Missing localized Review reason:')
      .map(([, code]) => code);
    // The modal logs from an effect. The labels reach the DOM at the commit and
    // the effect runs after it, so an expected log is waited for, never read at
    // once (CI run 44750774447 read an empty list on a slow runner). A read that
    // expects no new log stays a single assertion after the reload's `act`; the
    // next awaited read compares the whole list, so a late duplicate fails there.
    await waitFor(() => expect(codes()).toEqual([reasonCode, otherCode]));

    const refresh = async (...nextCodes: string[]) => {
      mock.generateZReport.mockResolvedValue(reportWithReasons(...nextCodes));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.refresh') })); });
    };
    await refresh(reasonCode, otherCode);
    expect(codes()).toEqual([reasonCode, otherCode]);
    await refresh(newCode, otherCode);
    await waitFor(() => expect(codes()).toEqual([reasonCode, otherCode, newCode]));
    await refresh(otherCode);
    expect(await screen.findByText('Άλλο θέμα πληρωμής')).toBeInTheDocument();
    expect(codes()).toEqual([reasonCode, otherCode, newCode]);
    await refresh(newCode, otherCode);
    await waitFor(() => expect(codes()).toEqual([reasonCode, otherCode, newCode, newCode]));
  });

  it('shows unclassified source totals and remembers only the current source IDs', async () => {
    const source = 'source_a';
    const otherSource = 'source_b';
    const newSource = 'source_c';
    const reportWithSources = (...sources: string[]) => {
      const report = reportWith([]);
      return {
        ...report,
        data: { ...report.data, integrity: {
          ...report.data.integrity,
          unclassifiedPlatforms: sources.map(source => ({ source, orders: 2, amount: 13 })),
        } },
      };
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.generateZReport.mockResolvedValue(reportWithSources(source, otherSource));
    const i18n = await renderModal('el');

    const labels = await screen.findAllByText('Άγνωστη πηγή παραγγελίας');
    expect(labels).toHaveLength(2);
    expect(labels[0].parentElement).toHaveTextContent(/×2 · 13[,.]00/);
    expect(screen.getByText('Τα ποσά των παραγγελιών από άγνωστες πηγές περιλαμβάνονται στα παραπάνω σύνολα.')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(source);
    const sourceIds = () => warn.mock.calls
      .filter(([message]) => message === '[ZReportModal] Unclassified order source in Review:')
      .map(([, id]) => id);
    // Logged from an effect, like the unknown reason codes above: an expected
    // log is waited for; a read that expects no new log is asserted once.
    await waitFor(() => expect(sourceIds()).toEqual([source, otherSource]));

    const refresh = async (...nextSources: string[]) => {
      mock.generateZReport.mockResolvedValue(reportWithSources(...nextSources));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.refresh') })); });
    };
    await refresh(source, otherSource);
    expect(sourceIds()).toEqual([source, otherSource]);
    await refresh(newSource, otherSource);
    await waitFor(() => expect(sourceIds()).toEqual([source, otherSource, newSource]));
    await refresh(otherSource);
    expect(await screen.findByText('Άγνωστη πηγή παραγγελίας')).toBeInTheDocument();
    expect(sourceIds()).toEqual([source, otherSource, newSource]);
    await refresh(newSource, otherSource);
    await waitFor(() => expect(sourceIds()).toEqual([source, otherSource, newSource, newSource]));
  });

  it('localizes and logs both the failed automatic reload after recording and the failed manual refresh', async () => {
    const reloadFailure = new Error('SQLITE_BUSY: raw automated reload failure');
    const retryFailure = new Error('SQLITE_BUSY: raw manual refresh failure');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    mock.resolvePaymentBlocker.mockImplementationOnce(async () => {
      mock.generateZReport.mockRejectedValueOnce(reloadFailure);
      return { success: true, charged: false, remainingBlockers: [] };
    });
    const i18n = await renderModal('el');
    await confirmRecordCash(i18n);

    expect(await screen.findByText('Η αναφορά δεν ανανεώθηκε. Πατήστε «Ανανέωση αναφοράς».')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(reloadFailure.message);
    expect(warn).toHaveBeenCalledWith('[ZReportModal] Report refresh after recording payment failed:', reloadFailure);

    mock.generateZReport.mockRejectedValueOnce(retryFailure);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.refresh') }));

    expect(await screen.findByText('Η αναφορά δεν φορτώθηκε. Πατήστε «Ανανέωση αναφοράς».')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(reloadFailure.message);
    expect(document.body).not.toHaveTextContent(retryFailure.message);
    expect(warn).toHaveBeenCalledWith('[ZReportModal] Report load failed:', retryFailure);
    expect(mock.resolvePaymentBlocker).toHaveBeenCalledOnce();
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

  it.each([
    { code: 'AUTH_SHIFT_REQUIRED' },
    { code: 'UNAUTHORIZED', reason: 'Active cashier or manager shift required on this terminal' },
  ])('explains $code when no cashier or manager is checked in', async refusal => {
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    mock.resolvePaymentBlocker.mockRejectedValueOnce({ ...refusal, scope: 'cash_drawer_control' });
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

  it.each([
    {
      name: 'a refusal without blockers',
      respond: () => mock.resolvePaymentBlocker.mockResolvedValueOnce({
        success: false, errorCode: 'UNSETTLED_PAYMENT_BLOCKER', error: 'raw record refusal',
      }),
      expected: 'Η πληρωμή δεν καταγράφηκε. Πατήστε ξανά «Καταγραφή πληρωμής μετρητών».',
      raw: 'raw record refusal',
    },
    {
      name: 'STORE_CURRENCY_UNAVAILABLE',
      respond: () => mock.resolvePaymentBlocker.mockResolvedValueOnce({
        success: false, error: 'STORE_CURRENCY_UNAVAILABLE', blockers: [unrecordedFinding()],
      }),
      expected: 'Η πληρωμή δεν καταγράφηκε. Ζητήστε από τον υπεύθυνο να ελέγξει τη χώρα του καταστήματος.',
      raw: 'STORE_CURRENCY_UNAVAILABLE',
    },
    {
      name: 'missing original currency',
      respond: () => mock.resolvePaymentBlocker.mockRejectedValueOnce('ORIGINAL_CURRENCY_UNAVAILABLE'),
      expected: 'Δεν έχει αποθηκευτεί το αρχικό νόμισμα αυτής της παραγγελίας. Η αλλαγή χώρας δεν τη διορθώνει. Η υποστήριξη πρέπει να ελέγξει την αρχική απόδειξη πριν καταγραφεί πληρωμή.',
      raw: 'ORIGINAL_CURRENCY_UNAVAILABLE',
    },
    {
      name: 'an order that was not found',
      respond: () => mock.resolvePaymentBlocker.mockRejectedValueOnce('Order not found'),
      expected: 'Η πληρωμή δεν καταγράφηκε. Πατήστε «Ανανέωση αναφοράς».',
      raw: 'Order not found',
    },
    ...[
      { error: 'This order no longer has a payment blocker.', blockers: [] },
      { error: 'This order no longer has a collectible outstanding balance.', blockers: [unrecordedFinding()] },
      { error: 'The outstanding balance changed since it was confirmed.', blockers: [unrecordedFinding()] },
    ].map(({ error, blockers }) => ({
      name: `${error} (${blockers.length ? 'with the same blocker' : 'without blockers'})`,
      respond: () => mock.resolvePaymentBlocker.mockResolvedValueOnce({
        success: false, errorCode: 'UNSETTLED_PAYMENT_BLOCKER', blockers,
        error: `${error} Refresh the payment blockers and try again.`,
      }),
      expected: 'Η πληρωμή δεν καταγράφηκε. Πατήστε «Ανανέωση αναφοράς».',
      raw: error,
    })),
    {
      name: 'an unknown failure',
      respond: () => mock.resolvePaymentBlocker.mockRejectedValueOnce(new Error('SQLITE_BUSY: raw write error')),
      expected: 'Η πληρωμή δεν καταγράφηκε. Πατήστε ξανά «Καταγραφή πληρωμής μετρητών».',
      raw: 'SQLITE_BUSY',
    },
  ])('shows Greek feedback for $name', async ({ respond, expected, raw }) => {
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    respond();
    const i18n = await renderModal('el');
    await confirmRecordCash(i18n);

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(raw);
    expect(mock.resolvePaymentBlocker).toHaveBeenCalledOnce();
  });

  it.each([
    { code: 'ORDER_CURRENCY_UNAVAILABLE', reply: 'rejection' },
    { code: 'PAYMENT_CURRENCY_UNAVAILABLE', reply: 'rejection' },
    { code: 'ORDER_CURRENCY_UNAVAILABLE', reply: 'refusal' },
  ])('shows the historical currency message for $code ($reply)', async ({ code, reply }) => {
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    if (reply === 'refusal') {
      mock.resolvePaymentBlocker.mockResolvedValueOnce({ success: false, error: code });
    } else {
      mock.resolvePaymentBlocker.mockRejectedValueOnce(code);
    }
    const i18n = await renderModal('el');
    await confirmRecordCash(i18n);

    expect(await screen.findByText(i18n.t('modals.zReport.recordPaymentOriginalCurrencyMissing'))).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(code);
    expect(mock.resolvePaymentBlocker).toHaveBeenCalledOnce();
  });

  it('names the card record button after a generic card failure', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([{ ...unrecordedFinding(), paymentMethod: 'card' }]));
    mock.resolvePaymentBlocker.mockRejectedValueOnce(new Error('raw card record error'));
    const i18n = await renderModal('el');
    fireEvent.click(await screen.findByRole('button', { name: /Καταγραφή πληρωμής κάρτας/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('modals.zReport.recordConfirmAction') }));
    });

    expect(await screen.findByText('Η πληρωμή δεν καταγράφηκε. Πατήστε ξανά «Καταγραφή πληρωμής κάρτας».')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('raw card record error');
  });

  it('shows the Greek expired sign-in message when the write is rejected after PIN approval', async () => {
    mock.generateZReport.mockResolvedValue(reportWith([unrecordedFinding()]));
    mock.resolvePaymentBlocker
      .mockRejectedValueOnce({ code: 'REAUTH_REQUIRED', reason: 'Fresh PIN confirmation required' })
      .mockRejectedValueOnce({ code: 'AUTH_SESSION_EXPIRED', reason: 'raw expired session' });
    mock.confirmPrivilegedAction.mockResolvedValue({ success: true });
    const i18n = await renderModal('el');
    await confirmRecordCash(i18n);
    await screen.findByText(i18n.t('modals.zReport.recordApprovalTitle'));
    for (const digit of '123456') fireEvent.click(screen.getByRole('button', { name: digit }));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.actions.confirm') }));

    expect(await screen.findByText('Η σύνδεση του ταμείου έληξε. Πληκτρολογήστε ξανά το PIN του ταμείου.')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('raw expired session');
    expect(mock.resolvePaymentBlocker).toHaveBeenCalledTimes(2);
  });

  it('asks staff to refresh the report when the refusal returns blockers for another order', async () => {
    const otherOrder = { ...unrecordedFinding(), orderId: 'order-2', orderNumber: 'A-0121' };
    mock.generateZReport
      .mockResolvedValueOnce(reportWith([unrecordedFinding()]))
      .mockResolvedValue(reportWith([otherOrder]));
    mock.resolvePaymentBlocker.mockResolvedValueOnce({
      success: false, errorCode: 'UNSETTLED_PAYMENT_BLOCKER', error: 'raw changed list', blockers: [otherOrder],
    });
    const i18n = await renderModal('el');
    await confirmRecordCash(i18n);

    expect(await screen.findByText('Η πληρωμή δεν καταγράφηκε. Πατήστε «Ανανέωση αναφοράς».')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('raw changed list');
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
