import type {
  ZReportData,
  ZReportGiftCloseBlocker,
  ZReportGiftCloseOriginal,
} from '../types/reports';

export type ZReportStaffReport = NonNullable<ZReportData['staffReports']>[number];

export interface ResolvedZReportPeriod {
  start?: string;
  end?: string;
}

function pickString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function toNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function resolveZReportPeriod(
  report?: Pick<ZReportData, 'period' | 'periodStart' | 'periodEnd'> | null
): ResolvedZReportPeriod {
  return {
    start: pickString(report?.period?.start, report?.periodStart),
    end: pickString(report?.period?.end, report?.periodEnd),
  };
}

export function normalizeZReportData(report: ZReportData | null | undefined): ZReportData | null {
  if (!report) {
    return null;
  }

  const period = resolveZReportPeriod(report);
  const normalizedPeriod = period.start || period.end
    ? {
      start: period.start,
      end: period.end,
    }
    : undefined;

  return {
    ...report,
    period: normalizedPeriod,
    periodStart: period.start,
    periodEnd: period.end,
  };
}

export function resolveShiftEarnedTotal(staff?: Partial<ZReportStaffReport> | null): number {
  const explicitTotal = staff?.orders?.totalAmount;
  if (typeof explicitTotal === 'number' && Number.isFinite(explicitTotal)) {
    return explicitTotal;
  }

  return toNumber(staff?.orders?.cashAmount) + toNumber(staff?.orders?.cardAmount);
}

export function resolveShiftActivityCount(staff?: Partial<ZReportStaffReport> | null): number {
  const role = String(staff?.role || '').toLowerCase();
  if (role === 'driver') {
    return toNumber(staff?.driver?.deliveries ?? staff?.orders?.count);
  }

  return toNumber(staff?.orders?.count);
}

export function resolveShiftWindow(staff?: Partial<ZReportStaffReport> | null): ResolvedZReportPeriod {
  return {
    start: pickString(staff?.checkIn),
    end: pickString(staff?.checkOut),
  };
}

// ---------------------------------------------------------------------------
// Gift card close: native `reportJson.giftFinancialClose` (gift_close_report_v1)
// ---------------------------------------------------------------------------

export const GIFT_CLOSE_REPORT_CONTRACT = 'gift_close_report_v1';
export const GIFT_CLOSE_PROOF_CONTRACT = 'gift_closing_v1';

/**
 * English copy shared by the Z modal (as i18n fallbacks) and the CSV export, so both
 * name the reconciliation and the proof state the same way.
 */
export const GIFT_CLOSE_LABELS = {
  title: 'Gift card cash',
  outsideSales: 'Shown separately from sales and tax. Included once in expected cash.',
  ordinaryExpected: 'Ordinary expected cash',
  ordinaryAdjustment: 'Other cash adjustment',
  giftLiabilityCash: 'Gift card cash',
  expected: 'Expected cash',
  counted: 'Counted cash',
  variance: 'Variance',
  currency: 'Currency',
  shift: 'Shift',
  drawer: 'Drawer',
  confirmedAt: 'Confirmed at',
  adoptedAt: 'Adopted at',
  proofStatus: 'Gift card close proof',
  proofFinal: 'Closing confirmed',
  proofNotFinal: 'Not final: a gift card close is not confirmed',
  proofUnreadable: 'Closing confirmation is unavailable',
  checklistFinal: 'Gift card cash {{amount}} is confirmed and kept outside sales.',
  blocked: 'Final print and submit stay disabled until every gift card close is confirmed.',
  blockerSection: 'Gift card close blocker',
  finalActions: 'Final print and submit',
  finalPrintUnavailable: 'Final printing is available after the Z-report has been saved.',
  recovery: {
    GIFT_CLOSE_PROOF_PENDING:
      'The gift card close for {{staff}} is waiting for confirmation. Keep this terminal online, then press Refresh.',
    GIFT_CLOSE_PROOF_UNAVAILABLE:
      'The confirmed gift card close for {{staff}} cannot be read. Press Refresh; if it stays, contact support before closing the day.',
    GIFT_CLOSE_PROOF_MISMATCH:
      'The gift card close for {{staff}} no longer matches its drawer. Do not close the day; contact support.',
    GIFT_CLOSE_JOURNAL_MISSING:
      'No confirmed gift card close was recorded for {{staff}}. Contact support before closing the day.',
    GIFT_OPENING_UNCONFIRMED:
      'The gift card opening for {{staff}} is not confirmed yet. Connect this terminal, then press Refresh.',
    unknown:
      'The gift card close for {{staff}} is not confirmed. Press Refresh; if it stays, contact support.',
    unreadable:
      'The gift card close in this report cannot be read. Press Refresh; if it stays, contact support before closing the day.',
  },
  errors: {
    proofRequired:
      'The day cannot close yet: a gift card drawer close is not confirmed. Keep this terminal online, press Refresh and follow the gift card notice.',
    snapshotStale:
      'This stored Z-report was saved before a gift card close was confirmed, so it cannot be reused. Contact support; the stored report was not changed.',
  },
} as const;

