/**
 * Shared IPC DTO contracts for renderer/native bridge calls.
 * These types are intentionally runtime-agnostic and reusable by any caller.
 */

// -- Auth --------------------------------------------------------------------

export interface AuthSetupPinRequest {
  adminPin?: string;
  staffPin?: string;
}

export type PrivilegedActionScope = 'system_control' | 'cash_drawer_control';

/**
 * A money action a manager approves with their own PIN when nobody is on
 * shift at this terminal (fix review 30/09/2026): a payment (record, give
 * back) or an order cancel. The till names it in its REAUTH_REQUIRED answer.
 */
export type MoneyApproval = 'void_payments' | 'void_orders';

export interface PrivilegedActionConfirmRequest {
  pin: string;
  scope: PrivilegedActionScope;
  /** Set when the till asked for a manager's approval (no shift here). */
  approval?: MoneyApproval;
}

export interface PrivilegedActionConfirmResponse {
  success: boolean;
  scope: PrivilegedActionScope;
  sessionId: string;
  ttlSeconds: number;
  expiresAt: string;
  /** A manager's approval: what it approves, who gave it, how. */
  approval?: MoneyApproval;
  approvedBy?: string;
  via?: 'manager_pin';
}

export interface PrivilegedActionErrorPayload {
  code: 'UNAUTHORIZED' | 'REAUTH_REQUIRED' | string;
  scope?: string;
  reason?: string;
  ttlSeconds?: number | null;
  /** The till asks a manager's own PIN for this approval (no shift here). */
  approval?: MoneyApproval | null;
}

export interface StaffCheckInPinVerifyRequest {
  staffId: string;
  branchId: string;
  pin: string;
}

export interface StaffCheckInPinVerifyResponse {
  success: boolean;
  staffId?: string;
  branchId?: string;
  /**
   * Machine-readable reason for a `success: false` outcome. Known values:
   *   - `staff_auth_unavailable` — local cache missing / offline
   *   - `staff_not_available_offline` — staff id absent from local cache
   *   - `pos_login_disabled` — staff not allowed to log in on POS
   *   - `pin_not_configured` — staff has no POS PIN
   *   - `invalid_pin` — PIN didn't match the hash
   *   - `staff_busy_elsewhere` — staff has an open shift on another terminal
   */
  reasonCode?: string;
  error?: string;
  /** Populated only when reasonCode === 'staff_busy_elsewhere'. */
  busyTerminalId?: string | null;
  busyTerminalName?: string;
  busyRole?: string;
  busyShiftId?: string;
  busyCheckedInAt?: string;
}

// -- Settings / Terminal Config ----------------------------------------------

export interface SettingsConfiguredResponse {
  configured: boolean;
  reason?: string;
}

export interface SettingsCredentialStatus {
  hasAdminUrl: boolean;
  hasApiKey: boolean;
  hasTerminalId: boolean;
}

export interface ResetStartResponse {
  success: boolean;
  started?: boolean;
  operationId?: string | null;
  mode?: string | null;
  error?: string;
}

export interface ResetStatus {
  operationId: string;
  mode: string;
  phase: string;
  state: string;
  updatedAt: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  failingKey?: string | null;
  failingPath?: string | null;
}

export interface SettingsGetRequest {
  category?: string;
  key?: string;
  settingType?: string;
  settingKey?: string;
  defaultValue?: unknown;
  default?: unknown;
}

export interface SettingsSetRequest {
  category?: string;
  key?: string;
  settingType?: string;
  settingKey?: string;
  value?: unknown;
  settingValue?: unknown;
}

export interface SettingsUpdateLocalObjectRequest {
  settingType: string;
  settings: Record<string, unknown>;
}

export interface SettingsUpdateLocalCategoryRequest {
  category: string;
  settings: Record<string, unknown>;
}

export interface SettingsUpdateLocalKeyValueRequest {
  key: string;
  value: unknown;
}

export type SettingsUpdateLocalRequest =
  | SettingsUpdateLocalObjectRequest
  | SettingsUpdateLocalCategoryRequest
  | SettingsUpdateLocalKeyValueRequest;

export interface TerminalConfigGetSettingRequest {
  category?: string;
  key?: string;
  settingType?: string;
  settingKey?: string;
  fullKey?: string;
  setting?: string;
  name?: string;
}

export type SyncHealthState = 'polling' | 'stale' | 'offline';

export interface TerminalRuntimeConfig {
  terminal_id?: string | null;
  branch_id?: string | null;
  organization_id?: string | null;
  admin_dashboard_url?: string | null;
  admin_url?: string | null;
  business_type?: string | null;
  terminal_type?: string | null;
  parent_terminal_id?: string | null;
  owner_terminal_id?: string | null;
  owner_terminal_db_id?: string | null;
  source_terminal_id?: string | null;
  source_terminal_db_id?: string | null;
  pos_operating_mode?: string | null;
  enabled_features?: Record<string, boolean>;
  last_config_sync_at?: string | null;
  ghost_mode_feature_enabled?: string | boolean | null;
  sync_health?: SyncHealthState;
  // Compatibility aliases while the renderer migrates.
  terminalType?: string | null;
  parentTerminalId?: string | null;
  ownerTerminalId?: string | null;
  ownerTerminalDbId?: string | null;
  sourceTerminalId?: string | null;
  sourceTerminalDbId?: string | null;
  posOperatingMode?: string | null;
  features?: Record<string, boolean>;
}

// -- Sync --------------------------------------------------------------------

export interface SyncValidatePendingOrdersResponse {
  success: boolean;
  total_pending: number;
  valid: number;
  invalid: number;
  invalid_orders: DiagnosticsInvalidOrder[];
}

export interface SyncRemoveInvalidOrdersResponse {
  success: boolean;
  removed: number;
  message?: string;
  order_ids?: string[];
}

export type SyncFinancialQueueStatus =
  | 'failed'
  | 'pending'
  | 'in_progress'
  | 'deferred'
  | 'queued_remote'
  | 'synced'
  | 'applied'
  | string;

