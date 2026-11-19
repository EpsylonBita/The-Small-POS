import type { RecoveryActionDescriptor, RecoveryIssue, RemoteIncidentReportResponse } from '../../../lib';
import type { HealthAvailability, HealthProblemCode } from '../../../../../shared/pos/health/health-contract';
import type { DesktopRecoveryIssue } from './sync-recovery-issues';
import type { TillHealthAttempt } from './useTillHealthActions';
import { verifiedSupportReceipt } from '../../services/support/SupportRemedyRunner';

export const OPEN_TILL_HEALTH = 'pos:open-till-health';

export interface TillHealthOpenContext {
  orderId?: string;
  preferredIssueId?: string;
}

export function openTillHealth(detail: TillHealthOpenContext = {}) {
  window.dispatchEvent(new CustomEvent(OPEN_TILL_HEALTH, { detail }));
}

export type TillHealthState = 'ok' | 'issue' | 'working' | 'pending' | 'solved' | 'support' | 'offline' | 'stale';

const issueFamilies = {
  customer_correction_refused: 'customerCorrection',
  parity_missing_credentials: 'connection',
  invalid_orders_pending: 'invalidOrders',
  change_refused: 'order',
  payment_not_on_server: 'payment',
  payment_total_conflict: 'wrongMoney',
  order_invalid_driver_update: 'driver',
  order_update_replay_blocked: 'orderPaymentWait',
  order_update_parent_wait: 'orderWaiting',
  stale_order_update_parent_wait: 'orderMissing',
  catalog_availability_retry: 'catalog',
  customer_address_default_conflict: 'address',
  duplicate_customer_conflict: 'customerDuplicate',
  customer_phone_rejected: 'customerPhone',
  customer_directory_not_synced: 'customerDirectory',
  remote_handover_snapshot_frozen: 'shiftClosed',
  legacy_edit_review_required: 'oldOrderCorrection',
  z_report_held_for_phone_shifts: 'phoneShifts',
  checkout_parked: 'uncertainPayment',
  platform_settlement_missing: 'platform',
  platform_settlement_mismatch: 'platform',
  order_payment_waiting_parent: 'paymentWaiting',
  payment_adjustment_waiting_parent: 'refundWaiting',
  payment_adjustment_missing_canonical_remote_payment: 'refundMissing',
  legacy_financial_parity_orphan: 'oldPayments',
  legacy_financial_parity_orphans_bulk: 'oldPayments',
  courier_cash_missing_from_earning: 'courierMoney',
  courier_cash_check_incomplete: 'courierCheck',
  'printer.brand_probe_unanswered': 'printerSetting',
  parity_module_pending_items: 'waiting',
  parity_module_failed_items: 'sending',
  parity_module_conflict_items: 'sending',
  parity_processor_stalled_zero_progress: 'sending',
  issue_check_unavailable: 'orderCheck',
} as const;

const staffActions = {
  resendOrderCustomerCorrection: 'saveAgain',
  restoreLastKnownPrinterBrand: 'restorePrinter',
  openOrderPaymentFix: 'openPayment',
  openConnectionSettings: 'openConnection',
} as const;

export type TillHealthStaffAction = keyof typeof staffActions;

export function issueFamily(issue: RecoveryIssue): string {
  if (Object.prototype.hasOwnProperty.call(issueFamilies, issue.code)) return issueFamilies[issue.code as keyof typeof issueFamilies];
  if (issue.titleKey === 'recovery.issues.checkoutPaymentBlocker.title') {
    return issue.actions.some(action => action.id === 'openOrderPaymentFix') ? 'balance' : 'payment';
  }
  if (isMoneyIssue(issue)) return 'payment';
  if (issue.entityType === 'order' || issue.entityType === 'orders') return 'order';
  if (issue.entityType === 'z_report' || issue.entityType === 'z_reports') return 'dayClose';
  return 'sending';
}

