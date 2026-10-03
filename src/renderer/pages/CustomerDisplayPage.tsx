import React, { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  CheckCircle2,
  Clock3,
  Monitor,
  RefreshCw,
  ScreenShare,
  X,
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import {
  getBridge,
  offEvent,
  onEvent,
  type ExternalDisplayCapabilities,
  type ExternalDisplayInfo,
} from '../../lib';
import { KdsReadCoordinator } from '../services/KdsReadCoordinator';
import {
  ExternalPresentationOwner,
  closeStaleExternalOpen,
  externalDisplayChoices,
  externalOpenParams,
  isExternalContentLive,
  isExternalDisplayFree,
  liveExternalPresentation,
} from '../services/ExternalDisplayOwnership';
import { findLocalPreparationMark, localPreparationStore } from '../services/KdsLocalPhaseStore';
import {
  getKdsRecordIdentityKeys,
  getKdsVisibleOrderNumber,
  isActiveLocalKitchenOrder,
  matchesKdsTenant,
  matchesKdsTerminal,
  overlayKitchenStatus,
  readCanonicalKitchenStatus,
  readKdsString,
} from '../services/KdsLocalOrders';
import { useLocalPreparationSnapshot } from '../hooks/useLocalPreparation';
import { useResolvedPosIdentity } from '../hooks/useResolvedPosIdentity';
import { useModules } from '../contexts/module-context';
import { useOrderStore } from '../hooks/useOrderStore';
import { formatCompactOrderNumberForDisplay } from '../utils/orderNumberUtils';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';
import { publishCustomerDisplaySnapshot, type CustomerTwintQr } from '../services/CustomerDisplayQrOverlay';

type DisplayStatus = 'pending' | 'preparing' | 'ready';

/** One customer screen row: public order number and stage only, never customer, cart, note or payment data. */
interface DisplayRow {
  order_id: string;
  order_number: string;
  status: DisplayStatus;
  created_at: string | null;
  updated_at: string | null;
}

/** One fresh read of the local SQLite orders, tagged with the scope it was read for. */
interface LocalOrdersRead {
  scope: string;
  orders: readonly Record<string, unknown>[];
}

const CUSTOMER_DISPLAY_CONTENT_TYPE = 'customer_display';
// Customers wait at the counter for pickup and takeaway orders; table service is never called here.
const CUSTOMER_DISPLAY_ORDER_TYPES = new Set(['pickup', 'takeaway']);
// Native events for local order changes. There is no display API, realtime channel or poll.
const LOCAL_ORDER_EVENTS = ['order-created', 'order-status-updated', 'order-deleted'];
const SYNC_REFRESH_INTERVAL_MS = 30000;

function readSearchParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function isExternalDisplayWindow(): boolean {
  return readSearchParam('externalDisplay') === CUSTOMER_DISPLAY_CONTENT_TYPE;
}

const hasValue = (value: unknown): boolean =>
  (typeof value === 'string' && value.trim() !== '') || (typeof value === 'number' && Number.isFinite(value));

function isCustomerDisplayOrder(order: Record<string, unknown>): boolean {
  const orderType = (readKdsString(order, 'order_type') || readKdsString(order, 'orderType')).toLowerCase().replace(/_/g, '-');
  return CUSTOMER_DISPLAY_ORDER_TYPES.has(orderType) && !hasValue(order['table_number']) && !hasValue(order['tableNumber']);
}

function getOrderIdentifier(order: Record<string, unknown>, orderId: string): string {
  const visibleNumber = getKdsVisibleOrderNumber(order);
  return visibleNumber ? formatCompactOrderNumberForDisplay(visibleNumber) : orderId.slice(0, 8);
}

function getOrderUpdatedAtMs(order: DisplayRow): number {
  const rawTimestamp = order.updated_at || order.created_at;
  if (!rawTimestamp) return 0;
  const parsed = new Date(rawTimestamp).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function useCustomerDisplayOwner(pageActive: boolean) {
  const bridge = getBridge();
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const storeOrders = useOrderStore((state) => state.orders);
  const preparation = useLocalPreparationSnapshot();
  const [ordersRead, setOrdersRead] = useState<LocalOrdersRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ExternalDisplayCapabilities | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDisplayBusy, setIsDisplayBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDark = resolvedTheme === 'dark';
  const { organizationId, branchId, terminalId, isReady } = useResolvedPosIdentity('branch+organization');
  const { isModuleEnabled } = useModules();
  // Purchase and terminal entitlement: without it nothing is read, projected or kept open.
  const enabled = isModuleEnabled('customer_display');
  const identityScope = enabled && isReady && organizationId && branchId && terminalId ? `${organizationId}|${branchId}|${terminalId}` : '';
  const scopeRef = useRef(identityScope);
  scopeRef.current = identityScope;
  const displayGeneration = useRef(0);
  const scheduleRead = useRef<() => void>(() => {});
  const coordinator = useRef(new KdsReadCoordinator()).current;
  // The one presentation this owner may close: its own open's token or the running one it adopted.
  const [presentation] = useState(() => new ExternalPresentationOwner(CUSTOMER_DISPLAY_CONTENT_TYPE));
  // Opening or running only; a closing window no longer shows this terminal's orders.
  const activeExternalDisplay = Boolean(identityScope) && isExternalContentLive(capabilities, CUSTOMER_DISPLAY_CONTENT_TYPE);
  // A closing window keeps its screen reserved until native destroyed it, so keep reading the screens.
  const watchExternalDisplay = Boolean(identityScope) && Boolean(
    capabilities?.activePresentations?.some((item) => item.contentType === CUSTOMER_DISPLAY_CONTENT_TYPE)
  );
  const ownerActive = Boolean(identityScope) && (pageActive || activeExternalDisplay);
  useEffect(() => {
    coordinator.configure(identityScope, ownerActive);
    return () => coordinator.configure('', false);
  }, [coordinator, identityScope, ownerActive]);
  useEffect(() => {
    setOrdersRead(null); setReadError(null); setCapabilities(null); setIsDisplayBusy(false);
    return () => {
      displayGeneration.current++;
      coordinator.configure('', false);
      void publishCustomerDisplaySnapshot(null).catch(() => {});
      // Sign-out, identity change or revoked entitlement: close only the presentation this owner holds.
      void presentation.release(bridge).catch(() => {});
    };
  }, [bridge, coordinator, identityScope, presentation]);

  const fetchCapabilities = useCallback(async () => {
    if (!identityScope) return;
    const requestedScope = identityScope;
    const generation = displayGeneration.current;
    // The answer to a read issued before this owner's last open or stop never changes what it owns.
    const ownership = presentation.revision;
    try {
      const result = await bridge.externalDisplay.getCapabilities();
      if (scopeRef.current !== requestedScope || generation !== displayGeneration.current) return;
      // Adopts the running presentation only while this owner holds none and opens nothing; forgets its
      // own once native lists no customer presentation at all (e.g. the window was closed from the OS).
      presentation.observe(result, ownership);
      setCapabilities(result);
    } catch (err) {
      if (scopeRef.current !== requestedScope || generation !== displayGeneration.current) return;
      setCapabilities({
        success: false,
        supported: false,
        displays: [],
        error: err instanceof Error ? err.message : 'Failed to inspect monitors',
      });
    }
  }, [bridge, identityScope, presentation]);

  // A fresh native read of the local SQLite orders, offline-only orders included; never a display API.
  const readLocalOrders = useCallback(
    async () => coordinator.request(async isCurrent => {
      const requestedScope = identityScope;
      try {
        const orders: unknown = await bridge.orders.getAll();
        if (!isCurrent() || scopeRef.current !== requestedScope) return;
        if (!Array.isArray(orders)) throw new Error('Local orders are unreadable');
        setOrdersRead({ scope: requestedScope, orders: orders as Record<string, unknown>[] });
        setReadError(null);
      } catch (err) {
        // A failed read keeps the last good rows of this scope; a first read shows nothing.
        if (!isCurrent() || scopeRef.current !== requestedScope) return;
        console.error('Customer display local read failed', err);
        setReadError(
          err instanceof Error
            ? err.message
            : t('customerDisplay.errors.fetchRowsFailed', 'Failed to load customer display orders')
        );
      }
      const stages = localPreparationStore.getSnapshot();
      if (stages.scope === requestedScope && (!stages.state || stages.error)) await localPreparationStore.refresh(requestedScope);
    }),
    [bridge, t, coordinator, identityScope]
  );

  useEffect(() => {
    if (!ownerActive) return;
    void readLocalOrders();
    void fetchCapabilities();
  }, [ownerActive, fetchCapabilities, readLocalOrders]);

  useEffect(() => {
    if (!ownerActive) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSync = 0;
    let disposed = false;
    const schedule = () => {
      if (timer || disposed) return;
      timer = setTimeout(() => { timer = null; void readLocalOrders(); }, 150);
    };
    // Sync writes cloud changes into local SQLite; re-read it at most every 30 seconds.
    const sync = () => { if (Date.now() - lastSync >= SYNC_REFRESH_INTERVAL_MS) { lastSync = Date.now(); schedule(); } };
    scheduleRead.current = schedule;
    LOCAL_ORDER_EVENTS.forEach(event => onEvent(event, schedule));
    onEvent('sync:complete', sync);
    return () => {
      disposed = true; scheduleRead.current = () => {}; if (timer) clearTimeout(timer);
      LOCAL_ORDER_EVENTS.forEach(event => offEvent(event, schedule)); offEvent('sync:complete', sync);
    };
  }, [ownerActive, readLocalOrders]);

  // The central order store reloading local orders is one more local change signal.
  const seenStoreOrders = useRef(storeOrders);
  useEffect(() => {
    if (seenStoreOrders.current === storeOrders) return;
    seenStoreOrders.current = storeOrders;
    scheduleRead.current();
  }, [storeOrders]);

  useEffect(() => {
    if (!watchExternalDisplay) return;
    const timer = setInterval(() => void fetchCapabilities(), 2000);
    return () => clearInterval(timer);
  }, [watchExternalDisplay, fetchCapabilities]);

  const preparationState = identityScope && preparation.scope === identityScope ? preparation.state : null;
  const localOrders = identityScope && ordersRead?.scope === identityScope ? ordersRead.orders : null;
  // Fail closed: until this scope's orders and kitchen stages are both read, nothing stale can show.
  const isLoading = !localOrders || !preparationState;
  const loadError = readError || (identityScope && preparation.scope === identityScope ? preparation.error : null);

  const displayOrders = useMemo(() => {
    if (!localOrders || !preparationState) return [];
    const seen = new Set<string>();
    const rows: DisplayRow[] = [];
    localOrders.forEach((order) => {
      const keys = getKdsRecordIdentityKeys(order);
      if (keys.length === 0 || keys.some((key) => seen.has(key))) return;
      if (!matchesKdsTenant(organizationId || null, branchId || null, order) || !matchesKdsTerminal(terminalId || null, order)) return;
      if (!isActiveLocalKitchenOrder(order) || !isCustomerDisplayOrder(order)) return;
      keys.forEach((key) => seen.add(key));
      const mark = findLocalPreparationMark(preparationState, keys);
      const status = overlayKitchenStatus(readCanonicalKitchenStatus(order), mark?.phase);
      // Collected from the kitchen: the order leaves this screen and stays unchanged everywhere else.
      if (!status) return;
      const createdAt = readKdsString(order, 'created_at') || readKdsString(order, 'createdAt') || null;
      const updatedAt = readKdsString(order, 'updated_at') || readKdsString(order, 'updatedAt') || createdAt;
      rows.push({
        order_id: keys[0],
        order_number: getOrderIdentifier(order, keys[0]),
        status,
        created_at: createdAt,
        // A newer kitchen stage moves the order to the top of the screen.
        updated_at: mark && !(Date.parse(mark.at) <= Date.parse(updatedAt ?? '')) ? mark.at : updatedAt,
      });
    });
    return rows.sort((a, b) => getOrderUpdatedAtMs(b) - getOrderUpdatedAtMs(a));
  }, [localOrders, preparationState, organizationId, branchId, terminalId]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([readLocalOrders(), fetchCapabilities(), localPreparationStore.refresh(identityScope)]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const openExternalDisplay = async (display?: ExternalDisplayInfo) => {
    if (!identityScope) return;
    const openedScope = identityScope;
    const generation = displayGeneration.current;
    const isCurrent = () => scopeRef.current === openedScope && generation === displayGeneration.current;
    setIsDisplayBusy(true);
    setNotice(null);
    setError(null);
    // The open names the presentation this owner holds, first adopting the running one the cashier sees.
    presentation.observe(capabilities);
    const endOpen = presentation.beginOpen();
    try {
      // Auto names only the content and the held token: native takes the first free external screen,
      // never the cashier's, and reopens only the presentation still holding `expectedToken`, so a late
      // or stale open takes over nothing. A chosen screen travels as its opaque id and is refused, never redirected.
      const result = await bridge.externalDisplay.open(externalOpenParams(CUSTOMER_DISPLAY_CONTENT_TYPE, display, presentation.ownedToken));
      if (!isCurrent()) {
        // Stopped, signed out or revoked meanwhile: close only what this late open created.
        await closeStaleExternalOpen(bridge, CUSTOMER_DISPLAY_CONTENT_TYPE, result);
        return;
      }
      if (!result?.success) {
        // The refusal is final: no other screen and no Auto retry. The open settled, so the fresh
        // answer may also forget a presentation that is gone (e.g. closed from the OS).
        endOpen();
        setError(
          result?.error ||
            t('customerDisplay.errors.startExternalFailed', 'Failed to open external customer display')
        );
        await fetchCapabilities();
        return;
      }
      presentation.opened(result);
      endOpen();
      setNotice(
        t(
          'customerDisplay.notices.externalRunning',
          'Customer display is running on the selected monitor or TV.'
        )
      );
      await fetchCapabilities();
    } catch (err) {
      if (!isCurrent()) return;
      setError(
        err instanceof Error
          ? err.message
          : t(
              'customerDisplay.errors.startExternalFailed',
              'Failed to open external customer display'
            )
      );
    } finally {
      endOpen();
      if (isCurrent()) setIsDisplayBusy(false);
    }
  };

  const closeExternalDisplay = async () => {
    const closingScope = identityScope;
    const generation = ++displayGeneration.current;
    const isCurrent = () => scopeRef.current === closingScope && generation === displayGeneration.current;
    // Owning nothing yet (e.g. after a reload), take the running presentation the cashier sees.
    presentation.observe(capabilities);
    setCapabilities(previous => previous ? { ...previous, activePresentations: previous.activePresentations?.filter(item => item.contentType !== CUSTOMER_DISPLAY_CONTENT_TYPE) } : null);
    await publishCustomerDisplaySnapshot(null).catch(() => {});
    setIsDisplayBusy(true);
    setNotice(null);
    setError(null);
    try {
      // Only the owned token closes: a newer session's presentation is never touched.
      const result = await presentation.release(bridge);
      if (!isCurrent()) return;
      if (result && !result.success) {
        throw new Error(
          result.error ||
            t('customerDisplay.errors.stopExternalFailed', 'Failed to stop external customer display')
        );
      }
      if (result) setNotice(t('customerDisplay.notices.externalStopped', 'External customer display stopped.'));
      // The screen stays reserved until native destroyed the window; read the screens again.
      await fetchCapabilities();
    } catch (err) {
      if (!isCurrent()) return;
      setError(
        err instanceof Error
          ? err.message
          : t(
              'customerDisplay.errors.stopExternalFailed',
              'Failed to stop external customer display'
            )
      );
    } finally {
      if (isCurrent()) setIsDisplayBusy(false);
    }
  };

  // Valid external screens only: never the cashier's monitor; an external OS primary is allowed.
  const externalChoices = identityScope ? externalDisplayChoices(capabilities) : [];
  const runningDisplayId = activeExternalDisplay
    ? liveExternalPresentation(capabilities, CUSTOMER_DISPLAY_CONTENT_TYPE)?.displayId ?? null
    : null;
  const canOpenExternal = Boolean(capabilities?.supported) && externalChoices.some(isExternalDisplayFree);

  return { identityScope, displayOrders, capabilities, isRefreshing, isLoading, isDisplayBusy, notice, error, loadError, isDark, locale: i18n.language, activeExternalDisplay, externalChoices, runningDisplayId, canOpenExternal, handleRefresh, openExternalDisplay, closeExternalDisplay };
}

type DisplayModel = ReturnType<typeof useCustomerDisplayOwner>;
type DisplaySnapshot = Pick<DisplayModel, 'displayOrders' | 'isLoading' | 'isDark' | 'locale'> & { twintQr?: CustomerTwintQr };
const CustomerDisplayContext = createContext<{ model: DisplayModel; attach: () => () => void } | null>(null);
export function CustomerDisplayProvider({ children }: { children: React.ReactNode }) {
  const [consumers, setConsumers] = useState(0);
  const model = useCustomerDisplayOwner(consumers > 0);
  const attach = useCallback(() => { setConsumers(count => count + 1); return () => setConsumers(count => Math.max(0, count - 1)); }, []);
  useEffect(() => {
    // Public rows and theme only: never screens, capabilities or a presentation token.
    const snapshot: DisplaySnapshot | null = model.activeExternalDisplay ? {
      displayOrders: model.displayOrders, isLoading: model.isLoading, isDark: model.isDark, locale: model.locale,
    } : null;
    void publishCustomerDisplaySnapshot(snapshot).catch(() => {});
  }, [model.activeExternalDisplay, model.displayOrders, model.isLoading, model.isDark, model.locale]);
  return <CustomerDisplayContext.Provider value={{ model, attach }}>{children}</CustomerDisplayContext.Provider>;
}
function LocalCustomerDisplayPage() {
  const context = useContext(CustomerDisplayContext);
  if (!context) throw new Error('Customer display requires its persistent owner');
  useEffect(() => context.attach(), [context.attach]);
  return <CustomerDisplayView model={context.model} externalWindow={false} />;
}
function ExternalCustomerDisplayPage() {
  const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(null);
  const { i18n } = useTranslation();
  useEffect(() => {
    let disposed = false; let reading = false;
    const read = async () => {
      if (reading) return; reading = true;
      try { const value = await getBridge().invoke('customer-display-snapshot'); if (!disposed) setSnapshot(value || null); }
      catch { if (!disposed) setSnapshot(null); }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 500);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  useEffect(() => { if (snapshot?.locale && snapshot.locale !== i18n.language) void i18n.changeLanguage(snapshot.locale); }, [snapshot?.locale, i18n]);
  if (!snapshot) return <div className="h-screen bg-black" />;
  if (snapshot.twintQr) return <CustomerTwintQrView qr={snapshot.twintQr} />;
  return <CustomerDisplayView externalWindow model={{ ...snapshot, capabilities: null, isRefreshing: false, isDisplayBusy: false, notice: null, error: null, loadError: null, activeExternalDisplay: true, externalChoices: [], runningDisplayId: null, canOpenExternal: false, openExternalDisplay: async () => {}, closeExternalDisplay: async () => {} } as unknown as DisplayModel} />;
}
function CustomerTwintQrView({ qr }: { qr: CustomerTwintQr }) {
  const { t } = useTranslation();
  return <div className="h-screen bg-white text-black flex flex-col items-center justify-center gap-6 p-8">
    <strong className="text-5xl">TWINT — CHF {qr.amount.toFixed(2)}</strong>
    <img src={qr.qrImageData} alt={t('twintPayment.qrAlt', 'Official shop TWINT QR')} className="max-h-[60vh] max-w-full" />
    <p className="text-2xl">{t('twintPayment.exactAmount', 'Scan the shop QR and enter this exact amount in TWINT.')}</p>
  </div>;
}
function CustomerDisplayPage() { return isExternalDisplayWindow() ? <ExternalCustomerDisplayPage /> : <LocalCustomerDisplayPage />; }
function CustomerDisplayView({ model, externalWindow }: { model: DisplayModel; externalWindow: boolean }) {
  const { t } = useTranslation();
  const { displayOrders, capabilities, isRefreshing, isLoading, isDisplayBusy, notice, error, loadError, isDark, activeExternalDisplay, externalChoices, runningDisplayId, canOpenExternal, handleRefresh, openExternalDisplay, closeExternalDisplay } = model;
  const phaseCounts = useMemo(
    () =>
      displayOrders.reduce(
        (acc, order) => {
          acc[order.status] += 1;
          return acc;
        },
        { pending: 0, preparing: 0, ready: 0 } as Record<DisplayStatus, number>
      ),
    [displayOrders]
  );

  const getPhase = useCallback(
    (status: DisplayStatus) => {
      if (status === 'ready') {
        return {
          label: t('customerDisplay.phases.ready', 'Ready'),
          sentence: t('customerDisplay.sentences.ready', 'ready'),
          detail: t('customerDisplay.descriptions.ready', 'Ready for pickup'),
          color: 'text-emerald-400',
          border: 'border-emerald-400/40',
          Icon: CheckCircle2,
        };
      }
      if (status === 'preparing') {
        return {
          label: t('customerDisplay.phases.preparing', 'Preparing'),
          sentence: t('customerDisplay.sentences.preparing', 'preparing'),
          detail: t('customerDisplay.descriptions.preparing', 'Kitchen is working'),
          color: 'text-amber-400',
          border: 'border-amber-400/40',
          Icon: Clock3,
        };
      }
      return {
        label: t('customerDisplay.phases.received', 'Received'),
        sentence: t('customerDisplay.sentences.received', 'received'),
        detail: t('customerDisplay.descriptions.received', 'Order received'),
        color: 'text-yellow-400',
        border: 'border-yellow-400/40',
        Icon: Clock3,
      };
    },
    [t]
  );

  const failure = error || loadError || capabilities?.error;

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={pageMotionContainer}
      className={`h-full min-h-0 overflow-hidden ${
        isDark ? 'text-white' : 'text-slate-950'
      } ${externalWindow ? 'p-0' : 'p-4 md:p-6'}`}
    >
      <motion.div
        variants={pageMotionContainer}
        className={`mx-auto flex h-full min-h-0 flex-col gap-4 overflow-hidden ${
          externalWindow ? 'max-w-none p-8' : 'max-w-7xl'
        }`}
      >
        <motion.section
          variants={pageMotionItem}
          className={`rounded-2xl border ${
            isDark ? 'border-zinc-800 bg-zinc-950' : 'border-slate-200 bg-white'
          } ${externalWindow ? 'px-8 py-6' : 'px-5 py-4'}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1
                className={
                  externalWindow
                    ? 'truncate text-4xl font-black tracking-tight'
                    : 'truncate text-3xl font-bold tracking-tight'
                }
              >
                {t('customerDisplay.title', 'Customer Display')}
              </h1>
              <p className={`mt-1 truncate ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                {t(
                  'customerDisplay.subtitle',
                  'Live order phases for customer-facing screens'
                )}
              </p>
            </div>

            {!externalWindow && (
              <div className="flex flex-wrap items-center gap-2">
                {activeExternalDisplay ? (
                  <button
                    type="button"
                    onClick={() => void closeExternalDisplay()}
                    disabled={isDisplayBusy}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-300 transition-all active:scale-[0.98] active:bg-red-500/20 disabled:opacity-60 disabled:active:scale-100"
                  >
                    <X className="h-4 w-4" />
                    {t('customerDisplay.actions.stopExternal', 'Stop External')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void openExternalDisplay()}
                    disabled={isDisplayBusy || !canOpenExternal}
                    className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-all active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 ${
                      isDark
                        ? 'border-amber-400/40 bg-amber-500/10 text-amber-200 active:bg-amber-500/20'
                        : 'border-amber-300 bg-amber-50 text-amber-800 active:bg-amber-100'
                    }`}
                  >
                    <ScreenShare className="h-4 w-4" />
                    {t('customerDisplay.actions.externalDisplay', 'External Display')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  disabled={isRefreshing}
                  aria-label={t('common.refresh', 'Refresh')}
                  className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all shadow-sm active:scale-95 ${
                    isDark
                      ? 'border border-white/80 bg-white text-black active:bg-zinc-200'
                      : 'border border-black bg-black text-white active:bg-zinc-800'
                  } ${isRefreshing ? 'opacity-60 cursor-not-allowed active:scale-100' : ''}`}
                >
                  <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
              </div>
            )}
          </div>

          {!externalWindow && (
            <motion.div variants={pageMotionContainer} className="mt-4 grid gap-3 md:grid-cols-4">
              {(['pending', 'preparing', 'ready'] as DisplayStatus[]).map((phase) => {
                const meta = getPhase(phase);
                const Icon = meta.Icon;
                return (
                  <motion.div
                    variants={pageMotionItem}
                    key={phase}
                    className={`rounded-xl border bg-transparent px-4 py-3 ${meta.border}`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className={`h-5 w-5 ${meta.color}`} />
                      <span className={isDark ? 'text-zinc-300' : 'text-slate-700'}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="mt-2 text-2xl font-black">{phaseCounts[phase]}</div>
                  </motion.div>
                );
              })}
              <motion.div
                variants={pageMotionItem}
                className={`rounded-xl border px-4 py-3 ${
                  isDark ? 'border-zinc-800 bg-transparent' : 'border-slate-200 bg-transparent'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Monitor className="h-5 w-5 text-emerald-400" />
                  <span className={isDark ? 'text-zinc-300' : 'text-slate-700'}>
                    {t('customerDisplay.actions.externalDisplay', 'External Display')}
                  </span>
                </div>
                <div className="mt-2 text-sm font-semibold">
                  {activeExternalDisplay
                    ? t('customerDisplay.status.connected', 'Connected')
                    : t('customerDisplay.status.ready', 'Ready')}
                </div>
              </motion.div>
            </motion.div>
          )}
        </motion.section>

        {!externalWindow && (
          <motion.section
            variants={pageMotionItem}
            className={`rounded-2xl border p-4 ${
              isDark ? 'border-zinc-800 bg-zinc-950' : 'border-slate-200 bg-white'
            }`}
          >
            <div className="mb-3 flex items-center gap-2">
              <Monitor className="h-5 w-5 text-amber-400" />
              <h2 className="font-bold">
                {t('customerDisplay.external.monitors', 'Connected monitors and TVs')}
              </h2>
            </div>
            {externalChoices.length > 0 && (
              <motion.div variants={pageMotionContainer} className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                {externalChoices.map((display) => {
                  // Shows this content now; any other reservation (other content or a closing window) blocks it.
                  const running = display.id === runningDisplayId;
                  const free = isExternalDisplayFree(display);
                  return (
                    <motion.button
                      variants={pageMotionItem}
                      key={display.id}
                      type="button"
                      onClick={() => void openExternalDisplay(display)}
                      disabled={isDisplayBusy || !free}
                      className={`min-w-[210px] rounded-xl border px-3 py-3 text-left transition-all active:scale-[0.98] disabled:active:scale-100 ${
                        running
                          ? 'border-emerald-500/40 bg-emerald-500/10'
                          : `${
                              isDark
                                ? 'border-zinc-700 bg-zinc-900 active:bg-zinc-800'
                                : 'border-slate-200 bg-slate-50 active:bg-slate-100'
                            } disabled:opacity-60`
                      }`}
                    >
                      <div className="font-semibold">{display.name}</div>
                      <div className={isDark ? 'text-sm text-zinc-400' : 'text-sm text-slate-600'}>
                        {display.size?.width || 0} x {display.size?.height || 0}
                      </div>
                      {running ? (
                        <div className="mt-1 text-xs font-semibold text-emerald-400">
                          {t('customerDisplay.external.running', 'Showing the customer display')}
                        </div>
                      ) : !free ? (
                        <div className={`mt-1 text-xs font-semibold ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                          {t('customerDisplay.external.inUse', 'In use')}
                        </div>
                      ) : null}
                    </motion.button>
                  );
                })}
              </motion.div>
            )}
            <p className={`${externalChoices.length > 0 ? 'mt-3 ' : ''}text-sm ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
              {t(
                'customerDisplay.external.help',
                'Cable displays and OS-level wireless displays appear here. Select one to show the customer display.'
              )}
            </p>
          </motion.section>
        )}

        {(notice || failure) && !externalWindow && (
          <motion.div
            variants={pageMotionItem}
            className={`rounded-xl border px-4 py-3 text-sm font-medium ${
              failure
                ? 'border-red-500/40 bg-red-500/10 text-red-200'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            {failure || notice}
          </motion.div>
        )}

        <motion.section
          variants={pageMotionItem}
          className={`min-h-0 flex-1 overflow-y-auto rounded-2xl border p-4 scrollbar-hide ${
            isDark ? 'border-zinc-800 bg-zinc-950' : 'border-slate-200 bg-white'
          } ${externalWindow ? 'p-8' : ''}`}
        >
          {!isLoading && displayOrders.length === 0 ? (
            <motion.div
              variants={pageMotionItem}
              className={`flex h-full min-h-[360px] items-center justify-center rounded-2xl border border-dashed px-4 text-center text-lg ${
                isDark ? 'border-white/15' : 'border-slate-300'
              }`}
            >
              {t(
                'customerDisplay.empty',
                'No active customer-display orders right now.'
              )}
            </motion.div>
          ) : isLoading ? (
            <motion.div
              variants={pageMotionItem}
              className={`flex h-full min-h-[360px] items-center justify-center rounded-2xl border border-dashed px-4 text-center text-lg ${
                isDark ? 'border-white/15' : 'border-slate-300'
              }`}
            >
              {t('customerDisplay.loading', 'Loading customer display...')}
            </motion.div>
          ) : (
            <motion.div
              variants={pageMotionContainer}
              className={
                externalWindow
                  ? 'grid grid-cols-1 gap-5 xl:grid-cols-2'
                  : 'grid grid-cols-1 gap-3 lg:grid-cols-2'
              }
            >
              {displayOrders.map((order) => {
                const phase = getPhase(order.status);
                const Icon = phase.Icon;

                return (
                  <motion.div
                    variants={pageMotionItem}
                    key={order.order_id}
                    className={`rounded-2xl border px-5 py-4 ${phase.border} ${
                      isDark ? 'bg-black' : 'bg-slate-50'
                    } ${externalWindow ? 'px-7 py-6' : ''}`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div
                          className={`break-words font-black leading-tight ${
                            externalWindow ? 'text-4xl' : 'text-2xl'
                          }`}
                        >
                          {t('customerDisplay.orderLine', 'Order ({{number}}) is {{status}}', {
                            number: order.order_number,
                            status: phase.sentence,
                          })}
                        </div>
                        <div
                          className={`mt-2 ${
                            isDark ? 'text-zinc-400' : 'text-slate-600'
                          } ${externalWindow ? 'text-xl' : 'text-sm'}`}
                        >
                          {phase.detail}
                        </div>
                      </div>
                      <div
                        className={`grid shrink-0 place-items-center rounded-full bg-transparent ${
                          externalWindow ? 'h-16 w-16' : 'h-12 w-12'
                        }`}
                      >
                        <Icon className={`${phase.color} ${externalWindow ? 'h-9 w-9' : 'h-6 w-6'}`} />
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </motion.section>
      </motion.div>
    </motion.div>
  );
};

export default CustomerDisplayPage;