export interface SyncFinancialQueueItem {
  queueId: number;
  entityType: string;
  entityId: string;
  operation: string;
  status: SyncFinancialQueueStatus;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  payload: string;
  parentShiftId?: string | null;
  parentShiftSyncStatus?: string | null;
  parentShiftQueueId?: number | null;
  parentShiftQueueStatus?: string | null;
  dependencyBlockReason?: string | null;
}

export interface SyncFinancialQueueItemsResponse {
  items: SyncFinancialQueueItem[];
}

export interface SyncFinancialIntegrityIssue {
  entityType: string;
  entityId: string;
  orderId?: string | null;
  orderNumber?: string | null;
  paymentId?: string | null;
  adjustmentId?: string | null;
  queueId?: number | null;
  queueStatus?: string | null;
  reasonCode: string;
  suggestedFix: string;
  syncState?: string | null;
  parentSyncState?: string | null;
  parentHasRemoteIdentity?: boolean | null;
  lastError?: string | null;
  details?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  legacyParityRowId?: string | null;
}

export interface SyncFinancialIntegrityResponse {
  valid: boolean;
  issues: SyncFinancialIntegrityIssue[];
}

export interface UnsettledPaymentBlocker {
  orderId: string;
  orderNumber: string;
  totalAmount: number;
  settledAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  /**
   * `missing_local_payment_row` · `no_persisted_payment` ·
   * `partial_*` · `split_payment_incomplete` · `unsupported_payment_method`
   * and, since the 16/09/2026 reconciliation work:
   * `overpaid_order` · `duplicate_payment` ·
   * `platform_settlement_mismatch` · `platform_settlement_missing`
   * and, since 30/09/2026: `payments_need_review` (one per payment set aside
   * as a possible duplicate; see `reviewPayment`) and `payments_not_saved`
   * (one per card charged on this till whose payment is not saved yet; see
   * `unsavedPayment`).
   */
  reasonCode: string;
  reasonText: string;
  suggestedFix: string;
  /** `blocking` (the Z must not close) or `warning`. Absent on ≤1.4.113. */
  severity?: 'blocking' | 'warning';
  /**
   * Order total − settled, in cents. Negative means the ledger holds MORE
   * than the order is worth (overpayment / duplicate settlement).
   */
  differenceCents?: number;
  /**
   * The money `reasonText` names, in cents, keyed by the placeholder the
   * localized sentence uses — `drawerAmount`, `platformSettledAmount`,
   * `overpaidAmount`, `netSettledAmount`, `ceilingAmount`.
   *
   * Absent on ≤1.4.114, and absent for reason codes whose sentence only needs
   * the order's own total and settled figures.
   */
  reasonAmounts?: Record<string, number>;
  /**
   * Which sentence a reason code with more than one shape is telling.
   * `platform_settlement_mismatch` covers two opposite breaks — platform money
   * booked as drawer takings (`platform_holds`) and store money booked as
   * platform revenue (`store_collects`, `store_collects_platform_order`) — and
   * one translated sentence cannot honestly say both.
   * `payments_not_saved` uses `cannot_save` (no save can succeed any more),
   * `new_order` and `new_order_cannot_save` (a card charged at new-order
   * checkout whose order is not written yet).
   *
   * Absent on ≤1.4.114 and for single-shaped reason codes.
   */
  reasonVariant?: string;
  /**
   * `payments_need_review` only: the payment set aside. It is counted nowhere;
   * the day closes once a manager confirms it was given back.
   */
  reviewPayment?: ReviewPaymentSummary;
  /**
   * `payments_not_saved` only: the card money charged on this till whose
   * payment row could not be saved yet. The day closes once it is saved, or a
   * manager confirms the money was given back.
   */
  unsavedPayment?: UnsavedPaymentSummary;
  /**
   * The delivery platform holds this order's money (shared rule R4, round 3,
   * 01/10/2026): the server refused a till payment on it as platform-held,
   * its disposition says so, or a platform settlement is recorded on it.
   * "Record the payment" (cash or card) is never offered for it; the money
   * is restored from the server. Sent only when true.
   */
  platformHeld?: boolean;
}

/** A card payment charged on this till and not saved yet (30/09/2026). */
export interface UnsavedPaymentSummary {
  idempotencyKey: string;
  method: string;
  amount: number;
  amountCents: number;
  currency: string;
  /** When the terminal approved it (ISO 8601). */
  capturedAt: string;
  /**
   * `single`, `split_portion`, `collect_outstanding` or `new_order_checkout`
   * (a card charged at new-order checkout whose order is not saved yet).
   */
  kind: string;
  attempts: number;
  /** False after a refusal no save can change: only the resolution is left. */
  canSaveAgain: boolean;
}

/** A payment set aside as a possible duplicate (30/09/2026). */
export interface ReviewPaymentSummary {
  paymentId: string;
  method: string;
  amount: number;
  amountCents: number;
  currency: string;
  /** When the payment was taken (ISO 8601). */
  takenAt: string;
  /**
   * `already_paid`, `order_already_covered`, `exceeds_amount_due` or
   * `platform_held` (cash/card the server refused on money a delivery
   * platform holds, `PLATFORM_HELD_ORDER`).
   */
  reason: string;
  detectedAt?: string;
}

/**
 * The Z-report reconciliation block: does the order side of the day agree
 * with the payment side?
 *
 * `orderTurnover` (Σ order totals, = `sales.totalSales`) and
 * `paymentCoverage` (Σ completed payments, = `daySummary.total`) are shown
 * side by side and NEVER summed — platform turnover already lives inside
 * both. On the founder's 16/09/2026 Z they read €1.636,16 against €1.105,73
 * and the report closed without a word; `findings` is why it no longer can.
 */
