import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ZReportModal from '../ZReportModal';
import { formatCurrency } from '../../../utils/format';
import { GIFT_CLOSE_LABELS } from '../../../utils/zReport';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  // Stable `t`: the modal's load effect depends on it. Interpolates {{name}} like i18next.
  const translate = (key: string, fallbackOrOptions?: unknown): string => {
    const options = fallbackOrOptions && typeof fallbackOrOptions === 'object'
      ? (fallbackOrOptions as Record<string, unknown>)
      : {};
    const template = typeof fallbackOrOptions === 'string'
      ? fallbackOrOptions
      : typeof options.defaultValue === 'string'
        ? options.defaultValue
        : typeof options.error === 'string'
          ? `${key}: {{error}}`
          : key;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ''));
  };
  return {
    listeners,
    translate,
    bridge: {
      reports: {
        generateZReport: vi.fn(),
        printZReport: vi.fn(),
        submitZReport: vi.fn(),
        resolvePaymentBlocker: vi.fn(),
      },
      auth: { logout: vi.fn(async () => ({ success: true })) },
    },
    clearShift: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate, i18n: { language: 'en', changeLanguage: vi.fn() } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
  Trans: ({ children }: { children?: unknown }) => children,
}));

vi.mock('../../../../lib', () => ({
  getBridge: () => mocks.bridge,
  onEvent: vi.fn((event: string, handler: () => void) => {
    if (!mocks.listeners.has(event)) mocks.listeners.set(event, new Set());
    mocks.listeners.get(event)?.add(handler);
  }),
  offEvent: vi.fn((event: string, handler: () => void) => {
    mocks.listeners.get(event)?.delete(handler);
  }),
}));

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: mocks.translate }),
}));

vi.mock('../../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));

vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => ({ clearShift: mocks.clearShift }),
}));

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light', theme: 'light' }),
}));

vi.mock('../../../hooks/useFeatures', () => ({
  useFeatures: () => ({
    isFeatureEnabled: () => true,
    isMainTerminal: true,
    isMobileWaiter: false,
    loading: false,
    parentTerminalId: null,
  }),
}));

vi.mock('../../../utils/session-utils', () => ({
  clearBusinessDayStorage: vi.fn(),
}));

const HISTORY_DATE = '2020-01-15';
const TODAY = new Date().toISOString().slice(0, 10);

function baseReport(date: string) {
  return {
    date,
    terminalName: 'Main POS',
    shifts: { total: 1, cashier: 1, driver: 0 },
    sales: { totalOrders: 3, totalSales: 500, cashSales: 100, cardSales: 400 },
    // Ordinary flows: opening 23.45 + cash sales 100.00 = 123.45 expected.
    cashDrawer: {
      totalVariance: 0,
      totalCashDrops: 0,
      unreconciledCount: 0,
      openingTotal: 23.45,
      driverCashGiven: 0,
      driverCashReturned: 0,
    },
    expenses: { total: 0, staffPaymentsTotal: 0, pendingCount: 0, items: [] },
    driverEarnings: { totalDeliveries: 0, totalEarnings: 0, unsettledCount: 0 },
    staffReports: [],
    daySummary: { total: 500 },
  };
}

function storedGiftReport(date = HISTORY_DATE) {
  const base = baseReport(date);
  return {
    ...base,
    zReportId: 'zr-stored-1',
    // Native canonical drawer: 12345 ordinary + 2000 gift = 14345 expected; 14000 counted = -345.
    cashDrawer: {
      ...base.cashDrawer,
      totalVariance: -3.45,
      totalVariance_cents: -345,
      expected: 143.45,
      expected_cents: 14345,
      closing: 140,
      closing_cents: 14000,
      ordinaryExpected: 123.45,
      ordinaryExpected_cents: 12345,
      giftLiabilityCash: 20,
      giftLiabilityCash_cents: 2000,
      ordinaryAdjustment: 0,
      ordinaryAdjustment_cents: 0,
    },
    giftFinancialClose: {
      contract: 'gift_close_report_v1',
      ready: true,
      giftLiabilityCash: 20,
      giftLiabilityCash_cents: 2000,
      ordinaryAdjustment: 0,
      ordinaryAdjustment_cents: 0,
      originals: [{
        shiftId: 'shift-1',
        drawerId: 'drawer-1',
        staffId: 'staff-1',
        staffName: 'Maria',
        terminalId: 'terminal-public-1',
        currency: 'EUR',
        ordinaryExpected: 123.45,
        ordinaryExpected_cents: 12345,
        giftLiabilityCash: 20,
        giftLiabilityCash_cents: 2000,
        expected: 143.45,
        expected_cents: 14345,
        counted: 140,
        counted_cents: 14000,
        variance: -3.45,
        variance_cents: -345,
        ordinaryAdjustment_cents: 0,
        drawerVersion: 3,
        provenance: {
          contract: 'gift_closing_v1',
          status: 'confirmed',
          localClosedAt: '2020-01-15T21:00:00Z',
          canonicalClosedAt: '2020-01-15T21:00:02Z',
          confirmedAt: '2020-01-15T21:00:05Z',
          adoptedAt: '2020-01-15T21:01:00Z',
        },
      }],
      blockers: [],
    },
  };
}