function isMoneyIssue(issue: RecoveryIssue) {
  return /^(?:payments?|payment_adjustments?|shift_expense|staff_payment|driver_earning)$/.test(issue.entityType)
    || issue.code.startsWith('financial_');
}

export function issueSubject(issue: RecoveryIssue): string {
  if (issue.orderId || issue.orderNumber || issue.entityType === 'order' || issue.entityType === 'orders') return 'order';
  if (issue.entityType === 'shift_expense') return 'expense';
  if (issue.entityType === 'staff_payment') return 'staffPayment';
  if (issue.entityType === 'driver_earning') return 'driverPayment';
  if (isMoneyIssue(issue)) return 'payment';
  if (issue.entityType === 'printer') return 'printer';
  if (issue.entityType.startsWith('z_report')) return 'closeout';
  return 'till';
}

export function safeOrderNumber(value: unknown): string | null {
  // The public till number is display data. The formatter must never fall back to an internal ID.
  return typeof value === 'string' && /^#?[0-9]{1,12}$/.test(value.trim()) ? value.trim().replace(/^#/, '') : null;
}

export function staffActionLabel(action: RecoveryActionDescriptor): string | undefined {
  if (action.id === 'retryParityItem' && action.labelKey === 'recovery.actions.retryCustomerAddressDefault.label') return 'saveAddress';
  return Object.prototype.hasOwnProperty.call(staffActions, action.id) ? staffActions[action.id as TillHealthStaffAction] : undefined;
}

function staffAction(issue: RecoveryIssue) {
  return issue.actions.find(action =>
    action.safetyLevel === 'safe' && staffActionLabel(action) &&
    (action.recommended || issue.knownSolution?.recipeId === action.recipeId && Boolean(action.recipeId)
      || action.id === 'openConnectionSettings' && issue.code === 'parity_missing_credentials'),
  );
}

export interface TillHealthCard {
  id: string;
  family: string;
  issue?: DesktopRecoveryIssue;
  action?: RecoveryActionDescriptor;
  secondary?: RecoveryActionDescriptor;
  localAction?: 'printer' | 'send';
  sendPhase?: 'working' | 'pending' | 'solved' | 'failed';
  verifiedAt?: string;
  attempt?: TillHealthAttempt;
  pending: boolean;
  copyDetail?: string;
}

