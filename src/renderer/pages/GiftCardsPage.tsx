/**
 * GiftCardsPage - Windows POS gift card management (THE-307).
 *
 * Lookup and history through the terminal-authenticated `/api/pos/gift-cards/*`
 * contract; issue and reload only as funded value through the native funding
 * client (`GiftCardFundingPanel`). Android parity reference: POSSystemMobile
 * `GiftCardsScreen`. Everything fails closed: without the module, a ready
 * status and a live connection no lookup is offered, and funding needs its own
 * native availability and journal. A change of staff, shift or terminal
 * configuration, an app reset or unmount drops every held reply and clears the
 * displayed card and any newly issued number. Paying an order with a gift card
 * belongs to checkout, not here.
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, Gift, History, RefreshCw, Search } from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { MODULE_IDS, useAcquiredModules } from '../hooks/useAcquiredModules';
import {
  POSGlassBadge,
  POSGlassButton,
  POSGlassCard,
  POSGlassInput,
} from '../components/ui/pos-glass-components';
import { formatCurrency } from '../utils/format';
import { getBridge, offEvent, onEvent } from '../../lib';
import {
  giftCardsApiService,
  normalizeGiftCardNumber,
  type GiftCard,
  type GiftCardTransaction,
  type GiftCardsFailure,
  type GiftCardsStatus,
} from '../services/GiftCardsApiService';
import type { FundingActor } from '../lib/gift-card-funding';
import GiftCardFundingPanel, { type CompletedFunding } from './GiftCardFundingPanel';

type BusyAction = 'refresh' | 'lookup';
type BannerTone = 'success' | 'error' | 'warning';
type StatusBadge = 'checking' | 'enabled' | 'disabled' | 'unavailable' | 'offline';

interface Banner {
  tone: BannerTone;
  message: string;
  detail: string | null;
}

interface TerminalIdentity {
  ready: boolean;
  organizationId: string | null;
  branchId: string | null;
  terminalId: string | null;
  /** Bumped by every configuration, credential, auth-pause or reset event. */
  epoch: number;
}

const BADGE_VARIANTS: Record<StatusBadge, 'success' | 'warning' | 'error' | 'pending'> = {
  checking: 'pending',
  enabled: 'success',
  disabled: 'error',
  unavailable: 'error',
  offline: 'warning',
};

/** After these events nothing held from the previous terminal configuration may be shown. */
const LIFECYCLE_EVENTS = [
  'terminal-config-updated',
  'terminal-credentials-updated',
  'terminal-auth-paused',
  'app:reset',
] as const;

const readOnlineFlag = (value: unknown): boolean | null => {
  if (!value || typeof value !== 'object') return null;
  const flag = (value as { isOnline?: unknown }).isOnline;
  return typeof flag === 'boolean' ? flag : null;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const formatTimestamp = (value: string | null, locale: string): string => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale);
};

const groupCardNumber = (value: string): string => value.replace(/(.{4})(?=.)/g, '$1 ');

/** Browser and native connectivity; either one reporting offline blocks every action. */
function useConnectivity(): boolean {
  const [browserOnline, setBrowserOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false,
  );
  const [nativeOnline, setNativeOnline] = useState(true);

  useEffect(() => {
    const goOnline = () => setBrowserOnline(true);
    const goOffline = () => setBrowserOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const apply = (status: unknown) => {
      const flag = readOnlineFlag(status);
      if (!cancelled && flag !== null) setNativeOnline(flag);
    };
    onEvent<unknown>('network:status', apply);
    void Promise.resolve()
      .then(() => getBridge().sync.getNetworkStatus())
      .then(apply)
      .catch(() => undefined);
    return () => {
      cancelled = true;
      offEvent<unknown>('network:status', apply);
    };
  }, []);

  return browserOnline && nativeOnline;
}

/**
 * The trusted terminal identity, re-read after every lifecycle event. `onInvalidate`
 * runs synchronously inside the event, before any held reply can resolve.
 */
