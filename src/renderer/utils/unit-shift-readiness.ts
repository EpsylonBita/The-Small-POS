/**
 * Phone shifts of this Main's unit (founder rule 13/10/2026: phones always
 * hand over to the Main).
 *
 * A phone ("mobile_waiter" child terminal) shift lives only on the server and
 * on the phone; this till's database never holds it. Every Main-side check
 * (the Z, the cashier's own close, the "Cash awaiting receipt" list and the
 * live notice) asks `GET /api/pos/shifts/unit-readiness` instead. Contract:
 * `docs/architecture/phone-shift-handover.md`.
 *
 * A read that fails is `unavailable`, never "no phone shifts": an empty list
 * would let a Z or a cashier close through. Only a server without the
 * endpoint (404) or a till that is not a Main (403 `UNIT_READINESS_MAIN_ONLY`)
 * is `unsupported`, which skips the check like the native Z stage does.
 */
import { getCachedTerminalCredentials } from '../services/terminal-credentials';

export type UnitShiftHandover = 'received' | 'pending' | 'none' | 'not_counted';

export const UNIT_SHIFT_HANDOVER_STATES: readonly UnitShiftHandover[] = [
  'received',
  'pending',
  'none',
  'not_counted',
] as const;

export interface UnitShift {
  id: string;
  staff_id: string | null;
  staff_name: string | null;
  /** Any role: waiter, server, driver, cashier, manager, kitchen. */
  role_type: string | null;
  terminal_id: string;
  terminal_name: string | null;
  /** `false` for a deactivated phone, `null` when its terminal row is gone. */
  terminal_active: boolean | null;
  check_in_time: string | null;
  currency: string | null;
  opening_cash_amount: number | null;
  /** The phone's last heartbeat (open shifts only), `null` when unknown. */
  terminal_last_seen_at: string | null;
}

/**
 * How a pending till is settled: `receive` (this Main's current receiver can
 * take it now with the receipt), `needs_cashier` (received here once a
 * cashier with an open drawer in its currency is checked in on the Main),
 * `manager` (no in-app path: a manager settles it), `null` when nothing is
 * pending. Founder decision 15/10/2026: the Main always receives.
 */
export type UnitShiftSettle = 'receive' | 'needs_cashier' | 'manager' | null;

export interface UnitClosedShift extends UnitShift {
  status: 'closed' | 'abandoned';
  check_out_time: string | null;
  closing_cash_amount: number | null;
  expected_cash_amount: number | null;
  cash_variance: number | null;
  total_orders_count: number | null;
  total_sales_amount: number | null;
  total_cash_sales: number | null;
  total_card_sales: number | null;
  handover: UnitShiftHandover;
  /** `main` when the Main closed it (remote checkout), else `phone`. */
  closed_by: 'main' | 'phone';
  /** When the Main took the till, if it did. */
  received_at: string | null;
  /**
   * Exact: this Main's current receiver (the latest checked-in cashier or
   * manager with an open drawer in the till's currency) can take it now with
   * the receipt RPC.
   */
  receivable: boolean;
  /** That receiver's shift, or `null`. */
  receiving_cashier_shift_id: string | null;
  settle: UnitShiftSettle;
}

export interface UnitTerminal {
  terminal_id: string;
  name: string | null;
  is_active: boolean;
  terminal_type: string | null;
  /** The phone's last heartbeat, `null` when unknown. */
  last_seen_at: string | null;
}

export interface UnitReadiness {
  mainTerminalId: string | null;
  checkedAt: string | null;
  since: string | null;
  /** Every open phone shift of the unit: each one blocks the Z and the cashier's close. */
  openShifts: UnitShift[];
  /** Phone shifts that ended at or after `since`, oldest first. */
  closedShifts: UnitClosedShift[];
  /** Closed tills whose cash or float the Main has not taken (31-day lookback). */
  pendingReturns: UnitClosedShift[];
  terminals: UnitTerminal[];
}

