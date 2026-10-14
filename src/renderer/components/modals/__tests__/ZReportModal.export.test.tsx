import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ZReportModal from '../ZReportModal';
import { goldenCase, storedRowFromGolden } from '../../../utils/__tests__/zReportExportKit';

// Founder, 14/10/2026: "the Z export must be based on the Z's real data". The Z window's two
// export buttons open the picker of stored Zs; neither downloads the live preview directly.

const mocks = vi.hoisted(() => {
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
  return {
    translate,
    bridge: {
      reports: {
        generateZReport: vi.fn(),
        printZReport: vi.fn(),
        submitZReport: vi.fn(),
        resolvePaymentBlocker: vi.fn(),
        listZReports: vi.fn(),
        getZReport: vi.fn(),
      },
      auth: { logout: vi.fn(async () => ({ success: true })) },
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate, i18n: { language: 'en', changeLanguage: vi.fn() } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
  Trans: ({ children }: { children?: unknown }) => children,
}));
vi.mock('../../../../lib', () => ({
  getBridge: () => mocks.bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: mocks.translate }),
}));
vi.mock('../../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));
vi.mock('../../../contexts/shift-context', () => ({ useShift: () => ({ clearShift: vi.fn() }) }));
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark', theme: 'dark' }) }));
vi.mock('../../../hooks/useFeatures', () => ({
  useFeatures: () => ({
    isFeatureEnabled: () => true,
    isMainTerminal: true,
    isMobileWaiter: false,
    loading: false,
    parentTerminalId: null,
  }),
}));
vi.mock('../../../utils/session-utils', () => ({ clearBusinessDayStorage: vi.fn() }));

const takeaway = goldenCase('desktop-takeaway-chf');
const storedRow = storedRowFromGolden(takeaway);
const liveReport = { ...takeaway.data, terminalId: 'terminal-zh-01', terminalName: 'Kasse 1' };

let anchorClicks: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.bridge.reports.generateZReport.mockReset();
  mocks.bridge.reports.listZReports.mockReset().mockResolvedValue({ success: true, reports: [storedRow], count: 1 });
  mocks.bridge.reports.getZReport.mockReset().mockResolvedValue({ success: true, report: storedRow });
  anchorClicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const serve = (report: unknown) =>
  mocks.bridge.reports.generateZReport.mockResolvedValue({ success: true, data: report });
const renderModal = () => render(<ZReportModal isOpen onClose={vi.fn()} branchId="branch-zh" />);
const dialog = () => screen.findByRole('dialog', { name: 'modals.zReport.exportDialog.title' });

describe('ZReportModal export buttons', () => {
  it('Export CSV opens the stored-Z picker; the live preview is offered there only as provisional', async () => {
    serve(liveReport);
    renderModal();
    await waitFor(() => expect(mocks.bridge.reports.generateZReport).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'modals.zReport.exportCSV' }));
    const picker = await dialog();
    await waitFor(() => expect(within(picker).getAllByRole('radio')).toHaveLength(1));
    expect(mocks.bridge.reports.listZReports).toHaveBeenCalledTimes(1);
    expect(picker.querySelector('[data-z-report-export-provisional]')).not.toBeNull();
    // Opening the picker exports nothing by itself.
    expect(anchorClicks).not.toHaveBeenCalled();
  });

  it('stays usable when the live preview cannot load: stored Zs export without it', async () => {
    mocks.bridge.reports.generateZReport.mockRejectedValue(new Error('preview failed'));
    renderModal();
    await waitFor(() => expect(mocks.bridge.reports.generateZReport).toHaveBeenCalled());

    const button = screen.getByRole('button', { name: 'modals.zReport.exportCSV' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    const picker = await dialog();
    await waitFor(() => expect(within(picker).getAllByRole('radio')).toHaveLength(1));
    expect(picker.querySelector('[data-z-report-export-provisional]')).toBeNull();
  });

  it('the Orders tab button opens the same picker, preselecting the stored Z the window shows', async () => {
    serve({ ...liveReport, zReportId: 'zr-desk-0001' });
    renderModal();
    await waitFor(() => expect(mocks.bridge.reports.generateZReport).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^modals\.zReport\.orders/ }));
    fireEvent.click(screen.getByRole('button', { name: 'modals.zReport.exportOrdersCSV' }));
    const picker = await dialog();
    await waitFor(() => expect(within(picker).getByRole('radio', { checked: true }))
      .toHaveAttribute('data-z-report-id', 'zr-desk-0001'));
    // A stored Z is never offered as a provisional preview.
    expect(picker.querySelector('[data-z-report-export-provisional]')).toBeNull();
    expect(anchorClicks).not.toHaveBeenCalled();
  });
});