function pendingGiftPreview(date: string) {
  return {
    ...baseReport(date),
    giftFinancialClose: {
      contract: 'gift_close_report_v1',
      ready: false,
      giftLiabilityCash: 0,
      giftLiabilityCash_cents: 0,
      ordinaryAdjustment: 0,
      ordinaryAdjustment_cents: 0,
      originals: [],
      blockers: [{
        code: 'GIFT_CLOSE_PROOF_PENDING',
        shiftId: 'shift-1',
        drawerId: 'drawer-1',
        staffId: 'staff-1',
        staffName: 'Maria',
        pendingReason: 'awaiting_canonical_ack',
      }],
    },
  };
}

function serveReports(pick: (date: string) => unknown) {
  mocks.bridge.reports.generateZReport.mockImplementation(async ({ date }: { date?: string }) => ({
    success: true,
    data: pick(date || TODAY),
  }));
}

const renderModal = () => render(<ZReportModal isOpen onClose={vi.fn()} branchId="branch-1" />);
const printButton = () => screen.getByRole('button', { name: 'modals.zReport.print' });
const submitButton = () => screen.getByRole('button', { name: 'modals.zReport.commitZReport' });
const openMoneyTab = () => fireEvent.click(screen.getByRole('button', { name: /^Money(\s*\d+)?$/ }));
const giftSection = () => document.querySelector<HTMLElement>('[data-z-report-gift-close]');
const lastReportDate = () => mocks.bridge.reports.generateZReport.mock.lastCall?.[0]?.date;
const pickBusinessDay = (date: string) =>
  fireEvent.change(screen.getByLabelText('modals.zReport.selectBusinessDay'), { target: { value: date } });
const emit = (event: string) => mocks.listeners.get(event)?.forEach((handler) => handler());
// Matches rendered outside the gift close section, i.e. the modal's own headline/flow figures.
const countOutsideGift = (text: string) =>
  screen.queryAllByText(text).filter((element) => !giftSection()?.contains(element)).length;