export type GiftCloseRecoveryKey = keyof typeof GIFT_CLOSE_LABELS.recovery;
export type GiftCloseFinalizationError = keyof typeof GIFT_CLOSE_LABELS.errors;

/**
 * - `none`: ordinary report, no gift-bound drawer.
 * - `final`: every gift-bound close has confirmed canonical proof and the frozen figures reconcile.
 * - `blocked`: pending, missing or mismatched proof (native blockers or not-ready readiness).
 * - `unreadable`: a gift block exists but cannot be trusted (unknown contract or figures that do not reconcile).
 */
export type ZReportGiftCloseState = 'none' | 'final' | 'blocked' | 'unreadable';

/** Canonical drawer figures in cents, read from `cashDrawer` as native froze them. */
export interface ZReportGiftCloseDrawerTotals {
  /** ordinary components + ordinary adjustment + gift card cash, each exactly once. */
  expectedCents: number;
  /** expected - gift card cash (includes the ordinary adjustment). */
  ordinaryExpectedCents: number;
  ordinaryAdjustmentCents: number;
  giftLiabilityCashCents: number;
  countedCents: number | null;
  varianceCents: number | null;
}

export interface ZReportGiftCloseView {
  state: ZReportGiftCloseState;
  /** False while any gift card close lacks confirmed proof: final print and submit must wait. */
  allowsFinal: boolean;
  /** The originals' shared currency, kept as native reported it. */
  currency: string | null;
  drawer: ZReportGiftCloseDrawerTotals | null;
  originals: ZReportGiftCloseOriginal[];
  blockers: ZReportGiftCloseBlocker[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

// `<key>_cents` is authoritative; the 2dp decimal twin is only read when the cents field is absent.
function readCents(record: UnknownRecord, key: string): number | null {
  const cents = record[`${key}_cents`];
  if (isCents(cents)) return cents;
  if (cents !== undefined && cents !== null) return null;
  const decimal = record[key];
  return typeof decimal === 'number' && Number.isFinite(decimal) ? Math.round(decimal * 100) : null;
}

function readText(record: UnknownRecord, key: string): string | null {
  return pickString(record[key]) ?? null;
}

const GIFT_CLOSE_ORIGINAL_AMOUNTS = [
  'ordinaryExpected',
  'giftLiabilityCash',
  'expected',
  'counted',
  'variance',
] as const;

function normalizeGiftCloseOriginal(value: unknown): ZReportGiftCloseOriginal | null {
  if (!isRecord(value) || !isRecord(value.provenance)) return null;
  const provenance = value.provenance;
  const shiftId = readText(value, 'shiftId');
  const drawerId = readText(value, 'drawerId');
  const currency = readText(value, 'currency');
  if (!shiftId || !drawerId || !currency) return null;
  if (provenance.contract !== GIFT_CLOSE_PROOF_CONTRACT || provenance.status !== 'confirmed') return null;

  const cents = {} as Record<(typeof GIFT_CLOSE_ORIGINAL_AMOUNTS)[number], number>;
  for (const key of GIFT_CLOSE_ORIGINAL_AMOUNTS) {
    const amount = value[`${key}_cents`];
    if (!isCents(amount)) return null;
    cents[key] = amount;
  }
  // A frozen row must reconcile on its own: gift card cash sits inside expected exactly once.
  if (cents.expected !== cents.ordinaryExpected + cents.giftLiabilityCash) return null;
  if (cents.variance !== cents.counted - cents.expected) return null;

  const adjustment = value.ordinaryAdjustment_cents;
  const drawerVersion = value.drawerVersion;
  return {
    shiftId,
    drawerId,
    staffId: readText(value, 'staffId') ?? '',
    staffName: readText(value, 'staffName'),
    terminalId: readText(value, 'terminalId') ?? '',
    currency,
    ordinaryExpected: cents.ordinaryExpected / 100,
    ordinaryExpected_cents: cents.ordinaryExpected,
    giftLiabilityCash: cents.giftLiabilityCash / 100,
    giftLiabilityCash_cents: cents.giftLiabilityCash,
    expected: cents.expected / 100,
    expected_cents: cents.expected,
    counted: cents.counted / 100,
    counted_cents: cents.counted,
    variance: cents.variance / 100,
    variance_cents: cents.variance,
    ordinaryAdjustment_cents: isCents(adjustment) ? adjustment : 0,
    drawerVersion: typeof drawerVersion === 'number' || typeof drawerVersion === 'string' ? drawerVersion : null,
    provenance: {
      contract: GIFT_CLOSE_PROOF_CONTRACT,
      status: 'confirmed',
      localClosedAt: readText(provenance, 'localClosedAt'),
      canonicalClosedAt: readText(provenance, 'canonicalClosedAt'),
      confirmedAt: readText(provenance, 'confirmedAt'),
      adoptedAt: readText(provenance, 'adoptedAt'),
    },
  };
}

function normalizeGiftCloseBlocker(value: unknown): ZReportGiftCloseBlocker {
  const record = isRecord(value) ? value : {};
  return {
    code: readText(record, 'code') ?? 'unknown',
    shiftId: readText(record, 'shiftId'),
    drawerId: readText(record, 'drawerId'),
    staffId: readText(record, 'staffId'),
    staffName: readText(record, 'staffName'),
    pendingReason: readText(record, 'pendingReason'),
  };
}

function mergeGiftCloseBlockers(...lists: ZReportGiftCloseBlocker[][]): ZReportGiftCloseBlocker[] {
  const merged = new Map<string, ZReportGiftCloseBlocker>();
  for (const blocker of ([] as ZReportGiftCloseBlocker[]).concat(...lists)) {
    const key = `${blocker.code}:${blocker.shiftId ?? ''}:${blocker.drawerId ?? ''}`;
    if (!merged.has(key)) merged.set(key, blocker);
  }
  return [...merged.values()];
}

function resolveGiftCloseDrawer(cashDrawer: unknown): ZReportGiftCloseDrawerTotals | null {
  if (!isRecord(cashDrawer)) return null;
  const expectedCents = readCents(cashDrawer, 'expected');
  const ordinaryExpectedCents = readCents(cashDrawer, 'ordinaryExpected');
  const giftLiabilityCashCents = readCents(cashDrawer, 'giftLiabilityCash');
  if (expectedCents === null || ordinaryExpectedCents === null || giftLiabilityCashCents === null) {
    return null;
  }
  return {
    expectedCents,
    ordinaryExpectedCents,
    ordinaryAdjustmentCents: readCents(cashDrawer, 'ordinaryAdjustment') ?? 0,
    giftLiabilityCashCents,
    countedCents: readCents(cashDrawer, 'closing'),
    varianceCents: readCents(cashDrawer, 'totalVariance'),
  };
}

/**
 * Read the frozen gift card close exactly as native stored it. Nothing here recomputes a
 * drawer from current amounts; a gift block that does not reconcile is `unreadable`, never final.
 */
export function resolveZReportGiftClose(
  report: Pick<ZReportData, 'cashDrawer' | 'giftFinancialClose' | 'giftCloseReadiness'> | null | undefined,
): ZReportGiftCloseView {
  const view: ZReportGiftCloseView = {
    state: 'none',
    allowsFinal: true,
    currency: null,
    drawer: null,
    originals: [],
    blockers: [],
  };
  if (!report) return view;

  const readiness: unknown = report.giftCloseReadiness;
  const readinessHolds = isRecord(readiness) && readiness.ready !== true;
  const readinessBlockers = isRecord(readiness) && Array.isArray(readiness.details)
    ? readiness.details.map(normalizeGiftCloseBlocker)
    : [];

  const raw: unknown = report.giftFinancialClose;
  if (raw === undefined || raw === null) {
    const carriesGiftCash = isRecord(report.cashDrawer) &&
      ('giftLiabilityCash' in report.cashDrawer || 'giftLiabilityCash_cents' in report.cashDrawer);
    const expectsGiftProof = isRecord(readiness) && (
      (typeof readiness.confirmedCount === 'number' && readiness.confirmedCount > 0) ||
      (typeof readiness.count === 'number' && readiness.count > 0)
    );
    return readinessHolds
      ? { ...view, state: 'blocked', allowsFinal: false, blockers: readinessBlockers }
      : carriesGiftCash || expectsGiftProof
        ? { ...view, state: 'unreadable', allowsFinal: false, blockers: readinessBlockers }
      : view;
  }
  if (
    !isRecord(raw) ||
    raw.contract !== GIFT_CLOSE_REPORT_CONTRACT ||
    typeof raw.ready !== 'boolean' ||
    !Array.isArray(raw.originals) ||
    !Array.isArray(raw.blockers)
  ) {
    return { ...view, state: 'unreadable', allowsFinal: false, blockers: readinessBlockers };
  }

  const originals = raw.originals.map(normalizeGiftCloseOriginal);
  const validOriginals = originals.filter(
    (original): original is ZReportGiftCloseOriginal => original !== null,
  );
  const blockers = mergeGiftCloseBlockers(raw.blockers.map(normalizeGiftCloseBlocker), readinessBlockers);
  const currencies = new Set(validOriginals.map((original) => original.currency));
  const drawer = resolveGiftCloseDrawer(report.cashDrawer);
  const resolved: ZReportGiftCloseView = {
    ...view,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    drawer,
    originals: validOriginals,
    blockers,
  };

  if (!raw.ready || blockers.length > 0 || readinessHolds) {
    return { ...resolved, state: 'blocked', allowsFinal: false };
  }

  const giftTotalCents = raw.giftLiabilityCash_cents;
  const adjustmentCents = raw.ordinaryAdjustment_cents;
  const reconciles =
    originals.length > 0 &&
    validOriginals.length === originals.length &&
    currencies.size === 1 &&
    isCents(giftTotalCents) &&
    validOriginals.reduce((sum, original) => sum + original.giftLiabilityCash_cents, 0) === giftTotalCents &&
    drawer !== null &&
    drawer.giftLiabilityCashCents === giftTotalCents &&
    drawer.expectedCents === drawer.ordinaryExpectedCents + drawer.giftLiabilityCashCents &&
    isCents(adjustmentCents) && adjustmentCents === drawer.ordinaryAdjustmentCents;

  return reconciles
    ? { ...resolved, state: 'final', allowsFinal: true }
    : { ...resolved, state: 'unreadable', allowsFinal: false };
}

export function giftCloseRecoveryKey(
  code: string | null | undefined,
): Exclude<GiftCloseRecoveryKey, 'unreadable'> {
  switch (code) {
    case 'GIFT_CLOSE_PROOF_PENDING':
    case 'GIFT_CLOSE_PROOF_UNAVAILABLE':
    case 'GIFT_CLOSE_PROOF_MISMATCH':
    case 'GIFT_CLOSE_JOURNAL_MISSING':
    case 'GIFT_OPENING_UNCONFIRMED':
      return code;
    default:
      return 'unknown';
  }
}

export function giftCloseStaffLabel(
  blocker: Pick<ZReportGiftCloseBlocker, 'staffName' | 'staffId' | 'shiftId'>,
): string {
  return pickString(blocker.staffName, blocker.staffId, blocker.shiftId) ?? 'a staff member';
}

/** English recovery wording for one blocker (`null` = unreadable proof). The modal localizes the same keys. */
export function giftCloseRecoveryText(blocker: ZReportGiftCloseBlocker | null): string {
  if (!blocker) return GIFT_CLOSE_LABELS.recovery.unreadable;
  return GIFT_CLOSE_LABELS.recovery[giftCloseRecoveryKey(blocker.code)]
    .replace(/\{\{staff\}\}/g, giftCloseStaffLabel(blocker));
}

/** Map native `GIFT_CLOSE_PROOF_REQUIRED:` / `GIFT_CLOSE_SNAPSHOT_STALE:` refusals to a copy key. */
export function classifyGiftCloseFinalizationError(value: unknown): GiftCloseFinalizationError | null {
  const candidates: unknown[] = [value];
  if (isRecord(value)) candidates.push(value.error, value.message);
  if (value instanceof Error) candidates.push(value.message);
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    if (candidate.includes('GIFT_CLOSE_PROOF_REQUIRED')) return 'proofRequired';
    if (candidate.includes('GIFT_CLOSE_SNAPSHOT_STALE')) return 'snapshotStale';
  }
  return null;
}

/**
 * Final print always goes through the stored `z_reports` row. Only an explicit persisted id
 * qualifies; a live preview has none and synthetic snapshot ids never count.
 */
export function resolvePersistedZReportId(
  report: Pick<ZReportData, 'zReportId' | 'z_report_id'> | null | undefined,
): string | null {
  const id = pickString(report?.zReportId, report?.z_report_id);
  return id && !id.startsWith('snapshot-') ? id : null;
}

export interface ZReportCsvRow {
  Section: string;
  Metric: string;
  Value: string | number;
}

function centsToAmount(cents: number): number {
  return cents / 100;
}

/**
 * CSV rows for the gift card close: the same reconciliation and proof labels as the modal.
 * Gift card cash is a drawer liability line, never a sales, tender or tax row. Ordinary reports get none.
 */
export function buildZReportGiftCloseCsvRows(
  report: Pick<ZReportData, 'cashDrawer' | 'giftFinancialClose' | 'giftCloseReadiness'> | null | undefined,
): ZReportCsvRow[] {
  const view = resolveZReportGiftClose(report);
  if (view.state === 'none') return [];

  const labels = GIFT_CLOSE_LABELS;
  const section = labels.title;
  const rows: ZReportCsvRow[] = [
    {
      Section: section,
      Metric: labels.proofStatus,
      Value: view.state === 'final'
        ? labels.proofFinal
        : view.state === 'unreadable'
          ? labels.proofUnreadable
          : labels.proofNotFinal,
    },
  ];
  if (view.currency) rows.push({ Section: section, Metric: labels.currency, Value: view.currency });

  if (view.drawer) {
    const drawer = view.drawer;
    rows.push({ Section: 'Cash Drawer', Metric: labels.ordinaryExpected, Value: centsToAmount(drawer.ordinaryExpectedCents) });
    if (drawer.ordinaryAdjustmentCents !== 0) {
      rows.push({ Section: 'Cash Drawer', Metric: labels.ordinaryAdjustment, Value: centsToAmount(drawer.ordinaryAdjustmentCents) });
    }
    rows.push({ Section: 'Cash Drawer', Metric: labels.giftLiabilityCash, Value: centsToAmount(drawer.giftLiabilityCashCents) });
    rows.push({ Section: 'Cash Drawer', Metric: labels.expected, Value: centsToAmount(drawer.expectedCents) });
    if (drawer.countedCents !== null) {
      rows.push({ Section: 'Cash Drawer', Metric: labels.counted, Value: centsToAmount(drawer.countedCents) });
    }
  }

  for (const original of view.originals) {
    const originalSection = `${section}: ${giftCloseStaffLabel(original)}`;
    rows.push(
      { Section: originalSection, Metric: labels.shift, Value: original.shiftId },
      { Section: originalSection, Metric: labels.drawer, Value: original.drawerId },
      { Section: originalSection, Metric: labels.currency, Value: original.currency },
      { Section: originalSection, Metric: labels.ordinaryExpected, Value: centsToAmount(original.ordinaryExpected_cents) },
      { Section: originalSection, Metric: labels.giftLiabilityCash, Value: centsToAmount(original.giftLiabilityCash_cents) },
      { Section: originalSection, Metric: labels.expected, Value: centsToAmount(original.expected_cents) },
      { Section: originalSection, Metric: labels.counted, Value: centsToAmount(original.counted_cents) },
      { Section: originalSection, Metric: labels.variance, Value: centsToAmount(original.variance_cents) },
      { Section: originalSection, Metric: labels.confirmedAt, Value: original.provenance.confirmedAt ?? '' },
      { Section: originalSection, Metric: labels.adoptedAt, Value: original.provenance.adoptedAt ?? '' },
    );
  }

  for (const blocker of view.blockers) {
    rows.push({ Section: labels.blockerSection, Metric: blocker.code, Value: giftCloseRecoveryText(blocker) });
  }
  if (view.state === 'unreadable') {
    rows.push({ Section: labels.blockerSection, Metric: 'unreadable', Value: giftCloseRecoveryText(null) });
  }
  if (!view.allowsFinal) {
    rows.push({ Section: section, Metric: labels.finalActions, Value: labels.blocked });
  }
  return rows;
}
