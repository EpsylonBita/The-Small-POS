import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ZReportModal from '../ZReportModal';
import { formatCurrency } from '../../../utils/format';

// Founder rule 13/10/2026: phones always hand over to the Main. The Z cannot
// run while any phone shift of the unit is still open, and it names them; a
// phone shift check that fails is never read as "no phone shifts". The Z
// window asks the server (`bridge.shifts.unitReadiness`), the native Z stage
// refuses with Z_REPORT_UNIT_SHIFTS_OPEN / _UNAVAILABLE, and the Staff tab
// lists the phone staff with their handover.

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  // Stable `t`: returns the English default (interpolated like i18next), else the key.
  const translate = (key: string, fallbackOrOptions?: unknown): string => {
    const options = fallbackOrOptions && typeof fallbackOrOptions === 'object'
      ? (fallbackOrOptions as Record<string, unknown>)
      : {};
    const template = typeof fallbackOrOptions === 'string'
      ? fallbackOrOptions
      : typeof options.defaultValue === 'string'
        ? options.defaultValue
        : key;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ''));
  };
  const features = {
    isFeatureEnabled: () => true,
    isMainTerminal: true,
    isMobileWaiter: false,
    loading: false,
    parentTerminalId: null as string | null,
  };
  return {
    listeners,
    translate,
    features,
    bridge: {
      reports: {
        generateZReport: vi.fn(),
        printZReport: vi.fn(),
        submitZReport: vi.fn(),
        resolvePaymentBlocker: vi.fn(),
      },
      shifts: { unitReadiness: vi.fn() },
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
vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => ({ clearShift: mocks.clearShift }),
}));
vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light', theme: 'light' }),
}));
vi.mock('../../../hooks/useFeatures', () => ({
  useFeatures: () => mocks.features,
}));
vi.mock('../../../services/SyncQueueBridge', () => ({
  getSyncQueueBridge: () => ({ retryModule: vi.fn(), processQueue: vi.fn() }),
}));
vi.mock('../../../utils/session-utils', () => ({
  clearBusinessDayStorage: vi.fn(),
}));
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ children, header, isOpen }: any) =>
    isOpen ? (
      <div>
        {header}
        {children}
      </div>
    ) : null,
}));
// This terminal's id keys the read it remembers (review 14/10/2026).
vi.mock('../../../services/terminal-credentials', async (original) => ({
  ...(await original<typeof import('../../../services/terminal-credentials')>()),
  getCachedTerminalCredentials: () => ({ terminalId: 'main-1', apiKey: '', organizationId: 'org-1', branchId: 'branch-1' }),
}));
vi.mock('../../ui/UnsettledPaymentBlockersPanel', () => ({
  UnsettledPaymentBlockersPanel: () => <div data-testid="payment-blockers" />,
  isNewOrderCheckoutBlocker: () => false,
}));

const PERIOD_START = '2026-10-14T06:00:00.000Z';
const TODAY = new Date().toISOString().slice(0, 10);

// A live preview ends at its build moment ("now").
function liveReport(overrides: Record<string, unknown> = {}) {
  return {
    date: TODAY,
    currency: 'EUR',
    terminalName: 'Main POS',
    periodStart: PERIOD_START,
    periodEnd: new Date().toISOString(),
    shifts: { total: 0, cashier: 0, driver: 0 },
    sales: { totalOrders: 4, totalSales: 120, cashSales: 40, cardSales: 80 },
    cashDrawer: {
      totalVariance: 0,
      totalCashDrops: 0,
      unreconciledCount: 0,
      openingTotal: 100,
      driverCashGiven: 0,
      driverCashReturned: 0,
    },
    expenses: { total: 0, staffPaymentsTotal: 0, pendingCount: 0, items: [] },
    driverEarnings: { totalDeliveries: 0, totalEarnings: 0, unsettledCount: 0 },
    staffReports: [],
    daySummary: { total: 120 },
    ...overrides,
  };
}