export type UnitReadinessResult =
  | { kind: 'ready'; readiness: UnitReadiness }
  /** A server without the endpoint (404) or a till that is not a Main (403). */
  | { kind: 'unsupported'; reason: 'not_found' | 'not_main' }
  | { kind: 'unavailable'; status: number | null; code: string | null; error: string };

export const UNIT_READINESS_MAIN_ONLY = 'UNIT_READINESS_MAIN_ONLY';
/** The only remote-checkout refusal that is not final: try again. */
export const REMOTE_HANDOVER_RETRY = 'REMOTE_HANDOVER_RETRY';
export const Z_REPORT_UNIT_SHIFTS_OPEN = 'Z_REPORT_UNIT_SHIFTS_OPEN';
export const Z_REPORT_UNIT_SHIFTS_UNAVAILABLE = 'Z_REPORT_UNIT_SHIFTS_UNAVAILABLE';

export interface UnitReadinessReader {
  unitReadiness(since?: string | null): Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

class MalformedReadiness extends Error {}

function parseShift(value: unknown): UnitShift {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.terminal_id !== 'string' || !value.terminal_id.trim()) {
    throw new MalformedReadiness('shift');
  }
  return {
    id: value.id,
    staff_id: optionalString(value.staff_id),
    staff_name: optionalString(value.staff_name),
    role_type: optionalString(value.role_type),
    terminal_id: value.terminal_id,
    terminal_name: optionalString(value.terminal_name),
    terminal_active: typeof value.terminal_active === 'boolean' ? value.terminal_active : null,
    check_in_time: optionalString(value.check_in_time),
    currency: optionalString(value.currency),
    opening_cash_amount: optionalNumber(value.opening_cash_amount),
    terminal_last_seen_at: optionalString(value.terminal_last_seen_at),
  };
}

function parseClosedShift(value: unknown): UnitClosedShift {
  const shift = parseShift(value);
  const record = value as Record<string, unknown>;
  const handover = UNIT_SHIFT_HANDOVER_STATES.includes(record.handover as UnitShiftHandover)
    ? record.handover as UnitShiftHandover
    : null;
  if (!handover) {
    throw new MalformedReadiness('handover');
  }
  return {
    ...shift,
    status: record.status === 'abandoned' ? 'abandoned' : 'closed',
    check_out_time: optionalString(record.check_out_time),
    closing_cash_amount: optionalNumber(record.closing_cash_amount),
    expected_cash_amount: optionalNumber(record.expected_cash_amount),
    cash_variance: optionalNumber(record.cash_variance),
    total_orders_count: optionalNumber(record.total_orders_count),
    total_sales_amount: optionalNumber(record.total_sales_amount),
    total_cash_sales: optionalNumber(record.total_cash_sales),
    total_card_sales: optionalNumber(record.total_card_sales),
    handover,
    closed_by: record.closed_by === 'main' ? 'main' : 'phone',
    received_at: optionalString(record.received_at),
    receivable: record.receivable === true,
    receiving_cashier_shift_id: optionalString(record.receiving_cashier_shift_id),
    settle: record.settle === 'receive' || record.settle === 'needs_cashier' || record.settle === 'manager'
      ? record.settle
      : null,
  };
}

function parseTerminal(value: unknown): UnitTerminal {
  if (!isRecord(value) || typeof value.terminal_id !== 'string' || !value.terminal_id.trim()) {
    throw new MalformedReadiness('terminal');
  }
  return {
    terminal_id: value.terminal_id,
    name: optionalString(value.name),
    is_active: value.is_active !== false,
    terminal_type: optionalString(value.terminal_type),
    last_seen_at: optionalString(value.last_seen_at),
  };
}

/**
 * The server's readiness body. Anything that is not the documented shape is
 * `null` (the caller reports "unavailable"), never a partial list.
 */
