/**
 * GiftCardTender - charges a gift card against an existing, synced, unpaid
 * order through the native checkout commands.
 *
 * Checkout only: native owns the debit, the idempotency key, the canonical
 * payment import and both durable journals, so this component never records
 * a payment, starts an EFT charge or calls the management redeem. The card
 * number lives only in component memory; it is cleared after every attempt
 * that reached native and whenever the order or scope changes. Each mount
 * runs native recovery before a new debit, and results that arrive for
 * another order, scope or an unmounted tender are dropped. An older result
 * never replaces newer admission, coverage or receipt state, and each action
 * only ends its own busy state.
 *
 * `onEvent` reports three secret-free kinds: `financial` (canonical payments
 * native booked, each reported once, with snapshot coverage), `fiscal`
 * (receipt progress, never a money retry) and `admission` (whether gift or
 * ordinary collection may run). Hosts apply `financial` idempotently by
 * payment ID, treat snapshot coverage as the paid authority and never pass a
 * gift payment to recordPayment or EFT.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GiftCardCheckoutSplit } from '../../../lib/ipc-contracts';
import { MODULE_IDS, useAcquiredModules } from '../../hooks/useAcquiredModules';
import {
  giftCardAdmissionKey,
  giftCardCheckoutService,
  giftCardOrderKey,
  type GiftCardAdmission,
  type GiftCardAdoptedPayment,
  type GiftCardCheckoutService,
  type GiftCardFiscalCall,
  type GiftCardFiscalOutcome,
  type GiftCardOrderCoverage,
  type GiftCardRecoveryOutcome,
  type GiftCardRedeemOutcome,
  type GiftCardTenderEvent,
  type GiftCardTenderRefusal,
} from '../../services/GiftCardCheckoutService';
import {
  giftCardsApiService,
  parseAmountToCents,
  type GiftCard,
  type GiftCardsApiService,
  type GiftCardScope,
  type GiftCardsFailureKind,
  type GiftCardsStatus,
} from '../../services/GiftCardsApiService';

export interface GiftCardTenderProps {
  /** Existing order this tender pays; nothing is collected before it exists. */
  orderId: string | null;
  /** The order is synced remotely, so native can settle against it. */
  orderSynced: boolean;
  /** Uppercase ISO 4217 currency captured from the order. */
  currency: string | null;
  /** Hosted organization and terminal identity of this checkout. */
  scope: GiftCardScope;
  online: boolean;
  /** Amount-split portion this tender pays. */
  split?: GiftCardCheckoutSplit | null;
  /** Fixed amount of that portion in cents; the cashier cannot change it. */
  fixedAmountCents?: number | null;
  /** Items chosen by an item split; gift refuses them visibly instead of dropping them. */
  selectedItemIds?: readonly string[] | null;
  /** Secret-free results: financial adoption, fiscal progress and admission. */
  onEvent?: (event: GiftCardTenderEvent) => void;
  service?: GiftCardCheckoutService;
  api?: Pick<GiftCardsApiService, 'getStatus' | 'lookup'>;
}

type BusyKind = 'recover' | 'lookup' | 'redeem' | 'fiscal';
type FiscalAction = 'readiness' | 'finalize' | 'reconcile';