export interface ZReportIntegrity {
  orderTurnover: number;
  paymentCoverage: number;
  /** orderTurnover − paymentCoverage, raw arithmetic. */
  difference: number;
  /**
   * The part of `difference` with a known, legitimate cause — today, orders
   * whose `refunded` status keeps them in turnover but out of coverage. A
   * normal refund must not read as a financial-integrity gap.
   */
  explainedDifference?: number;
  /**
   * `difference − explainedDifference`. THIS is the number that means
   * something is wrong, and the one the panel colours on.
   */
  unexplainedDifference?: number;
  /** Orders excluded from the payment side by their `refunded` status. */
  refundedOrders?: { orders: number; amount: number };
  /** Money missing because a paid order has no ledger coverage. */
  uncoveredAmount: number;
  /** Money the ledger holds beyond the orders' worth. */
  excessAmount: number;
  blockingFindings: number;
  warningFindings: number;
  findingsByReason?: Array<{
    reasonCode: string;
    orders: number;
    difference: number;
  }>;
  findings: UnsettledPaymentBlocker[];
  /**
   * Orders held back because an earlier Z already closed their day. Excluded
   * from every total, reported so nothing disappears silently.
   */
  carriedOverFromClosedDays?: { orders: number; amount: number };
  /**
   * Order sources that name neither one of our own channels (`pos`, `kiosk`,
   * `web`, `android-ios`) nor a marketplace we know.
   *
   * `orders.plugin` shares its namespace with payment gateways, analytics,
   * e-invoicing and e-commerce integrations (`stripe`, `viva`, `mydata`,
   * `woocommerce`, …), so an unrecognised slug is NOT guessed into
   * ΠΛΑΤΦΟΡΜΕΣ. Its money stays fully counted in `orderTurnover` and
   * `paymentCoverage`; only the platform attribution is withheld, and it is
   * named here so the slug can be classified.
   */
  unclassifiedPlatforms?: Array<{ source: string; orders: number; amount: number }>;
  reconciled: boolean;
}

export interface PaymentIntegrityErrorPayload {
  errorCode?: string;
  error?: string;
  message?: string;
  blockers?: UnsettledPaymentBlocker[];
}

export interface SyncBlockerDetail {
  queueId: number;
  entityType: string;
  entityId: string;
  operation: string;
  queueStatus: string;
  blockerReason: string;
  orderId?: string | null;
  orderNumber?: string | null;
  paymentId?: string | null;
  adjustmentId?: string | null;
  lastError?: string | null;
  paymentMethod?: string | null;
  paymentAmount?: number | null;
  paymentTransactionRef?: string | null;
  paymentSyncState?: string | null;
  paymentSyncStatus?: string | null;
  remotePaymentIdPresent?: boolean | null;
  orderTotalAmount?: number | null;
  orderSettledAmount?: number | null;
  orderOutstandingAmount?: number | null;
  paymentCreatedAt?: string | null;
  paymentUpdatedAt?: string | null;
}

export type ZReportSyncState =
  | 'pending'
  | 'syncing'
  | 'applied'
  | 'failed'
  | string;

export type EndOfDayStatus =
  | 'idle'
  | 'pending_local_submit'
  | 'submitted_pending_admin'
  | string;

export interface EndOfDayStatusResponse {
  status: EndOfDayStatus;
  pendingReportDate?: string | null;
  cutoffAt?: string | null;
  periodStartAt?: string | null;
  activeReportDate?: string | null;
  activePeriodStartAt?: string | null;
  latestZReportId?: string | null;
  latestZReportSyncState?: string | null;
  canOpenPendingZReport?: boolean;
}

export interface ZReportSubmitResponse extends PaymentIntegrityErrorPayload {
  success: boolean;
  data?: unknown;
  cleanup?: Record<string, number>;
  lastZReportTimestamp?: string;
  zReportId?: string | null;
  localDayClosed?: boolean;
  syncQueued?: boolean;
  syncState?: ZReportSyncState | null;
  stage?: string;
  stageCode?: string;
  syncItemCount?: number;
  blockersSummary?: string;
  syncBlockerDetails?: SyncBlockerDetail[];
  message?: string;
  error?: string;
}

// -- Shift financial opening (gift_opening_v1) ---------------------------------
// The three native financial opening commands take the positional
// `{ arg0: payload }` envelope. Native owns the opening key, the original
// shift/drawer ids, the captured tuple, the queued original and the selected
// cashier's volatile hosted session. The PIN is a transient request field; no
// response ever carries a PIN or a staff session.

/** Starts a new original, or re-authorizes the same `openingKey`. */
export interface ShiftFinancialOpeningBeginRequest {
  openingKey?: string;
  staffId: string;
  staffName?: string;
  /** Integer cents, 0..99_999_999. */
  openingCents: number;
  /** Uppercase ISO 4217 code. */
  currency: string;
  /** Transient 4..8 digit PIN of the selected cashier. */
  pin: string;
}

/** Same-cashier hosted re-authorization of an existing original. */
export interface ShiftFinancialOpeningAuthorizeRequest {
  openingKey: string;
  pin: string;
}

export interface ShiftFinancialOpeningStatusRequest {
  openingKey?: string;
}

export type ShiftFinancialOpeningState = 'pending' | 'confirmed_usable' | 'confirmed_unusable';

export interface ShiftFinancialOpeningDrawer {
  version: number;
  acknowledgementId: string | null;
  giftCashCents: number;
  ordinaryExpectedCents: number;
  expectedCents: number;
}

export interface ShiftFinancialOpeningView {
  openingKey: string;
  shiftId: string;
  drawerId: string;
  staffId: string;
  organizationId: string;
  branchId: string;
  terminalId: string;
  openingCents: number;
  currency: string;
  businessDate: string;
  checkedInAt: string;
  isDayStart: boolean;
  calculationVersion: 2;
  state: ShiftFinancialOpeningState;
  /** Only a confirmed usable original publishes the local shift and drawer. */
  usable: boolean;
  hostedAuthorization: { state: 'authorized' | 'required'; expiresAt: string | null };
  lastPendingCode: string | null;
  drawer: ShiftFinancialOpeningDrawer | null;
}

export interface ShiftFinancialOpeningRefusal {
  success: false;
  code: string;
  error: string;
}

export type ShiftFinancialOpeningResponse =
  | { success: true; opening: ShiftFinancialOpeningView }
  | ShiftFinancialOpeningRefusal;