beforeEach(() => {
  mocks.listeners.clear();
  mocks.bridge.reports.generateZReport.mockReset();
  mocks.bridge.reports.printZReport.mockReset().mockResolvedValue({ success: true });
  mocks.bridge.reports.submitZReport.mockReset().mockResolvedValue({ success: true, localDayClosed: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ZReportModal gift card close', () => {
  it('shows a stored gift close from frozen figures, once and outside sales, and prints it by stored id', async () => {
    serveReports((date) => (date === HISTORY_DATE ? storedGiftReport() : baseReport(date)));
    renderModal();
    await waitFor(() => expect(mocks.bridge.reports.generateZReport).toHaveBeenCalledTimes(1));

    pickBusinessDay(HISTORY_DATE);
    await waitFor(() => expect(printButton()).toBeEnabled());
    expect(lastReportDate()).toBe(HISTORY_DATE);

    const giftFlowLine = `+${formatCurrency(20)}`;
    const reviewExpected = countOutsideGift(formatCurrency(143.45));
    const reviewGiftLines = screen.queryAllByText(giftFlowLine).length;
    const reviewSales = screen.queryAllByText(formatCurrency(500)).length;
    // Never gift twice in expected (163.45) and never gift inside sales (520).
    expect(screen.queryAllByText(formatCurrency(163.45))).toHaveLength(0);
    expect(screen.queryAllByText(formatCurrency(520))).toHaveLength(0);

    openMoneyTab();
    const gift = giftSection() as HTMLElement;
    expect(gift).toHaveAttribute('data-gift-close-state', 'final');
    expect(within(gift).getByText(GIFT_CLOSE_LABELS.proofFinal)).toBeInTheDocument();
    expect(within(gift).getByText(`${GIFT_CLOSE_LABELS.currency}: EUR`)).toBeInTheDocument();
    for (const amount of [123.45, 20, 143.45, 140, -3.45]) {
      expect(within(gift).getByText(formatCurrency(amount, 'EUR'))).toBeInTheDocument();
    }
    // Headline/flow use the canonical 14345 expected; gift card cash is one flow line; sales stay 500.
    expect(reviewExpected + countOutsideGift(formatCurrency(143.45))).toBeGreaterThan(0);
    expect(reviewGiftLines + screen.queryAllByText(giftFlowLine).length).toBe(1);
    expect(reviewSales + screen.queryAllByText(formatCurrency(500)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(formatCurrency(163.45))).toHaveLength(0);
    expect(screen.queryAllByText(formatCurrency(520))).toHaveLength(0);

    // Frozen history: a live shift update must not refetch or change the stored figures.
    act(() => emit('shift-updated'));
    expect(mocks.bridge.reports.generateZReport).toHaveBeenCalledTimes(2);
    expect(within(giftSection() as HTMLElement).getByText(formatCurrency(143.45, 'EUR'))).toBeInTheDocument();

    fireEvent.click(printButton());
    await waitFor(() => expect(screen.getAllByText('Z-Report print queued').length).toBeGreaterThan(0));
    expect(mocks.bridge.reports.printZReport).toHaveBeenCalledTimes(1);
    const payload = mocks.bridge.reports.printZReport.mock.calls[0][0];
    expect(payload).toMatchObject({ zReportId: 'zr-stored-1' });
    expect(payload).not.toHaveProperty('snapshot');
  });

  it('keeps pending gift proof not final: no final print, no submit, actionable recovery', async () => {
    serveReports((date) => pendingGiftPreview(date));
    renderModal();
    await waitFor(() => expect(printButton()).toHaveAttribute('title', GIFT_CLOSE_LABELS.blocked));

    expect(printButton()).toBeDisabled();
    expect(submitButton()).toBeDisabled();
    fireEvent.click(submitButton());
    fireEvent.click(printButton());
    expect(mocks.bridge.reports.submitZReport).not.toHaveBeenCalled();
    expect(mocks.bridge.reports.printZReport).not.toHaveBeenCalled();

    openMoneyTab();
    const gift = giftSection() as HTMLElement;
    expect(gift).toHaveAttribute('data-gift-close-state', 'blocked');
    expect(within(gift).getByText(GIFT_CLOSE_LABELS.proofNotFinal)).toBeInTheDocument();
    expect(within(gift).getByText(
      GIFT_CLOSE_LABELS.recovery.GIFT_CLOSE_PROOF_PENDING.replace('{{staff}}', 'Maria'),
    )).toBeInTheDocument();
    expect(within(gift).getByText(GIFT_CLOSE_LABELS.blocked)).toBeInTheDocument();
  });

  it('keeps ordinary reports unchanged and a no-id preview unavailable for final print', async () => {
    serveReports((date) => baseReport(date));
    renderModal();
    await waitFor(() => expect(printButton()).toHaveAttribute('title', GIFT_CLOSE_LABELS.finalPrintUnavailable));
    await waitFor(() => expect(submitButton()).toBeEnabled());

    expect(printButton()).toBeDisabled();
    expect(screen.getAllByText(formatCurrency(123.45)).length).toBeGreaterThan(0);
    expect(screen.queryByText(GIFT_CLOSE_LABELS.giftLiabilityCash)).toBeNull();
    expect(screen.getByRole('button', { name: 'modals.zReport.exportCSV' })).toBeEnabled();

    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.bridge.reports.submitZReport)
      .toHaveBeenCalledWith(expect.objectContaining({ branchId: 'branch-1' })));
    expect(mocks.bridge.reports.printZReport).not.toHaveBeenCalled();
  });

  it('prints an ordinary stored report by its stored id without gift rows', async () => {
    serveReports((date) => ({ ...baseReport(date), zReportId: 'zr-ordinary-7' }));
    renderModal();
    await waitFor(() => expect(printButton()).toBeEnabled());

    openMoneyTab();
    expect(giftSection()).toBeNull();
    expect(document.querySelector('[data-z-report-gift-close-term]')).toBeNull();
    expect(screen.queryByText(GIFT_CLOSE_LABELS.giftLiabilityCash)).toBeNull();

    fireEvent.click(printButton());
    await waitFor(() => expect(mocks.bridge.reports.printZReport).toHaveBeenCalledTimes(1));
    expect(mocks.bridge.reports.printZReport.mock.calls[0][0]).toMatchObject({ zReportId: 'zr-ordinary-7' });
    expect(mocks.bridge.reports.printZReport.mock.calls[0][0]).not.toHaveProperty('snapshot');
  });

  it('drops a late print result after the operator switches business day', async () => {
    let resolvePrint: (value: unknown) => void = () => undefined;
    mocks.bridge.reports.printZReport.mockImplementation(() => new Promise((resolve) => {
      resolvePrint = resolve;
    }));
    serveReports((date) => (date === HISTORY_DATE ? baseReport(HISTORY_DATE) : storedGiftReport(date)));
    renderModal();
    await waitFor(() => expect(printButton()).toBeEnabled());

    fireEvent.click(printButton());
    await waitFor(() => expect(mocks.bridge.reports.printZReport).toHaveBeenCalledTimes(1));
    pickBusinessDay(HISTORY_DATE);
    await waitFor(() => expect(lastReportDate()).toBe(HISTORY_DATE));
    await act(async () => {
      resolvePrint({ success: true });
    });

    expect(screen.queryByText('Z-Report print queued')).toBeNull();
  });

  it('keeps the new print busy when the previous open finishes late', async () => {
    const replies: Array<(value: unknown) => void> = [];
    mocks.bridge.reports.printZReport.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
    serveReports((date) => storedGiftReport(date));
    const view = renderModal();
    await waitFor(() => expect(printButton()).toBeEnabled());
    fireEvent.click(printButton());
    await waitFor(() => expect(replies).toHaveLength(1));
    view.rerender(<ZReportModal isOpen={false} onClose={vi.fn()} branchId="branch-1" />);
    view.rerender(<ZReportModal isOpen onClose={vi.fn()} branchId="branch-1" />);
    await waitFor(() => expect(printButton()).toBeEnabled());
    fireEvent.click(printButton());
    await waitFor(() => expect(replies).toHaveLength(2));
    await act(async () => { replies[0]({ success: true }); });
    expect(printButton()).toBeDisabled();
    expect(screen.queryByText('Z-Report print queued')).toBeNull();
    await act(async () => { replies[1]({ success: true }); });
    await waitFor(() => expect(printButton()).toBeEnabled());
  });

  it('uses the original currency for the aggregate gift cash as well as each original', async () => {
    serveReports((date) => {
      const report = storedGiftReport(date);
      report.giftFinancialClose.originals[0].currency = 'USD';
      return report;
    });
    renderModal();
    await waitFor(() => expect(printButton()).toBeEnabled());
    openMoneyTab();
    const term = document.querySelector<HTMLElement>('[data-z-report-gift-close-term]')!;
    expect(within(term).getByText(formatCurrency(20, 'USD'))).toBeInTheDocument();
    expect(within(term).queryByText(formatCurrency(20, 'EUR'))).toBeNull();
    expect(countOutsideGift(formatCurrency(143.45, 'USD'))).toBeGreaterThan(0);
  });

  it('maps a native gift proof refusal on submit to recovery wording', async () => {
    serveReports((date) => baseReport(date));
    mocks.bridge.reports.submitZReport.mockResolvedValue({
      success: false,
      error: 'GIFT_CLOSE_PROOF_REQUIRED: Cannot generate Z-report: 1 gift-bound drawer close(s) lack confirmed canonical proof: shift-1',
    });
    renderModal();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.click(submitButton());
    await waitFor(() => expect(
      screen.getAllByText((content) => content.includes(GIFT_CLOSE_LABELS.errors.proofRequired)).length,
    ).toBeGreaterThan(0));
  });
});
