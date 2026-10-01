/**
 * Thin renderer client for native gift card funding (`giftFunding`, gift_funding_v1).
 *
 * Native owns every attempt key, the durable attempt journal, the hosted
 * cashier/manager sessions and each permission decision; the server decides
 * every funding write. This client only calls the typed bridge, classifies each
 * reply as ok, refused or lost (a thrown or malformed reply is an unknown
 * outcome, never a refusal) and narrows journal DTOs to the actor a screen may
 * show. It never creates a key, keeps a PIN or persists anything.
 */

import { getBridge } from '../../lib';
import type {
  GiftFundingAttemptResult,
  GiftFundingAttemptState,
  GiftFundingAttemptView,
  GiftFundingAvailability,
  GiftFundingAvailabilityAuthority,
  GiftFundingCashEvidence,
  GiftFundingDrawerView,
  GiftFundingExternalCardEvidence,
  GiftFundingGrantRequest,
  GiftFundingMode,
  GiftFundingModeAvailability,
  GiftFundingOperation,
  GiftFundingPrepareRequest,
  ShiftFinancialOpeningView,
} from '../../lib/ipc-contracts';
import { financialOpening, openingMatchesScope } from './financial-opening';

/** Who a funding reply must belong to: the native-confirmed actor and trusted terminal scope. */
export interface FundingActor {
  staffId: string;
  /** Null only before a trusted organization is known; it is then not compared. */
  organizationId: string | null;
  branchId: string;
  terminalId: string;
}

export interface FundingStaffOption {
  id: string;
  name: string;
}

/** Operator-recorded references of an external card terminal; never a verified capture. */
export interface ExternalCardReferences {
  provider: string;
  merchantId: string;
  terminalReference: string;
  transactionReference: string;
}

export type FundingRefused = { kind: 'refused'; code: string; error: string };
export type FundingLost = { kind: 'lost' };

export type AvailabilityOutcome =
  | { kind: 'ok'; availability: GiftFundingAvailability }
  | FundingRefused
  | FundingLost;
export type AttemptOutcome =
  | { kind: 'ok'; attempt: GiftFundingAttemptView; cardNumber: string | null }
  | (FundingRefused & { attempt: GiftFundingAttemptView | null })
  | FundingLost;
export type JournalOutcome = { kind: 'ok'; attempts: GiftFundingAttemptView[] } | FundingRefused | FundingLost;
export type ManagerOutcome = { kind: 'ok'; staffId: string; expiresAt: string } | FundingRefused | FundingLost;
export type DrawerOutcome = { kind: 'ok'; drawer: GiftFundingDrawerView } | FundingRefused | FundingLost;
export type OpeningOutcome = { kind: 'ok'; opening: ShiftFinancialOpeningView | null } | FundingLost;
export type RenewOutcome = { kind: 'ok'; opening: ShiftFinancialOpeningView } | FundingRefused | FundingLost;

type Loose<T> = { [K in keyof T]?: unknown };

interface Envelope {
  success?: unknown;
  code?: unknown;
  error?: unknown;
  attempt?: unknown;
  attempts?: unknown;
  cardNumber?: unknown;
  availability?: unknown;
  authorization?: unknown;
  drawer?: unknown;
  opening?: unknown;
  openings?: unknown;
}

interface DirectoryEntry {
  id?: unknown;
  name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  is_active?: unknown;
}

const LOST: FundingLost = { kind: 'lost' };
const MODES: readonly GiftFundingMode[] = ['cash_confirmed', 'external_card_recorded', 'manager_grant'];
const OPERATIONS: readonly GiftFundingOperation[] = ['issue', 'reload'];
const STATES: readonly GiftFundingAttemptState[] = [
  'prepare_pending',
  'prepared',
  'collection_pending',
  'collection_started',
  'complete_pending',
  'cancel_pending',
  'completed',
  'canceled',
  'refused',
  'abandoned',
];
const FINAL_STATES: readonly GiftFundingAttemptState[] = ['completed', 'canceled', 'refused', 'abandoned'];
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const PIN_PATTERN = /^\d{4,8}$/;
const REFERENCE_MAX_LENGTH = 128;
// The local directory the check-in modal keeps per branch; only ids and names are read here.
const STAFF_DIRECTORY_CATEGORY = 'staff_auth_cache';

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