const REFUSAL_COPY: Record<GiftCardTenderRefusal, [string, string]> = {
  scope: ['scope', 'This terminal has no confirmed organization or terminal identity. Pair the POS again.'],
  order: ['order', 'Create the order before taking a gift card.'],
  unsynced: ['unsynced', 'Wait until the order is synced, then try again.'],
  module: ['module', 'The Gift Cards module is not active for this store.'],
  offline: ['offline', 'Gift cards need a connection. Reconnect and try again.'],
  unavailable: ['unavailable', 'The gift card service is unavailable. Try again shortly.'],
  card_number: ['cardNumber', 'Check the card number and try again.'],
  not_found: ['notFound', 'No gift card matches this number.'],
  amount: ['amount', 'Enter an amount above zero with at most two decimals.'],
  currency: ['currency', 'The card currency does not match the order currency.'],
  balance: ['balance', 'The card balance is too low for this amount.'],
  expired: ['expired', 'This gift card has expired.'],
  inactive: ['inactive', 'This gift card is not active.'],
  exceeds_outstanding: ['exceedsOutstanding', 'The amount is more than the order still owes.'],
  nothing_due: ['nothingDue', 'Nothing is outstanding on this order.'],
  item_split: [
    'itemSplit',
    'Gift cards can pay an amount split only. Switch to an amount split or use another tender.',
  ],
  split: ['split', 'This split portion is invalid. Reopen the split and try again.'],
  coverage_unavailable: ['coverageUnavailable', 'The order balance could not be read. Try again.'],
  admission: ['admission', 'Earlier gift card attempts must be checked first.'],
  fiscal_pending: ['fiscalPending', 'A receipt for this order is still pending. Check the receipt first.'],
  staff: ['staff', 'A signed-in staff session is required. Sign in again and retry.'],
  readiness: ['readiness', 'The fiscal receipt route is not ready for gift cards.'],
  rejected: ['rejected', 'The gift card payment was refused.'],
};

const FISCAL_COPY: Record<GiftCardFiscalOutcome['status'], [string, string]> = {
  ready: ['ready', 'Receipt ready to issue'],
  partial: ['partial', 'Collect the rest with cash or card; the receipt follows that payment'],
  pending: ['pending', 'Receipt pending confirmation'],
  approved: ['approved', 'Receipt approved'],
  not_required: ['notRequired', 'No fiscal receipt required'],
  unsupported: ['unsupported', 'This receipt route does not support gift cards'],
  unavailable: ['unavailable', 'Fiscal register unavailable'],
  error: ['error', 'Receipt failed'],
  invocation_failed: ['unknown', 'Receipt state unknown'],
  unrecognized: ['unknown', 'Receipt state unknown'],
};

const UPPERCASE_ISO = /^[A-Z]{3}$/;

const toCents = (major: number): number => Math.round(major * 100);

function formatCents(cents: number, currency: string | null): string {
  const amount = (cents / 100).toFixed(2);
  return currency ? `${amount} ${currency}` : amount;
}

function failureRefusal(kind: GiftCardsFailureKind, lookup: boolean): GiftCardTenderRefusal {
  if (kind === 'offline') return 'offline';
  if (kind === 'module_disabled') return 'module';
  if (lookup && kind === 'invalid') return 'card_number';
  if (lookup && kind === 'not_found') return 'not_found';
  if (lookup && kind === 'rejected') return 'rejected';
  return 'unavailable';
}

function statusRefusal(status: GiftCardsStatus): GiftCardTenderRefusal | null {
  if (!status.moduleEnabled) return 'module';
  if (!status.enabled || status.unavailable || !status.supportsLookup) return 'unavailable';
  return null;
}

function cardRefusal(card: GiftCard, currency: string | null, now: number): GiftCardTenderRefusal | null {
  const status = card.status.trim().toLowerCase();
  if (status === 'expired' || (card.expiresAt && Date.parse(card.expiresAt) <= now)) return 'expired';
  if (status !== 'active') return 'inactive';
  if (!currency || card.currency?.trim().toUpperCase() !== currency) return 'currency';
  if (!(card.balance > 0)) return 'balance';
  return null;
}