export interface ShiftFinancialOpeningStatusResponse {
  success: true;
  openings: ShiftFinancialOpeningView[];
}

/**
 * Native-only clear of every dedicated hosted cashier authorization (e.g. on
 * logout). It also fences in-flight issuance; durable originals, their queued
 * items and the main login are untouched. No credential crosses the bridge.
 */
export interface ShiftFinancialOpeningClearAuthorizationResponse {
  success: true;
}

// -- Shift financial closing authorization (gift_closing_v1) -----------------
// Original-cashier hosted renewal of one retained pending financial closing
// after its local close, a restart or expiry. Native selects the cashier from
// the stored original, never from the renderer. The PIN is a transient request
// field; no response carries a PIN or a staff session. A closed original is
// never an open usable opening. Clearing stays on
// `shiftFinancialOpening.clearAuthorization()`.

/** The retained closing key is the only identity the renderer supplies. */
export interface ShiftFinancialClosingAuthorizeRequest {
  closingKey: string;
  /** Transient 4..8 digit PIN of the original cashier. */
  pin: string;
}

export interface ShiftFinancialClosingAuthorizationView {
  closingKey: string;
  openingKey: string;
  shiftId: string;
  drawerId: string;
  staffId: string;
  organizationId: string;
  branchId: string;
  terminalId: string;
  /** Only a pending (not yet proven) original renews. */
  state: 'pending';
  hostedAuthorization: { state: 'authorized'; expiresAt: string };
}

export type ShiftFinancialClosingAuthorizeResponse =
  | { success: true; closing: ShiftFinancialClosingAuthorizationView }
  | ShiftFinancialOpeningRefusal;

// -- Retained financial closing recovery (gift_closing_v1) -------------------
// Nonsecret reads of the selected original cashier's retained closings in the
// current trusted organization, branch and public terminal (resolved
// natively), plus an explicit retry of one exact pending original. A view
// carries identity, the count, its state and a safe code, and either the
// count-time `localPreview` (never canonical money) or, once adopted, only the
// frozen `canonical` proof terms. No PIN, staff session, request body or
// provider diagnostic is returned. `retry` only makes the stored original due
// again and wakes the native sync: `queued` is not completion, so confirm with
// a later `status` read. `HOSTED_REAUTH_REQUIRED` / `HOSTED_SESSION_EXPIRED`
// mean `shiftFinancialClosing.authorize` first.

/** The selected original cashier; organization, branch and terminal are native. */
export interface ShiftFinancialClosingListPendingRequest {
  staffId: string;
}

/** One retained closing of the selected original cashier. */
export interface ShiftFinancialClosingKeyRequest {
  closingKey: string;
  staffId: string;
}

export type ShiftFinancialClosingStatusRequest = ShiftFinancialClosingKeyRequest;
export type ShiftFinancialClosingRetryRequest = ShiftFinancialClosingKeyRequest;

/**
 * `pending`: retained, not yet proven. `confirmed`: adopted canonical proof.
 * `blocked`: needs support (missing original or queue item, unreadable proof,
 * changed scope or mirror); never an ordinary completed close.
 */
export type ShiftFinancialClosingRecoveryState = 'pending' | 'confirmed' | 'blocked';

/** Count-time local terms of a pending original. Never canonical money. */
export interface ShiftFinancialClosingLocalPreview {
  closedAt: string;
  ordinaryExpectedCents: number;
  giftCashCents: number;
  expectedCents: number;
  varianceCents: number;
}

/** Frozen canonical terms of an adopted close. */
export interface ShiftFinancialClosingCanonical {
  closedAt: string;
  confirmedAt: string;
  countedCents: number;
  ordinaryExpectedCents: number;
  giftCashCents: number;
  expectedCents: number;
  varianceCents: number;
}

export interface ShiftFinancialClosingQueueView {
  status: 'pending' | 'processing';
  /** Next automatic attempt; `null` when already due. */
  nextRetryAt: string | null;
}

export interface ShiftFinancialClosingRecoveryView {
  /** `null` only for a gift shift closed without its original (`GIFT_CLOSING_ORIGINAL_MISSING`). */
  closingKey: string | null;
  openingKey: string;
  shiftId: string;
  state: ShiftFinancialClosingRecoveryState;
  /** Safe retained, authorization or blocking code. */
  code: string | null;
  /** The original cashier must authorize this closing again before a retry. */
  authorizationRequired: boolean;
  currency: string | null;
  countedCents: number | null;
  queue: ShiftFinancialClosingQueueView | null;
  localPreview: ShiftFinancialClosingLocalPreview | null;
  canonical: ShiftFinancialClosingCanonical | null;
}

export type ShiftFinancialClosingListPendingResponse =
  | { success: true; closings: ShiftFinancialClosingRecoveryView[]; truncated: boolean }
  | ShiftFinancialOpeningRefusal;

export type ShiftFinancialClosingStatusResponse =
  | { success: true; closing: ShiftFinancialClosingRecoveryView }
  | ShiftFinancialOpeningRefusal;

export interface ShiftFinancialClosingRetryView {
  closingKey: string;
  shiftId: string;
  /** Rescheduled only; confirm completion with a later `status` read. */
  state: 'queued';
}

export type ShiftFinancialClosingRetryResponse =
  | { success: true; closing: ShiftFinancialClosingRetryView }
  | ShiftFinancialOpeningRefusal;

// -- Gift card original-card return (native core, atomic_return_v1) ----------
//
// Windows adapter for POST /api/pos/gift-cards/redemptions/{id}/reverse. The
// renderer supplies only the local gift payment row, action, integer amount
// and reason. Native captures the original proof, key and exact body, keeps
// the hosted staff session private and adopts the canonical result atomically.

export type GiftReturnAction = "refund" | "void";

/** Durable native attempt state. */
export type GiftReturnState = "pending" | "completed" | "refused";

/**
 * Outcome of one call. `pending` and `auth_required` retain the captured
 * original: recover it with the same `returnKey` (after authorizing its
 * recorded operator again). `refused` ends that attempt. `rejected` means
 * nothing was captured.
 */
