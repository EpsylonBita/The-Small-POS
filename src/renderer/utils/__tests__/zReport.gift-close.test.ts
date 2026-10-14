import { afterEach, describe, expect, it, vi } from 'vitest';
import { zReportLabel } from '../../../../../shared/reports/z-report-labels';
import type { StoredZReportRow } from '../../../lib/ipc-contracts';
import type { ZReportData } from '../../types/reports';
import { exportProvisionalZReportCsv, exportStoredZReportCsv } from '../reportExport';
import {
  classifyGiftCloseFinalizationError,
  resolvePersistedZReportId,
  resolveZReportGiftClose,
} from '../zReport';
import { captureDownloads, parseCsv } from './zReportExportKit';

function giftOriginal(overrides: Record<string, unknown> = {}) {
  return {
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
      localClosedAt: '2026-09-28T21:00:00Z',
      canonicalClosedAt: '2026-09-28T21:00:02Z',
      confirmedAt: '2026-09-28T21:00:05Z',
      adoptedAt: '2026-09-28T21:01:00Z',
    },
    ...overrides,
  };
}

function giftFinancialClose(overrides: Record<string, unknown> = {}) {
  return {
    contract: 'gift_close_report_v1',
    ready: true,
    giftLiabilityCash: 20,
    giftLiabilityCash_cents: 2000,
    ordinaryAdjustment: 0,
    ordinaryAdjustment_cents: 0,
    originals: [giftOriginal()],
    blockers: [],
    ...overrides,
  };
}

const ORDINARY_CASH_DRAWER = {
  totalVariance: 0,
  totalCashDrops: 0,
  unreconciledCount: 0,
  openingTotal: 23.45,
};

// 12345 ordinary + 2000 gift = 14345 expected; 14000 counted = -345 variance.
const GIFT_CASH_DRAWER = {
  ...ORDINARY_CASH_DRAWER,
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
};

function report(overrides: Record<string, unknown> = {}): ZReportData {
  return {
    date: '2026-09-28',
    shifts: { total: 1, cashier: 1, driver: 0 },
    sales: { totalOrders: 3, totalSales: 500, cashSales: 100, cardSales: 400 },
    cashDrawer: GIFT_CASH_DRAWER,
    expenses: { total: 0, cashTotal: 0, cardTotal: 0, pendingCount: 0, items: [] },
    driverEarnings: { totalDeliveries: 0, totalEarnings: 0, unsettledCount: 0 },
    giftFinancialClose: giftFinancialClose(),
    zReportId: 'zr-stored-1',
    ...overrides,
  } as unknown as ZReportData;
}