async function settle<T>(issue: () => Promise<T>): Promise<T | undefined> {
  try {
    return await issue();
  } catch {
    // Transport loss, a thrown native error or a lifecycle fence: the outcome is unknown.
    return undefined;
  }
}

function refusedOf(envelope: Envelope): FundingRefused {
  return {
    kind: 'refused',
    code: isText(envelope.code) ? envelope.code : 'UNKNOWN',
    error: typeof envelope.error === 'string' ? envelope.error : '',
  };
}

export function isAttemptView(value: unknown): value is GiftFundingAttemptView {
  if (!isObject(value)) return false;
  const view = value as Loose<GiftFundingAttemptView>;
  return (
    isText(view.attemptKey) &&
    isText(view.organizationId) &&
    isText(view.branchId) &&
    isText(view.terminalId) &&
    isText(view.staffId) &&
    OPERATIONS.includes(view.operation as GiftFundingOperation) &&
    MODES.includes(view.mode as GiftFundingMode) &&
    STATES.includes(view.state as GiftFundingAttemptState) &&
    Number.isSafeInteger(view.amountCents) &&
    typeof view.currency === 'string' &&
    CURRENCY_PATTERN.test(view.currency) &&
    typeof view.collectionPermitted === 'boolean' &&
    (view.cardId == null || isText(view.cardId)) &&
    (view.result == null || isObject(view.result)) &&
    view.verifiedCapture === false &&
    view.fiscalReceipt === false
  );
}

function isAvailability(
  value: unknown,
  staffId: string,
  authority: GiftFundingAvailabilityAuthority,
): value is GiftFundingAvailability {
  if (!isObject(value)) return false;
  const view = value as Loose<GiftFundingAvailability>;
  const modes = isObject(view.modes) ? (view.modes as Partial<Record<GiftFundingMode, unknown>>) : null;
  const modesValid =
    modes !== null &&
    MODES.every((mode) => {
      const entry = modes[mode];
      if (!isObject(entry)) return false;
      const loose = entry as Loose<GiftFundingModeAvailability>;
      return (
        typeof loose.ready === 'boolean' &&
        typeof loose.supported === 'boolean' &&
        (loose.reason == null || typeof loose.reason === 'string')
      );
    });
  return (
    modesValid &&
    view.staffId === staffId &&
    view.authority === authority &&
    isText(view.organizationId) &&
    isText(view.branchId) &&
    isText(view.terminalId) &&
    typeof view.enabled === 'boolean' &&
    typeof view.unavailable === 'boolean' &&
    typeof view.fundingConfigured === 'boolean' &&
    (view.currency == null || (typeof view.currency === 'string' && CURRENCY_PATTERN.test(view.currency))) &&
    view.verifiedCapture === false &&
    view.fiscalReceipt === false
  );
}

async function attemptCall(issue: () => Promise<unknown>, expectedKey?: string): Promise<AttemptOutcome> {
  const reply = await settle(issue);
  if (!isObject(reply)) return LOST;
  const envelope = reply as Envelope;
  if (envelope.success === false) {
    const attempt =
      isAttemptView(envelope.attempt) && (!expectedKey || envelope.attempt.attemptKey === expectedKey)
        ? envelope.attempt
        : null;
    return { ...refusedOf(envelope), attempt };
  }
  if (envelope.success !== true || !isAttemptView(envelope.attempt)) return LOST;
  // A reply about another original is not an answer to this request.
  if (expectedKey && envelope.attempt.attemptKey !== expectedKey) return LOST;
  return {
    kind: 'ok',
    attempt: envelope.attempt,
    cardNumber: isText(envelope.cardNumber) ? envelope.cardNumber : null,
  };
}

