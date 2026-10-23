import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Offline week (founder 21/10/2026, Ω3 α): without a connection the Z closes
// the day on this till and its submission is sent once the server is back.
// The modal says so in the store's language instead of the old refusal, and
// ends the day like any other Z (logout, then a restart of the day).

const mock = vi.hoisted(() => {
  const noPhoneShifts = { success: true, open_shifts: [], closed_shifts: [], pending_returns: [], terminals: [] };
  const generateZReport = vi.fn();
  const submitZReport = vi.fn();
  const getNetworkStatus = vi.fn();
  const logout = vi.fn();
  const bridge = {
    reports: {
      generateZReport,
      submitZReport,
      printZReport: vi.fn(),
      resolvePaymentBlocker: vi.fn(),
    },
    sync: { getNetworkStatus },
    shifts: { unitReadiness: vi.fn(async () => ({ success: true, data: noPhoneShifts })) },
    auth: { logout },
  };
  const features = {
    isFeatureEnabled: () => true,
    isMainTerminal: true,
    isMobileWaiter: false,
    loading: false,
    parentTerminalId: null,
  };
  return { bridge, generateZReport, submitZReport, getNetworkStatus, logout, features, clearShift: vi.fn() };
});

vi.mock('../../../../lib', () => ({
  getBridge: () => mock.bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => ({ clearShift: mock.clearShift }),
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
  LiquidGlassModal: ({ children, header, isOpen }: any) =>
    isOpen ? (
      <div>
        {header}
        {children}
      </div>
    ) : null,
}));
vi.mock('../../ui/UnsettledPaymentBlockersPanel', () => ({
  UnsettledPaymentBlockersPanel: () => <div data-testid="payment-blockers" />,
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

const report = {
  success: true,
  data: {
    date: '2026-10-21',
    sales: { totalOrders: 110, totalSales: 1820.5, cashSales: 820.5, cardSales: 1000 },
    cashDrawer: {
      totalVariance: 0,
      totalCashDrops: 0,
      unreconciledCount: 0,
      openingTotal: 150,
      driverCashGiven: 0,
      driverCashReturned: 0,
    },
    expenses: { total: 0, items: [], pendingCount: 0 },
    staffReports: [],
  },
};

// The native answer of a Z closed on this till (`close_prepared_z_report_locally`).
const localClose = {
  success: true,
  localClose: true,
  pendingUpload: true,
  localDayClosed: true,
  zReportId: 'z-local-1',
  reportDate: '2026-10-21',
  syncQueued: true,
  syncState: 'pending',
};

const renderModal = async (lng: Lng) => {
  const i18n = await createI18n(lng);
  render(
    <I18nextProvider i18n={i18n}>
      <ZReportModal isOpen onClose={() => {}} branchId="branch-tomikro" date="2026-10-21" />
    </I18nextProvider>,
  );
  return i18n;
};

describe('ZReportModal: a Z closed on this till without a connection', () => {
  const reload = vi.fn();
  const originalLocation = window.location;

  beforeEach(() => {
    mock.generateZReport.mockReset().mockResolvedValue(report);
    mock.submitZReport.mockReset();
    mock.getNetworkStatus.mockReset().mockResolvedValue({ isOnline: false });
    mock.logout.mockReset();
    reload.mockReset();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it.each(Object.keys(LOCALES) as Lng[])(
    'says in %s that the day closed on this till and will be sent',
    async (lng) => {
      mock.submitZReport.mockResolvedValue(localClose);
      const i18n = await renderModal(lng);

      const commit = screen.getByRole('button', {
        name: i18n.t('modals.zReport.commitZReport'),
      }) as HTMLButtonElement;
      await waitFor(() => expect(commit.disabled).toBe(false));
      await act(async () => {
        fireEvent.click(commit);
      });

      await waitFor(() => expect(mock.submitZReport).toHaveBeenCalled());
      const expected = i18n.t('zReportOffline.localCloseDone', { date: '2026-10-21' });
      expect(expected).toContain('2026-10-21');
      expect(await screen.findByText(expected)).toBeTruthy();
      // Never the refusal of a till that may not close locally.
      expect(screen.queryByText((content) => content.includes(LOCALES[lng].zReportOffline.refusal))).toBeNull();
      // The day ends as after any Z, but the message stays to be read.
      await waitFor(() => expect(mock.logout).toHaveBeenCalled());
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it('keeps the typed refusal when the till may not close locally (active fiscal plugin)', async () => {
    mock.submitZReport.mockResolvedValue({
      success: false,
      errorCode: 'Z_REPORT_OFFLINE',
      stage: 'pre_z_sync',
      localCloseRefused: 'fiscal_plugin_active',
      error: 'No connection to the server: the day cannot be closed now.',
    });
    const i18n = await renderModal('el');
    const commit = screen.getByRole('button', {
      name: i18n.t('modals.zReport.commitZReport'),
    }) as HTMLButtonElement;
    await waitFor(() => expect(commit.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(commit);
    });
    const refusal = LOCALES.el.zReportOffline.refusal;
    expect(await screen.findByText((content) => content.includes(refusal))).toBeTruthy();
    expect(mock.logout).not.toHaveBeenCalled();
  });
});

describe('local close and set-aside strings', () => {
  const Z_GATE_KEYS = [
    'approvalTitle',
    'approvalSubtitle',
    'setAsideDone',
    'undoDone',
    'actionFailed',
    'stale',
    'unavailable',
    'localTitle',
    'localDay',
    'waits.earlier_z',
    'waits.window_rows',
    'waits.server_refusal',
    'waits.sending',
    'waits.cleanup',
    'details',
    'refusedTitle',
    'refusedIntro',
    'kind.payment',
    'kind.refund',
    'kind.driverEarning',
    'kind.expense',
    'kind.staffPayment',
    'kind.cashReturn',
    'kind.shift',
    'kind.record',
    'setAsideState',
    'setAside',
    'undo',
  ];
  const read = (bundle: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], bundle);

  it.each(Object.keys(LOCALES) as Lng[])('exist in %s', (lng) => {
    const bundle = LOCALES[lng] as unknown;
    const done = read(bundle, 'zReportOffline.localCloseDone');
    expect(typeof done).toBe('string');
    expect(done as string).toContain('{{date}}');
    for (const key of Z_GATE_KEYS) {
      const value = read(bundle, `sync.zGate.${key}`);
      expect(typeof value, `${lng} sync.zGate.${key}`).toBe('string');
      expect((value as string).trim().length, `${lng} sync.zGate.${key}`).toBeGreaterThan(1);
      if (lng !== 'en' && !['setAside'].includes(key)) {
        // Translated, not the English copy (a few short words may coincide).
        expect(value, `${lng} sync.zGate.${key}`).not.toBe(read(en, `sync.zGate.${key}`));
      }
    }
  });
});