export function parseUnitReadiness(body: unknown): UnitReadiness | null {
  if (!isRecord(body) || body.success !== true
    || !Array.isArray(body.open_shifts)
    || !Array.isArray(body.closed_shifts)
    || !Array.isArray(body.pending_returns)) {
    return null;
  }
  try {
    return {
      mainTerminalId: optionalString(body.main_terminal_id),
      checkedAt: optionalString(body.checked_at),
      since: optionalString(body.since),
      openShifts: body.open_shifts.map(parseShift),
      closedShifts: body.closed_shifts.map(parseClosedShift),
      pendingReturns: body.pending_returns.map(parseClosedShift),
      terminals: Array.isArray(body.terminals) ? body.terminals.map(parseTerminal) : [],
    };
  } catch (error) {
    if (error instanceof MalformedReadiness) return null;
    throw error;
  }
}

/**
 * Read this Main's phone shifts through the native admin bridge
 * (`bridge.shifts.unitReadiness`). Never throws.
 */
export async function readUnitShiftReadiness(
  shifts: UnitReadinessReader,
  since?: string | null,
): Promise<UnitReadinessResult> {
  let response: unknown;
  try {
    response = await shifts.unitReadiness(since ?? null);
  } catch (error) {
    return {
      kind: 'unavailable',
      status: null,
      code: null,
      error: error instanceof Error ? error.message : String(error ?? 'unavailable'),
    };
  }
  const envelope = isRecord(response) ? response : {};
  const status = typeof envelope.status === 'number' ? envelope.status : null;
  const code = typeof envelope.code === 'string' ? envelope.code : null;
  if (envelope.success === false) {
    if (status === 404) {
      return { kind: 'unsupported', reason: 'not_found' };
    }
    if (status === 403 && code === UNIT_READINESS_MAIN_ONLY) {
      return { kind: 'unsupported', reason: 'not_main' };
    }
    return {
      kind: 'unavailable',
      status,
      code,
      error: typeof envelope.error === 'string' && envelope.error ? envelope.error : 'unavailable',
    };
  }
  const readiness = parseUnitReadiness('data' in envelope ? envelope.data : response);
  if (!readiness) {
    return { kind: 'unavailable', status, code: null, error: 'UNIT_READINESS_MALFORMED' };
  }
  return { kind: 'ready', readiness };
}

/** `since` for a Z window: its start, unless the till never closed a Z (epoch). */
export function readinessSinceFromPeriodStart(periodStart: unknown): string | null {
  if (typeof periodStart !== 'string' || !periodStart.trim()) return null;
  const millis = Date.parse(periodStart);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis).toISOString();
}

/** The staff member's name as the server gave it, never translated. */
export function unitShiftStaffLabel(shift: Pick<UnitShift, 'staff_name' | 'staff_id' | 'id'>): string {
  return shift.staff_name?.trim() || shift.staff_id?.trim() || shift.id;
}

/** The phone's name, else its terminal id. */
export function unitShiftPhoneLabel(shift: Pick<UnitShift, 'terminal_name' | 'terminal_id'>): string {
  return shift.terminal_name?.trim() || shift.terminal_id;
}

/** `deactivated` for a phone switched off in the admin, `removed` when its row is gone. */
export function unitShiftPhoneState(
  shift: Pick<UnitShift, 'terminal_active'>,
): 'active' | 'deactivated' | 'removed' {
  if (shift.terminal_active === false) return 'deactivated';
  if (shift.terminal_active === null) return 'removed';
  return 'active';
}

/**
 * Cash still to take from a closed phone till: exactly its recorded count
 * (founder decision 15/10/2026: the Main receives the till's count, and a
 * count of 0 with a float is valid), else its float when no count was kept.
 */
export function unitShiftCashToReceive(shift: Pick<UnitClosedShift, 'closing_cash_amount' | 'opening_cash_amount'>): number {
  if (shift.closing_cash_amount !== null && Number.isFinite(shift.closing_cash_amount)) {
    return Math.max(shift.closing_cash_amount, 0);
  }
  return Math.max(shift.opening_cash_amount ?? 0, 0);
}