export type GiftReturnOutcome =
  | "completed"
  | "pending"
  | "auth_required"
  | "refused"
  | "rejected";

export interface GiftReturnAuthorizeRequest {
  staffId: string;
  pin: string;
}

export interface GiftReturnBeginRequest {
  localPaymentId: string;
  action: GiftReturnAction;
  /** Integer cents; required for `refund`, omitted for `void`. */
  amountCents?: number;
  reason: string;
}

export interface GiftReturnRecoverRequest {
  returnKey: string;
}

/** At most one selector; none lists the scope's pending and recent returns. */
export interface GiftReturnStatusRequest {
  localPaymentId?: string;
  returnKey?: string;
}

export interface GiftReturnProof {
  returnId: string;
  paymentAdjustmentId: string;
  returnedCents: number;
  totalReturnedCents: number;
  remainingCents: number;
  paymentStatus: "completed" | "voided" | "refunded";
  orderPaymentStatus: "pending" | "partially_paid" | "paid";
  orderRemainingCents: number;
  cardBalanceCents: number;
  replayed: boolean;
  completedAt: string;
}

export interface GiftReturnView {
  returnKey: string;
  localPaymentId: string;
  localOrderId: string;
  action: GiftReturnAction;
  state: GiftReturnState;
  currency: string;
  grossCents: number;
  requestedCents: number | null;
  reason: string;
  staffId: string;
  sendCount: number;
  lastCode: string | null;
  authRequired: boolean;
  createdAt: string;
  updatedAt: string;
  proof: GiftReturnProof | null;
}

export interface GiftReturnRefusal {
  success: false;
  code: string;
  error: string;
  outcome: GiftReturnOutcome;
  /** Present only for a caller in the attempt's own trusted scope. */
  return?: GiftReturnView;
}

export interface GiftReturnCompleted {
  success: true;
  contract: "atomic_return_v1";
  outcome: "completed";
  return: GiftReturnView;
}

export type GiftReturnResponse = GiftReturnCompleted | GiftReturnRefusal;

export type GiftReturnAuthorizeResponse =
  | {
      success: true;
      contract: "atomic_return_v1";
      staffId: string;
      usableUntil: string;
    }
  | GiftReturnRefusal;

/** Advisory local projection of one original; never implies permission. */
export interface GiftReturnOriginalAdvisory {
  localPaymentId: string;
  eligible: boolean;
  code: string | null;
  currency: string | null;
  grossCents: number | null;
  returnedCents: number | null;
  remainingCents: number | null;
  pendingReturnKey: string | null;
}

/** Advisory only; the server rechecks the operator's permission. */
export interface GiftReturnAuthorizationStatus {
  active: boolean;
  staffId: string | null;
  usableUntil: string | null;
}

export type GiftReturnStatusResponse =
  | {
      success: true;
      contract: "atomic_return_v1";
      advisory: true;
      authorization: GiftReturnAuthorizationStatus;
      original: GiftReturnOriginalAdvisory | null;
      returns: GiftReturnView[];
    }
  | GiftReturnRefusal;

// -- Gift card funding (native core, gift_funding_v1) -------------------------
// The eleven native gift funding commands take the positional `{ arg0: payload }`
// envelope. Native owns the attempt key, the immutable attempt journal and the
// cashier/manager hosted sessions; the renderer never generates or overrides
// any of them. A PIN is a transient request field. No response ever carries a
// PIN, a staff session or a raw card number, except the transient `cardNumber`
// of the completed same-scope issue reply. Funding is stored value: it is never
// an order, a payment, a fiscal receipt or a verified capture.

export type GiftFundingMode = 'cash_confirmed' | 'external_card_recorded' | 'manager_grant';

export type GiftFundingOperation = 'issue' | 'reload';

export type GiftFundingAttemptState =
  | 'prepare_pending'
  | 'prepared'
  | 'collection_pending'
  | 'collection_started'
  | 'complete_pending'
  | 'cancel_pending'
  | 'completed'
  | 'canceled'
  | 'refused'
  | 'abandoned';

/** Cashier-collected funding. Omit `attemptKey` for a new attempt: native issues it. */
export interface GiftFundingPrepareRequest {
  attemptKey?: string;
  staffId: string;
  mode: 'cash_confirmed' | 'external_card_recorded';
  operation: GiftFundingOperation;
  /** Reload only. */
  cardId?: string;
  /** Integer cents, 1..99_999_999. */
  amountCents: number;
  /** Uppercase ISO 4217 code. */
  currency: string;
  reason: string;
}

/** Manager grant (mode `manager_grant`) after a separate `authorizeManager`. */
export interface GiftFundingGrantRequest {
  attemptKey?: string;
  /** The separately authorized manager. */
  staffId: string;
  operation: GiftFundingOperation;
  /** Reload only. */
  cardId?: string;
  /** Integer cents, 1..99_999_999. */
  amountCents: number;
  /** Uppercase ISO 4217 code. */
  currency: string;
  reason: string;
}

export interface GiftFundingAttemptRequest {
  attemptKey: string;
}

export interface GiftFundingCashEvidence {
  kind: 'operator_cash_confirmation';
  amountCents: number;
  currency: string;
  confirmed: true;
}

/** Operator-recorded references of an external card terminal; never a verified capture. */
export interface GiftFundingExternalCardEvidence {
  kind: 'external_card_recorded';
  amountCents: number;
  currency: string;
  confirmed: true;
  provider: string;
  merchantId: string;
  terminalReference: string;
  transactionReference: string;
}

export interface GiftFundingCompleteRequest {
  attemptKey: string;
  evidence: GiftFundingCashEvidence | GiftFundingExternalCardEvidence;
}

export interface GiftFundingCancelRequest {
  attemptKey: string;
  reason: string;
}

export interface GiftFundingAuthorizeManagerRequest {
  staffId: string;
  /** Transient 4..8 digit PIN of the manager. */
  pin: string;
}

