import { getBridge } from '../../lib';
import type { ShiftFinancialOpeningView } from '../../lib/ipc-contracts';
import type { StaffShift } from '../types';

type OpeningBridge = ReturnType<typeof getBridge>['shiftFinancialOpening'];

export interface FinancialOpeningScope {
  organizationId: string;
  branchId: string;
  terminalId: string;
  staffId: string;
}

/** Validate the whole displayed value, without parseFloat's partial/zero fallback. */
export function parseOpeningCents(displayed: string): number | null {
  if (!/^\d+(?:[,.]\d{1,2})?$/.test(displayed)) return null;
  const [whole, fraction = ''] = displayed.split(/[,.]/);
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 99_999_999 ? cents : null;
}

export function openingMatchesScope(opening: ShiftFinancialOpeningView, scope: FinancialOpeningScope): boolean {
  return opening.organizationId === scope.organizationId && opening.branchId === scope.branchId &&
    opening.terminalId === scope.terminalId && opening.staffId === scope.staffId;
}

/** A financial request or reply outlived the renderer lifecycle that issued it. */
export class FinancialOpeningInvalidatedError extends Error {
  constructor(message = 'Financial opening authority was invalidated') {
    super(message);
    this.name = 'FinancialOpeningInvalidatedError';
  }
}

// Transient renderer fence only. Keys, originals, queues and authorization stay native-owned;
// current usable, authorized tuples are remembered solely for same-cashier publication.
let generation = 0;
let clearAttempt = 0;
let pendingClear: Promise<boolean> | null = null;
let clearFailed = false;
const authorizedOpenings = new Map<string, string>();

function scopeKey(scope: Partial<FinancialOpeningScope>): string {
  return JSON.stringify([scope.organizationId, scope.branchId, scope.terminalId, scope.staffId]);
}

function isUsableAuthorized(opening: ShiftFinancialOpeningView | null | undefined): opening is ShiftFinancialOpeningView {
  return !!opening && opening.state === 'confirmed_usable' && opening.usable === true &&
    opening.hostedAuthorization?.state === 'authorized';
}

function observeAuthorized(response: unknown, requestedKey?: string | null): void {
  if (!response || typeof response !== 'object') return;
  // A full status replaces the observed originals; a keyed status can also prove
  // that its original disappeared from the current scope. Do not retain old authority.
  if (requestedKey === null) authorizedOpenings.clear();
  else if (requestedKey !== undefined) authorizedOpenings.delete(requestedKey);
  const { opening, openings } = response as { opening?: ShiftFinancialOpeningView; openings?: unknown };
  for (const view of [opening, ...(Array.isArray(openings) ? openings : [])] as ShiftFinancialOpeningView[]) {
    if (!view || typeof view.openingKey !== 'string') continue;
    authorizedOpenings.delete(view.openingKey);
    if (isUsableAuthorized(view)) authorizedOpenings.set(view.openingKey, scopeKey(view));
  }
}

/** Start the dedicated native clear now; only the latest attempt may set or lift the barrier. */
function startClear(): Promise<Awaited<ReturnType<OpeningBridge['clearAuthorization']>>> {
  generation += 1;
  const attempt = ++clearAttempt;
  authorizedOpenings.clear();
  let response: Promise<Awaited<ReturnType<OpeningBridge['clearAuthorization']>>>;
  try {
    response = Promise.resolve(getBridge().shiftFinancialOpening.clearAuthorization());
  } catch (error) {
    response = Promise.reject(error);
  }
  const settle = (ok: boolean) => {
    if (attempt === clearAttempt) {
      pendingClear = null;
      clearFailed = !ok;
    }
    return ok;
  };
  pendingClear = response.then(
    (result) => settle(result?.success === true),
    () => settle(false),
  );
  return response;
}

async function settledClear(): Promise<void> {
  while (pendingClear) await pendingClear;
  if (clearFailed) throw new FinancialOpeningInvalidatedError('Financial opening authorization clear failed');
}

/** Issue only after any clear succeeded, and refuse replies that outlive an invalidation. */
function fenced<T>(issue: () => Promise<T>, observe: boolean, requestedKey?: string | null): Promise<T> {
  const issuedAt = generation;
  const run = () => Promise.resolve(issue()).then((result) => {
    if (issuedAt !== generation) throw new FinancialOpeningInvalidatedError();
    if (observe) observeAuthorized(result, requestedKey);
    return result;
  });
  if (!pendingClear && !clearFailed) return run();
  return settledClear().then(() => {
    if (issuedAt !== generation) throw new FinancialOpeningInvalidatedError();
    return run();
  });
}

/**
 * Synchronously fence every in-flight financial reply and start the dedicated native clear,
 * never queued behind a pending begin/authorize. Shift/EOD state is deliberately untouched.
 */
export function invalidateFinancialOpening(): void {
  void startClear();
}

/** Whether this exact tuple was seen usable and authorized since the last clear. */
export function isFinancialOpeningAuthorizedFor(scope: Partial<FinancialOpeningScope> | null | undefined): boolean {
  return !!scope && [...authorizedOpenings.values()].includes(scopeKey(scope));
}

function confirmedShiftRow(opening: ShiftFinancialOpeningView, response: unknown): StaffShift | null {
  if (!response || typeof response !== 'object') return null;
  const envelope = response as { success?: boolean; data?: unknown };
  if (envelope.success === false) return null;
  const value = envelope.data ?? response;
  if (!value || typeof value !== 'object') return null;
  const shift = value as Partial<StaffShift>;
  if (shift.id !== opening.shiftId || shift.staff_id !== opening.staffId ||
      shift.branch_id !== opening.branchId || shift.terminal_id !== opening.terminalId ||
      shift.role_type !== 'cashier' || shift.status !== 'active' ||
      shift.check_in_time !== opening.checkedInAt || shift.opening_cash_amount !== opening.openingCents / 100 ||
      typeof shift.created_at !== 'string' || typeof shift.updated_at !== 'string' ||
      !['total_orders_count', 'total_sales_amount', 'total_cash_sales', 'total_card_sales'].every(
        (key) => typeof (value as Record<string, unknown>)[key] === 'number',
      )) return null;
  return shift as StaffShift;
}

/** Thin native consumer: originals, authorization and recovery stay native-owned. */
export const financialOpening = {
  begin: (input: Parameters<OpeningBridge['begin']>[0]) =>
    fenced(() => getBridge().shiftFinancialOpening.begin(input), true),
  authorize: (openingKey: string, pin: string) =>
    fenced(() => getBridge().shiftFinancialOpening.authorize({ openingKey, pin }), true, openingKey),
  status: (openingKey?: string) =>
    fenced(() => getBridge().shiftFinancialOpening.status(openingKey ? { openingKey } : undefined), true, openingKey ?? null),
  clearAuthorization: () => startClear(),
  async readConfirmedShift(opening: ShiftFinancialOpeningView): Promise<StaffShift | null> {
    if (!isUsableAuthorized(opening)) return null;
    let response: unknown;
    try {
      response = await fenced<unknown>(() => getBridge().shifts.getById(opening.shiftId), false);
    } catch (error) {
      // A row read that outlived an invalidation or failed clear never publishes.
      if (error instanceof FinancialOpeningInvalidatedError) return null;
      throw error;
    }
    return confirmedShiftRow(opening, response);
  },
};