export function buildTillHealthCards(input: {
  issues: DesktopRecoveryIssue[];
  attempts: TillHealthAttempt[];
  problem: HealthProblemCode;
  printerNeedsAttention: boolean;
  canSend: boolean;
  sendResult?: { state: NonNullable<TillHealthCard['sendPhase']>; verifiedAt?: string };
  printCount?: number;
  focus?: TillHealthOpenContext | null;
}): TillHealthCard[] {
  const byEvent = new Map<string, TillHealthCard>();
  for (const issue of input.issues) {
    if (issue.severity === 'info' || issue.status === 'resolved' || issue.code === 'parity_module_pending_items') continue;
    const id = issue.businessEventKey ?? issue.id;
    const action = staffAction(issue);
    const card = {
      id, issue, family: issueFamily(issue), action,
      secondary: issue.actions.find(action => action.id === 'keepServerOrderCustomerDetails' && action.safetyLevel === 'safe'),
      pending: issue.status === 'recovering' && !action,
      attempt: input.attempts.find(attempt => attempt.issue.id === issue.id),
    };
    const existing = byEvent.get(id);
    if (!existing || (!existing.action && card.action)) byEvent.set(id, card);
  }
  const cards = [...byEvent.values()];
  for (const attempt of input.attempts) {
    if (!['working', 'pending', 'solved'].includes(attempt.state) ||
        cards.some(card => card.issue?.id === attempt.issue.id)) continue;
    cards.push({ id: attempt.issue.id, family: issueFamily(attempt.issue), issue: attempt.issue, attempt, pending: false });
  }
  if (input.printerNeedsAttention && !cards.some(card => card.issue?.entityType === 'printer')) {
    cards.push({ id: 'printer', family: input.printCount ? 'printing' : 'printer', localAction: 'printer', pending: false });
  }
  if (input.canSend || input.sendResult) {
    const card = cards.find(candidate => candidate.issue?.code === 'parity_processor_stalled_zero_progress');
    if (card) {
      card.localAction = input.canSend ? 'send' : undefined;
      if (input.canSend) card.family = 'waiting';
      card.sendPhase = input.sendResult?.state;
      card.verifiedAt = input.sendResult?.verifiedAt;
    } else {
      cards.push({ id: 'send', family: 'waiting', pending: false, localAction: input.canSend ? 'send' : undefined,
        sendPhase: input.sendResult?.state, verifiedAt: input.sendResult?.verifiedAt });
    }
  }
  const signal = { closeoutOverdue: 'dayOverdue', fiscalNotSent: 'fiscal', closeoutBlocked: 'dayClose', crashDetected: 'crash' } as const;
  if (Object.prototype.hasOwnProperty.call(signal, input.problem)) {
    const family = signal[input.problem as keyof typeof signal];
    if (!cards.some(card => card.family === family || (family === 'dayClose' && card.issue))) {
      cards.push({ id: family, family, pending: false });
    }
  }
  if (!cards.length && input.problem === 'syncFailed') cards.push({ id: 'sending', family: 'sending', pending: false });
  if (!cards.length && input.problem === 'failedPayments') cards.push({ id: 'payment', family: 'payment', pending: false });
  const focus = (card: TillHealthCard) => Number(Boolean(card.issue &&
    (input.focus?.preferredIssueId === card.issue.id || (input.focus?.orderId &&
      [card.issue.orderId, card.issue.entityId, card.issue.params?.sampleRecordId].includes(input.focus.orderId)))));
  return cards.sort((a, b) => focus(b) - focus(a) || Number(Boolean(b.action || b.localAction)) - Number(Boolean(a.action || a.localAction)));
}

export function tillHealthState(input: {
  availability: HealthAvailability;
  online: boolean;
  cards: TillHealthCard[];
  sendState?: 'working' | 'pending' | 'solved' | 'failed';
  supportUnavailable: boolean;
}): TillHealthState {
  if (input.availability !== 'ready') return 'stale';
  if (!input.online) return 'offline';
  if (input.sendState === 'working' || input.cards.some(card => card.attempt?.state === 'working')) return 'working';
  const first = input.cards[0];
  if (first?.attempt?.state === 'solved' || first?.sendPhase === 'solved' || (!first && input.sendState === 'solved')) return 'solved';
  if (first?.attempt?.state === 'pending' || first?.pending || input.sendState === 'pending') return 'pending';
  if (first?.attempt?.state === 'failed' || input.sendState === 'failed') return 'support';
  if (first) return first.action || first.localAction || first.family === 'dayOverdue' ? 'issue' : 'support';
  return input.supportUnavailable ? 'support' : 'ok';
}

export function tillHealthTone(state: TillHealthState): 'ok' | 'warn' | 'bad' {
  return state === 'ok' || state === 'solved' ? 'ok' : state === 'support' ? 'bad' : 'warn';
}

export interface TillHealthReport {
  result: RemoteIncidentReportResponse;
  at: string;
  automatic?: boolean;
}

export function tillHealthReportStatus(report: TillHealthReport | null) {
  if (!report) return 'none';
  if (verifiedSupportReceipt(report.result)) return report.automatic ? 'automatic' : 'sent';
  if (report.result.deliveryState === 'waiting') return 'waiting';
  if (report.result.deliveryState === 'local') return 'local';
  if (report.result.deliveryState === 'failed' && report.result.localPrepared) return 'sendFailed';
  return report.result.localPrepared && report.result.path ? 'local' : 'failed';
}
