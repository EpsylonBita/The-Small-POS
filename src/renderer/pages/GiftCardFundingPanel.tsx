/**
 * GiftCardFundingPanel - funded gift card issue and reload on the Windows POS.
 *
 * Every step goes through the native funding client (`giftCardFunding`): native
 * owns the attempt key, the durable journal and the hosted cashier and manager
 * sessions, and the server decides every write. The page mounts one panel per
 * lifecycle (staff, shift, trusted terminal scope, configuration epoch), so a
 * reply that returns after that lifecycle ended, or after the manager
 * authorization it relied on was closed, is dropped. Only a direct begin
 * acknowledgement invites collection. Paying an order with a gift card belongs
 * to checkout, not here.
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import {
  POSGlassBadge,
  POSGlassButton,
  POSGlassCard,
  POSGlassInput,
} from '../components/ui/pos-glass-components';
import { formatCurrency } from '../utils/format';
import { parseAmountToCents, type GiftCard } from '../services/GiftCardsApiService';
import {
  attemptBelongsTo,
  availabilityInScope,
  blocksFreshIntent,
  buildFundingEvidence,
  fundingAttemptsFor,
  giftCardFunding,
  isExpired,
  isFundingPin,
  isStrictlyCompleted,
  mayBeginCollection,
  mayCancelFunding,
  mayRecordCollection,
  type ExternalCardReferences,
  type FundingActor,
  type FundingRefused,
  type FundingStaffOption,
} from '../lib/gift-card-funding';
import type {
  GiftFundingAttemptResult,
  GiftFundingAttemptView,
  GiftFundingAvailability,
  GiftFundingDrawerView,
  GiftFundingMode,
  GiftFundingOperation,
} from '../../lib/ipc-contracts';

export type CompletedFunding = GiftFundingAttemptView & { result: GiftFundingAttemptResult };

export interface GiftCardFundingPanelProps {
  /** The selected staff member and the trusted terminal scope. */
  actor: FundingActor;
  shiftId: string;
  cashierName: string;
  /** The looked-up card; a reload funds only this card. */
  card: GiftCard | null;
  online: boolean;
  /** Page lifecycle fence: false once the staff, shift, terminal scope or configuration changed. */
  isCurrent: () => boolean;
  /** Called only for a strictly completed original of the current lifecycle. */
  onCompleted: (attempt: CompletedFunding, cardNumber: string | null) => void;
}

type Read<T> = { status: 'loading' } | { status: 'ok'; value: T } | { status: 'failed'; code: string | null };
type Tone = 'success' | 'error' | 'warning';

interface Notice {
  tone: Tone;
  message: string;
  detail: string | null;
}

/** `invited` only after a direct begin acknowledgement; otherwise evidence of an earlier collection. */
interface Collection {
  key: string;
  invited: boolean;
}

interface ManagerAuthorization {
  staffId: string;
  name: string;
  expiresAt: string;
}

interface FundingIntent {
  operation: GiftFundingOperation;
  cardId: string | null;
  amountCents: number;
  currency: string;
  reason: string;
}

const OPERATIONS: readonly GiftFundingOperation[] = ['issue', 'reload'];
const MODES: readonly GiftFundingMode[] = ['cash_confirmed', 'external_card_recorded', 'manager_grant'];
const REFERENCE_FIELDS = ['provider', 'merchantId', 'terminalReference', 'transactionReference'] as const;
const EMPTY_REFERENCES: ExternalCardReferences = {
  provider: '',
  merchantId: '',
  terminalReference: '',
  transactionReference: '',
};

const refusalCode = (outcome: { kind: string }): string | null =>
  outcome.kind === 'refused' ? (outcome as FundingRefused).code : null;

const serviceUsable = (availability: GiftFundingAvailability): boolean =>
  availability.enabled && !availability.unavailable && availability.fundingConfigured && availability.currency !== null;

function upsertAttempt(attempts: GiftFundingAttemptView[], attempt: GiftFundingAttemptView): GiftFundingAttemptView[] {
  const index = attempts.findIndex((entry) => entry.attemptKey === attempt.attemptKey);
  if (index === -1) return [...attempts, attempt];
  const next = attempts.slice();
  next[index] = attempt;
  return next;
}