export const isFinalFundingState = (state: GiftFundingAttemptState): boolean => FINAL_STATES.includes(state);

export function attemptBelongsTo(attempt: GiftFundingAttemptView, actor: FundingActor): boolean {
  return (
    attempt.staffId === actor.staffId &&
    attempt.branchId === actor.branchId &&
    attempt.terminalId === actor.terminalId &&
    (actor.organizationId === null || attempt.organizationId === actor.organizationId)
  );
}

/**
 * The actor's unfinished and recent completed originals (plus explicitly kept keys).
 * A native completion can survive a lost renderer reply, so completed journal rows
 * remain checkable after remount. The native list is bounded; this is not full history.
 * This is a UI disclosure boundary, not a permission claim: native and server still decide.
 */
export function fundingAttemptsFor(
  attempts: readonly GiftFundingAttemptView[],
  actor: FundingActor,
  grants: boolean,
  keep: readonly string[] = [],
): GiftFundingAttemptView[] {
  return attempts.filter(
    (attempt) =>
      attemptBelongsTo(attempt, actor) &&
      (attempt.mode === 'manager_grant') === grants &&
      (!isFinalFundingState(attempt.state) || attempt.state === 'completed' || keep.includes(attempt.attemptKey)),
  );
}

export function availabilityInScope(availability: GiftFundingAvailability, scope: FundingActor): boolean {
  return (
    availability.branchId === scope.branchId &&
    availability.terminalId === scope.terminalId &&
    (scope.organizationId === null || availability.organizationId === scope.organizationId)
  );
}

export function actorOf(availability: GiftFundingAvailability): FundingActor {
  return {
    staffId: availability.staffId,
    organizationId: availability.organizationId,
    branchId: availability.branchId,
    terminalId: availability.terminalId,
  };
}

/** The only outcome that may be shown as success. */
export function isStrictlyCompleted(
  attempt: GiftFundingAttemptView,
): attempt is GiftFundingAttemptView & { result: GiftFundingAttemptResult } {
  return (
    attempt.state === 'completed' && isObject(attempt.result) && Number.isSafeInteger(attempt.result.cardBalanceCents)
  );
}

/** Any unfinished original of the same operation (and card, for reload) blocks a fresh intent. */
export function blocksFreshIntent(
  attempt: GiftFundingAttemptView,
  operation: GiftFundingOperation,
  cardId: string | null,
): boolean {
  return (
    !isFinalFundingState(attempt.state) &&
    attempt.operation === operation &&
    (operation === 'issue' || attempt.cardId === cardId)
  );
}

/** Never begun, so never collected: the only state the operator may begin or cancel. */
export const mayBeginCollection = (attempt: GiftFundingAttemptView): boolean =>
  attempt.state === 'prepared' && attempt.mode !== 'manager_grant';
export const mayCancelFunding = (attempt: GiftFundingAttemptView): boolean => attempt.state === 'prepared';
/** Begun earlier (possibly in a lost reply): evidence of a real collection may be recorded, never re-collected. */
export const mayRecordCollection = (attempt: GiftFundingAttemptView): boolean =>
  attempt.state === 'collection_started' && attempt.mode !== 'manager_grant';

export const isFundingPin = (pin: string): boolean => PIN_PATTERN.test(pin);

/** Missing means no expiry; an unreadable timestamp counts as expired. */
export function isExpired(iso: string | null | undefined, now = Date.now()): boolean {
  if (iso == null) return false;
  const at = Date.parse(iso);
  return !Number.isFinite(at) || at <= now;
}

