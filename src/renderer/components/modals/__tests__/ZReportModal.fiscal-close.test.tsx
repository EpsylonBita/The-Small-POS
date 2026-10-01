import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Field incident 29/09/2026 (Le Petit Paris, Android POS 1.0.12): the Z was
// refused over two queued fiscal submissions with an English sentence built
// in native code, and only after the cashier confirmed. On the desktop the
// guard now refuses with a code + parameters (FISCAL_CLOSE_BLOCKED) and the
// preview carries the queued rows, so the cashier sees the blocker before
// confirming and reads it in the store's configured language.

const mock = vi.hoisted(() => {
  const generateZReport = vi.fn();
  const submitZReport = vi.fn();
  // One bridge object, as the real `getBridge()` singleton: the modal's
  // load effect depends on it, so a fresh object per render would loop.
  const bridge = {
    reports: {
      generateZReport,
      submitZReport,
      printZReport: vi.fn(),
      resolvePaymentBlocker: vi.fn(),
    },
    auth: { logout: vi.fn() },
  };
  const clearShift = vi.fn();
  const features = {
    isFeatureEnabled: () => true,
    isMainTerminal: true,
    isMobileWaiter: false,
    loading: false,
    parentTerminalId: null,
  };
  return {
    bridge,
    generateZReport,
    submitZReport,
    clearShift,
    features,
    retryModule: vi.fn(),
    processQueue: vi.fn(),
  };
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
  getSyncQueueBridge: () => ({
    retryModule: mock.retryModule,
    processQueue: mock.processQueue,
  }),
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

// The native refusal exactly as `report_submit_z_report` answers it.
const NATIVE_ENGLISH =
  'Cannot close day: 2 fiscal receipt(s) of 2026-09-29 have not been sent to the tax authority yet.';
const fiscalRefusal = {
  success: false,
  errorCode: 'FISCAL_CLOSE_BLOCKED',
  code: 'fiscal_close_blocked',
  reason: 'fiscal_queue_not_empty',
  count: 2,
  businessDay: '2026-09-29',
  activeVerdict: 'unknown',
  fiscalRows: [],
  error: NATIVE_ENGLISH,
  message: NATIVE_ENGLISH,
};

const fiscalRows = [
  {
    queueItemId: 'queue-1',
    orderId: 'order-2e556433',
    receiptNumber: 'R-81165128',
    status: 'pending',
    attempts: 3,
    maxRetries: 10,
    createdAt: '2026-09-29T11:50:03Z',
    lastAttempt: '2026-09-29T12:10:00Z',
    nextRetryAt: '2026-09-29T12:15:00Z',
    lastError: 'HTTP_400_CLIENT_ERROR: Invalid FiscalReceiptInput',
  },
  {
    queueItemId: 'queue-2',
    orderId: 'order-81165128',
    receiptNumber: null,
    status: 'failed',
    attempts: 10,
    maxRetries: 10,
    createdAt: '2026-09-29T12:09:00Z',
    lastAttempt: null,
    nextRetryAt: null,
    lastError: null,
  },
];

const reportWith = (fiscalQueue?: Record<string, unknown>) => ({
  success: true,
  data: {
    date: '2026-09-29',
    sales: { totalOrders: 17, totalSales: 221.5, cashSales: 5, cardSales: 216.5 },
    cashDrawer: {
      totalVariance: 0,
      totalCashDrops: 0,
      unreconciledCount: 0,
      openingTotal: 200,
      driverCashGiven: 0,
      driverCashReturned: 0,
    },
    expenses: { total: 0, items: [], pendingCount: 0 },
    staffReports: [],
    ...(fiscalQueue ? { fiscalQueue } : {}),
  },
});

const blockingQueue = {
  count: 2,
  activeVerdict: 'unknown',
  blocking: true,
  branchId: 'branch-lpp',
  reportDate: '2026-09-29',
  periodStartAt: '2026-09-29T05:00:00+00:00',
  cutoffAt: null,
  rows: fiscalRows,
};

const renderModal = async (lng: Lng) => {
  const i18n = await createI18n(lng);
  render(
    <I18nextProvider i18n={i18n}>
      <ZReportModal isOpen onClose={() => {}} branchId="branch-lpp" date="2026-09-29" />
    </I18nextProvider>,
  );
  return i18n;
};

const commitButton = (i18n: Awaited<ReturnType<typeof createI18n>>) =>
  screen.getByRole('button', { name: i18n.t('modals.zReport.commitZReport') });

describe('ZReportModal fiscal close-day guard', () => {
  beforeEach(() => {
    mock.generateZReport.mockReset();
    mock.submitZReport.mockReset();
    mock.retryModule.mockReset().mockResolvedValue({ retried: 2 });
    mock.processQueue.mockReset().mockResolvedValue({ success: true, processed: 2 });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the queued fiscal submissions before the cashier confirms and holds the commit', async () => {
    mock.generateZReport.mockResolvedValue(reportWith(blockingQueue));
    const i18n = await renderModal('el');

    await waitFor(() => expect(mock.generateZReport).toHaveBeenCalled());
    const title = await screen.findByText(
      i18n.t('modals.zReport.fiscalQueue.listTitle', { count: 2 }),
    );
    expect(title.textContent).toContain('Φορολογικές υποβολές');
    expect(screen.getByText('R-81165128')).toBeTruthy();
    expect(screen.getByText('order-81165128')).toBeTruthy();
    expect(screen.getByText(/Προσπάθειες 3\/10/)).toBeTruthy();
    expect(screen.getByText(/Invalid FiscalReceiptInput/)).toBeTruthy();
    expect((commitButton(i18n) as HTMLButtonElement).disabled).toBe(true);
  });

  it('never shows a fiscal blocker for a branch the server reports as fiscally inactive', async () => {
    mock.generateZReport.mockResolvedValue(
      reportWith({ ...blockingQueue, activeVerdict: 'inactive', blocking: false }),
    );
    const i18n = await renderModal('el');

    await waitFor(() => expect((commitButton(i18n) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(i18n.t('modals.zReport.fiscalQueue.label'))).toBeNull();
    expect(document.querySelector('[data-z-report-fiscal-queue]')).toBeNull();
  });

  it('asks the queue to send the fiscal submissions again, then re-reads the report', async () => {
    mock.generateZReport.mockResolvedValue(reportWith(blockingQueue));
    const i18n = await renderModal('en');

    const retry = await screen.findByRole('button', {
      name: i18n.t('modals.zReport.fiscalQueue.retryAction'),
    });
    const readsBefore = mock.generateZReport.mock.calls.length;
    await act(async () => {
      fireEvent.click(retry);
    });

    expect(mock.retryModule).toHaveBeenCalledWith('fiscal');
    expect(mock.processQueue).toHaveBeenCalled();
    await waitFor(() =>
      expect(mock.generateZReport.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    expect(await screen.findByText(i18n.t('modals.zReport.fiscalQueue.retryRequested'))).toBeTruthy();
  });

  it.each(Object.keys(LOCALES) as Lng[])(
    'localizes the native refusal in %s, never showing the native English sentence',
    async (lng) => {
      mock.generateZReport.mockResolvedValue(reportWith());
      mock.submitZReport.mockResolvedValue(fiscalRefusal);
      const i18n = await renderModal(lng);

      const commit = commitButton(i18n) as HTMLButtonElement;
      await waitFor(() => expect(commit.disabled).toBe(false));
      await act(async () => {
        fireEvent.click(commit);
      });

      await waitFor(() => expect(mock.submitZReport).toHaveBeenCalled());
      const template = i18n.t('modals.zReport.fiscalCloseBlocked', { count: 2, date: '§' });
      const prefix = template.split('§')[0];
      const message = await screen.findByText((content) => content.startsWith(prefix));
      expect(message.textContent).toContain('2');
      expect(message.textContent).not.toContain('Cannot close day');
      expect(message.textContent).not.toMatch(/\{\{\w+\}\}/);
      if (lng !== 'en') {
        expect(message.textContent).not.toContain(
          (en as any).modals.zReport.fiscalCloseBlocked.split('{{')[0],
        );
      }
      // The report is re-read so the queued rows show up under the message.
      await waitFor(() => expect(mock.generateZReport.mock.calls.length).toBeGreaterThan(1));
    },
  );

  // Review of the 29/09/2026 fixes: a fiscal queue that cannot be read now
  // holds the close (it used to read as "nothing queued"). The cashier is
  // told the submissions could not be checked, never "0 not sent".
  it.each(Object.keys(LOCALES) as Lng[])(
    'says the fiscal submissions could not be checked in %s when the queue is unreadable',
    async (lng) => {
      const nativeEnglish =
        'Cannot close day: the fiscal submissions of 2026-09-29 could not be checked.';
      mock.generateZReport.mockResolvedValue(reportWith());
      mock.submitZReport.mockResolvedValue({
        ...fiscalRefusal,
        reason: 'fiscal_queue_unreadable',
        count: null,
        fiscalRows: [],
        checkError: 'count queued fiscal submissions: no such table: parity_sync_queue',
        error: nativeEnglish,
        message: nativeEnglish,
      });
      const i18n = await renderModal(lng);

      const commit = commitButton(i18n) as HTMLButtonElement;
      await waitFor(() => expect(commit.disabled).toBe(false));
      await act(async () => {
        fireEvent.click(commit);
      });

      await waitFor(() => expect(mock.submitZReport).toHaveBeenCalled());
      const template = i18n.t('modals.zReport.fiscalCloseCheckFailed', { date: '§' });
      const prefix = template.split('§')[0];
      expect(prefix.length).toBeGreaterThan(10);
      const message = await screen.findByText((content) => content.startsWith(prefix));
      expect(message.textContent).not.toContain('Cannot close day');
      expect(message.textContent).not.toContain('parity_sync_queue');
      expect(message.textContent).not.toMatch(/\{\{\w+\}\}/);
      if (lng !== 'en') {
        expect(message.textContent).not.toContain(
          (en as any).modals.zReport.fiscalCloseCheckFailed.split('{{')[0],
        );
      }
    },
  );
});