const GiftCardFundingPanel: React.FC<GiftCardFundingPanelProps> = ({
  actor,
  shiftId,
  cashierName,
  card,
  online,
  isCurrent,
  onCompleted,
}) => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const managerTitleId = useId();
  const renewTitleId = useId();
  const grantTitleId = useId();
  const grantBodyId = useId();

  // Instance and manager-authority fences: a reply is shown only while both still match.
  const aliveRef = useRef(false);
  const authorityRef = useRef(0);
  const busyRef = useRef(false);
  // PIN fields are uncontrolled: a PIN never enters React state and is cleared before any await.
  const managerPinRef = useRef<HTMLInputElement>(null);
  const renewPinRef = useRef<HTMLInputElement>(null);

  const [cashier, setCashier] = useState<Read<GiftFundingAvailability>>({ status: 'loading' });
  const [journal, setJournal] = useState<Read<GiftFundingAttemptView[]>>({ status: 'loading' });
  const [drawer, setDrawer] = useState<Read<GiftFundingDrawerView> | null>(null);
  const [operation, setOperation] = useState<GiftFundingOperation>('issue');
  const [mode, setMode] = useState<GiftFundingMode>('external_card_recorded');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [collection, setCollection] = useState<Collection | null>(null);
  const [references, setReferences] = useState<ExternalCardReferences>(EMPTY_REFERENCES);
  const [cancelKey, setCancelKey] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [directory, setDirectory] = useState<FundingStaffOption[]>([]);
  const [managerId, setManagerId] = useState('');
  const [manager, setManager] = useState<ManagerAuthorization | null>(null);
  const [managerRead, setManagerRead] = useState<Read<GiftFundingAvailability> | null>(null);
  const [grantReview, setGrantReview] = useState<FundingIntent | null>(null);

  useLayoutEffect(() => {
    aliveRef.current = true;
    return () => {
      // Unmount, or a lifecycle change remounting the panel, ends every held reply.
      aliveRef.current = false;
      authorityRef.current += 1;
    };
  }, []);

  useEffect(() => {
    // A reviewed grant names one card; another lookup needs a new review.
    setGrantReview(null);
  }, [card?.id]);

  const live = useCallback(() => aliveRef.current && isCurrent(), [isCurrent]);

  const money = useCallback(
    (cents: number, currency: string) => formatCurrency(cents / 100, currency, i18n.language),
    [i18n.language],
  );

  const say = (tone: Tone, message: string, detail: string | null = null) => setNotice({ tone, message, detail });
  const detailOf = (code: string | null | undefined) => (code ? t('giftCards.errors.details', { code }) : null);

  const exclusive = async (task: () => Promise<void>): Promise<void> => {
    // A ref, not state, so a second press in the same frame is already refused.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await task();
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  /** Advisory availability, the durable native journal and, for cash, this cashier's drawer. */
  const loadReads = async (): Promise<void> => {
    if (!live()) return;
    setCashier({ status: 'loading' });
    setJournal({ status: 'loading' });
    setDrawer(null);
    const [availability, attempts] = await Promise.all([
      giftCardFunding.availability(actor.staffId, 'cashier'),
      giftCardFunding.journal(),
    ]);
    if (!live()) return;
    setJournal(
      attempts.kind === 'ok' ? { status: 'ok', value: attempts.attempts } : { status: 'failed', code: refusalCode(attempts) },
    );
    // A reply for another terminal scope is not this terminal's availability.
    if (availability.kind !== 'ok' || !availabilityInScope(availability.availability, actor)) {
      setCashier({ status: 'failed', code: refusalCode(availability) });
      return;
    }
    const current = availability.availability;
    setCashier({ status: 'ok', value: current });
    if (!current.modes.cash_confirmed.ready) return;
    setDrawer({ status: 'loading' });
    const drawerOutcome = await giftCardFunding.drawer(actor.staffId);
    if (!live()) return;
    if (
      drawerOutcome.kind === 'ok' &&
      drawerOutcome.drawer.staffId === actor.staffId &&
      drawerOutcome.drawer.shiftId === shiftId &&
      drawerOutcome.drawer.currency === current.currency
    ) {
      setDrawer({ status: 'ok', value: drawerOutcome.drawer });
    } else {
      setDrawer({ status: 'failed', code: refusalCode(drawerOutcome) });
    }
  };

  useEffect(() => {
    // Mount only: the page remounts this panel for another actor, shift or scope.
    void exclusive(loadReads);
  }, []);

  const reloadJournal = async (): Promise<void> => {
    if (!live()) return;
    setJournal({ status: 'loading' });
    const attempts = await giftCardFunding.journal();
    if (!live()) return;
    setJournal(
      attempts.kind === 'ok' ? { status: 'ok', value: attempts.attempts } : { status: 'failed', code: refusalCode(attempts) },
    );
  };

  const remember = (attempt: GiftFundingAttemptView | null | undefined) => {
    if (!attempt) return;
    setJournal((current) =>
      current.status === 'ok' ? { status: 'ok', value: upsertAttempt(current.value, attempt) } : current,
    );
  };

  const settleAttempt = (attempt: GiftFundingAttemptView, cardNumber: string | null, owner: FundingActor) => {
    remember(attempt);
    if (isStrictlyCompleted(attempt) && attemptBelongsTo(attempt, owner)) {
      say(
        'success',
        t('giftCards.funding.messages.completed', { balance: money(attempt.result.cardBalanceCents, attempt.currency) }),
      );
      // A new card number is shown only for this strictly completed, current issue.
      onCompleted(attempt, attempt.operation === 'issue' ? cardNumber : null);
      return;
    }
    if (attempt.state === 'prepared') return say('success', t('giftCards.funding.messages.prepared'));
    if (attempt.state === 'canceled') return say('success', t('giftCards.funding.messages.canceled'));
    if (attempt.state === 'refused' || attempt.state === 'abandoned') {
      return say('error', t('giftCards.funding.messages.final'), detailOf(attempt.lastCode));
    }
    if (attempt.state === 'collection_started') return say('warning', t('giftCards.funding.pending.noCollectAgain'));
    say('warning', t('giftCards.funding.messages.pendingOutcome'));
  };

  const refused = (outcome: FundingRefused & { attempt?: GiftFundingAttemptView | null }) => {
    remember(outcome.attempt);
    const final = outcome.attempt?.state === 'refused' || outcome.attempt?.state === 'abandoned';
    say(
      'error',
      t(final ? 'giftCards.funding.messages.final' : 'giftCards.funding.messages.refused'),
      detailOf(outcome.code),
    );
  };

  const lost = async (): Promise<void> => {
    // Unknown, never a refusal: the original stays in the native journal for recovery.
    say('warning', t('giftCards.funding.messages.unknownOutcome'));
    await reloadJournal();
  };

  // -- Derived readiness ------------------------------------------------------
  const cashierAvailability = cashier.status === 'ok' ? cashier.value : null;
  const journalReady = journal.status === 'ok';
  const attempts = journal.status === 'ok' ? journal.value : [];
  const operatorReady = cashierAvailability?.operator.ready === true;
  const cashierUsable = cashierAvailability !== null && serviceUsable(cashierAvailability);
  const drawerReady = drawer?.status === 'ok';
  const modeReady = (candidate: GiftFundingMode): boolean => {
    if (!cashierAvailability || !cashierUsable || !operatorReady) return false;
    if (candidate === 'cash_confirmed') return cashierAvailability.modes.cash_confirmed.ready && drawerReady;
    if (candidate === 'external_card_recorded') return cashierAvailability.modes.external_card_recorded.ready;
    return false;
  };
  const managerExpired = manager !== null && isExpired(manager.expiresAt);
  const managerActor: FundingActor | null = manager && !managerExpired ? { ...actor, staffId: manager.staffId } : null;
  const managerAvailability =
    managerRead?.status === 'ok' && manager !== null && managerRead.value.staffId === manager.staffId
      ? managerRead.value
      : null;
  // Only the selected cashier's originals, plus a separately authorized manager's grants.
  const cashierAttempts = fundingAttemptsFor(attempts, actor, false);
  const managerAttempts = managerActor ? fundingAttemptsFor(attempts, managerActor, true) : [];
  const fundingCurrency =
    mode === 'manager_grant' ? managerAvailability?.currency ?? null : cashierAvailability?.currency ?? null;
  const reloadMismatch = card !== null && fundingCurrency !== null && card.currency !== fundingCurrency;
  const operationReady = operation === 'issue' || (card !== null && !reloadMismatch);
  const reloadCardId = operation === 'reload' ? card?.id ?? null : null;
  const blocked = [...cashierAttempts, ...managerAttempts].some((attempt) =>
    blocksFreshIntent(attempt, operation, reloadCardId),
  );
  const prepareReady =
    online && journalReady && mode !== 'manager_grant' && modeReady(mode) && operationReady && !blocked;
  const grantReady =
    online &&
    journalReady &&
    managerActor !== null &&
    managerAvailability !== null &&
    serviceUsable(managerAvailability) &&
    managerAvailability.modes.manager_grant.ready &&
    operationReady &&
    !blocked;
  const needsRenewal = cashier.status === 'failed' || (cashierAvailability !== null && !operatorReady);

  const buildIntent = (currency: string | null): FundingIntent | null => {
    const amountCents = parseAmountToCents(amount);
    if (amountCents === null) {
      say('error', t('giftCards.funding.errors.amount'));
      return null;
    }
    const why = reason.trim();
    if (!why) {
      say('error', t('giftCards.funding.errors.reason'));
      return null;
    }
    if (!currency) {
      say('error', t('giftCards.funding.noCurrency'));
      return null;
    }
    let cardId: string | null = null;
    if (operation === 'reload') {
      if (!card) {
        say('error', t('giftCards.funding.operation.reloadNeedsCard'));
        return null;
      }
      if (card.currency !== currency) {
        say('error', t('giftCards.funding.operation.currencyMismatch'));
        return null;
      }
      cardId = card.id;
    }
    if ([...cashierAttempts, ...managerAttempts].some((attempt) => blocksFreshIntent(attempt, operation, cardId))) {
      say('warning', t('giftCards.funding.pendingBlocks'));
      return null;
    }
    return { operation, cardId, amountCents, currency, reason: why };
  };

  // -- Cashier-collected funding ----------------------------------------------
  const handlePrepare = () =>
    exclusive(async () => {
      if (!live() || mode === 'manager_grant' || !prepareReady || !cashierAvailability) return;
      const intent = buildIntent(cashierAvailability.currency);
      if (!intent) return;
      setNotice(null);
      const outcome = await giftCardFunding.prepare({
        staffId: actor.staffId,
        mode,
        operation: intent.operation,
        ...(intent.cardId ? { cardId: intent.cardId } : {}),
        amountCents: intent.amountCents,
        currency: intent.currency,
        reason: intent.reason,
      });
      if (!live()) return;
      if (outcome.kind === 'lost') return lost();
      if (outcome.kind === 'refused') return refused(outcome);
      setAmount('');
      setReason('');
      settleAttempt(outcome.attempt, null, actor);
    });

  const handleBegin = (attempt: GiftFundingAttemptView) =>
    exclusive(async () => {
      if (!live() || !online || !journalReady || !mayBeginCollection(attempt) || !modeReady(attempt.mode)) return;
      if (!attemptBelongsTo(attempt, actor)) return;
      setNotice(null);
      setCollection(null);
      setReferences(EMPTY_REFERENCES);
      const outcome = await giftCardFunding.begin(attempt.attemptKey);
      // A held acknowledgement from an ended lifecycle must never invite collection.
      if (!live()) return;
      if (outcome.kind === 'lost') return lost();
      if (outcome.kind === 'refused') return refused(outcome);
      const acknowledged = outcome.attempt;
      remember(acknowledged);
      if (
        acknowledged.collectionPermitted &&
        acknowledged.state === 'collection_started' &&
        attemptBelongsTo(acknowledged, actor)
      ) {
        setCollection({ key: acknowledged.attemptKey, invited: true });
        say('success', t('giftCards.funding.messages.collect'));
        return;
      }
      say('warning', t('giftCards.funding.messages.notPermitted'));
    });

  const handleComplete = (attempt: GiftFundingAttemptView) =>
    exclusive(async () => {
      if (!live() || collection?.key !== attempt.attemptKey || !attemptBelongsTo(attempt, actor)) return;
      const invited = collection.invited && attempt.state === 'collection_started';
      if (!invited && !mayRecordCollection(attempt)) return;
      const evidence = buildFundingEvidence(attempt, references);
      if (!evidence) return say('error', t('giftCards.funding.evidence.incomplete'));
      setNotice(null);
      // Whatever the reply, this original is never offered for collection again.
      setCollection(null);
      const outcome = await giftCardFunding.complete(attempt.attemptKey, evidence);
      if (!live()) return;
      if (outcome.kind === 'lost') return lost();
      if (outcome.kind === 'refused') return refused(outcome);
      setReferences(EMPTY_REFERENCES);
      settleAttempt(outcome.attempt, outcome.cardNumber, actor);
    });

  const handleRecover = (attempt: GiftFundingAttemptView, owner: FundingActor, grant: boolean) =>
    exclusive(async () => {
      if (!live()) return;
      const authority = authorityRef.current;
      setNotice(null);
      // Recovery may record an earlier collection but never invites collecting again.
      if (collection?.key === attempt.attemptKey) setCollection(null);
      const outcome = await giftCardFunding.recover(attempt.attemptKey);
      if (!live() || (grant && authority !== authorityRef.current)) return;
      if (outcome.kind === 'lost') return lost();
      if (outcome.kind === 'refused') return refused(outcome);
      settleAttempt(outcome.attempt, outcome.cardNumber, owner);
    });

  const handleCancel = (attempt: GiftFundingAttemptView, owner: FundingActor, grant: boolean) =>
    exclusive(async () => {
      if (!live() || !mayCancelFunding(attempt) || cancelKey !== attempt.attemptKey) return;
      const why = cancelReason.trim();
      if (!why) return say('error', t('giftCards.funding.errors.reason'));
      const authority = authorityRef.current;
      setNotice(null);
      const outcome = await giftCardFunding.cancel(attempt.attemptKey, why);
      if (!live() || (grant && authority !== authorityRef.current)) return;
      setCancelKey(null);
      setCancelReason('');
      if (outcome.kind === 'lost') return lost();
      if (outcome.kind === 'refused') return refused(outcome);
      settleAttempt(outcome.attempt, null, owner);
    });

  // -- Same-cashier renewal of the original shift opening ----------------------
  const handleRenew = () =>
    exclusive(async () => {
      const input = renewPinRef.current;
      const pin = input?.value ?? '';
      if (input) input.value = '';
      if (!live()) return;
      if (!isFundingPin(pin)) return say('error', t('giftCards.funding.errors.pin'));
      setNotice(null);
      const opening = await giftCardFunding.cashierOpening(actor, shiftId);
      if (!live()) return;
      if (opening.kind === 'lost') return say('warning', t('giftCards.funding.errors.noReply'));
      if (!opening.opening) return say('error', t('giftCards.funding.renew.noOpening'));
      // The same cashier's original opening of this shift: no new shift or drawer.
      const renewed = await giftCardFunding.renewCashier(opening.opening, pin);
      if (!live()) return;
      if (renewed.kind === 'lost') return say('warning', t('giftCards.funding.errors.noReply'));
      if (renewed.kind === 'refused') {
        return say('error', t('giftCards.funding.errors.renewFailed'), detailOf(renewed.code));
      }
      await loadReads();
      if (live()) say('success', t('giftCards.funding.renew.done'));
    });

  // -- Manager grant ------------------------------------------------------------
  const closeManager = () => {
    // Closing the authorization ends it: held manager replies are dropped from here on.
    authorityRef.current += 1;
    if (managerPinRef.current) managerPinRef.current.value = '';
    setManager(null);
    setManagerRead(null);
    setGrantReview(null);
    setManagerId('');
  };

  const loadDirectory = async (): Promise<void> => {
    const options = await giftCardFunding.staffDirectory(actor.branchId, { id: actor.staffId, name: cashierName });
    if (live()) setDirectory(options);
  };

  const selectMode = (next: GiftFundingMode) => {
    if (busyRef.current || next === mode) return;
    if (mode === 'manager_grant') closeManager();
    setMode(next);
    if (next === 'manager_grant') void loadDirectory();
  };

  const handleAuthorizeManager = () =>
    exclusive(async () => {
      const input = managerPinRef.current;
      const pin = input?.value ?? '';
      if (input) input.value = '';
      if (!live()) return;
      const staffId = managerId;
      if (!staffId) return say('error', t('giftCards.funding.errors.managerRequired'));
      if (!isFundingPin(pin)) return say('error', t('giftCards.funding.errors.pin'));
      authorityRef.current += 1;
      const authority = authorityRef.current;
      const current = () => live() && authority === authorityRef.current;
      setManager(null);
      setManagerRead(null);
      setGrantReview(null);
      setNotice(null);
      const authorization = await giftCardFunding.authorizeManager(staffId, pin);
      if (!current()) return;
      if (authorization.kind === 'lost') return say('warning', t('giftCards.funding.errors.noReply'));
      if (authorization.kind === 'refused') {
        return say('error', t('giftCards.funding.errors.managerFailed'), detailOf(authorization.code));
      }
      const name = directory.find((option) => option.id === staffId)?.name ?? staffId;
      setManager({ staffId, name, expiresAt: authorization.expiresAt });
      setManagerRead({ status: 'loading' });
      // Manager-purpose availability is read separately; it consumes no grant.
      const availability = await giftCardFunding.availability(staffId, 'manager');
      if (!current()) return;
      if (availability.kind !== 'ok' || !availabilityInScope(availability.availability, { ...actor, staffId })) {
        setManagerRead({ status: 'failed', code: refusalCode(availability) });
        return say('error', t('giftCards.funding.manager.notReady'), detailOf(refusalCode(availability)));
      }
      setManagerRead({ status: 'ok', value: availability.availability });
      const grantMode = availability.availability.modes.manager_grant;
      if (grantMode.ready && serviceUsable(availability.availability)) {
        return say('success', t('giftCards.funding.messages.managerAuthorized'));
      }
      say('error', t('giftCards.funding.manager.notReady'), detailOf(grantMode.reason));
    });

  const handleReviewGrant = () => {
    if (busyRef.current || !live() || !grantReady || !managerAvailability) return;
    const intent = buildIntent(managerAvailability.currency);
    if (!intent) return;
    setNotice(null);
    setGrantReview(intent);
  };

  const handleConfirmGrant = () =>
    exclusive(async () => {
      const review = grantReview;
      const authorized = manager;
      if (!live() || !review || !authorized || !grantReady) return;
      if (isExpired(authorized.expiresAt)) {
        setGrantReview(null);
        return say('error', t('giftCards.funding.manager.expired'));
      }
      const authority = authorityRef.current;
      const owner: FundingActor = { ...actor, staffId: authorized.staffId };
      setNotice(null);
      const outcome = await giftCardFunding.grant({
        staffId: authorized.staffId,
        operation: review.operation,
        ...(review.cardId ? { cardId: review.cardId } : {}),
        amountCents: review.amountCents,
        currency: review.currency,
        reason: review.reason,
      });
      // A reply after the authorization was closed stays in the native journal only.
      if (!live() || authority !== authorityRef.current) return;
      setGrantReview(null);
      if (outcome.kind === 'lost') return lost();
      if (outcome.kind === 'refused') return refused(outcome);
      setAmount('');
      setReason('');
      settleAttempt(outcome.attempt, outcome.cardNumber, owner);
    });

  // -- View -----------------------------------------------------------------------
  const mutedClass = isDark ? 'text-zinc-400' : 'text-gray-500';
  const noticeClass: Record<Tone, string> = {
    success: isDark
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800',
    error: isDark ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-800',
    warning: isDark
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
      : 'border-amber-200 bg-amber-50 text-amber-900',
  };
  const toneText: Record<Tone, string> = {
    success: isDark ? 'text-emerald-300' : 'text-emerald-700',
    error: isDark ? 'text-red-300' : 'text-red-600',
    warning: isDark ? 'text-amber-300' : 'text-amber-700',
  };
  const sectionClass = `rounded-2xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-white/70'}`;
  const fieldClass = `h-12 w-full rounded-xl border px-3 text-base outline-none focus:ring-2 focus:ring-yellow-400 disabled:opacity-50 ${
    isDark ? 'border-zinc-700 bg-zinc-900 text-zinc-100' : 'border-gray-200 bg-white text-gray-900'
  }`;
  const optionClass = (selected: boolean) =>
    `min-h-12 w-full rounded-2xl border px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50 ${
      selected
        ? 'border-yellow-400 bg-yellow-400 text-black'
        : isDark
          ? 'border-zinc-800 bg-zinc-900 text-zinc-100'
          : 'border-gray-200 bg-white text-gray-800'
    }`;

  const statusLine = (): { tone: Tone | 'muted'; text: string; detail: string | null } => {
    if (cashier.status === 'loading' || journal.status === 'loading') {
      return { tone: 'muted', text: t('giftCards.funding.checking'), detail: null };
    }
    if (journal.status === 'failed') {
      return { tone: 'error', text: t('giftCards.funding.journalFailed'), detail: detailOf(journal.code) };
    }
    if (cashier.status === 'failed') {
      return { tone: 'error', text: t('giftCards.funding.readFailed'), detail: detailOf(cashier.code) };
    }
    const availability = cashier.value;
    if (!availability.enabled || availability.unavailable || !availability.fundingConfigured) {
      return {
        tone: 'error',
        text: t('giftCards.funding.unavailable'),
        detail: detailOf(availability.configurationRequired),
      };
    }
    if (!availability.currency) {
      return { tone: 'error', text: t('giftCards.funding.noCurrency'), detail: detailOf(availability.configurationRequired) };
    }
    if (!online) return { tone: 'warning', text: t('giftCards.status.offline'), detail: null };
    return { tone: 'muted', text: t('giftCards.funding.currency', { currency: availability.currency }), detail: null };
  };
  const status = statusLine();

  const withReason = (label: string, code: string | null) =>
    code ? `${label} ${t('giftCards.funding.mode.reason', { reason: code })}` : label;

  const modeNote = (candidate: GiftFundingMode): string | null => {
    if (candidate === 'manager_grant') return t('giftCards.funding.mode.grantHint');
    if (!cashierAvailability) return t('giftCards.funding.mode.unavailable');
    const entry = cashierAvailability.modes[candidate];
    if (candidate === 'cash_confirmed') {
      if (!entry.ready) return withReason(t('giftCards.funding.mode.cashUnavailable'), entry.reason);
      if (!drawerReady) {
        return t('giftCards.funding.mode.cashDrawer', { currency: cashierAvailability.currency ?? '' });
      }
      return null;
    }
    if (!entry.ready) return withReason(t('giftCards.funding.mode.unavailable'), entry.reason);
    return t('giftCards.funding.mode.externalHint');
  };

  const renderAttempt = (attempt: GiftFundingAttemptView, owner: FundingActor, grant: boolean) => {
    const amountLabel = money(attempt.amountCents, attempt.currency);
    const open = collection !== null && collection.key === attempt.attemptKey ? collection : null;
    const showForm = open !== null && attempt.state === 'collection_started' && attempt.mode !== 'manager_grant';
    return (
      <li key={attempt.attemptKey} className="py-3" data-testid="gift-funding-attempt">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">
              {t(`giftCards.funding.operation.${attempt.operation}`)} · {t(`giftCards.funding.mode.${attempt.mode}`)}
            </p>
            <POSGlassBadge variant={attempt.state === 'completed' ? 'success' : attempt.state === 'collection_started' ? 'warning' : 'pending'} size="sm">
              {t(`giftCards.funding.pending.states.${attempt.state}`)}
            </POSGlassBadge>
          </div>
          <p className="shrink-0 font-semibold">{amountLabel}</p>
        </div>
        {attempt.state === 'collection_started' && !open?.invited && (
          <p className={`mt-2 text-xs ${toneText.warning}`}>{t('giftCards.funding.pending.noCollectAgain')}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {mayBeginCollection(attempt) && (
            <POSGlassButton
              type="button"
              onClick={() => void handleBegin(attempt)}
              disabled={busy || !online || !journalReady || !modeReady(attempt.mode)}
            >
              {t('giftCards.funding.pending.begin')}
            </POSGlassButton>
          )}
          {mayRecordCollection(attempt) && open === null && (
            <POSGlassButton
              type="button"
              variant="warning"
              onClick={() => {
                setReferences(EMPTY_REFERENCES);
                setCollection({ key: attempt.attemptKey, invited: false });
              }}
              disabled={busy}
            >
              {t('giftCards.funding.pending.recordCollected')}
            </POSGlassButton>
          )}
          <POSGlassButton
            type="button"
            variant="secondary"
            onClick={() => void handleRecover(attempt, owner, grant)}
            disabled={busy}
          >
            {t('giftCards.funding.pending.check')}
          </POSGlassButton>
          {mayCancelFunding(attempt) && cancelKey !== attempt.attemptKey && (
            <POSGlassButton
              type="button"
              variant="secondary"
              onClick={() => {
                setCancelKey(attempt.attemptKey);
                setCancelReason('');
              }}
              disabled={busy}
            >
              {t('giftCards.funding.pending.cancel')}
            </POSGlassButton>
          )}
        </div>
        {cancelKey === attempt.attemptKey && mayCancelFunding(attempt) && (
          <div className={`mt-2 ${sectionClass}`}>
            <POSGlassInput
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              placeholder={t('giftCards.funding.pending.cancelReason')}
              aria-label={t('giftCards.funding.pending.cancelReason')}
              maxLength={500}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <POSGlassButton
                type="button"
                variant="warning"
                onClick={() => void handleCancel(attempt, owner, grant)}
                disabled={busy}
              >
                {t('giftCards.funding.pending.cancelConfirm')}
              </POSGlassButton>
              <POSGlassButton
                type="button"
                variant="secondary"
                onClick={() => {
                  setCancelKey(null);
                  setCancelReason('');
                }}
                disabled={busy}
              >
                {t('giftCards.funding.pending.back')}
              </POSGlassButton>
            </div>
          </div>
        )}
        {showForm && open && (
          <div
            role="group"
            aria-label={
              open.invited
                ? t('giftCards.funding.collect.title', { amount: amountLabel })
                : t('giftCards.funding.pending.recordCollected')
            }
            className={`mt-3 rounded-2xl border p-3 ${noticeClass.warning}`}
          >
            <p className="font-semibold">
              {open.invited
                ? t('giftCards.funding.collect.title', { amount: amountLabel })
                : t('giftCards.funding.pending.recordCollected')}
            </p>
            <p className="mt-1 text-sm">
              {open.invited
                ? t(attempt.mode === 'cash_confirmed' ? 'giftCards.funding.collect.cash' : 'giftCards.funding.collect.external', {
                    amount: amountLabel,
                  })
                : t('giftCards.funding.pending.recordCollectedWarning')}
            </p>
            {attempt.mode === 'external_card_recorded' && (
              <>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {REFERENCE_FIELDS.map((field) => (
                    <POSGlassInput
                      key={field}
                      value={references[field]}
                      onChange={(event) => {
                        const value = event.target.value;
                        setReferences((current) => ({ ...current, [field]: value }));
                      }}
                      placeholder={t(`giftCards.funding.evidence.${field}`)}
                      aria-label={t(`giftCards.funding.evidence.${field}`)}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={128}
                    />
                  ))}
                </div>
                <p className="mt-2 text-xs">{t('giftCards.funding.collect.recordedNotice')}</p>
              </>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <POSGlassButton type="button" variant="success" onClick={() => void handleComplete(attempt)} disabled={busy}>
                {attempt.mode === 'cash_confirmed'
                  ? t('giftCards.funding.collect.cashConfirm', { amount: amountLabel })
                  : t('giftCards.funding.collect.externalConfirm')}
              </POSGlassButton>
              <POSGlassButton
                type="button"
                variant="secondary"
                onClick={() => {
                  setCollection(null);
                  setReferences(EMPTY_REFERENCES);
                }}
                disabled={busy}
              >
                {t('giftCards.funding.pending.back')}
              </POSGlassButton>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <POSGlassCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('giftCards.funding.title')}</h2>
          <p className={`text-xs ${mutedClass}`}>{t('giftCards.funding.hint')}</p>
          <p className={`mt-1 text-sm ${mutedClass}`}>{t('giftCards.funding.cashier', { name: cashierName })}</p>
        </div>
        <POSGlassButton
          type="button"
          variant="secondary"
          onClick={() => void exclusive(loadReads)}
          disabled={busy}
          icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
        >
          {t('giftCards.funding.retry')}
        </POSGlassButton>
      </div>

      <div role="status" aria-live="polite" className="mt-3 text-sm">
        <p className={status.tone === 'muted' ? mutedClass : toneText[status.tone]}>{status.text}</p>
        {status.detail && <p className={`text-xs ${mutedClass}`}>{status.detail}</p>}
        {cashierAvailability && !operatorReady && (
          <p className={`mt-1 ${toneText.warning}`}>{t('giftCards.funding.operatorNotReady')}</p>
        )}
      </div>

      {needsRenewal && (
        <div role="group" aria-labelledby={renewTitleId} className={`mt-3 rounded-2xl border p-3 ${noticeClass.warning}`}>
          <p id={renewTitleId} className="font-semibold">
            {t('giftCards.funding.renew.title')}
          </p>
          <p className="mt-1 text-sm">
            {t(cashierAvailability ? 'giftCards.funding.renew.required' : 'giftCards.funding.renew.optional')}
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              ref={renewPinRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              aria-label={t('giftCards.funding.renew.pin')}
              placeholder={t('giftCards.funding.renew.pin')}
              disabled={busy}
              className={fieldClass}
            />
            <POSGlassButton type="button" onClick={() => void handleRenew()} disabled={busy}>
              {t('giftCards.funding.renew.action')}
            </POSGlassButton>
          </div>
        </div>
      )}

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={`mt-3 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm ${noticeClass[notice.tone]}`}
        >
          {notice.tone === 'success' ? (
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <p>{notice.message}</p>
            {notice.detail && <p className="mt-1 text-xs opacity-80">{notice.detail}</p>}
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-3">
        <div role="radiogroup" aria-label={t('giftCards.funding.operation.label')}>
          <p className={`mb-1 text-xs font-medium ${mutedClass}`}>{t('giftCards.funding.operation.label')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {OPERATIONS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={operation === candidate}
                aria-label={t(`giftCards.funding.operation.${candidate}`)}
                disabled={busy}
                onClick={() => {
                  setOperation(candidate);
                  setGrantReview(null);
                }}
                className={optionClass(operation === candidate)}
              >
                {t(`giftCards.funding.operation.${candidate}`)}
              </button>
            ))}
          </div>
          {operation === 'reload' && (
            <p className={`mt-1 text-xs ${!card || reloadMismatch ? toneText.warning : mutedClass}`}>
              {!card
                ? t('giftCards.funding.operation.reloadNeedsCard')
                : reloadMismatch
                  ? t('giftCards.funding.operation.currencyMismatch')
                  : card.maskedNumber}
            </p>
          )}
        </div>

        <div role="radiogroup" aria-label={t('giftCards.funding.mode.label')}>
          <p className={`mb-1 text-xs font-medium ${mutedClass}`}>{t('giftCards.funding.mode.label')}</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODES.map((candidate) => {
              const note = modeNote(candidate);
              // Manager grant stays reachable: the cashier's own availability does not decide it.
              const disabled = busy || (candidate !== 'manager_grant' && !modeReady(candidate));
              return (
                <div key={candidate} className="flex flex-col gap-1">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode === candidate}
                    aria-label={t(`giftCards.funding.mode.${candidate}`)}
                    disabled={disabled}
                    onClick={() => selectMode(candidate)}
                    className={optionClass(mode === candidate)}
                  >
                    {t(`giftCards.funding.mode.${candidate}`)}
                  </button>
                  {note && <p className={`text-xs ${mutedClass}`}>{note}</p>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <POSGlassInput
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setGrantReview(null);
            }}
            placeholder={t('giftCards.funding.amount')}
            aria-label={t('giftCards.funding.amount')}
            inputMode="decimal"
            autoComplete="off"
            disabled={busy}
          />
          <POSGlassInput
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setGrantReview(null);
            }}
            placeholder={t('giftCards.funding.reasonPlaceholder')}
            aria-label={t('giftCards.funding.reason')}
            maxLength={500}
            disabled={busy}
          />
        </div>

        {blocked && <p className={`text-sm ${toneText.warning}`}>{t('giftCards.funding.pendingBlocks')}</p>}

        {mode !== 'manager_grant' ? (
          <POSGlassButton type="button" onClick={() => void handlePrepare()} disabled={!prepareReady || busy}>
            {t('giftCards.funding.prepare')}
          </POSGlassButton>
        ) : (
          <div role="dialog" aria-labelledby={managerTitleId} className={sectionClass}>
            <p id={managerTitleId} className="font-semibold">
              {t('giftCards.funding.manager.title')}
            </p>
            <p className={`mt-1 text-xs ${mutedClass}`}>{t('giftCards.funding.mode.grantHint')}</p>
            {managerExpired && (
              <p role="alert" className={`mt-2 text-sm ${toneText.error}`}>
                {t('giftCards.funding.manager.expired')}
              </p>
            )}
            {manager && !managerExpired && (
              <p className="mt-2 text-sm font-medium">{t('giftCards.funding.manager.authorized', { name: manager.name })}</p>
            )}
            {!(managerAvailability && !managerExpired) && (
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <select
                  aria-label={t('giftCards.funding.manager.select')}
                  value={managerId}
                  onChange={(event) => setManagerId(event.target.value)}
                  disabled={busy}
                  className={fieldClass}
                >
                  <option value="">{t('giftCards.funding.manager.selectPlaceholder')}</option>
                  {directory.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
                <input
                  ref={managerPinRef}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  aria-label={t('giftCards.funding.manager.pin')}
                  placeholder={t('giftCards.funding.manager.pin')}
                  disabled={busy}
                  className={fieldClass}
                />
                <POSGlassButton type="button" onClick={() => void handleAuthorizeManager()} disabled={busy}>
                  {t('giftCards.funding.manager.authorize')}
                </POSGlassButton>
              </div>
            )}
            {managerAvailability && !managerExpired && !grantReview && (
              <POSGlassButton type="button" className="mt-3" onClick={handleReviewGrant} disabled={!grantReady || busy}>
                {t('giftCards.funding.manager.review')}
              </POSGlassButton>
            )}
            {grantReview && manager && (
              <div
                role="alertdialog"
                aria-labelledby={grantTitleId}
                aria-describedby={grantBodyId}
                className={`mt-3 rounded-2xl border p-3 ${noticeClass.warning}`}
              >
                <p id={grantTitleId} className="font-semibold">
                  {t('giftCards.funding.manager.confirmTitle')}
                </p>
                <p id={grantBodyId} className="mt-1 text-sm">
                  {t('giftCards.funding.manager.confirmBody', {
                    manager: manager.name,
                    amount: money(grantReview.amountCents, grantReview.currency),
                    operation: t(`giftCards.funding.operation.${grantReview.operation}`),
                  })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <POSGlassButton
                    type="button"
                    variant="warning"
                    onClick={() => void handleConfirmGrant()}
                    disabled={busy || !grantReady}
                  >
                    {t('giftCards.funding.manager.confirm')}
                  </POSGlassButton>
                  <POSGlassButton type="button" variant="secondary" onClick={() => setGrantReview(null)} disabled={busy}>
                    {t('giftCards.funding.manager.back')}
                  </POSGlassButton>
                </div>
              </div>
            )}
            {!grantReview && (
              <POSGlassButton
                type="button"
                variant="secondary"
                className="mt-3"
                onClick={() => selectMode('external_card_recorded')}
                disabled={busy}
              >
                {t('giftCards.funding.manager.back')}
              </POSGlassButton>
            )}
          </div>
        )}
      </div>

      {journalReady && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">{t('giftCards.funding.pending.title')}</h3>
          {cashierAttempts.length === 0 ? (
            <p className={`text-sm ${mutedClass}`}>{t('giftCards.funding.pending.empty')}</p>
          ) : (
            <ul className={`divide-y ${isDark ? 'divide-zinc-800' : 'divide-gray-200'}`}>
              {cashierAttempts.map((attempt) => renderAttempt(attempt, actor, false))}
            </ul>
          )}
        </div>
      )}

      {journalReady && managerActor && manager && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">{t('giftCards.funding.manager.pendingTitle', { name: manager.name })}</h3>
          {managerAttempts.length === 0 ? (
            <p className={`text-sm ${mutedClass}`}>{t('giftCards.funding.pending.empty')}</p>
          ) : (
            <ul className={`divide-y ${isDark ? 'divide-zinc-800' : 'divide-gray-200'}`}>
              {managerAttempts.map((attempt) => renderAttempt(attempt, managerActor, true))}
            </ul>
          )}
        </div>
      )}
    </POSGlassCard>
  );
};

export default GiftCardFundingPanel;