/** Exact cents and currency of the original; external references are operator-recorded. */
export function buildFundingEvidence(
  attempt: GiftFundingAttemptView,
  references: ExternalCardReferences,
): GiftFundingCashEvidence | GiftFundingExternalCardEvidence | null {
  if (attempt.mode === 'cash_confirmed') {
    return {
      kind: 'operator_cash_confirmation',
      amountCents: attempt.amountCents,
      currency: attempt.currency,
      confirmed: true,
    };
  }
  if (attempt.mode !== 'external_card_recorded') return null;
  const provider = references.provider.trim();
  const merchantId = references.merchantId.trim();
  const terminalReference = references.terminalReference.trim();
  const transactionReference = references.transactionReference.trim();
  const values = [provider, merchantId, terminalReference, transactionReference];
  if (values.some((value) => !value || value.length > REFERENCE_MAX_LENGTH)) return null;
  return {
    kind: 'external_card_recorded',
    amountCents: attempt.amountCents,
    currency: attempt.currency,
    confirmed: true,
    provider,
    merchantId,
    terminalReference,
    transactionReference,
  };
}

export const giftCardFunding = {
  /** Advisory hosted availability for the selected cashier or a separately authorized manager. */
  async availability(staffId: string, authority: GiftFundingAvailabilityAuthority): Promise<AvailabilityOutcome> {
    const reply = await settle(() => getBridge().giftFunding.availability({ staffId, authority }));
    if (!isObject(reply)) return LOST;
    const envelope = reply as Envelope;
    if (envelope.success === false) return refusedOf(envelope);
    return envelope.success === true && isAvailability(envelope.availability, staffId, authority)
      ? { kind: 'ok', availability: envelope.availability }
      : LOST;
  },

  /** The local native journal of this terminal scope. */
  async journal(): Promise<JournalOutcome> {
    const reply = await settle(() => getBridge().giftFunding.status());
    if (!isObject(reply)) return LOST;
    const envelope = reply as Envelope;
    if (envelope.success === false) return refusedOf(envelope);
    // One unreadable entry could hide an unfinished original, so the whole read fails.
    if (envelope.success !== true || !Array.isArray(envelope.attempts) || !envelope.attempts.every(isAttemptView)) {
      return LOST;
    }
    return { kind: 'ok', attempts: envelope.attempts as GiftFundingAttemptView[] };
  },

  prepare: (request: GiftFundingPrepareRequest) => attemptCall(() => getBridge().giftFunding.prepare(request)),
  grant: (request: GiftFundingGrantRequest) => attemptCall(() => getBridge().giftFunding.grant(request)),
  begin: (attemptKey: string) =>
    attemptCall(() => getBridge().giftFunding.beginCollection({ attemptKey }), attemptKey),
  complete: (attemptKey: string, evidence: GiftFundingCashEvidence | GiftFundingExternalCardEvidence) =>
    attemptCall(() => getBridge().giftFunding.complete({ attemptKey, evidence }), attemptKey),
  cancel: (attemptKey: string, reason: string) =>
    attemptCall(() => getBridge().giftFunding.cancel({ attemptKey, reason }), attemptKey),
  recover: (attemptKey: string) => attemptCall(() => getBridge().giftFunding.recover({ attemptKey }), attemptKey),

  async authorizeManager(staffId: string, pin: string): Promise<ManagerOutcome> {
    const reply = await settle(() => getBridge().giftFunding.authorizeManager({ staffId, pin }));
    if (!isObject(reply)) return LOST;
    const envelope = reply as Envelope;
    if (envelope.success === false) return refusedOf(envelope);
    const authorization = isObject(envelope.authorization)
      ? (envelope.authorization as Loose<{ staffId: string; expiresAt: string }>)
      : null;
    return envelope.success === true &&
      authorization !== null &&
      authorization.staffId === staffId &&
      isText(authorization.expiresAt)
      ? { kind: 'ok', staffId, expiresAt: authorization.expiresAt }
      : LOST;
  },

  async drawer(staffId: string): Promise<DrawerOutcome> {
    const reply = await settle(() => getBridge().giftFunding.refreshDrawer({ staffId }));
    if (!isObject(reply)) return LOST;
    const envelope = reply as Envelope;
    if (envelope.success === false) return refusedOf(envelope);
    const drawer = isObject(envelope.drawer) ? (envelope.drawer as Loose<GiftFundingDrawerView>) : null;
    return envelope.success === true &&
      drawer !== null &&
      isText(drawer.staffId) &&
      isText(drawer.shiftId) &&
      isText(drawer.currency)
      ? { kind: 'ok', drawer: drawer as GiftFundingDrawerView }
      : LOST;
  },

  /** The selected cashier's own original opening of this shift, through the fenced opening client. */
  async cashierOpening(actor: FundingActor, shiftId: string): Promise<OpeningOutcome> {
    const reply = await settle(() => financialOpening.status());
    if (!isObject(reply)) return LOST;
    const openings = (reply as Envelope).openings;
    if (!Array.isArray(openings)) return LOST;
    const opening = (openings as unknown[]).find((entry): entry is ShiftFinancialOpeningView => {
      if (!isObject(entry)) return false;
      const view = entry as Loose<ShiftFinancialOpeningView>;
      return (
        view.shiftId === shiftId &&
        view.staffId === actor.staffId &&
        view.branchId === actor.branchId &&
        view.terminalId === actor.terminalId &&
        (actor.organizationId === null || view.organizationId === actor.organizationId) &&
        isText(view.openingKey) &&
        isObject(view.hostedAuthorization)
      );
    });
    return { kind: 'ok', opening: opening ?? null };
  },

  /** Same-cashier renewal of that original; it never begins another shift or drawer. */
  async renewCashier(opening: ShiftFinancialOpeningView, pin: string): Promise<RenewOutcome> {
    const reply = await settle(() => financialOpening.authorize(opening.openingKey, pin));
    if (!isObject(reply)) return LOST;
    const envelope = reply as Envelope;
    if (envelope.success === false) return refusedOf(envelope);
    const view = isObject(envelope.opening) ? (envelope.opening as ShiftFinancialOpeningView) : null;
    return envelope.success === true &&
      view !== null &&
      view.openingKey === opening.openingKey &&
      view.shiftId === opening.shiftId &&
      openingMatchesScope(view, opening)
      ? { kind: 'ok', opening: view }
      : LOST;
  },

  /**
   * Local staff directory reduced to ids and names; PIN hashes and roles are dropped. The
   * server decides who may grant, so there is no role guessing, and the selected cashier is
   * always offered: one person may authorize a separate manager purpose.
   */
  async staffDirectory(branchId: string, selected: FundingStaffOption): Promise<FundingStaffOption[]> {
    const settings = getBridge().settings as unknown as {
      get(request: { category: string; key: string; defaultValue: string }): Promise<unknown>;
    };
    const raw = await settle(() =>
      settings.get({ category: STAFF_DIRECTORY_CATEGORY, key: `branch_${branchId.trim()}`, defaultValue: '' }),
    );
    const options: FundingStaffOption[] = [];
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as { branch_id?: unknown; staff?: unknown };
        const cachedBranch = typeof parsed.branch_id === 'string' ? parsed.branch_id.trim() : '';
        const entries = cachedBranch && cachedBranch !== branchId.trim() ? [] : parsed.staff;
        for (const entry of Array.isArray(entries) ? (entries as unknown[]) : []) {
          if (!isObject(entry)) continue;
          const member = entry as DirectoryEntry;
          const id = typeof member.id === 'string' ? member.id.trim() : '';
          if (!id || member.is_active === false || options.some((option) => option.id === id)) continue;
          const fullName = [member.first_name, member.last_name].filter(isText).join(' ').trim();
          const name = typeof member.name === 'string' && member.name.trim() ? member.name.trim() : fullName || id;
          options.push({ id, name });
        }
      } catch {
        // An unreadable directory still offers the selected cashier.
      }
    }
    if (!options.some((option) => option.id === selected.id)) options.unshift(selected);
    return options;
  },
};
