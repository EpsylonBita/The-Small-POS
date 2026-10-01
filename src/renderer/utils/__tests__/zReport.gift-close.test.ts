import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZReportData } from '../../types/reports';
import { exportZReportToCSV } from '../reportExport';
import {
  GIFT_CLOSE_LABELS,
  buildZReportGiftCloseCsvRows,
  classifyGiftCloseFinalizationError,
  resolvePersistedZReportId,
  resolveZReportGiftClose,
} from '../zReport';

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
    expect(buildZReportGiftCloseCsvRows(ordinary)).toEqual([]);
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

describe('gift close CSV rows', () => {
  it('adds gift card cash once to the drawer reconciliation, outside sales, with currency and proof', () => {
    const rows = buildZReportGiftCloseCsvRows(report());
    const drawerRow = (metric: string) =>
      rows.filter((row) => row.Section === 'Cash Drawer' && row.Metric === metric);

    expect(drawerRow(GIFT_CLOSE_LABELS.giftLiabilityCash)).toEqual([
      { Section: 'Cash Drawer', Metric: GIFT_CLOSE_LABELS.giftLiabilityCash, Value: 20 },
    ]);
    expect(drawerRow(GIFT_CLOSE_LABELS.ordinaryExpected)[0]?.Value).toBe(123.45);
    expect(drawerRow(GIFT_CLOSE_LABELS.expected)[0]?.Value).toBe(143.45);
    expect(drawerRow(GIFT_CLOSE_LABELS.counted)[0]?.Value).toBe(140);
    expect(rows.some((row) => row.Section === 'Sales')).toBe(false);
    expect(rows).toContainEqual({
      Section: GIFT_CLOSE_LABELS.title,
      Metric: GIFT_CLOSE_LABELS.proofStatus,
      Value: GIFT_CLOSE_LABELS.proofFinal,
    });
    expect(rows).toContainEqual({ Section: GIFT_CLOSE_LABELS.title, Metric: GIFT_CLOSE_LABELS.currency, Value: 'EUR' });
    expect(rows).toContainEqual({
      Section: `${GIFT_CLOSE_LABELS.title}: Maria`,
      Metric: GIFT_CLOSE_LABELS.variance,
      Value: -3.45,
    });
    expect(rows.some((row) => row.Metric === GIFT_CLOSE_LABELS.finalActions)).toBe(false);
  });

  it('exports pending proof as not final with the same recovery wording', () => {
    const rows = buildZReportGiftCloseCsvRows(report({
      zReportId: undefined,
      cashDrawer: ORDINARY_CASH_DRAWER,
      giftFinancialClose: giftFinancialClose({ ready: false, originals: [], blockers: [PENDING_BLOCKER] }),
    }));

    expect(rows).toContainEqual({
      Section: GIFT_CLOSE_LABELS.title,
      Metric: GIFT_CLOSE_LABELS.proofStatus,
      Value: GIFT_CLOSE_LABELS.proofNotFinal,
    });
    expect(rows).toContainEqual({
      Section: GIFT_CLOSE_LABELS.blockerSection,
      Metric: 'GIFT_CLOSE_PROOF_PENDING',
      Value: GIFT_CLOSE_LABELS.recovery.GIFT_CLOSE_PROOF_PENDING.replace('{{staff}}', 'Maria'),
    });
    expect(rows).toContainEqual({
      Section: GIFT_CLOSE_LABELS.title,
      Metric: GIFT_CLOSE_LABELS.finalActions,
      Value: GIFT_CLOSE_LABELS.blocked,
    });
  });

  it('appends the gift rows to the Z CSV export while sales rows stay unchanged', () => {
    const csvParts: string[] = [];
    class CapturingBlob {
      constructor(chunks: string[]) {
        csvParts.push(chunks.join(''));
      }
    }
    vi.stubGlobal('Blob', CapturingBlob);
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:z-report'), configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    exportZReportToCSV(report(), 'z-report-2026-09-28');

    expect(click).toHaveBeenCalledTimes(1);
    const lines = csvParts[0].split('\n');
    expect(lines).toContain('"Sales","Total Sales",500');
    expect(lines).toContain('"Sales","Cash Sales",100');
    expect(lines.filter((line) => line.startsWith(`"Cash Drawer","${GIFT_CLOSE_LABELS.giftLiabilityCash}"`)))
      .toEqual([`"Cash Drawer","${GIFT_CLOSE_LABELS.giftLiabilityCash}",20`]);
    expect(lines).toContain(`"Cash Drawer","${GIFT_CLOSE_LABELS.expected}",143.45`);
    expect(lines).toContain(`"${GIFT_CLOSE_LABELS.title}","${GIFT_CLOSE_LABELS.proofStatus}","${GIFT_CLOSE_LABELS.proofFinal}"`);
    expect(lines).toContain(`"${GIFT_CLOSE_LABELS.title}","${GIFT_CLOSE_LABELS.currency}","EUR"`);
  });
});