export function GiftCardTender({
  orderId,
  orderSynced,
  currency,
  scope,
  online,
  split = null,
  fixedAmountCents = null,
  selectedItemIds = null,
  onEvent,
  service = giftCardCheckoutService,
  api = giftCardsApiService,
}: GiftCardTenderProps) {
  const { t } = useTranslation();
  const { hasModule } = useAcquiredModules();
  const moduleVisible = hasModule(MODULE_IDS.GIFT_CARDS);
  const id = orderId?.trim() ?? '';
  const activeKey = giftCardOrderKey(scope, id);

  const [admission, setAdmission] = useState<GiftCardAdmission | null>(null);
  const [coverage, setCoverage] = useState<GiftCardOrderCoverage | null>(null);
  const [status, setStatus] = useState<GiftCardsStatus | null>(null);
  const [serviceRefusal, setServiceRefusal] = useState<GiftCardTenderRefusal | null>(null);
  const [cardNumber, setCardNumber] = useState('');
  const [card, setCard] = useState<GiftCard | null>(null);
  const [amountText, setAmountText] = useState('');
  const [activeKinds, setActiveKinds] = useState<BusyKind[]>([]);
  const [refusal, setRefusal] = useState<GiftCardTenderRefusal | null>(null);
  const [applied, setApplied] = useState<GiftCardAdoptedPayment | null>(null);
  const [fiscal, setFiscal] = useState<GiftCardFiscalOutcome | null>(null);
  const busy: BusyKind | null = activeKinds.length > 0 ? activeKinds[activeKinds.length - 1] : null;

  const mountedRef = useRef(false);
  const keyRef = useRef(activeKey);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const lookupSeq = useRef(0);
  const lookupToken = useRef(0);
  const ownRedeem = useRef(false);
  const lastState = useRef<GiftCardAdmission['state'] | null>(null);
  // In-memory fences only: each action ends just its own busy entry, and an
  // older coverage or receipt answer never replaces a newer one.
  const actions = useRef(new Map<number, BusyKind>());
  const actionSeq = useRef(0);
  const coverageSeq = useRef(0);
  const coverageShown = useRef(0);
  const fiscalSeq = useRef(0);
  const reported = useRef(new Set<string>());

  const isCurrent = useCallback((key: string) => mountedRef.current && keyRef.current === key, []);
  const emit = useCallback((event: GiftCardTenderEvent) => {
    try {
      onEventRef.current?.(event);
    } catch {
      // A host callback failure never changes money state.
    }
  }, []);

  const begin = useCallback((kind: BusyKind) => {
    const token = ++actionSeq.current;
    actions.current.set(token, kind);
    setActiveKinds([...actions.current.values()]);
    return token;
  }, []);

  const finish = useCallback((token: number) => {
    if (actions.current.delete(token) && mountedRef.current) setActiveKinds([...actions.current.values()]);
  }, []);

  const showCoverage = useCallback((ticket: number, next: GiftCardOrderCoverage | null) => {
    if (ticket <= coverageShown.current) return;
    coverageShown.current = ticket;
    setCoverage(next);
  }, []);

  const runFiscal = useCallback(
    async (key: string, targetOrderId: string, action: FiscalAction) => {
      const token = begin('fiscal');
      const seq = ++fiscalSeq.current;
      let call: GiftCardFiscalCall;
      try {
        call =
          action === 'readiness'
            ? await service.fiscalReadiness(scopeRef.current, targetOrderId)
            : action === 'finalize'
              ? await service.finalizeFiscal(scopeRef.current, targetOrderId)
              : await service.reconcileFiscal(scopeRef.current, targetOrderId);
      } finally {
        finish(token);
      }
      // A newer receipt request, from this tender or another caller, governs.
      if (!isCurrent(key) || seq !== fiscalSeq.current || !call.sent || !call.current) return;
      setFiscal(call.fiscal);
      emit({ type: 'fiscal', orderId: targetOrderId, fiscal: call.fiscal });
    },
    [begin, emit, finish, isCurrent, service],
  );

  const runRecovery = useCallback(
    async (key: string, targetOrderId: string) => {
      const token = begin('recover');
      const ticket = ++coverageSeq.current;
      let outcome: GiftCardRecoveryOutcome;
      try {
        outcome = await service.recoverOrder(scopeRef.current, targetOrderId);
      } finally {
        finish(token);
      }
      if (!isCurrent(key)) return;
      // Newer work on the order may have changed admission meanwhile: show it as it is now.
      setAdmission(service.getAdmission(scopeRef.current, targetOrderId));
      showCoverage(ticket, outcome.coverage);
      const adopted = outcome.adopted.filter((payment) => !reported.current.has(payment.localPaymentId));
      adopted.forEach((payment) => reported.current.add(payment.localPaymentId));
      if (adopted.length > 0 || (outcome.coverage?.giftPayments.length ?? 0) > 0) {
        emit({
          type: 'financial',
          orderId: targetOrderId,
          source: 'recovery',
          adopted,
          coverage: outcome.coverage,
        });
        // A booked gift may still owe its receipt; read it, never re-debit.
        await runFiscal(key, targetOrderId, 'readiness');
      }
    },
    [begin, emit, finish, isCurrent, runFiscal, service, showCoverage],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(
    () =>
      service.subscribe((next) => {
        if (!mountedRef.current || giftCardAdmissionKey(next) !== keyRef.current) return;
        const previous = lastState.current;
        lastState.current = next.state;
        setAdmission(next);
        emit({ type: 'admission', orderId: next.orderId, admission: next });
        // Another caller's debit for this order settled: adopt it through native recovery.
        if (previous === 'submitting' && next.state !== 'submitting' && !ownRedeem.current) {
          const key = keyRef.current;
          void Promise.resolve().then(() => runRecovery(key, next.orderId));
        }
      }),
    [emit, runRecovery, service],
  );

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    setServiceRefusal(null);
    api.getStatus().then(
      (result) => {
        if (cancelled || !mountedRef.current) return;
        if (result.ok) setStatus(result.data);
        else setServiceRefusal(failureRefusal(result.kind, false));
      },
      () => {
        if (!cancelled && mountedRef.current) setServiceRefusal('unavailable');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, activeKey, online]);

  useEffect(() => {
    keyRef.current = activeKey;
    lookupSeq.current += 1;
    fiscalSeq.current += 1;
    coverageShown.current = coverageSeq.current;
    // Actions for the previous order or scope can no longer end busy states here.
    actions.current.clear();
    reported.current = new Set();
    // A different order or scope never inherits a card, amount or result.
    setCardNumber('');
    setCard(null);
    setAmountText('');
    setRefusal(null);
    setApplied(null);
    setFiscal(null);
    setCoverage(null);
    setActiveKinds([]);
    if (!id) {
      lastState.current = null;
      setAdmission(null);
      return;
    }
    const current = service.getAdmission(scopeRef.current, id);
    lastState.current = current.state;
    setAdmission(current);
    void runRecovery(activeKey, id);
  }, [activeKey, id, runRecovery, service]);

  const currencyValid = typeof currency === 'string' && UPPERCASE_ISO.test(currency);
  const preconditionRefusal: GiftCardTenderRefusal | null = !moduleVisible
    ? 'module'
    : !online
      ? 'offline'
      : !id
        ? 'order'
        : !orderSynced
          ? 'unsynced'
          : selectedItemIds && selectedItemIds.length > 0
            ? 'item_split'
            : !currencyValid
              ? 'currency'
              : serviceRefusal ?? (status ? statusRefusal(status) : null);
  const admissionState = admission?.state ?? null;
  const checking =
    admissionState === 'checking' || (admissionState === 'submitting' && !activeKinds.includes('redeem'));
  const uncertain = admissionState === 'unresolved';
  const needsCheck = (admissionState === 'unresolved' || admissionState === 'unknown') && busy === null;
  // Any collection hold (an ordinary cash/card collection, or another caller's
  // gift debit) blocks a new debit even while native reports the order clear.
  const reserved = Boolean(admission?.reservation);
  const admissionRefusal: GiftCardTenderRefusal | null =
    admissionState !== 'clear' || reserved ? 'admission' : admission?.fiscalPending ? 'fiscal_pending' : null;
  const coverageRefusal: GiftCardTenderRefusal | null =
    coverage && coverage.outstandingCents <= 0 ? 'nothing_due' : null;
  const cardIssue = card ? cardRefusal(card, currencyValid ? currency : null, Date.now()) : null;
  const blockedBy =
    preconditionRefusal ?? admissionRefusal ?? coverageRefusal ?? (status ? null : 'unavailable');
  const statusLoading = moduleVisible && !status && !serviceRefusal;
  const shownRefusal =
    refusal ??
    preconditionRefusal ??
    (uncertain || checking || admissionState === null ? null : admissionRefusal) ??
    coverageRefusal ??
    cardIssue;
  const formVisible = moduleVisible && preconditionRefusal === null;

  const text = (key: GiftCardTenderRefusal) => {
    const [suffix, fallback] = REFUSAL_COPY[key];
    return t(`giftCardCheckout.refusal.${suffix}`, fallback);
  };

  const fiscalText = (outcome: GiftCardFiscalOutcome) => {
    const [suffix, fallback] = FISCAL_COPY[outcome.status];
    const label = t(`giftCardCheckout.fiscal.${suffix}`, fallback);
    return outcome.status === 'approved' && !outcome.certified
      ? `${label} · ${t('giftCardCheckout.fiscal.uncertified', 'Register support not certified')}`
      : label;
  };

  const checkAgain = () => {
    if (id) void runRecovery(keyRef.current, id);
  };

  const lookup = async () => {
    if (busy !== null || blockedBy !== null) return;
    const key = keyRef.current;
    const seq = ++lookupSeq.current;
    const token = begin('lookup');
    lookupToken.current = token;
    setRefusal(null);
    setCard(null);
    setApplied(null);
    let result: Awaited<ReturnType<GiftCardsApiService['lookup']>> | null;
    try {
      result = await api.lookup(cardNumber);
    } catch {
      result = null;
    }
    finish(token);
    if (!isCurrent(key) || seq !== lookupSeq.current) return;
    if (!result) {
      setRefusal('unavailable');
      return;
    }
    if (!result.ok) {
      setRefusal(failureRefusal(result.kind, true));
      return;
    }
    const found = result.data.card;
    setCard(found);
    const due = fixedAmountCents ?? coverage?.outstandingCents ?? null;
    if (due !== null && due > 0) {
      setAmountText((Math.min(due, Math.max(toCents(found.balance), 0)) / 100).toFixed(2));
    }
  };

  const pay = async () => {
    if (!id || !card || busy !== null || blockedBy !== null || cardIssue !== null) return;
    const amountCents = fixedAmountCents ?? parseAmountToCents(amountText);
    if (amountCents === null) {
      setRefusal('amount');
      return;
    }
    const key = keyRef.current;
    const token = begin('redeem');
    const ticket = ++coverageSeq.current;
    const fiscalTurn = ++fiscalSeq.current;
    setRefusal(null);
    setApplied(null);
    ownRedeem.current = true;
    let outcome: GiftCardRedeemOutcome;
    try {
      outcome = await service.redeem(scopeRef.current, {
        orderId: id,
        cardNumber,
        amountCents,
        currency: currency ?? '',
        split,
        selectedItemIds,
        card,
      });
    } catch {
      return;
    } finally {
      ownRedeem.current = false;
      finish(token);
    }
    if (!isCurrent(key)) return;
    if (outcome.kind !== 'refused' || outcome.sent) {
      // The number never outlives an attempt that reached native.
      setCardNumber('');
      setCard(null);
      setAmountText('');
    }
    if (outcome.kind === 'applied') {
      const { payment } = outcome;
      const fresh = !reported.current.has(payment.localPaymentId);
      reported.current.add(payment.localPaymentId);
      setApplied(payment);
      showCoverage(ticket, outcome.coverage);
      emit({
        type: 'financial',
        orderId: id,
        source: 'redeem',
        adopted: fresh ? [payment] : [],
        coverage: outcome.coverage,
      });
      if (outcome.fiscal && fiscalTurn === fiscalSeq.current) {
        setFiscal(outcome.fiscal);
        emit({ type: 'fiscal', orderId: id, fiscal: outcome.fiscal });
      }
    } else if (outcome.kind === 'refused') {
      setRefusal(outcome.refusal);
    }
  };

  const fiscalAction: FiscalAction | null =
    fiscal?.nextAction === 'finalize'
      ? 'finalize'
      : fiscal?.nextAction === 'reconcile'
        ? 'reconcile'
        : fiscal?.nextAction === 'recheck'
          ? 'readiness'
          : null;

  return (
    <section className="space-y-3" data-testid="gift-card-tender" aria-busy={busy !== null}>
      <h3 className="text-sm font-semibold liquid-glass-modal-text">
        {t('giftCardCheckout.title', 'Gift card')}
      </h3>
      {coverage && coverage.outstandingCents > 0 && (
        <p className="text-xs liquid-glass-modal-text-muted">
          {t('giftCardCheckout.due', {
            amount: formatCents(coverage.outstandingCents, currency),
            defaultValue: 'Due {{amount}}',
          })}
        </p>
      )}
      {checking && (
        <p role="status" className="text-xs liquid-glass-modal-text-muted">
          {t('giftCardCheckout.checkingAttempts', 'Checking earlier gift card attempts…')}
        </p>
      )}
      {statusLoading && !checking && (
        <p role="status" className="text-xs liquid-glass-modal-text-muted">
          {t('giftCardCheckout.checkingService', 'Checking the gift card service…')}
        </p>
      )}
      {uncertain && (
        <p role="alert" className="text-xs text-amber-400">
          {t(
            'giftCardCheckout.uncertain',
            'The gift card result is not confirmed. Do not collect again; check again first.',
          )}
        </p>
      )}
      {shownRefusal && (
        <p role="alert" className="text-xs text-red-400">
          {text(shownRefusal)}
        </p>
      )}
      {needsCheck && (
        <button type="button" className="liquid-glass-modal-button" onClick={checkAgain}>
          {t('giftCardCheckout.checkAgain', 'Check again')}
        </button>
      )}
      {applied && (
        <p role="status" className="text-xs text-green-400">
          {t('giftCardCheckout.applied', {
            amount: formatCents(applied.amountCents, applied.currency),
            defaultValue: 'Gift card payment recorded: {{amount}}',
          })}
        </p>
      )}
      {formVisible && (
        <div className="space-y-2">
          <input
            type="text"
            aria-label={t('giftCardCheckout.cardNumber', 'Gift card number')}
            placeholder={t('giftCardCheckout.cardNumberPlaceholder', 'Scan or type the card number')}
            autoComplete="off"
            spellCheck={false}
            value={cardNumber}
            onChange={(event) => {
              // A new number supersedes any lookup still in flight.
              lookupSeq.current += 1;
              finish(lookupToken.current);
              setCardNumber(event.target.value);
              setCard(null);
              setRefusal(null);
            }}
            className="liquid-glass-modal-input"
          />
          <button
            type="button"
            className="liquid-glass-modal-button"
            disabled={busy !== null || blockedBy !== null || !cardNumber.trim()}
            onClick={() => void lookup()}
          >
            {t('giftCardCheckout.check', 'Check card')}
          </button>
          {card && (
            <div className="space-y-2">
              <p className="text-xs liquid-glass-modal-text-muted">
                {t('giftCardCheckout.card', {
                  masked: card.maskedNumber,
                  balance: formatCents(toCents(card.balance), card.currency),
                  defaultValue: 'Card {{masked}} · balance {{balance}}',
                })}
              </p>
              <input
                type="text"
                inputMode="decimal"
                aria-label={t('giftCardCheckout.amount', 'Amount to charge')}
                autoComplete="off"
                readOnly={fixedAmountCents !== null}
                value={fixedAmountCents !== null ? (fixedAmountCents / 100).toFixed(2) : amountText}
                onChange={(event) => setAmountText(event.target.value)}
                className="liquid-glass-modal-input"
              />
              <button
                type="button"
                className="liquid-glass-modal-button"
                disabled={busy !== null || blockedBy !== null || cardIssue !== null}
                onClick={() => void pay()}
              >
                {t('giftCardCheckout.pay', 'Charge gift card')}
              </button>
            </div>
          )}
        </div>
      )}
      {fiscal && (
        <div role="status" className="space-y-1">
          <p className="text-xs liquid-glass-modal-text-muted">{fiscalText(fiscal)}</p>
          {fiscalAction && id && (
            <button
              type="button"
              className="liquid-glass-modal-button"
              disabled={busy !== null}
              onClick={() => void runFiscal(keyRef.current, id, fiscalAction)}
            >
              {fiscalAction === 'finalize'
                ? t('giftCardCheckout.fiscal.issue', 'Issue receipt')
                : t('giftCardCheckout.fiscal.check', 'Check receipt')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export default GiftCardTender;