const openShift = (overrides: Record<string, unknown> = {}) => ({
  id: 'shift-maria',
  staff_id: 'staff-maria',
  staff_name: 'Maria',
  role_type: 'waiter',
  terminal_id: 'phone-1',
  terminal_name: 'Phone 1',
  terminal_active: true,
  check_in_time: '2026-10-14T16:02:00.000Z',
  currency: 'EUR',
  opening_cash_amount: 0,
  ...overrides,
});

const closedShift = (overrides: Record<string, unknown> = {}) => ({
  ...openShift(),
  status: 'closed',
  check_out_time: '2026-10-14T22:10:00.000Z',
  closing_cash_amount: 42.5,
  expected_cash_amount: 42.5,
  cash_variance: 0,
  total_orders_count: 7,
  total_sales_amount: 96.4,
  total_cash_sales: 42.5,
  total_card_sales: 53.9,
  handover: 'received',
  closed_by: 'main',
  received_at: '2026-10-14T22:12:00.000Z',
  receivable: false,
  ...overrides,
});

// The native admin bridge's envelope around the readiness body.
const phoneTerminal = { terminal_id: 'phone-1', name: 'Phone 1', is_active: true, terminal_type: 'mobile_waiter' };
const kioskTerminal = { terminal_id: 'kiosk-1', name: 'Kiosk', is_active: true, terminal_type: 'kiosk' };

const readiness = (body: { open?: unknown[]; closed?: unknown[]; pending?: unknown[]; terminals?: unknown[] } = {}) => ({
  success: true,
  status: 200,
  data: {
    success: true,
    main_terminal_id: 'main-1',
    checked_at: '2026-10-14T22:30:00.000Z',
    since: PERIOD_START,
    open_shifts: body.open ?? [],
    closed_shifts: body.closed ?? [],
    pending_returns: body.pending ?? [],
    terminals: body.terminals ?? [],
  },
});

const serveReport = (report: unknown) => {
  mocks.bridge.reports.generateZReport.mockResolvedValue({ success: true, data: report });
};

const renderModal = (props: Partial<React.ComponentProps<typeof ZReportModal>> = {}) =>
  render(<ZReportModal isOpen onClose={vi.fn()} branchId="branch-1" {...props} />);
const commitButton = () =>
  screen.getByRole('button', { name: 'modals.zReport.commitZReport' }) as HTMLButtonElement;
const phoneShiftLines = () =>
  Array.from(document.querySelectorAll('[data-z-report-checklist-details="phone-shifts"] li'))
    .map((line) => line.textContent ?? '');
const openStaffTab = () =>
  fireEvent.click(screen.getByRole('button', { name: /^modals\.zReport\.staff(\s*\d+)?$/ }));

beforeEach(() => {
  localStorage.clear();
  mocks.listeners.clear();
  mocks.features.isMainTerminal = true;
  mocks.features.isMobileWaiter = false;
  mocks.features.isFeatureEnabled = () => true;
  mocks.bridge.reports.generateZReport.mockReset();
  mocks.bridge.reports.submitZReport.mockReset();
  mocks.bridge.shifts.unitReadiness.mockReset().mockResolvedValue(readiness());
});

afterEach(() => {
  cleanup();
});