/**
 * A Z refused for phone shifts: the native stage's typed answer
 * (`errorCode: Z_REPORT_UNIT_SHIFTS_OPEN` with `openShifts`, the server's
 * `UnitShift` objects, or `Z_REPORT_UNIT_SHIFTS_UNAVAILABLE`), or `null` for
 * any other answer. An `openShifts` entry that cannot be read is dropped; the
 * refusal itself still stands.
 */
export function unitShiftsZRefusal(
  value: unknown,
): { kind: 'open'; openShifts: UnitShift[]; error: string | null } | { kind: 'unavailable'; error: string | null } | null {
  if (!isRecord(value)) return null;
  const code = typeof value.errorCode === 'string'
    ? value.errorCode
    : typeof value.code === 'string' ? value.code : null;
  const error = typeof value.error === 'string' && value.error.trim() ? value.error : null;
  if (code === Z_REPORT_UNIT_SHIFTS_UNAVAILABLE) {
    return { kind: 'unavailable', error };
  }
  if (code !== Z_REPORT_UNIT_SHIFTS_OPEN) return null;
  const raw = Array.isArray(value.openShifts)
    ? value.openShifts
    : Array.isArray(value.open_shifts) ? value.open_shifts : [];
  const openShifts: UnitShift[] = [];
  for (const entry of raw) {
    try {
      openShifts.push(parseShift(entry));
    } catch (parseError) {
      if (!(parseError instanceof MalformedReadiness)) throw parseError;
    }
  }
  return { kind: 'open', openShifts, error };
}

/**
 * Whether the unit has a phone: a child terminal that is not a kiosk (a kiosk
 * is a child too, but never holds a staff shift).
 */
export function unitHasPhones(readiness: Pick<UnitReadiness, 'terminals'>): boolean {
  return readiness.terminals.some((terminal) => terminal.terminal_type !== 'kiosk');
}

/** Nothing for the Main to do: no phone shift open and no till pending. */
export function unitIsQuiet(readiness: Pick<UnitReadiness, 'openShifts' | 'pendingReturns'>): boolean {
  return readiness.openShifts.length === 0 && readiness.pendingReturns.length === 0;
}

/** A phone heartbeat older than this, or none, may hide unsent orders. */
export const PHONE_LAST_SEEN_STALE_MS = 5 * 60_000;

/** `true` when the phone's last heartbeat is unknown or older than five minutes. */
export function phoneLastSeenIsStale(lastSeenAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastSeenAt) return true;
  const seen = Date.parse(lastSeenAt);
  return !Number.isFinite(seen) || now - seen > PHONE_LAST_SEEN_STALE_MS;
}

/**
 * Roles whose phone till counts cash. A shift of any other role (kitchen,
 * for example) has no cash handover: the Main may close it without one.
 */
export const CASH_PHONE_ROLES: readonly string[] = ['cashier', 'manager', 'driver', 'server', 'waiter'];

export function isNonCashPhoneRole(role: string | null | undefined): boolean {
  const normalized = (role ?? '').trim().toLowerCase();
  return normalized.length > 0 && !CASH_PHONE_ROLES.includes(normalized);
}

/**
 * The last good readiness read of this terminal, kept on the device so an
 * offline Main still knows what it last saw (coordinator review 14/10/2026):
 * opening the staff modal or pressing Refresh offline never replaces it with
 * "unavailable", and an offline cashier close passes when it showed no open
 * phone shift and no till to receive. Browser storage in try/catch: when it
 * is unavailable the Main simply has no remembered read.
 */
export const UNIT_READINESS_MEMORY_KEY = 'pos.unitShiftReadiness.lastGood.v1';

export interface RememberedUnitReadiness {
  terminalId: string;
  /** When the read was made (the server's `checked_at`, else this device's clock). */
  checkedAt: string;
  readiness: UnitReadiness;
}