function useTerminalIdentity(onInvalidate: () => void): TerminalIdentity {
  const [identity, setIdentity] = useState<TerminalIdentity>({
    ready: false,
    organizationId: null,
    branchId: null,
    terminalId: null,
    epoch: 0,
  });
  const invalidateRef = useRef(onInvalidate);
  useLayoutEffect(() => {
    invalidateRef.current = onInvalidate;
  });

  useEffect(() => {
    let active = true;
    let request = 0;
    const read = () => {
      const current = ++request;
      const terminalConfig = getBridge().terminalConfig;
      void Promise.all([
        Promise.resolve().then(() => terminalConfig.getOrganizationId()).catch(() => null),
        Promise.resolve().then(() => terminalConfig.getBranchId()).catch(() => null),
        Promise.resolve().then(() => terminalConfig.getTerminalId()).catch(() => null),
      ]).then(([organizationId, branchId, terminalId]) => {
        if (!active || current !== request) return;
        setIdentity((previous) => ({
          ready: true,
          organizationId: text(organizationId),
          branchId: text(branchId),
          terminalId: text(terminalId),
          epoch: previous.epoch,
        }));
      });
    };
    const handleLifecycle = () => {
      invalidateRef.current();
      setIdentity((previous) => ({
        ready: false,
        organizationId: null,
        branchId: null,
        terminalId: null,
        epoch: previous.epoch + 1,
      }));
      read();
    };
    read();
    LIFECYCLE_EVENTS.forEach((event) => onEvent<unknown>(event, handleLifecycle));
    return () => {
      active = false;
      LIFECYCLE_EVENTS.forEach((event) => offEvent<unknown>(event, handleLifecycle));
    };
  }, []);

  return identity;
}

const GiftCardsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const { hasModule } = useAcquiredModules();
  const moduleActive = hasModule(MODULE_IDS.GIFT_CARDS);
  const online = useConnectivity();
  const { staff, activeShift, isShiftActive } = useShift();
  const issuedTitleId = useId();

  // Lifecycle fences: cleared synchronously by a lifecycle event and on unmount,
  // re-keyed after every staff, shift, scope or configuration change.
  const sessionRef = useRef<string | null>(null);
  const fundingRef = useRef<string | null>(null);
  const invalidate = useCallback(() => {
    sessionRef.current = null;
    fundingRef.current = null;
  }, []);
  const identity = useTerminalIdentity(invalidate);

  const staffId = text(staff?.staffId);
  const shiftId = isShiftActive ? text(activeShift?.id) : null;
  const organizationId = identity.organizationId ?? text(staff?.organizationId);
  const branchId = identity.branchId ?? text(staff?.branchId);
  const terminalId = identity.terminalId ?? text(staff?.terminalId);
  const scopeReady = Boolean(branchId && terminalId);
  const sessionKey = `${staffId ?? '-'}|${shiftId ?? '-'}|${identity.epoch}`;
  const fundingActor = useMemo<FundingActor | null>(
    () =>
      identity.ready && staffId && shiftId && branchId && terminalId
        ? { staffId, organizationId, branchId, terminalId }
        : null,
    [identity.ready, staffId, shiftId, organizationId, branchId, terminalId],
  );
  const fundingKey = fundingActor
    ? `${sessionKey}|${fundingActor.organizationId ?? '-'}|${fundingActor.branchId}|${fundingActor.terminalId}`
    : null;

  const [status, setStatus] = useState<GiftCardsStatus | null>(null);
  const [statusFailure, setStatusFailure] = useState<GiftCardsFailure | null>(null);
  const [lookupNumber, setLookupNumber] = useState('');
  const [card, setCard] = useState<GiftCard | null>(null);
  const [transactions, setTransactions] = useState<GiftCardTransaction[]>([]);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [issuedNumber, setIssuedNumber] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  // The selected card's full number stays in component memory only; a refresh
  // needs it, nothing persists or logs it.
  const cardNumberRef = useRef<string | null>(null);
  const busyRef = useRef<BusyAction | null>(null);
  const previousSessionRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    sessionRef.current = sessionKey;
    fundingRef.current = fundingKey;
    const previous = previousSessionRef.current;
    previousSessionRef.current = sessionKey;
    if (previous === null || previous === sessionKey) return;
    // Another staff member, shift, terminal configuration or a reset: nothing held may show.
    cardNumberRef.current = null;
    setCard(null);
    setTransactions([]);
    setHistoryFailed(false);
    setIssuedNumber(null);
    setLookupNumber('');
    setBanner(null);
  }, [sessionKey, fundingKey]);

  useLayoutEffect(
    () => () => {
      sessionRef.current = null;
      fundingRef.current = null;
    },
    [],
  );

  const busy = busyAction !== null;
  const serviceReady = moduleActive && online && status?.enabled === true;
  const canLookup = serviceReady && status?.supportsLookup === true && !busy;

  const mutedClass = isDark ? 'text-zinc-400' : 'text-gray-500';
  const bannerClass: Record<BannerTone, string> = {
    success: isDark
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800',
    error: isDark ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-800',
    warning: isDark
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
      : 'border-amber-200 bg-amber-50 text-amber-900',
  };

  const money = useCallback(
    (amount: number, currency: string | null) =>
      currency ? formatCurrency(amount, currency, i18n.language) : amount.toFixed(2),
    [i18n.language],
  );

  const runExclusive = useCallback(async (action: BusyAction, task: () => Promise<void>) => {
    // A ref, not state, so a second click in the same frame is already refused.
    if (busyRef.current) return;
    busyRef.current = action;
    setBusyAction(action);
    try {
      await task();
    } finally {
      busyRef.current = null;
      setBusyAction(null);
    }
  }, []);

  const loadStatus = useCallback(async (): Promise<boolean> => {
    if (!moduleActive || !online) return false;
    const result = await giftCardsApiService.getStatus();
    if (result.ok) {
      setStatus(result.data);
      setStatusFailure(null);
      return result.data.enabled;
    }
    setStatus(null);
    setStatusFailure(result);
    return false;
  }, [moduleActive, online]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const showError = useCallback((message: string) => {
    setBanner({ tone: 'error', message, detail: null });
  }, []);

  const handleFailure = useCallback(
    (failure: GiftCardsFailure, fallbackKey: string) => {
      if (failure.kind === 'busy') return;
      if (failure.kind === 'module_disabled' || failure.kind === 'unavailable' || failure.kind === 'offline') {
        // The service is not usable right now: fail closed until a refresh.
        setStatus(null);
        setStatusFailure(failure);
      }
      const messages: Partial<Record<GiftCardsFailure['kind'], string>> = {
        offline: t('giftCards.status.offline'),
        module_disabled: t('giftCards.status.moduleRequired'),
        unavailable: t('giftCards.status.unavailable'),
        not_found: t('giftCards.errors.notFound'),
        unknown: t('giftCards.errors.unknownOutcome'),
      };
      setBanner({
        tone: failure.kind === 'unknown' ? 'warning' : 'error',
        message: messages[failure.kind] ?? t(fallbackKey),
        detail: failure.code && failure.kind !== 'unknown' ? t('giftCards.errors.details', { code: failure.code }) : null,
      });
    },
    [t],
  );

  const refreshCard = useCallback(async (): Promise<GiftCardsFailure | null> => {
    const number = cardNumberRef.current;
    const session = sessionRef.current;
    if (!number || session === null) return null;
    const result = await giftCardsApiService.lookup(number);
    // A reply that returns after a lifecycle change or another lookup is not shown.
    if (sessionRef.current !== session || cardNumberRef.current !== number) return null;
    if (!result.ok) {
      setHistoryFailed(true);
      return result;
    }
    setCard(result.data.card);
    setTransactions(result.data.transactions);
    setHistoryFailed(false);
    return null;
  }, []);

  const isFundingCurrent = useCallback(
    () => fundingKey !== null && fundingRef.current === fundingKey,
    [fundingKey],
  );

  const handleFundingCompleted = useCallback(
    (attempt: CompletedFunding, cardNumber: string | null) => {
      if (!isFundingCurrent()) return;
      // The full number of a new card is returned only now; it stays on screen
      // until dismissed or the lifecycle changes, and is never persisted.
      if (attempt.operation === 'issue' && cardNumber) setIssuedNumber(cardNumber);
      if (attempt.operation === 'reload') void refreshCard();
    },
    [isFundingCurrent, refreshCard],
  );

  const handleRefresh = () =>
    runExclusive('refresh', async () => {
      setBanner(null);
      if (!(await loadStatus())) return;
      // Only an explicit refresh reports a failed re-read; after a confirmed
      // mutation a banner here could look like the change itself failed.
      const failure = await refreshCard();
      if (failure) handleFailure(failure, 'giftCards.errors.lookupFailed');
    });

  const handleLookup = () =>
    runExclusive('lookup', async () => {
      if (!serviceReady) return;
      setBanner(null);
      if (!lookupNumber.trim()) return showError(t('giftCards.errors.numberRequired'));
      const normalized = normalizeGiftCardNumber(lookupNumber);
      if (!normalized) return showError(t('giftCards.errors.numberInvalid'));
      cardNumberRef.current = null;
      setCard(null);
      setTransactions([]);
      setHistoryFailed(false);
      const session = sessionRef.current;
      const result = await giftCardsApiService.lookup(normalized);
      if (session === null || sessionRef.current !== session) return;
      if (!result.ok) return handleFailure(result, 'giftCards.errors.lookupFailed');
      cardNumberRef.current = normalized;
      setCard(result.data.card);
      setTransactions(result.data.transactions);
      setBanner({ tone: 'success', message: t('giftCards.messages.balanceLoaded'), detail: null });
    });

  const statusView = useMemo((): { badge: StatusBadge; message: string | null } => {
    if (!moduleActive) return { badge: 'disabled', message: t('giftCards.status.moduleRequired') };
    if (!online) return { badge: 'offline', message: t('giftCards.status.offline') };
    if (statusFailure) {
      if (statusFailure.kind === 'module_disabled') {
        return { badge: 'disabled', message: t('giftCards.status.moduleRequired') };
      }
      if (statusFailure.kind === 'offline') return { badge: 'offline', message: t('giftCards.status.offline') };
      return { badge: 'unavailable', message: t('giftCards.status.unavailable') };
    }
    if (!status) return { badge: 'checking', message: t('giftCards.status.checking') };
    if (status.enabled) {
      return {
        badge: 'enabled',
        message: identity.ready && !scopeReady ? t('giftCards.errors.terminalMissing') : null,
      };
    }
    if (status.unavailable || !status.configured) {
      return { badge: 'unavailable', message: t('giftCards.status.notInstalled') };
    }
    if (!status.moduleEnabled) return { badge: 'disabled', message: t('giftCards.status.moduleRequired') };
    if (!status.terminalEnabled) return { badge: 'disabled', message: t('giftCards.status.notEnabled') };
    return { badge: 'disabled', message: t('giftCards.status.notConfigured') };
  }, [identity.ready, moduleActive, online, scopeReady, status, statusFailure, t]);

  const fundingUnavailableMessage = !identity.ready
    ? t('giftCards.funding.checking')
    : !staffId || !shiftId
      ? t('giftCards.funding.noShift')
      : t('giftCards.errors.terminalMissing');

  return (
    <div
      className={`h-full min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide p-4 md:p-5 ${
        isDark ? 'bg-black text-zinc-100' : 'bg-[#fdfaf5] text-gray-900'
      }`}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-yellow-400 text-black">
              <Gift className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold">{t('giftCards.title')}</h1>
              <p className={`text-sm ${mutedClass}`}>{t('giftCards.funding.description')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={!moduleActive || busy}
            aria-label={t('giftCards.refresh')}
            title={t('giftCards.refresh')}
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border transition-colors disabled:opacity-50 ${
              isDark
                ? 'border-zinc-800 bg-zinc-900 text-zinc-100 active:bg-zinc-800'
                : 'border-gray-200 bg-white text-gray-800 active:bg-gray-100'
            }`}
          >
            <RefreshCw className={`h-5 w-5 ${busyAction === 'refresh' ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </header>

        <POSGlassCard size="compact" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{t('giftCards.status.label')}</span>
            <POSGlassBadge variant={BADGE_VARIANTS[statusView.badge]} size="sm">
              {t(`giftCards.badge.${statusView.badge}`)}
            </POSGlassBadge>
          </div>
          {statusView.message && <p className={`mt-2 text-sm ${mutedClass}`}>{statusView.message}</p>}
        </POSGlassCard>

        {banner && (
          <div
            role={banner.tone === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm ${bannerClass[banner.tone]}`}
          >
            {banner.tone === 'success' ? (
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p>{banner.message}</p>
              {banner.detail && <p className="mt-1 text-xs opacity-80">{banner.detail}</p>}
            </div>
          </div>
        )}

        {moduleActive && (
          <>
            {issuedNumber && (
              <POSGlassCard variant="success" aria-labelledby={issuedTitleId}>
                <p id={issuedTitleId} className="text-sm font-semibold">
                  {t('giftCards.issue.deliverTitle')}
                </p>
                <p
                  data-testid="gift-card-issued-number"
                  className="mt-2 select-all break-all font-mono text-2xl font-bold tracking-widest"
                >
                  {groupCardNumber(issuedNumber)}
                </p>
                <p className={`mt-2 text-sm ${mutedClass}`}>{t('giftCards.issue.deliverHint')}</p>
                <POSGlassButton type="button" variant="secondary" className="mt-3" onClick={() => setIssuedNumber(null)}>
                  {t('giftCards.issue.dismiss')}
                </POSGlassButton>
              </POSGlassCard>
            )}

            <POSGlassCard>
              <h2 className="mb-3 text-base font-semibold">{t('giftCards.lookup.title')}</h2>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <div className="flex-1">
                  <POSGlassInput
                    value={lookupNumber}
                    onChange={(event) => setLookupNumber(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleLookup();
                      }
                    }}
                    placeholder={t('giftCards.lookup.placeholder')}
                    aria-label={t('giftCards.lookup.placeholder')}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={!serviceReady || status?.supportsLookup !== true}
                    icon={<Search className="h-4 w-4" aria-hidden="true" />}
                  />
                </div>
                <POSGlassButton
                  type="button"
                  onClick={() => void handleLookup()}
                  disabled={!canLookup}
                  loading={busyAction === 'lookup'}
                >
                  {t('giftCards.lookup.action')}
                </POSGlassButton>
              </div>
            </POSGlassCard>

            {card && (
              <POSGlassCard>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className={`text-xs uppercase tracking-wide ${mutedClass}`}>{t('giftCards.balance.card')}</p>
                    <p data-testid="gift-card-masked-number" className="font-mono text-lg font-semibold">
                      {card.maskedNumber}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`text-xs ${mutedClass}`}>{t('giftCards.balance.status')}</p>
                    <POSGlassBadge variant={card.status === 'active' ? 'success' : 'warning'} size="sm">
                      {t(`giftCards.cardStatus.${card.status}`, { defaultValue: card.status.toUpperCase() })}
                    </POSGlassBadge>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className={`text-xs ${mutedClass}`}>{t('giftCards.balance.current')}</p>
                    <p data-testid="gift-card-balance" className="text-3xl font-bold">
                      {money(card.balance, card.currency)}
                    </p>
                  </div>
                  <div>
                    <p className={`text-xs ${mutedClass}`}>{t('giftCards.balance.currency')}</p>
                    <p data-testid="gift-card-currency" className="text-lg font-semibold">
                      {card.currency ?? '—'}
                    </p>
                    {card.expiresAt && (
                      <p className={`text-xs ${mutedClass}`}>
                        {t('giftCards.balance.expires', { date: formatTimestamp(card.expiresAt, i18n.language) })}
                      </p>
                    )}
                  </div>
                </div>
              </POSGlassCard>
            )}

            {fundingActor && fundingKey && shiftId ? (
              <GiftCardFundingPanel
                key={fundingKey}
                actor={fundingActor}
                shiftId={shiftId}
                cashierName={text(staff?.name) ?? fundingActor.staffId}
                card={card}
                online={online}
                isCurrent={isFundingCurrent}
                onCompleted={handleFundingCompleted}
              />
            ) : (
              <POSGlassCard>
                <h2 className="mb-1 text-base font-semibold">{t('giftCards.funding.title')}</h2>
                <p className={`text-sm ${mutedClass}`}>{fundingUnavailableMessage}</p>
              </POSGlassCard>
            )}

            {card && (
              <POSGlassCard>
                <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
                  <History className="h-4 w-4" aria-hidden="true" />
                  {t('giftCards.history.title')}
                </h2>
                {historyFailed && (
                  <p role="alert" className="mb-2 text-sm text-red-500">
                    {t('giftCards.errors.historyFailed')}
                  </p>
                )}
                {transactions.length === 0 ? (
                  <p className={`text-sm ${mutedClass}`}>{t('giftCards.history.empty')}</p>
                ) : (
                  <ul className={`divide-y ${isDark ? 'divide-zinc-800' : 'divide-gray-200'}`}>
                    {transactions.map((entry) => {
                      const currency = entry.currency ?? card.currency;
                      const signedAmount = entry.type === 'redeem' ? -Math.abs(entry.amount) : entry.amount;
                      return (
                        <li key={entry.id} className="flex items-start justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <p className="font-medium">
                              {t(`giftCards.history.types.${entry.type}`, { defaultValue: entry.type })}
                            </p>
                            <p className={`text-xs ${mutedClass}`}>
                              {[formatTimestamp(entry.createdAt, i18n.language), entry.note].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="font-semibold">{money(signedAmount, currency)}</p>
                            {entry.balanceAfter !== null && (
                              <p className={`text-xs ${mutedClass}`}>
                                {t('giftCards.history.balanceAfter', { amount: money(entry.balanceAfter, currency) })}
                              </p>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </POSGlassCard>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default GiftCardsPage;