describe('ZReportModal phone shifts', () => {
  it('names every open phone shift and holds the commit', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({
      open: [
        openShift(),
        openShift({
          id: 'shift-nikos',
          staff_name: 'Nikos',
          role_type: 'driver',
          terminal_id: 'phone-2',
          terminal_name: 'Phone 2',
          terminal_active: false,
        }),
      ],
    }));
    renderModal();

    await waitFor(() => expect(phoneShiftLines()).toHaveLength(2));
    // The window's POS day start is the readiness `since`.
    expect(mocks.bridge.shifts.unitReadiness).toHaveBeenCalledWith(PERIOD_START);
    const [maria, nikos] = phoneShiftLines();
    expect(maria).toContain('Maria');
    expect(maria).toContain('Phone 1');
    expect(maria).toContain('checked in');
    expect(nikos).toContain('Nikos');
    expect(nikos).toContain('Phone 2 (phone deactivated)');
    // The row, and the verdict's subtitle while it is the first thing to fix.
    expect(screen.getAllByText('2 phone shift(s) still open. The day cannot close until each one is closed.').length).toBeGreaterThan(0);
    expect(screen.getByText('Close it on the phone, or from Staff on this register')).toBeTruthy();
    expect(commitButton().disabled).toBe(true);
    expect(screen.queryByText('modals.zReport.readyToClose')).toBeNull();
  });

  it('opens the commit once the phone shifts are closed (shift-updated re-reads them)', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({ open: [openShift()] }));
    renderModal();
    await waitFor(() => expect(phoneShiftLines()).toHaveLength(1));
    expect(commitButton().disabled).toBe(true);

    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness());
    await act(async () => {
      mocks.listeners.get('shift-updated')?.forEach((handler) => handler());
    });
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    expect(phoneShiftLines()).toHaveLength(0);
  });

  it('shows the row as checking, never ready, while the first read is in flight', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockReturnValue(new Promise(() => undefined));
    renderModal();

    expect((await screen.findAllByText('Checking the phone shifts…')).length).toBeGreaterThan(0);
    expect(commitButton().disabled).toBe(true);
    expect(screen.queryByText('modals.zReport.readyToClose')).toBeNull();
  });

  it('blocks on a failed read with a retry, and never reads it as "no phone shifts"', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue({
      success: false,
      status: 503,
      code: 'UNIT_READINESS_UNAVAILABLE',
      error: 'Unit readiness unavailable',
    });
    renderModal();

    const unavailable = 'Phone shifts could not be checked. Check the connection and try again.';
    expect((await screen.findAllByText(unavailable)).length).toBeGreaterThan(0);
    expect(commitButton().disabled).toBe(true);
    expect(screen.queryByText('modals.zReport.readyToClose')).toBeNull();
    expect(screen.queryByText('No phone shift is open.')).toBeNull();

    // A thrown bridge error is unavailable too.
    mocks.bridge.shifts.unitReadiness.mockRejectedValueOnce(new Error('network down'));
    const retry = document.querySelector<HTMLButtonElement>('[data-z-report-phone-shifts-retry]');
    expect(retry?.textContent).toContain('Retry');
    await act(async () => { fireEvent.click(retry as HTMLButtonElement); });
    await waitFor(() => expect(mocks.bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText(unavailable).length).toBeGreaterThan(0);
    expect(commitButton().disabled).toBe(true);

    // The server answers again: the latest read decides.
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness());
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-z-report-phone-shifts-retry]') as HTMLButtonElement);
    });
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    expect(screen.queryByText(unavailable)).toBeNull();
  });

  it('shows no phone row when the server has no readiness or this till is not a Main', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue({ success: false, status: 404, error: 'Not found' });
    renderModal();

    await waitFor(() => expect(mocks.bridge.shifts.unitReadiness).toHaveBeenCalled());
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    expect(screen.queryByText('Phone shifts')).toBeNull();
    expect(screen.queryByText('Checking the phone shifts…')).toBeNull();
    expect(screen.getAllByText('modals.zReport.readyToClose').length).toBeGreaterThan(0);

    cleanup();
    mocks.bridge.shifts.unitReadiness.mockResolvedValue({
      success: false,
      status: 403,
      code: 'UNIT_READINESS_MAIN_ONLY',
      error: 'Main only',
    });
    renderModal();
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    expect(screen.queryByText('Phone shifts')).toBeNull();
  });

  it('never reads phone shifts on a till that cannot run the Z', async () => {
    mocks.features.isMainTerminal = false;
    mocks.features.isMobileWaiter = true;
    mocks.features.isFeatureEnabled = () => false;
    serveReport(liveReport());
    renderModal();

    await waitFor(() => expect(mocks.bridge.reports.generateZReport).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText('Z-Report can only be executed from Main POS terminal').length).toBeGreaterThan(0));
    expect(mocks.bridge.shifts.unitReadiness).not.toHaveBeenCalled();
    expect(screen.queryByText('Phone shifts')).toBeNull();
  });

  it('still checks a hand-picked date that native answers with the current window (no stored Z)', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({ open: [openShift()] }));
    renderModal();
    await waitFor(() => expect(phoneShiftLines()).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('modals.zReport.selectBusinessDay'), { target: { value: '2020-01-01' } });
    await waitFor(() => expect(mocks.bridge.reports.generateZReport).toHaveBeenLastCalledWith({
      branchId: 'branch-1',
      date: '2020-01-01',
    }));
    await waitFor(() => expect(phoneShiftLines()).toHaveLength(1));
    expect(commitButton().disabled).toBe(true);
  });

  it('lists cash still to receive from closed phone tills as a warning, not a blocker', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({
      pending: [
        closedShift({ handover: 'pending', closed_by: 'phone', received_at: null, receivable: true }),
        closedShift({
          id: 'shift-eli',
          staff_name: 'Eli',
          terminal_name: 'Phone 3',
          terminal_active: null,
          currency: 'CHF',
          closing_cash_amount: 0,
          opening_cash_amount: 20,
          handover: 'pending',
        }),
      ],
    }));
    renderModal();

    expect(await screen.findByText('Phone cash to receive')).toBeTruthy();
    const lines = Array.from(document.querySelectorAll('[data-z-report-checklist-details="phone-returns"] li'))
      .map((line) => line.textContent ?? '');
    expect(lines).toEqual([
      `Maria · Phone 1 · to receive ${formatCurrency(42.5, 'EUR')}`,
      // Founder decision 15/10/2026: the Main receives exactly the till's
      // count, a count of 0 with a float included, in the till's own currency.
      `Eli · Phone 3 (phone removed) · to receive ${formatCurrency(0, 'CHF')}`,
    ]);
    expect(screen.getAllByText(/stays listed, also the next day/).length).toBeGreaterThan(0);
    // Non-blocking: the Z can still be committed.
    await waitFor(() => expect(commitButton().disabled).toBe(false));
  });

  it('names the shifts of a native Z refusal in the store language and holds the commit', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness
      .mockResolvedValueOnce(readiness())
      .mockResolvedValue(readiness({ open: [openShift()] }));
    const englishServerText = 'Close the phone shifts before the Z: Maria (waiter, Phone 1)';
    mocks.bridge.reports.submitZReport.mockResolvedValue({
      success: false,
      errorCode: 'Z_REPORT_UNIT_SHIFTS_OPEN',
      stage: 'unit_shifts',
      error: englishServerText,
      openShifts: [openShift()],
    });
    renderModal();

    await waitFor(() => expect(commitButton().disabled).toBe(false));
    await act(async () => { fireEvent.click(commitButton()); });

    const message = await screen.findByText((content) =>
      content.startsWith('The day was not closed: phone shifts are still open:'));
    expect(message.textContent).toContain('Maria');
    expect(message.textContent).toContain('Phone 1');
    expect(message.textContent).not.toContain(englishServerText);
    expect(screen.queryByText(englishServerText)).toBeNull();
    // Re-read, and held on the named shift.
    await waitFor(() => expect(mocks.bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(phoneShiftLines()).toHaveLength(1));
    expect(commitButton().disabled).toBe(true);
    expect(mocks.clearShift).not.toHaveBeenCalled();
  });

  it('maps an unavailable phone shift check thrown by the native Z to its own message', async () => {
    serveReport(liveReport());
    // A unit with a phone: a failed check holds the commit (review 14/10/2026:
    // only a quiet unit without phones stays quiet).
    mocks.bridge.shifts.unitReadiness
      .mockResolvedValueOnce(readiness({ terminals: [phoneTerminal] }))
      .mockResolvedValue({ success: false, status: 503, code: 'UNIT_READINESS_UNAVAILABLE', error: 'down' });
    mocks.bridge.reports.submitZReport.mockRejectedValue(new Error(JSON.stringify({
      success: false,
      errorCode: 'Z_REPORT_UNIT_SHIFTS_UNAVAILABLE',
      stage: 'unit_shifts',
      error: 'Phone shifts could not be read (HTTP 503)',
    })));
    renderModal();

    await waitFor(() => expect(commitButton().disabled).toBe(false));
    await act(async () => { fireEvent.click(commitButton()); });

    expect(await screen.findByText(
      'The day was not closed: the phone shifts could not be checked. Check the connection and try again.',
    )).toBeTruthy();
    expect(screen.queryByText(/HTTP 503/)).toBeNull();
    await waitFor(() => expect(mocks.bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2));
    expect(commitButton().disabled).toBe(true);
  });

  it('treats a preview that ended well before it arrived as a frozen window, and a live one as open-ended', async () => {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const lateCheckIn = new Date(cutoff.getTime() + 10 * 60 * 1000).toISOString();
    serveReport(liveReport({ periodEnd: cutoff.toISOString() }));
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({
      open: [openShift({ id: 'shift-late', staff_name: 'Dora', check_in_time: lateCheckIn })],
    }));
    renderModal();
    await waitFor(() => expect(mocks.bridge.shifts.unitReadiness).toHaveBeenCalled());
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    expect(phoneShiftLines()).toHaveLength(0);

    // A live preview ends now: every open phone shift holds it, whenever it checked in.
    cleanup();
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({
      open: [openShift({ id: 'shift-late', staff_name: 'Dora', check_in_time: new Date(Date.now() + 5_000).toISOString() })],
    }));
    renderModal();
    await waitFor(() => expect(phoneShiftLines()).toHaveLength(1));
    expect(commitButton().disabled).toBe(true);
  });

  it('counts only phone shifts that checked in by the cutoff of a frozen (pending) Z window', async () => {
    serveReport(liveReport({
      date: '2026-10-14',
      periodEnd: '2026-10-14T23:00:00.000Z',
    }));
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({
      open: [
        openShift({ id: 'shift-next-day', staff_name: 'Dora', check_in_time: '2026-10-15T07:00:00.000Z' }),
      ],
    }));
    renderModal({ date: '2026-10-14', lockDate: true });

    await waitFor(() => expect(mocks.bridge.shifts.unitReadiness).toHaveBeenCalled());
    // Dora's shift belongs to the next POS day: it does not hold this Z.
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    expect(phoneShiftLines()).toHaveLength(0);

    cleanup();
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({
      open: [
        openShift({ id: 'shift-next-day', staff_name: 'Dora', check_in_time: '2026-10-15T07:00:00.000Z' }),
        openShift(),
        // An unreadable check-in holds the Z.
        openShift({ id: 'shift-unknown', staff_name: 'Kostas', check_in_time: null }),
      ],
    }));
    renderModal({ date: '2026-10-14', lockDate: true });
    await waitFor(() => expect(phoneShiftLines()).toHaveLength(2));
    expect(phoneShiftLines().join('\n')).not.toContain('Dora');
    expect(commitButton().disabled).toBe(true);
  });

  it('lists the phone staff of the live window with their handover in the Staff tab', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({
      closed: [
        closedShift(),
        closedShift({
          id: 'shift-nikos',
          staff_name: 'Nikos',
          role_type: 'server',
          terminal_name: 'Phone 2',
          handover: 'pending',
          closing_cash_amount: 18,
          total_orders_count: 3,
        }),
      ],
    }));
    renderModal();
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    openStaffTab();

    const group = document.querySelector<HTMLElement>('[data-z-report-phone-shifts-staff]');
    expect(group).not.toBeNull();
    const scope = within(group as HTMLElement);
    expect(scope.getByText('Phone shifts')).toBeTruthy();
    const maria = group?.querySelector<HTMLElement>('[data-z-report-phone-shift="shift-maria"]') as HTMLElement;
    expect(within(maria).getByText('Maria')).toBeTruthy();
    expect(within(maria).getByText('Received')).toBeTruthy();
    expect(within(maria).getByText('7')).toBeTruthy();
    expect(within(maria).getByText(formatCurrency(96.4, 'EUR'))).toBeTruthy();
    expect(within(maria).getAllByText(formatCurrency(42.5, 'EUR')).length).toBe(2);
    expect(within(maria).getByText(formatCurrency(53.9, 'EUR'))).toBeTruthy();
    const nikos = group?.querySelector<HTMLElement>('[data-z-report-phone-shift="shift-nikos"]') as HTMLElement;
    expect(within(nikos).getByText('To receive')).toBeTruthy();
    expect(within(nikos).getByText(formatCurrency(18, 'EUR'))).toBeTruthy();
  });

  it('lists a stored Z\'s phone shifts without reading the server', async () => {
    serveReport(liveReport({
      date: '2026-10-13',
      zReportId: 'zr-stored-1',
      periodEnd: '2026-10-13T23:00:00.000Z',
      phoneShifts: [
        {
          staffShiftId: 'shift-maria',
          staffId: 'staff-maria',
          staffName: 'Maria',
          role: 'waiter',
          terminalId: 'phone-1',
          terminalName: 'Phone 1',
          terminalActive: false,
          checkIn: '2026-10-13T16:00:00.000Z',
          checkOut: '2026-10-13T22:00:00.000Z',
          status: 'closed',
          currency: 'EUR',
          ordersCount: 5,
          salesTotal: 70,
          salesTotal_cents: 7000,
          cashSales: 30,
          cashSales_cents: 3000,
          cardSales: 40,
          cardSales_cents: 4000,
          countedCash: 99,
          // The cents twin is authoritative.
          countedCash_cents: 3050,
          handover: 'none',
          closedBy: 'phone',
          receivedAt: null,
        },
        {
          staffShiftId: 'shift-old',
          staffName: 'Old Till',
          role: 'driver',
          terminalName: 'Phone 9',
          status: 'abandoned',
          ordersCount: null,
          salesTotal: null,
          handover: 'not_counted',
        },
      ],
    }));
    renderModal();
    await waitFor(() => expect(mocks.bridge.reports.generateZReport).toHaveBeenCalled());
    openStaffTab();

    const group = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-z-report-phone-shifts-staff]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const maria = group.querySelector<HTMLElement>('[data-z-report-phone-shift="shift-maria"]') as HTMLElement;
    expect(within(maria).getByText('Nothing to hand over')).toBeTruthy();
    expect(within(maria).getByText(/Phone 1 \(phone deactivated\)/)).toBeTruthy();
    expect(within(maria).getByText(formatCurrency(30.5, 'EUR'))).toBeTruthy();
    const old = group.querySelector<HTMLElement>('[data-z-report-phone-shift="shift-old"]') as HTMLElement;
    expect(within(old).getByText('Not counted')).toBeTruthy();
    expect(within(old).getAllByText('—').length).toBeGreaterThan(0);
    expect(mocks.bridge.shifts.unitReadiness).not.toHaveBeenCalled();
    expect(screen.queryByText('Checking the phone shifts…')).toBeNull();
  });
});

