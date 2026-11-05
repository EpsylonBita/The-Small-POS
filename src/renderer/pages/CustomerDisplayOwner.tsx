// The customer display's persistent owner. App mounts the provider for the whole session, so this
// module loads eagerly; the screen itself (CustomerDisplayPage) stays a lazy chunk.
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { publishCustomerDisplaySnapshot, type CustomerTwintQr } from '../services/CustomerDisplayQrOverlay';

export type DisplayStatus = 'pending' | 'preparing' | 'ready';

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

export function isExternalDisplayWindow(): boolean {
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

export type DisplayModel = ReturnType<typeof useCustomerDisplayOwner>;
export type DisplaySnapshot = Pick<DisplayModel, 'displayOrders' | 'isLoading' | 'isDark' | 'locale'> & { twintQr?: CustomerTwintQr };
export const CustomerDisplayContext = createContext<{ model: DisplayModel; attach: () => () => void } | null>(null);
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
