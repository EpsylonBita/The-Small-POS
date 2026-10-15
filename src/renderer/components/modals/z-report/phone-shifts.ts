/**
 * Phone shifts in the Z modal (founder rule 13/10/2026: phones always hand
 * over to the Main). Pure helpers for `ZReportModal`:
 *
 * - which open phone shifts hold this Z (a frozen window counts only the
 *   ones that checked in by its cutoff, like the native Z stage),
 * - one Staff-tab row shape, whether it comes from the live readiness read
 *   (`closed_shifts`) or from a stored Z (`report_json.phoneShifts`),
 * - the native Z stage's refusal, wherever the bridge wrapped it.
 *
 * Contract: `docs/architecture/phone-shift-handover.md`.
 */
import type { ZReportPhoneShift, ZReportPhoneShiftHandover } from '../../../types/reports';
import {
  unitShiftPhoneLabel,
  unitShiftPhoneState,
  unitShiftStaffLabel,
  unitShiftsZRefusal,
  type UnitClosedShift,
  type UnitShift,
} from '../../../utils/unit-shift-readiness';

/**
 * How long after the preview's arrival its `periodEnd` still counts as the
 * build moment of a live window (a live preview ends "now"). An older end is
 * the frozen cutoff of an issued Z.
 */
export const LIVE_PERIOD_END_TOLERANCE_MS = 120_000;

/**
 * The cutoff of a frozen Z window in epoch ms, or `null` for a live window,
 * where every open phone shift holds the Z. A frozen window is the pending
 * local submit (`lockDate`) or a preview whose end lies well before it
 * arrived. A frozen window without a readable end has no cutoff either: every
 * open phone shift holds it.
 */
export function frozenZCutoffMs(input: {
  lockDate: boolean;
  periodEnd: string | null | undefined;
  receivedAt: number | null;
}): number | null {
  const endMs = typeof input.periodEnd === 'string' ? Date.parse(input.periodEnd) : Number.NaN;
  if (!Number.isFinite(endMs)) return null;
  const frozen = input.lockDate
    || (input.receivedAt !== null && endMs < input.receivedAt - LIVE_PERIOD_END_TOLERANCE_MS);
  return frozen ? endMs : null;
}

/**
 * An open phone shift holds the Z unless it checked in after a frozen cutoff
 * (it belongs to the next POS day). An unreadable check-in holds it.
 */
export function unitShiftHoldsZ(shift: Pick<UnitShift, 'check_in_time'>, cutoffMs: number | null): boolean {
  if (cutoffMs === null) return true;
  const checkInMs = shift.check_in_time ? Date.parse(shift.check_in_time) : Number.NaN;
  return !Number.isFinite(checkInMs) || checkInMs <= cutoffMs;
}

/**
 * A closed phone till belongs to the Z window it closed in AND to the one it
 * was received in (re-review 15/10/2026: closed today and received tomorrow,
 * it shows in both Zs, today "to receive", tomorrow "handed over"), as the
 * native stored `phoneShifts` rule. `startMs`/`endMs` are the window's
 * bounds; `null` leaves that side open (a live window ends now).
 */
export function closedShiftInZWindow(
  shift: Pick<UnitClosedShift, 'check_out_time' | 'received_at'>,
  startMs: number | null,
  endMs: number | null,
): boolean {
  const inside = (moment: string | null) => {
    const ms = moment ? Date.parse(moment) : Number.NaN;
    return Number.isFinite(ms)
      && (startMs === null || ms >= startMs)
      && (endMs === null || ms <= endMs);
  };
  return inside(shift.check_out_time) || inside(shift.received_at);
}

/** A money unit of a phone shift: its own 3-letter code, else the report's. */
export function phoneShiftCurrency(currency: string | null | undefined, fallback: string | null): string | null {
  return typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : fallback;
}

/** One phone shift in the Z Staff tab. */
export interface PhoneShiftStaffRow {
  id: string;
  staffName: string;
  role: string | null;
  phoneName: string;
  phoneState: 'active' | 'deactivated' | 'removed';
  checkIn: string | null;
  checkOut: string | null;
  currency: string | null;
  ordersCount: number | null;
  salesTotal: number | null;
  cashSales: number | null;
  cardSales: number | null;
  countedCash: number | null;
  /** Counted minus expected: positive over, negative short. */
  cashVariance: number | null;
  handover: ZReportPhoneShiftHandover | null;
}

/** A phone shift that closed in the live window (readiness `closed_shifts`). */
export function phoneShiftRowFromReadiness(shift: UnitClosedShift): PhoneShiftStaffRow {
  return {
    id: shift.id,
    staffName: unitShiftStaffLabel(shift),
    role: shift.role_type,
    phoneName: unitShiftPhoneLabel(shift),
    phoneState: unitShiftPhoneState(shift),
    checkIn: shift.check_in_time,
    checkOut: shift.check_out_time,
    currency: shift.currency,
    ordersCount: shift.total_orders_count,
    salesTotal: shift.total_sales_amount,
    cashSales: shift.total_cash_sales,
    cardSales: shift.total_card_sales,
    countedCash: shift.closing_cash_amount,
    cashVariance: shift.cash_variance,
    handover: shift.handover,
  };
}

/** A phone shift a committed Z stored (`zReport.phoneShifts`, already normalized). */
export function phoneShiftRowFromStoredZ(entry: ZReportPhoneShift): PhoneShiftStaffRow {
  return {
    id: entry.staffShiftId,
    staffName: entry.staffName?.trim() || entry.staffId?.trim() || entry.staffShiftId,
    role: entry.role ?? null,
    phoneName: entry.terminalName?.trim() || entry.terminalId?.trim() || '—',
    // An entry stored without the flag is shown as an ordinary phone.
    phoneState: entry.terminalActive === false
      ? 'deactivated'
      : entry.terminalActive === null ? 'removed' : 'active',
    checkIn: entry.checkIn ?? null,
    checkOut: entry.checkOut ?? null,
    currency: entry.currency ?? null,
    ordersCount: entry.ordersCount ?? null,
    salesTotal: entry.salesTotal ?? null,
    cashSales: entry.cashSales ?? null,
    cardSales: entry.cardSales ?? null,
    countedCash: entry.countedCash ?? null,
    cashVariance: entry.cashVariance ?? null,
    handover: entry.handover ?? null,
  };
}

export type UnitShiftsZRefusal = NonNullable<ReturnType<typeof unitShiftsZRefusal>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseJsonRecord(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The native Z stage's phone shift refusal (`Z_REPORT_UNIT_SHIFTS_OPEN` /
 * `Z_REPORT_UNIT_SHIFTS_UNAVAILABLE`) in a submit answer or a thrown error:
 * the value itself, a JSON error string, `error`, `data`. Detected by code,
 * never by text, so the operator reads it in the store's language.
 */
export function extractUnitShiftsZRefusal(value: unknown): UnitShiftsZRefusal | null {
  const visit = (candidate: unknown, depth: number): UnitShiftsZRefusal | null => {
    if (depth > 3 || candidate === null || candidate === undefined) return null;
    if (typeof candidate === 'string') {
      const parsed = parseJsonRecord(candidate);
      return parsed ? visit(parsed, depth + 1) : null;
    }
    if (candidate instanceof Error) {
      return visit(candidate.message, depth + 1);
    }
    if (!isRecord(candidate)) return null;
    return unitShiftsZRefusal(candidate)
      ?? visit(candidate.error, depth + 1)
      ?? visit(candidate.data, depth + 1);
  };
  return visit(value, 0);
}