export interface GiftFundingStatusRequest {
  attemptKey?: string;
}

export interface GiftFundingRefreshDrawerRequest {
  staffId: string;
}

export interface GiftFundingCloseBlockerRequest {
  shiftId?: string;
}

export interface GiftFundingAttemptResult {
  cardId: string;
  creditId: string;
  acknowledgementId: string;
  cardBalanceCents: number;
  cardNumberHash: string;
  completedAt: string;
}

export interface GiftFundingAttemptView {
  attemptKey: string;
  organizationId: string;
  branchId: string;
  terminalId: string;
  staffId: string;
  operation: GiftFundingOperation;
  mode: GiftFundingMode;
  cardId: string | null;
  amountCents: number;
  currency: string;
  reason: string;
  drawerId: string | null;
  shiftId: string | null;
  state: GiftFundingAttemptState;
  intentId: string | null;
  unresolved: boolean;
  possiblySent: boolean;
  /** One explicit begin acknowledgement only; status, duplicate replies and recovery are false. */
  collectionPermitted: boolean;
  lastCode: string | null;
  result: GiftFundingAttemptResult | null;
  verifiedCapture: false;
  fiscalReceipt: false;
  createdAt: string;
  updatedAt: string;
}

export interface GiftFundingRefusal {
  success: false;
  code: string;
  error: string;
  /** The retained attempt, when the refusal concerns one. */
  attempt?: GiftFundingAttemptView;
}

export type GiftFundingAttemptResponse =
  | {
      success: true;
      attempt: GiftFundingAttemptView;
      /** Transient raw card number, present only on the completed same-scope issue reply. */
      cardNumber?: string;
    }
  | GiftFundingRefusal;

/** An unverifiable terminal scope is a refusal, never an empty journal. */
export type GiftFundingStatusResponse =
  | { success: true; attempts: GiftFundingAttemptView[] }
  | GiftFundingRefusal;

export type GiftFundingAuthorizeManagerResponse =
  | { success: true; authorization: { staffId: string; expiresAt: string } }
  | GiftFundingRefusal;

export interface GiftFundingDrawerView {
  openingKey: string;
  shiftId: string;
  drawerId: string;
  staffId: string;
  currency: string;
  version: number;
  acknowledgementId: string | null;
  giftCashCents: number;
  ordinaryExpectedCents: number;
  expectedCents: number;
}

export type GiftFundingRefreshDrawerResponse =
  | { success: true; drawer: GiftFundingDrawerView }
  | GiftFundingRefusal;

export interface GiftFundingUnresolvedAttempt {
  attemptKey: string;
  state: GiftFundingAttemptState;
  mode: GiftFundingMode;
  amountCents: number;
  currency: string;
  shiftId: string | null;
}

export type GiftFundingCloseBlockerResponse =
  | {
      success: true;
      blocked: boolean;
      shiftId: string | null;
      unresolved: GiftFundingUnresolvedAttempt[];
    }
  | GiftFundingRefusal;

/**
 * Advisory hosted availability (`GET /api/pos/gift-cards/status`), not the local
 * journal of `status`. `cashier` sends the selected cashier's usable original
 * session; `manager` sends the separately authorized manager's grant session and
 * consumes no grant. Native sends it once and writes nothing; every funding
 * write is still decided by the server.
 */
export type GiftFundingAvailabilityAuthority = 'cashier' | 'manager';

export interface GiftFundingAvailabilityRequest {
  staffId: string;
  authority: GiftFundingAvailabilityAuthority;
}

export interface GiftFundingModeAvailability {
  supported: boolean;
  ready: boolean;
  /** Server reason code while not ready; null when ready. */
  reason: string | null;
}

export interface GiftFundingAvailability {
  /** The native-confirmed actor and the trusted terminal scope. */
  staffId: string;
  authority: GiftFundingAvailabilityAuthority;
  organizationId: string;
  branchId: string;
  terminalId: string;
  configured: boolean;
  enabled: boolean;
  unavailable: boolean;
  /** Uppercase store currency; null while `configurationRequired` is set. */
  currency: string | null;
  /** Server code, e.g. `GIFT_CARD_CURRENCY_NOT_CONFIGURED`. */
  configurationRequired: string | null;
  fundingConfigured: boolean;
  modes: Record<GiftFundingMode, GiftFundingModeAvailability> & {
    /** This client has no verified capture. */
    verified_capture: { supported: false; ready: false; reason: string };
  };
  /** Return readiness of the same hosted session. */
  operator: { ready: boolean; reason: string | null; returnPayments: boolean };
  verifiedCapture: false;
  fiscalReceipt: false;
}

/** A refusal never carries an attempt, a prior actor or any readiness. */
export type GiftFundingAvailabilityResponse =
  | { success: true; availability: GiftFundingAvailability }
  | Omit<GiftFundingRefusal, 'attempt'>;

// -- Gift card checkout --------------------------------------------------------
// The five native gift checkout commands take the positional `{ arg0: payload }`
// envelope. Native owns the idempotency key, the durable attempt journal, the
// canonical payment import and the fiscal journal; the renderer never
// generates or overrides any of them.

/** One amount-split portion. Native refuses selected-item gift splits. */
export interface GiftCardCheckoutSplit {
  groupId: string;
  portionId: string;
}

export interface GiftCardRedeemForOrderRequest {
  orderId: string;
  /** Bearer credential: memory-only, never logged, persisted or queued. */
  cardNumber: string;
  /** Major currency units carrying a positive whole number of cents. */
  amount: number;
  /** Uppercase ISO 4217 code of the order and card. */
  currency: string;
  split?: GiftCardCheckoutSplit;
}

export interface GiftCardOrderRequest {
  orderId: string;
}

export interface GiftCardFiscalReadinessRequest {
  orderId?: string;
}

/** The payment native already imported and booked. Never record it again. */
export interface GiftCardCanonicalPayment {
  localPaymentId: string;
  remotePaymentId?: string | null;
  method: 'gift_card';
  amountCents: number;
  currency: string;
  transactionRef?: string | null;
}

