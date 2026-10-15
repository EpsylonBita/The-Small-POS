import { resolveZReportSections } from '../../../../shared/reports/z-report-sections';
import type {
  ZReportData,
  ZReportGiftCloseBlocker,
  ZReportGiftCloseOriginal,
  ZReportPhoneShift,
  ZReportPhoneShiftHandover,
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

  const normalized: ZReportData = {
    ...report,
    period: normalizedPeriod,
    periodStart: period.start,
    periodEnd: period.end,
  };
  // Absent stays absent: it means the Z skipped the phone shift check.
  if ('phoneShifts' in report) {
    normalized.phoneShifts = normalizeZReportPhoneShifts(report.phoneShifts);
  }
  return normalized;
}

const PHONE_SHIFT_HANDOVERS: readonly ZReportPhoneShiftHandover[] = ['received', 'pending', 'none', 'not_counted'];
const PHONE_SHIFT_AMOUNTS = [
  'salesTotal',
  'cashSales',
  'cardSales',
  'openingCash',
  'countedCash',
  'expectedCash',
  'cashVariance',
] as const;

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The phone shifts a committed Z stored (founder rule 13/10/2026). An entry
 * without a shift id is dropped; an amount reads its `_cents` twin first, and
 * an invalid one is null (shown as a dash), never 0.
 */
export function normalizeZReportPhoneShifts(value: unknown): ZReportPhoneShift[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const shifts: ZReportPhoneShift[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const staffShiftId = readText(entry, 'staffShiftId');
    if (!staffShiftId) continue;
    const shift: ZReportPhoneShift = {
      staffShiftId,
      staffId: readText(entry, 'staffId'),
      staffName: readText(entry, 'staffName'),
      role: readText(entry, 'role'),
      terminalId: readText(entry, 'terminalId'),
      terminalName: readText(entry, 'terminalName'),
      terminalActive: typeof entry.terminalActive === 'boolean'
        ? entry.terminalActive
        : entry.terminalActive === null ? null : undefined,
      checkIn: readText(entry, 'checkIn'),
      checkOut: readText(entry, 'checkOut'),
      status: entry.status === 'abandoned' ? 'abandoned' : entry.status === 'closed' ? 'closed' : null,
      currency: readText(entry, 'currency'),
      ordersCount: optionalFiniteNumber(entry.ordersCount),
      handover: PHONE_SHIFT_HANDOVERS.includes(entry.handover as ZReportPhoneShiftHandover)
        ? entry.handover as ZReportPhoneShiftHandover
        : null,
      closedBy: entry.closedBy === 'main' ? 'main' : entry.closedBy === 'phone' ? 'phone' : null,
      receivedAt: readText(entry, 'receivedAt'),
    };
    for (const key of PHONE_SHIFT_AMOUNTS) {
      const cents = readCents(entry, key);
      shift[key] = cents === null ? null : cents / 100;
      shift[`${key}_cents` as const] = cents;
    }
    shifts.push(shift);
  }
  return shifts;
}

export function resolveShiftEarnedTotal(staff?: Partial<ZReportStaffReport> | null): number {
  const explicitTotal = staff?.orders?.totalAmount;
  if (typeof explicitTotal === 'number' && Number.isFinite(explicitTotal)) {
    return explicitTotal;
  }

  return toNumber(staff?.orders?.cashAmount) + toNumber(staff?.orders?.cardAmount) + toNumber(staff?.orders?.twintAmount);
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
 * English i18n fallbacks of the Z modal's gift card close copy. The CSV export takes its
 * words from `shared/reports` (six languages), never from here.
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
  confirmedAt: 'Confirmed at',
  proofFinal: 'Closing confirmed',
  proofNotFinal: 'Not final: a gift card close is not confirmed',
  proofUnreadable: 'Closing confirmation is unavailable',
  checklistFinal: 'Gift card cash {{amount}} is confirmed and kept outside sales.',
  blocked: 'Final print and submit stay disabled until every gift card close is confirmed.',
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

/** Canonical tender amount; absent historical reports have no TWINT value. */
export function resolveZReportTwintTotal(report: ZReportData | null | undefined): number {
  return toNumber(report?.sales?.twintSales ?? report?.paymentsBreakdown?.twint?.total ?? report?.daySummary?.twintTotal);
}

/** Unknown legacy flags infer recorded activity only, never grant a module or payment. */
export function resolveZReportPresentation(report: ZReportData | null | undefined) {
  const staff = report?.staffReports ?? [];
  const drivers = staff.filter(s => s.role === 'driver');
  const sales = report?.sales as (ZReportData['sales'] & { deliveryOrders?: number; deliverySales?: number }) | undefined;
  const deliveryCount = toNumber(sales?.deliveryOrders);
  const deliveryAmount = toNumber(sales?.deliverySales);
  const driverMoney = drivers.reduce((sum, s) => sum + Math.abs(toNumber(s.orders?.totalAmount))
    + Math.abs(toNumber(s.drawer?.opening)) + Math.abs(toNumber(s.driver?.earnings))
    + Math.abs(toNumber(s.driver?.cashToReturn)) + Math.abs(toNumber(s.payments?.staffPayments)), 0)
    + Math.abs(toNumber(report?.driverEarnings?.totalEarnings))
    + Math.abs(toNumber(report?.cashDrawer?.driverCashGiven)) + Math.abs(toNumber(report?.cashDrawer?.driverCashReturned));
  return resolveZReportSections({
    deliveryModuleEnabled: report?.presentation?.deliveryModuleEnabled ?? (deliveryCount > 0 || drivers.length > 0),
    twintPluginEnabled: report?.presentation?.twintPluginEnabled === true,
    expenseCount: (report?.expenses?.items?.length ?? 0) + toNumber(report?.expenses?.pendingCount),
    expenseTotal: Math.abs(toNumber(report?.expenses?.total)) + Math.abs(toNumber(report?.expenses?.staffPaymentsTotal)),
    deliveryOrderCount: deliveryCount, deliveryAmount,
    driverShiftCount: drivers.length,
    driverDeliveryCount: toNumber(report?.driverEarnings?.totalDeliveries), driverMoneyTotal: driverMoney,
    waiterShiftCount: staff.filter(s => s.role === 'waiter').length,
    twintPaymentCount: toNumber(report?.sales?.twintPaymentCount ?? report?.paymentsBreakdown?.twint?.count),
    twintTotal: resolveZReportTwintTotal(report),
  });
}