describe('ZReportModal phone shifts, review 14/10/2026', () => {
  const unavailable = 'Phone shifts could not be checked. Check the connection and try again.';
  const offline = { success: false, error: 'Cannot reach admin dashboard' };

  it('shows no phone row for a unit without phones (a kiosk is not one) with nothing open or pending', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [kioskTerminal] }));
    renderModal();
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    expect(screen.queryByText('No phone shift is open.')).toBeNull();
    expect(screen.queryByText('Phone shifts')).toBeNull();
  });

  it('a failed read hides nothing for a unit that has phones, and stays quiet for one without', async () => {
    serveReport(liveReport());
    // Last good read: no phones, nothing open or pending.
    mocks.bridge.shifts.unitReadiness.mockResolvedValueOnce(readiness({ terminals: [kioskTerminal] }));
    const first = renderModal();
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    first.unmount();

    mocks.bridge.shifts.unitReadiness.mockResolvedValue(offline);
    const quiet = renderModal();
    await waitFor(() => expect(mocks.bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    expect(screen.queryByText(unavailable)).toBeNull();
    quiet.unmount();

    // The last good read had a phone: the failed read blocks as before.
    localStorage.clear();
    mocks.bridge.shifts.unitReadiness.mockResolvedValueOnce(readiness({ terminals: [phoneTerminal] }));
    const withPhone = renderModal();
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    withPhone.unmount();
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(offline);
    renderModal();
    expect((await screen.findAllByText(unavailable)).length).toBeGreaterThan(0);
    expect(commitButton().disabled).toBe(true);
  });

  it('lists a till received in this window even though it closed before, and not one that did neither', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({
      terminals: [phoneTerminal],
      closed: [
        // Closed yesterday, received this morning: today's Z shows it handed over.
        closedShift({ id: 'shift-received-today', staff_name: 'Nikos', check_out_time: '2026-10-13T22:00:00.000Z',
          handover: 'received', closed_by: 'main', received_at: '2026-10-14T09:15:00.000Z' }),
        // Closed today, not received yet: today's Z shows it to receive.
        closedShift({ id: 'shift-closed-today', staff_name: 'Eleni', handover: 'pending', received_at: null }),
        // Closed and received before this window (a server answer that still carries it).
        closedShift({ id: 'shift-old', staff_name: 'Old', check_out_time: '2026-10-13T20:00:00.000Z',
          handover: 'received', received_at: '2026-10-13T21:00:00.000Z' }),
      ],
    }));
    renderModal();
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    openStaffTab();
    const group = document.querySelector<HTMLElement>('[data-z-report-phone-shifts-staff]') as HTMLElement;
    const card = (id: string) => group.querySelector<HTMLElement>(`[data-z-report-phone-shift="${id}"]`);
    expect(within(card('shift-received-today') as HTMLElement).getByText('Received')).toBeTruthy();
    expect(within(card('shift-closed-today') as HTMLElement).getByText('To receive')).toBeTruthy();
    expect(card('shift-old')).toBeNull();
  });

  it('shows each phone till\'s variance in the Staff tab, signed', async () => {
    serveReport(liveReport());
    mocks.bridge.shifts.unitReadiness.mockResolvedValue(readiness({
      terminals: [phoneTerminal],
      closed: [
        closedShift({ cash_variance: -2.5, closing_cash_amount: 40, expected_cash_amount: 42.5 }),
        closedShift({ id: 'shift-nikos', staff_name: 'Nikos', cash_variance: 1.25 }),
        closedShift({ id: 'shift-eleni', staff_name: 'Eleni', cash_variance: 0 }),
      ],
    }));
    renderModal();
    await waitFor(() => expect(commitButton().disabled).toBe(false));
    openStaffTab();
    const group = document.querySelector<HTMLElement>('[data-z-report-phone-shifts-staff]') as HTMLElement;
    const card = (id: string) => group.querySelector<HTMLElement>(`[data-z-report-phone-shift="${id}"]`) as HTMLElement;
    expect(within(card('shift-maria')).getByText(`-${formatCurrency(2.5, 'EUR')}`)).toBeTruthy();
    expect(within(card('shift-nikos')).getByText(`+${formatCurrency(1.25, 'EUR')}`)).toBeTruthy();
    expect(within(card('shift-eleni')).getAllByText(formatCurrency(0, 'EUR')).length).toBeGreaterThan(0);
  });
});