const PENDING_BLOCKER = {
  code: 'GIFT_CLOSE_PROOF_PENDING',
  shiftId: 'shift-1',
  drawerId: 'drawer-1',
  staffId: 'staff-1',
  staffName: 'Maria',
  pendingReason: 'awaiting_canonical_ack',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveZReportGiftClose', () => {
  it('reads the frozen canonical drawer with gift card cash counted once', () => {
    const view = resolveZReportGiftClose(report());

    expect(view.state).toBe('final');
    expect(view.allowsFinal).toBe(true);
    expect(view.currency).toBe('EUR');
    expect(view.drawer).toEqual({
      expectedCents: 14345,
      ordinaryExpectedCents: 12345,
      ordinaryAdjustmentCents: 0,
      giftLiabilityCashCents: 2000,
      countedCents: 14000,
      varianceCents: -345,
    });
    expect(view.originals).toHaveLength(1);
    expect(view.originals[0]).toMatchObject({
      currency: 'EUR',
      giftLiabilityCash_cents: 2000,
      expected_cents: 14345,
      variance_cents: -345,
      provenance: { status: 'confirmed', confirmedAt: '2026-09-28T21:00:05Z' },
    });
    expect(view.blockers).toEqual([]);
  });

  it('leaves ordinary reports untouched', () => {
    const ordinary = report({ giftFinancialClose: undefined, cashDrawer: ORDINARY_CASH_DRAWER });

    expect(resolveZReportGiftClose(ordinary)).toMatchObject({ state: 'none', allowsFinal: true, drawer: null });
    expect(resolveZReportGiftClose(null)).toMatchObject({ state: 'none', allowsFinal: true });
  });

  it('keeps pending proof not final and names the blocked drawer', () => {
    const view = resolveZReportGiftClose(report({
      zReportId: undefined,
      giftFinancialClose: giftFinancialClose({ ready: false, originals: [], blockers: [PENDING_BLOCKER] }),
    }));

    expect(view.state).toBe('blocked');
    expect(view.allowsFinal).toBe(false);
    expect(view.blockers).toEqual([PENDING_BLOCKER]);
  });

  it('holds the day when readiness is not ready even without a gift block', () => {
    const view = resolveZReportGiftClose(report({
      giftFinancialClose: undefined,
      cashDrawer: ORDINARY_CASH_DRAWER,
      giftCloseReadiness: {
        ready: false,
        count: 1,
        confirmedCount: 0,
        details: [{ code: 'GIFT_CLOSE_PROOF_UNAVAILABLE', staffName: 'Nikos' }],
      },
    }));

    expect(view.state).toBe('blocked');
    expect(view.allowsFinal).toBe(false);
    expect(view.blockers).toMatchObject([{ code: 'GIFT_CLOSE_PROOF_UNAVAILABLE', staffName: 'Nikos' }]);
  });

  it.each([
    ['missing proof despite contradictory readiness', {
      giftFinancialClose: undefined,
      cashDrawer: ORDINARY_CASH_DRAWER,
      giftCloseReadiness: { ready: true, count: 1, confirmedCount: 0 },
    }],
    ['missing proof with explicit gift cash', { giftFinancialClose: undefined }],
    ['missing proof with explicit zero gift cash', {
      giftFinancialClose: undefined,
      cashDrawer: { ...GIFT_CASH_DRAWER, giftLiabilityCash: 0, giftLiabilityCash_cents: 0 },
    }],
    ['a missing required ordinary adjustment', {
      giftFinancialClose: giftFinancialClose({ ordinaryAdjustment_cents: undefined }),
    }],
    ['an unknown contract', { giftFinancialClose: giftFinancialClose({ contract: 'gift_close_report_v0' }) }],
    ['an original that adds gift cash twice', {
      giftFinancialClose: giftFinancialClose({ originals: [giftOriginal({ expected_cents: 16345 })] }),
    }],
    ['non-integer cents', {
      giftFinancialClose: giftFinancialClose({ originals: [giftOriginal({ giftLiabilityCash_cents: 2000.5 })] }),
    }],
    ['unconfirmed provenance', {
      giftFinancialClose: giftFinancialClose({
        originals: [giftOriginal({ provenance: { contract: 'gift_closing_v1', status: 'pending' } })],
      }),
    }],
    ['a drawer total that double-adds gift cash', {
      cashDrawer: { ...GIFT_CASH_DRAWER, expected: 163.45, expected_cents: 16345 },
    }],
    ['mixed original currencies', {
      giftFinancialClose: giftFinancialClose({
        giftLiabilityCash_cents: 4000,
        originals: [giftOriginal(), giftOriginal({ shiftId: 'shift-2', drawerId: 'drawer-2', currency: 'ALL' })],
      }),
    }],
  ])('treats %s as unreadable, never final', (_label, overrides) => {
    const view = resolveZReportGiftClose(report(overrides));

    expect(view.state).toBe('unreadable');
    expect(view.allowsFinal).toBe(false);
  });
});

describe('resolvePersistedZReportId', () => {
  it('accepts only an explicit stored z_reports id', () => {
    expect(resolvePersistedZReportId(report())).toBe('zr-stored-1');
    expect(resolvePersistedZReportId({ z_report_id: 'zr-2' })).toBe('zr-2');
    expect(resolvePersistedZReportId({})).toBeNull();
    expect(resolvePersistedZReportId({ zReportId: '   ' })).toBeNull();
    expect(resolvePersistedZReportId({ zReportId: 'snapshot-2026-09-28-1790000000000' })).toBeNull();
    expect(resolvePersistedZReportId(null)).toBeNull();
  });
});