export type GiftCardFiscalStatus =
  | 'not_required'
  | 'unsupported'
  | 'unavailable'
  | 'ready'
  | 'partial'
  | 'pending'
  | 'approved'
  | 'error';

/**
 * Fiscal disposition from readiness, finalize, fiscal reconcile and redeem.
 * `success` is true only for approved/not_required, so `ready` normally
 * arrives with `success:false`: classify `status`. Flags are conditional.
 * Native currently returns `certified:false` and `fiscalReceiptNumber:null`.
 */
export interface GiftCardFiscalDisposition {
  success?: boolean;
  status?: string;
  code?: string | null;
  error?: string | null;
  operationId?: string | null;
  requiresFinalize?: boolean;
  requiresReconciliation?: boolean;
  retryable?: boolean;
  certified?: boolean;
  fiscalReceiptNumber?: string | null;
  cloudRoute?: unknown;
  register?: unknown;
  order?: unknown;
}

/** Safe card summary; never carries the full number. */
export interface GiftCardRedeemCardSummary {
  maskedNumber?: string | null;
  balance?: number | null;
  currency?: string | null;
}

export interface GiftCardRedeemForOrderResponse {
  success: boolean;
  code?: string | null;
  error?: string | null;
  serverCode?: string | null;
  replayed?: boolean;
  recovered?: boolean;
  reconciliationPending?: boolean;
  orderId?: string | null;
  remoteOrderId?: string | null;
  idempotencyKey?: string | null;
  payment?: GiftCardCanonicalPayment | null;
  card?: GiftCardRedeemCardSummary | null;
  serverSettlement?: unknown;
  localSettlement?: unknown;
  fiscal?: GiftCardFiscalDisposition | null;
}

/**
 * `success:true` only means no attempt is unresolved; it is not proof that
 * the order is paid. No `fiscal` or `idempotencyKeys` field is guaranteed.
 */
export interface GiftCardReconcileOrderResponse {
  success: boolean;
  code?: string | null;
  error?: string | null;
  applied?: unknown[];
  abandoned?: unknown;
  unresolved?: unknown;
  reconciliationPending?: boolean;
  localSettlement?: unknown;
}

// -- Recovery ----------------------------------------------------------------

export type RecoveryPointKind =
  | 'scheduled'
  | 'manual'
  | 'pre_recovery_action'
  | 'pre_factory_reset'
  | 'pre_emergency_reset'
  | 'pre_clear_operational_data'
  | 'pre_restore'
  | 'pre_migration'
  | 'quarantined_open_failure';

export interface RecoveryPoint {
  id: string;
  kind: RecoveryPointKind;
  createdAt: string;
  path: string;
  snapshotPath: string;
  walPath?: string | null;
  shmPath?: string | null;
  schemaVersion: number;
  terminalId?: string | null;
  branchId?: string | null;
  organizationId?: string | null;
  dbSizeBytes: number;
  snapshotSizeBytes: number;
  fingerprint: string;
  tableCounts: Record<string, number>;
  syncBacklog: Record<string, Record<string, number>>;
  activePeriodStartAt?: string | null;
  activeReportDate?: string | null;
  latestZReportId?: string | null;
  latestZReportDate?: string | null;
  latestZReportGeneratedAt?: string | null;
  latestZReportSyncState?: string | null;
  lastZReportTimestamp?: string | null;
  error?: string | null;
}

export interface RecoveryListResponse {
  success: boolean;
  points: RecoveryPoint[];
}

export interface RecoveryExportResponse {
  success: boolean;
  path: string;
  exportKind: string;
  pointId?: string | null;
}

export interface RecoveryRestoreResponse {
  success: boolean;
  staged: boolean;
  restartRequired: boolean;
  pointId: string;
  preRestorePointId?: string | null;
  message: string;
}

// -- Diagnostics --------------------------------------------------------------

export interface DiagnosticsAboutInfo {
  version: string;
  buildTimestamp: string;
  gitSha: string;
  platform: string;
  arch: string;
  rustVersion: string;
}

export interface DiagnosticsRecentPrintJob {
  id: string;
  entityType: string;
  status: string;
  createdAt: string;
  warningCode: string | null;
}

export interface DiagnosticsInvalidOrder {
  order_id: string;
  queue_id: number;
  invalid_menu_items: string[];
  created_at: string | null;
  reason: string;
}

export interface DiagnosticsPaymentAdjustmentBacklog {
  genericDeferred: number;
  waitingForParentPayment: number;
  waitingForCanonicalRemotePaymentId: number;
}

export interface DiagnosticsSyncStatusSummary {
  isOnline: boolean;
  lastSync?: string | null;
  lastSyncAt?: string | null;
  pendingItems: number;
  pendingChanges: number;
  syncInProgress: boolean;
  error?: string | null;
  syncErrors: number;
  queuedRemote: number;
  backpressureDeferred: number;
  oldestNextRetryAt?: string | null;
  lastQueueFailure?: Record<string, unknown> | null;
  historicalZReportConflicts: number;
  pendingPaymentItems: number;
  failedPaymentItems: number;
  financialStats?: Record<string, unknown>;
}

export interface DiagnosticsParityQueueStatus {
  total: number;
  pending: number;
  failed: number;
  conflicts: number;
  oldestItemAge?: number | null;
}

export interface DiagnosticsFinancialQueueBucket {
  pending: number;
  failed: number;
}

export interface DiagnosticsFinancialQueueStatus {
  driver_earnings: DiagnosticsFinancialQueueBucket;
  staff_payments: DiagnosticsFinancialQueueBucket;
  shift_expenses: DiagnosticsFinancialQueueBucket;
  payments?: DiagnosticsFinancialQueueBucket;
  pendingPaymentItems?: number;
  failedPaymentItems?: number;
  totalPending?: number;
  totalFailed?: number;
}

export interface DiagnosticsCredentialState {
  hasAdminUrl: boolean;
  hasApiKey: boolean;
}

export type DiagnosticsParitySyncStatus =
  | 'idle'
  | 'started'
  | 'completed'
  | 'skipped_missing_credentials'
  | 'failed';

