import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Offline audit 07/10/2026: with no internet the Z checklist still read "No
// sync blocker detected", and the commit answered a Greek cashier with
// «Αποτυχία: Cannot close day: pre-Z-report sync failed: reconcile remote
// orders: Cannot reach admin dashboard at …». The native Z now refuses with
// Z_REPORT_OFFLINE, and the checklist reads the till's own connection.

const mock = vi.hoisted(() => {
  const generateZReport = vi.fn();
  const submitZReport = vi.fn();
  const getNetworkStatus = vi.fn();
  const bridge = {
    reports: {
      generateZReport,
      submitZReport,
      printZReport: vi.fn(),
      resolvePaymentBlocker: vi.fn(),
    },
    sync: { getNetworkStatus },
    auth: { logout: vi.fn() },
  };
  const features = {
    isFeatureEnabled: () => true,
    isMainTerminal: true,
    isMobileWaiter: false,
    loading: false,
    parentTerminalId: null,
  };
  return { bridge, generateZReport, submitZReport, getNetworkStatus, features, clearShift: vi.fn() };
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
    date: '2026-10-07',
    sales: { totalOrders: 12, totalSales: 180.5, cashSales: 80.5, cardSales: 100 },
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

// The native refusal exactly as `report_submit_z_report` answers it offline.
const offlineRefusal = {
  success: false,
  errorCode: 'Z_REPORT_OFFLINE',
  stage: 'pre_z_sync',
  error: 'No connection to the server: the day cannot be closed now. Keep selling; close the day once the connection is back.',
};

const renderModal = async (lng: Lng) => {
  const i18n = await createI18n(lng);
  render(
    <I18nextProvider i18n={i18n}>
      <ZReportModal isOpen onClose={() => {}} branchId="branch-tomikro" date="2026-10-07" />
    </I18nextProvider>,
  );
  return i18n;
};

describe('ZReportModal without a connection', () => {
  beforeEach(() => {
    mock.generateZReport.mockReset().mockResolvedValue(report);
    mock.submitZReport.mockReset();
    mock.getNetworkStatus.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('says in the checklist that the day closes once the connection is back', async () => {
    mock.getNetworkStatus.mockResolvedValue({ isOnline: false });
    const i18n = await renderModal('el');

    expect(await screen.findByText(i18n.t('zReportOffline.checklist'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('modals.zReport.syncReady'))).toBeNull();
    expect(screen.getAllByText(i18n.t('zReportOffline.status')).length).toBeGreaterThan(0);
  });

  it('says nothing about the connection while the till is online', async () => {
    mock.getNetworkStatus.mockResolvedValue({ isOnline: true });
    const i18n = await renderModal('en');

    await waitFor(() => expect(mock.getNetworkStatus).toHaveBeenCalled());
    await waitFor(() => expect(mock.generateZReport).toHaveBeenCalled());
    // A ready check is not listed; the day reads ready to close.
    expect(await screen.findAllByText(i18n.t('modals.zReport.readyToClose'))).not.toHaveLength(0);
    expect(screen.queryByText(i18n.t('zReportOffline.checklist'))).toBeNull();
    expect(screen.queryByText(i18n.t('zReportOffline.status'))).toBeNull();
  });

  it.each(Object.keys(LOCALES) as Lng[])(
    'answers an offline commit in %s with what to do, never the native English',
    async (lng) => {
      mock.getNetworkStatus.mockResolvedValue({ isOnline: true });
      mock.submitZReport.mockResolvedValue(offlineRefusal);
      const i18n = await renderModal(lng);

      const commit = screen.getByRole('button', {
        name: i18n.t('modals.zReport.commitZReport'),
      }) as HTMLButtonElement;
      await waitFor(() => expect(commit.disabled).toBe(false));
      await act(async () => {
        fireEvent.click(commit);
      });

      await waitFor(() => expect(mock.submitZReport).toHaveBeenCalled());
      const refusal = LOCALES[lng].zReportOffline.refusal;
      const message = await screen.findByText((content) => content.includes(refusal));
      expect(message.textContent).not.toContain('pre-Z-report sync failed');
      expect(message.textContent).not.toContain('No connection to the server: the day cannot');
    },
  );
});