describe('classifyGiftCloseFinalizationError', () => {
  it('maps native gift close refusals and ignores other errors', () => {
    const required =
      'GIFT_CLOSE_PROOF_REQUIRED: Cannot generate Z-report: 1 gift-bound drawer close(s) lack confirmed canonical proof: shift-1';

    expect(classifyGiftCloseFinalizationError(required)).toBe('proofRequired');
    expect(classifyGiftCloseFinalizationError({ success: false, error: required })).toBe('proofRequired');
    expect(classifyGiftCloseFinalizationError(new Error('GIFT_CLOSE_SNAPSHOT_STALE: Cannot reuse Z-report zr-1: stale')))
      .toBe('snapshotStale');
    expect(classifyGiftCloseFinalizationError({ success: false, error: 'Unsettled payments block the Z-report' }))
      .toBeNull();
    expect(classifyGiftCloseFinalizationError(undefined)).toBeNull();
  });
});

/** The z_reports row of a stored gift close Z: its columns and its frozen snapshot as JSON text. */
function storedRow(snapshot: ZReportData): StoredZReportRow {
  return {
    id: 'zr-stored-1',
    terminalId: 'terminal-public-1',
    reportDate: '2026-09-28',
    generatedAt: '2026-09-28T21:05:00Z',
    grossSales: 500,
    netSales: 500,
    totalOrders: 3,
    cashSales: 100,
    cardSales: 400,
    reportJson: JSON.stringify(snapshot),
  } as StoredZReportRow;
}

describe('gift close in the Z export (shared document)', () => {
  const label = (key: Parameters<typeof zReportLabel>[1]) => zReportLabel('en', key);
  const exportRows = (action: () => string) => {
    const downloads = captureDownloads();
    action();
    return parseCsv(downloads[0].csv, ',');
  };

  it('exports gift card cash once in the drawer, outside sales, with the confirmed proof and each original in its currency', () => {
    const rows = exportRows(() => exportStoredZReportCsv(storedRow(report()), 'en'));
    const drawer = rows.filter((cells) => cells[0] === label('section.cashDrawer'));

    expect(drawer.filter((cells) => cells[1] === label('drawer.giftCash'))).toEqual([
      [label('section.cashDrawer'), label('drawer.giftCash'), '+20.00'],
    ]);
    expect(drawer).toContainEqual([label('section.cashDrawer'), label('drawer.giftOrdinaryExpected'), '123.45']);
    // Gift card cash sits in the expectation exactly once (14345, never 16345).
    expect(drawer).toContainEqual([label('section.cashDrawer'), label('drawer.expected'), '143.45']);
    expect(drawer).toContainEqual([label('section.cashDrawer'), label('drawer.counted'), '140.00']);
    // Never a sales, tender or tax line.
    expect(rows.filter((cells) => cells[0] === label('section.sales')).map((cells) => cells[1]))
      .not.toContain(label('drawer.giftCash'));
    expect(rows).toContainEqual([label('section.sales'), label('sales.gross'), '500.00']);
    expect(rows).toContainEqual([label('section.giftClose'), label('gift.status'), label('gift.final')]);
    const original = `${label('section.giftClose')} · Maria`;
    expect(rows).toContainEqual([original, zReportLabel('en', 'gift.shift', { shift: 'shift-1' }), 'EUR']);
    expect(rows).toContainEqual([original, label('drawer.variance'), '-3.45']);
  });

  it('exports an ordinary Z without any gift line', () => {
    const rows = exportRows(() =>
      exportStoredZReportCsv(storedRow(report({ giftFinancialClose: undefined, cashDrawer: ORDINARY_CASH_DRAWER })), 'en'));
    expect(rows.some((cells) => cells[0].startsWith(label('section.giftClose')))).toBe(false);
    expect(rows.some((cells) => cells[1] === label('drawer.giftCash'))).toBe(false);
  });

  it('exports a preview with pending proof as not final, never as a confirmed close', () => {
    const rows = exportRows(() => exportProvisionalZReportCsv(report({
      zReportId: undefined,
      cashDrawer: ORDINARY_CASH_DRAWER,
      giftFinancialClose: giftFinancialClose({ ready: false, originals: [], blockers: [PENDING_BLOCKER] }),
    }), 'en'));

    expect(rows[1]).toEqual([label('section.report'), label('report.status'), label('status.provisional')]);
    expect(rows).toContainEqual([label('section.giftClose'), label('gift.status'), label('gift.notFinal')]);
    expect(rows.some((cells) => cells[2] === label('gift.final'))).toBe(false);
  });
});