export interface DiagnosticsLastParitySync {
  status: DiagnosticsParitySyncStatus;
  trigger?: string;
  startedAt: string;
  finishedAt?: string | null;
  processed: number;
  failed: number;
  conflicts: number;
  remaining: number;
  error?: string | null;
  reason?: string | null;
  legacySyncTriggered: boolean;
  credentialState?: DiagnosticsCredentialState;
  queueStatus?: DiagnosticsParityQueueStatus | null;
  telemetry?: {
    startedAt: string;
    finishedAt: string;
    queueDepthBefore: number;
    queueDepthAfter: number;
    replayAttempts: number;
    deferred: number;
    processed: number;
    failed: number;
    conflicts: number;
    terminalAuthFailures: number;
    scope: {
      organizationId?: string | null;
      terminalId?: string | null;
    };
    queueStatus: DiagnosticsParityQueueStatus;
    outcomes: Array<{
      moduleType: string;
      status: string;
      errorClass: string;
      count: number;
    }>;
  } | null;
}

export interface DiagnosticsCheckoutPaymentBlockers {
  count: number;
  details: UnsettledPaymentBlocker[];
  sourceWindow: 'active_shift' | 'z_report';
}

export interface DiagnosticsSystemHealth {
  schemaVersion: number;
  syncBacklog: Record<string, Record<string, number>>;
  /**
   * 'unavailable' when the backlog could not be read: `syncBacklog` is then
   * empty and means nothing (never "clear"). Missing on older backends.
   */
  syncBacklogStatus?: 'ok' | 'unavailable';
  paymentAdjustmentBacklog: DiagnosticsPaymentAdjustmentBacklog;
  syncBlockerDetails?: SyncBlockerDetail[];
  terminalContext?: DiagnosticsTerminalContext;
  syncStatusSummary?: DiagnosticsSyncStatusSummary;
  lastSyncTimes: Record<string, string | null>;
  printerStatus: {
    configured: boolean;
    profileCount: number;
    defaultProfile: string | null;
    recentJobs: DiagnosticsRecentPrintJob[];
    /**
     * Every print job still waiting to print (`pending`, or `printing` and not
     * finished), over the whole queue (not the five-job `recentJobs` window),
     * leaving out jobs held by a paused queue or printer. The Health view
     * ages the oldest to tell a stuck queue. Missing on older backends, null
     * when the read failed: the queue was not read.
     */
    pendingJobs?: {
      count: number;
      oldestCreatedAt: string | null;
      /** Jobs held by a pause (evidence only). Missing on older backends. */
      pausedCount?: number;
    } | null;
  };
  lastZReport: {
    id: string;
    shiftId: string;
    generatedAt: string;
    syncState: string;
    totalGrossSales: number;
    totalNetSales: number;
  } | null;
  pendingOrders: number;
  dbSizeBytes: number;
  panicCount?: number;
  invalidOrders?: {
    count: number;
    details: DiagnosticsInvalidOrder[];
  };
  parityQueueStatus?: DiagnosticsParityQueueStatus | null;
  financialQueueStatus?: DiagnosticsFinancialQueueStatus | null;
  lastParitySync?: DiagnosticsLastParitySync | null;
  credentialState?: DiagnosticsCredentialState | null;
  checkoutPaymentBlockers?: DiagnosticsCheckoutPaymentBlockers | null;
  isOnline: boolean;
  lastSyncTime: string | null;
}

export interface DiagnosticsExportOptions {
  includeLogs?: boolean;
  redactSensitive?: boolean;
  /**
   * What the operator saw in the Health view (shared buildHealthView), for
   * the bundle's health_view.json.
   */
  healthView?: Record<string, unknown>;
}

export interface DiagnosticsExportResponse {
  success: boolean;
  path: string;
  options?: {
    includeLogs: boolean;
    redactSensitive: boolean;
  };
  error?: string;
}

export interface DiagnosticsOpenExportDirResponse {
  success: boolean;
  path?: string;
  error?: string;
}

export type PosIncidentSeverity = 'info' | 'warning' | 'high' | 'critical';

export interface PosIncidentCandidate {
  issueCode: string;
  severity: PosIncidentSeverity;
  fingerprint: string;
  summary: string;
  evidence: Record<string, unknown>;
  shouldReport: boolean;
}

export interface RemoteIncidentReportResponse {
  success: boolean;
  incidentId?: string | null;
  status?: 'open' | 'resolved' | string;
  deduped?: boolean;
  alertSent?: boolean;
  lastSentAt?: string;
  candidate?: PosIncidentCandidate;
  error?: string;
}

// -- Recovery Center ---------------------------------------------------------

export interface DiagnosticsTerminalContext {
  terminalId: string | null;
  branchId: string | null;
  branchName?: string | null;
  organizationId: string | null;
  organizationName?: string | null;
  terminalType?: string | null;
  parentTerminalId?: string | null;
  ownerTerminalId?: string | null;
  ownerTerminalDbId?: string | null;
  sourceTerminalId?: string | null;
  sourceTerminalDbId?: string | null;
  posOperatingMode?: string | null;
  enabledFeatures?: Record<string, unknown>;
  lastConfigSyncAt?: string | null;
  syncHealth?: string | null;
  syncHealthState?: string | null;
  businessType?: string | null;
  ghostModeFeatureEnabled?: boolean | string | null;
  adminDashboardUrl?: string | null;
}

// The Recovery Center issue, action and action-log contract is shared with
// POSSystemMobile (shared/pos/health/health-contract.ts); both POS apps build
// their Health view from it.
export type {
  RecoveryIssueSeverity,
  RecoveryIssueStatus,
  RecoveryRouteTarget,
  RecoveryActionSafetyLevel,
  RecoveryKnownSolution,
  RecoveryActionDescriptor,
  RecoveryIssue,
  RecoveryActionRequest,
  RecoveryActionResult,
  RecoveryActionOutcome,
  RecoveryActionLogEntry,
} from '../../../shared/pos/health/health-contract';