function readinessBody(readiness: UnitReadiness): Record<string, unknown> {
  return {
    success: true,
    main_terminal_id: readiness.mainTerminalId,
    checked_at: readiness.checkedAt,
    since: readiness.since,
    open_shifts: readiness.openShifts,
    closed_shifts: readiness.closedShifts,
    pending_returns: readiness.pendingReturns,
    terminals: readiness.terminals,
  };
}

/** The terminal a remembered read belongs to: the caller's, else this terminal's. */
function memoryKey(terminalId: string | null | undefined): string | null {
  const explicit = terminalId?.trim();
  if (explicit) return explicit;
  try {
    return getCachedTerminalCredentials().terminalId.trim() || null;
  } catch {
    return null;
  }
}

function readMemory(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(UNIT_READINESS_MEMORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberUnitReadiness(
  terminalId: string | null | undefined,
  readiness: UnitReadiness,
  now: Date = new Date(),
): RememberedUnitReadiness | null {
  const key = memoryKey(terminalId);
  if (!key) return null;
  const remembered: RememberedUnitReadiness = {
    terminalId: key,
    checkedAt: readiness.checkedAt ?? now.toISOString(),
    readiness,
  };
  try {
    const memory = readMemory();
    memory[key] = { checkedAt: remembered.checkedAt, body: readinessBody(readiness) };
    localStorage.setItem(UNIT_READINESS_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // Storage unavailable: nothing is remembered across a reload.
  }
  return remembered;
}

export function lastGoodUnitReadiness(terminalId?: string | null): RememberedUnitReadiness | null {
  const key = memoryKey(terminalId);
  if (!key) return null;
  const entry = readMemory()[key];
  if (!isRecord(entry) || typeof entry.checkedAt !== 'string' || !Number.isFinite(Date.parse(entry.checkedAt))) {
    return null;
  }
  const readiness = parseUnitReadiness(entry.body);
  return readiness ? { terminalId: key, checkedAt: entry.checkedAt, readiness } : null;
}

/**
 * A fresh read, remembered when it is good. `lastGood` is that read, or, when
 * the fresh one failed, the last good read this terminal remembers (`null`
 * when there is none). An `unsupported` answer is never remembered.
 */
export async function readUnitShiftReadinessRemembered(
  shifts: UnitReadinessReader,
  terminalId: string | null | undefined,
  since?: string | null,
): Promise<{ result: UnitReadinessResult; lastGood: RememberedUnitReadiness | null }> {
  const result = await readUnitShiftReadiness(shifts, since);
  if (result.kind === 'ready') {
    // Without a known terminal id, this terminal's, else the answer's own Main id.
    const key = memoryKey(terminalId) ?? result.readiness.mainTerminalId;
    return {
      result,
      lastGood: rememberUnitReadiness(key, result.readiness)
        ?? { terminalId: key ?? '', checkedAt: result.readiness.checkedAt ?? new Date().toISOString(), readiness: result.readiness },
    };
  }
  return { result, lastGood: result.kind === 'unavailable' ? lastGoodUnitReadiness(terminalId) : null };
}

/**
 * Tills the cashier's close waits for (coordinator review 14/10/2026):
 * exactly the ones this Main can receive now (`receivable`) whose local claim
 * a manager has not released. Every other pending till is information: a
 * manager settles it.
 */
export function tillsToReceive(
  pendingReturns: readonly UnitClosedShift[],
  releasedSourceIds: ReadonlySet<string>,
): UnitClosedShift[] {
  return pendingReturns.filter((till) => till.receivable && !releasedSourceIds.has(till.id));
}

/** The satellite shifts whose only local claim a manager released (native journal). */
export async function readReleasedPhoneTills(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): Promise<Set<string>> {
  try {
    const reply = await invoke('shift_satellite_handover_recovery', { action: 'released_sources' });
    const ids = isRecord(reply) && Array.isArray(reply.satelliteShiftIds) ? reply.satelliteShiftIds : [];
    return new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0));
  } catch {
    // Unreadable: no claim counts as released, so a receivable till still waits.
    return new Set();
  }
}
