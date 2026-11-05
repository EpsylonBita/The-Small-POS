// The kitchen display's persistent owner. App mounts the provider for the whole session, so this
// module loads eagerly; the board itself (KitchenDisplayPage) stays a lazy chunk.
import React, { createContext, useEffect, useState, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { KdsReadCoordinator } from '../services/KdsReadCoordinator';
import {
  LocalPreparationConflictError,
  findLocalPreparationMark,
  localPreparationStore,
  type LocalPreparationPhase,
  type LocalPreparationState,
} from '../services/KdsLocalPhaseStore';
import {
  getKdsRecordIdentityKeys,
  getKdsVisibleOrderNumber,
  isActiveLocalKitchenOrder,
  matchesKdsTenant,
  matchesKdsTerminal,
  overlayKitchenStatus,
  readCanonicalKitchenStatus,
  readKdsString,
  type KitchenBoardStatus,
} from '../services/KdsLocalOrders';
import { useLocalPreparationSnapshot } from '../hooks/useLocalPreparation';
import {
  getKdsLocalDrafts,
  readKdsModifierLabels,
  subscribeKdsLocalDrafts,
  type KdsLocalDraft,
} from '../services/KdsLocalDraftStore';
import { useTranslation } from 'react-i18next';
import { playAppAudioFile, useAppAudioEnabled } from '../services/appAudio';
import { toast } from 'react-hot-toast';
import {
  getBridge,
  offEvent,
  onEvent,
  type ExternalDisplayCapabilities,
  type ExternalDisplayInfo,
} from '../../lib';
import {
  ExternalPresentationOwner,
  closeStaleExternalOpen,
  externalDisplayChoices,
  externalOpenParams,
  isExternalContentLive,
} from '../services/ExternalDisplayOwnership';
import { useModules } from '../contexts/module-context';
import { useResolvedPosIdentity } from '../hooks/useResolvedPosIdentity';
import { useOrderStore } from '../hooks/useOrderStore';

/** Kitchen board stage. "Collected" orders leave the board; none of these is a canonical order status. */
export type KitchenStatus = KitchenBoardStatus;

export interface KitchenOrder {
  id: string;
  sourceOrderId?: string;
  /** Every identity of the local order (local id, cloud id, client ids): stage marks match any of them. */
  identityKeys: string[];
  order_number: string;
  order_type: 'dine-in' | 'pickup' | 'takeaway' | 'delivery' | 'drive-through' | 'dine_in' | 'room_service';
  status: KitchenStatus;
  items: KitchenOrderItem[];
  created_at: string;
  table_number?: string;
  priority: 'normal' | 'rush' | 'vip';
  notes?: string;
  station_id?: string;
  source: 'live-draft' | 'local-order';
  isDraft: boolean;
  draftSessionId?: string;
  sourceTerminalId?: string;
}

interface KitchenOrderItem {
  id: string;
  name: string;
  quantity: number;
  station: string;
  status: KitchenStatus;
  modifiers?: string[];
  notes?: string;
}

export interface KdsStation {
  id: string;
  name: string;
  station_type: string;
}

// Background sync can land orders in SQLite without a store event; re-hydrate the
// local store after sync at most this often. Local IPC only.
const LOCAL_REHYDRATE_MIN_MS = 30000;
export const KITCHEN_DISPLAY_CONTENT_TYPE = 'kitchen_display';
const KDS_PRIORITIES = new Set(['rush', 'vip']);
const LOCAL_KDS_STATIONS = ['hot', 'grill', 'cold', 'dessert', 'drinks'];
const KITCHEN_STATUSES = new Set<unknown>(['pending', 'preparing', 'ready']);
const isKitchenStatus = (value: unknown): value is KitchenStatus => KITCHEN_STATUSES.has(value);
// Start Preparing -> Mark Ready -> Mark Collected. Local kitchen stages only.
const NEXT_LOCAL_PHASE: Record<KitchenStatus, LocalPreparationPhase> = { pending: 'preparing', preparing: 'ready', ready: 'collected' };

// Identifies one owner session: a connected display intent from an older session is rejected.
const createKdsDisplaySessionId = (): string => {
  try {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  } catch {
    // Fall through to the non-cryptographic id; it only has to differ between sessions.
  }
  return `kds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

function readSearchParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

export function isKitchenExternalDisplayWindow(): boolean {
  return readSearchParam('externalDisplay') === KITCHEN_DISPLAY_CONTENT_TYPE;
}

const mapLocalOrderToKitchenOrder = (order: Record<string, unknown>): KitchenOrder | null => {
  const id = readKdsString(order, 'id') || readKdsString(order, 'supabase_id');
  const orderNumber = getKdsVisibleOrderNumber(order) || id;

  if (!id || !orderNumber) return null;

  const rawItems = Array.isArray(order['items']) ? (order['items'] as Record<string, unknown>[]) : [];
  // Canonical pending/confirmed, preparing or ready: a ready order stays until it is collected.
  const status = readCanonicalKitchenStatus(order);
  const priority = readKdsString(order, 'priority').toLowerCase();

  return {
    id,
    sourceOrderId: readKdsString(order, 'supabase_id') || id,
    identityKeys: getKdsRecordIdentityKeys(order),
    order_number: orderNumber,
    order_type: (readKdsString(order, 'order_type') || readKdsString(order, 'orderType') || 'takeaway') as KitchenOrder['order_type'],
    status,
    created_at: readKdsString(order, 'created_at') || readKdsString(order, 'createdAt') || new Date().toISOString(),
    notes: readKdsString(order, 'special_instructions') || readKdsString(order, 'notes') || undefined,
    table_number: readKdsString(order, 'table_number') || readKdsString(order, 'tableNumber') || undefined,
    priority: KDS_PRIORITIES.has(priority) ? priority as KitchenOrder['priority'] : 'normal',
    source: 'local-order',
    isDraft: false,
    draftSessionId: undefined,
    sourceTerminalId: readKdsString(order, 'source_terminal_id') || readKdsString(order, 'sourceTerminalId') || undefined,
    items: rawItems.map((item, index) => ({
      id: readKdsString(item, 'id') || `local-item-${index + 1}`,
      name: readKdsString(item, 'name') || readKdsString(item, 'menu_item_name') || 'Unknown',
      quantity: Number(item['quantity']) || 1,
      station: readKdsString(item, 'station') || 'hot',
      status,
      notes: readKdsString(item, 'notes') || readKdsString(item, 'special_instructions') || undefined,
      modifiers: readKdsModifierLabels(item['modifiers']) ?? readKdsModifierLabels(item['customizations']),
    })),
  };
};

const mapLocalDraftToKitchenOrder = (draft: KdsLocalDraft): KitchenOrder => ({
  id: `live-draft-${draft.sessionId}`,
  // A live cart has no order identity: no stage mark can ever apply to it.
  identityKeys: [],
  order_number: `LIVE-${draft.sessionId.slice(0, 8).toUpperCase()}`,
  order_type: (draft.orderType || 'pickup') as KitchenOrder['order_type'],
  status: 'pending',
  created_at: draft.updatedAt,
  priority: 'normal',
  source: 'live-draft',
  isDraft: true,
  draftSessionId: draft.sessionId,
  items: draft.items.map((item) => ({ ...item, status: 'pending' as const })),
});

const createdAtMs = (order: KitchenOrder): number => Date.parse(order.created_at) || 0;

const composeLocalKitchenOrders = (
  orders: readonly unknown[],
  terminalId: string | null,
  organizationId: string | null,
  branchId: string | null
): KitchenOrder[] => {
  const seen = new Set<string>();
  const composed: KitchenOrder[] = [];
  orders.forEach((value) => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (!isActiveLocalKitchenOrder(record) || !matchesKdsTerminal(terminalId, record) || !matchesKdsTenant(organizationId, branchId, record)) return;
    const keys = getKdsRecordIdentityKeys(record);
    if (keys.some((key) => seen.has(key))) return;
    const order = mapLocalOrderToKitchenOrder(record);
    if (!order) return;
    keys.forEach((key) => seen.add(key));
    composed.push(order);
  });
  return composed.sort((left, right) => createdAtMs(left) - createdAtMs(right));
};

// Every identity of a local order: stage reads and stage writes resolve the same keys.
const kitchenOrderKeys = (order: KitchenOrder): string[] => [...new Set([order.id, ...order.identityKeys])];

// Board stage of a local order under its latest local mark; null once a waiter collected it.
// A mark only moves an order forward: it never downgrades a canonical stage.
const readKitchenStatus = (order: KitchenOrder, state: LocalPreparationState): KitchenStatus | null =>
  overlayKitchenStatus(order.status, findLocalPreparationMark(state, kitchenOrderKeys(order))?.phase);

// Kitchen stages overlay the local order; they never change its canonical status,
// payment state or closure. Live drafts are never marked.
const applyLocalPhases = (orders: KitchenOrder[], state: LocalPreparationState): KitchenOrder[] =>
  orders.flatMap((order) => {
    if (order.isDraft) return [order];
    const status = readKitchenStatus(order, state);
    if (!status) return [];
    if (status === order.status) return [order];
    return [{ ...order, status, items: order.items.map((item) => ({ ...item, status })) }];
  });

const localStationRank = (id: string): number => {
  const index = LOCAL_KDS_STATIONS.indexOf(id);
  return index === -1 ? LOCAL_KDS_STATIONS.length : index;
};

const formatStationLabel = (id: string): string =>
  (id.charAt(0).toUpperCase() + id.slice(1)).replace(/[_-]+/g, ' ');

/**
 * Strictly local owner: local order store + the shared local kitchen stage store
 * (preparing / ready / collected) + local cart drafts. No KDS API, realtime channel,
 * sync or canonical order status/payment/closure write exists here: "collected"
 * only means a waiter picked the order up from the kitchen.
 */
function useKitchenDisplayOwner(pageActive: boolean) {
  const bridge = getBridge();
  const { t } = useTranslation();
  const {
    branchId,
    organizationId,
    terminalId,
    isResolving: isIdentityResolving,
    isReady: isIdentityReady,
    missing,
    refresh: refreshIdentity,
  } = useResolvedPosIdentity('branch');
  const localOrders = useOrderStore((state) => state.orders);
  const loadLocalOrders = useOrderStore((state) => state.loadOrders);
  const localDrafts = useSyncExternalStore(subscribeKdsLocalDrafts, getKdsLocalDrafts);
  // The app-level LocalPreparationScopeSync selects the store scope; this owner only reads and marks.
  const preparation = useLocalPreparationSnapshot();
  const [stationFilter, setStationFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [soundEnabled, setSoundEnabled] = useState(true);
  useAppAudioEnabled();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [displayCapabilities, setDisplayCapabilities] =
    useState<ExternalDisplayCapabilities | null>(null);
  const [displayNotice, setDisplayNotice] = useState<string | null>(null);
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [isDisplayBusy, setIsDisplayBusy] = useState(false);
  // One owner per hook instance, kept across identity scopes: Stop and cleanup close only its token.
  const [presentation] = useState(() => new ExternalPresentationOwner(KITCHEN_DISPLAY_CONTENT_TYPE));

  const externalWindow = false;
  const { isModuleEnabled } = useModules();
  const moduleEnabled = isModuleEnabled('kitchen_display');
  const identityScope = moduleEnabled && isIdentityReady && organizationId && branchId && terminalId ? `${organizationId}|${branchId}|${terminalId}` : '';
  // A new owner session per scope: connected display intents must name it.
  const sessionId = useMemo(() => (identityScope ? createKdsDisplaySessionId() : ''), [identityScope]);
  // Opening or running only: a closing window no longer projects.
  const activeExternalDisplay = Boolean(identityScope) && isExternalContentLive(displayCapabilities, KITCHEN_DISPLAY_CONTENT_TYPE);
  // Valid external screens only: never the cashier's monitor; an external OS primary is allowed.
  const externalDisplays = useMemo(() => externalDisplayChoices(displayCapabilities), [displayCapabilities]);
  // Any kitchen window, closing included: a closing window keeps its screen occupied until destroyed.
  const hasKitchenPresentation = Boolean(identityScope) && Boolean(
    displayCapabilities?.activePresentations?.some((item) => item.contentType === KITCHEN_DISPLAY_CONTENT_TYPE)
  );
  const ownerActive = Boolean(identityScope) && (pageActive || activeExternalDisplay);
  // A paused page keeps an active connected display current.
  const effectiveRefresh = autoRefresh || activeExternalDisplay;
  const displayGeneration = useRef(0);
  const coordinator = useRef(new KdsReadCoordinator()).current;
  const scopeRef = useRef(identityScope);
  scopeRef.current = identityScope;
  const loadLocalOrdersRef = useRef(loadLocalOrders);
  loadLocalOrdersRef.current = loadLocalOrders;
  useEffect(() => {
    coordinator.configure(identityScope, ownerActive);
    return () => coordinator.configure('', false);
  }, [coordinator, identityScope, ownerActive]);

  const fetchExternalDisplayCapabilities = useCallback(async () => {
    if (externalWindow || !identityScope) return;
    const requestedScope = identityScope;
    const generation = displayGeneration.current;
    // The answer to a read issued before this owner's last open or stop never changes what it owns.
    const ownership = presentation.revision;
    try {
      const result = await bridge.externalDisplay.getCapabilities();
      if (scopeRef.current !== requestedScope || generation !== displayGeneration.current) return;
      // A live kitchen window this owner neither holds nor is opening (e.g. after a reload) becomes its own;
      // once native lists no kitchen window at all (e.g. closed from the OS), the owned one is forgotten.
      presentation.observe(result, ownership);
      setDisplayCapabilities(result);
    } catch (err) {
      if (scopeRef.current !== requestedScope || generation !== displayGeneration.current) return;
      setDisplayCapabilities({
        success: false,
        supported: false,
        displays: [],
        error: err instanceof Error ? err.message : 'Failed to inspect connected displays',
      });
    }
  }, [bridge, externalWindow, identityScope, presentation]);

  // Stage marks gate the board: until they are read for this scope nothing is shown,
  // so a ready or collected order can never resurrect from an unread or failed store.
  // The shared store never throws on refresh: it keeps the last good marks and records
  // the error. A failed order-store reload keeps its current orders.
  const readLocalState = async (isCurrent: () => boolean) => {
    const requestedScope = scopeRef.current;
    if (!requestedScope || !isCurrent()) return;
    await Promise.all([
      localPreparationStore.refresh(requestedScope),
      Promise.resolve().then(() => loadLocalOrdersRef.current()).catch(() => undefined),
    ]);
  };
  const readLocalStateRef = useRef(readLocalState);
  readLocalStateRef.current = readLocalState;
  // Coalesced by the coordinator: one running and one queued local read at most.
  const fetchOrders = useCallback((_showLoading?: boolean) =>
    coordinator.request(isCurrent => readLocalStateRef.current(isCurrent)), [coordinator]);

  useEffect(() => {
    void fetchExternalDisplayCapabilities();
    if (ownerActive) void fetchOrders(true);
  }, [fetchExternalDisplayCapabilities, fetchOrders, ownerActive]);

  useEffect(() => {
    if (!ownerActive || !effectiveRefresh) return;
    let lastRehydrateAt = Date.now();
    const handleSyncComplete = () => {
      const now = Date.now();
      if (now - lastRehydrateAt < LOCAL_REHYDRATE_MIN_MS) return;
      lastRehydrateAt = now;
      void fetchOrders(false);
    };
    onEvent('sync:complete', handleSyncComplete);
    return () => offEvent('sync:complete', handleSyncComplete);
  }, [identityScope, ownerActive, effectiveRefresh, fetchOrders]);

  const baseOrders = useMemo(() => {
    if (!identityScope) return [];
    const drafts = localDrafts
      .filter((draft) => draft.scope === identityScope)
      .map(mapLocalDraftToKitchenOrder);
    return [...composeLocalKitchenOrders(localOrders, terminalId, organizationId, branchId), ...drafts];
  }, [identityScope, localDrafts, localOrders, terminalId, organizationId, branchId]);
  const baseOrdersRef = useRef(baseOrders);
  baseOrdersRef.current = baseOrders;
  // Only a snapshot of this exact scope counts; another or unresolved scope shows nothing.
  const scopedPreparation = identityScope && preparation.scope === identityScope ? preparation : null;
  const phaseState = scopedPreparation?.state ?? null;
  const phaseError = scopedPreparation?.error ?? null;
  // Same-scope read failure: keep the last good board with a banner. First failure: fail closed.
  const stale = Boolean(phaseState && phaseError);
  const error = !phaseState && phaseError ? t('kitchen.loadError', 'Unable to load orders') : null;
  const orders = useMemo(
    () => (phaseState ? applyLocalPhases(baseOrders, phaseState) : []),
    [baseOrders, phaseState]
  );
  const stations = useMemo<KdsStation[]>(() => {
    const ids = new Set<string>();
    orders.forEach((order) => order.items.forEach((item) => { if (item.station) ids.add(item.station); }));
    if (stationFilter !== 'all') ids.add(stationFilter);
    return [...ids]
      .sort((left, right) => localStationRank(left) - localStationRank(right) || left.localeCompare(right))
      .map((id) => ({ id, name: t(`kitchen.stations.${id}`, formatStationLabel(id)), station_type: id }));
  }, [orders, stationFilter, t]);
  const loading = isIdentityResolving || (ownerActive && !phaseState && !phaseError);
  const isLive = ownerActive && autoRefresh && Boolean(phaseState);

  const bumping = useRef(new Set<string>());
  // Start Preparing -> Mark Ready -> Mark Collected, persisted locally only. `expectedStatus`
  // is the stage the operator saw, so a stale or double action never skips a stage.
  const handleBumpOrder = async (orderId: string, expectedStatus?: KitchenStatus) => {
    // The latest store snapshot wins over a render that has not caught up yet.
    const latest = localPreparationStore.getSnapshot();
    const bumpScope = latest.scope;
    const state = latest.state;
    if (!ownerActive || !bumpScope || bumpScope !== identityScope || bumpScope !== scopeRef.current || !state || bumping.current.has(orderId)) return;
    const current = baseOrdersRef.current.find(order => order.id === orderId);
    if (!current || current.isDraft) return;
    const status = readKitchenStatus(current, state);
    if (!status || (expectedStatus && status !== expectedStatus)) return;
    const next = NEXT_LOCAL_PHASE[status];
    bumping.current.add(orderId);
    try {
      // `expected` is resolved by alias exactly like the board read, so an order that
      // changed between its local and cloud representation still moves forward once.
      const keys = kitchenOrderKeys(current);
      await localPreparationStore.mark(bumpScope, current.id, next, findLocalPreparationMark(state, keys)?.phase ?? null, keys);
      if (scopeRef.current !== bumpScope) return;
      if (soundEnabled) playAppAudioFile('/sounds/bump.mp3');
    } catch (err) {
      if (scopeRef.current !== bumpScope) return;
      if (err instanceof LocalPreparationConflictError) {
        // Another action already moved this order: show the stored stage instead.
        void localPreparationStore.refresh(bumpScope);
        return;
      }
      console.error('Failed to save local kitchen state:', err);
      toast.error(t('kitchen.bumpError', 'Failed to update order'));
    } finally { bumping.current.delete(orderId); }
  };

  // Without a screen the native side picks the first free external one (Auto).
  const openExternalDisplay = async (display?: ExternalDisplayInfo) => {
    if (!identityScope) return;
    const openedScope = identityScope;
    const generation = displayGeneration.current;
    const isCurrent = () => scopeRef.current === openedScope && generation === displayGeneration.current;
    // The open names the window this owner holds, first adopting the running one the cashier sees;
    // while it is in flight the owner adopts no other window.
    presentation.observe(displayCapabilities);
    const endOpen = presentation.beginOpen();
    setIsDisplayBusy(true);
    setDisplayNotice(null);
    setDisplayError(null);
    try {
      // Auto sends only `{ contentType: KITCHEN_DISPLAY_CONTENT_TYPE }` and the held token; a chosen screen adds
      // only its opaque `displayId`, so a missing or occupied screen fails instead of being redirected. Native
      // reopens only the window still holding `expectedToken`, so a late or stale open takes over nothing.
      const result = await bridge.externalDisplay.open(externalOpenParams(KITCHEN_DISPLAY_CONTENT_TYPE, display, presentation.ownedToken));
      if (!isCurrent()) {
        // A late completion closes only the window it created, never a newer session's.
        await closeStaleExternalOpen(bridge, KITCHEN_DISPLAY_CONTENT_TYPE, result);
        return;
      }
      if (!result?.success) {
        // The native refusal stands: no retry on another screen and no Auto fallback. The open settled,
        // so the fresh answer may also forget a window that is gone (e.g. closed from the OS).
        endOpen();
        setDisplayError(result?.error || t('kitchen.externalDisplay.openFailed', 'Failed to open kitchen display'));
        await fetchExternalDisplayCapabilities();
        return;
      }
      presentation.opened(result);
      endOpen();
      setDisplayNotice(
        t('kitchen.externalDisplay.running', 'Kitchen display is running on the selected monitor or TV.')
      );
      await fetchExternalDisplayCapabilities();
    } catch (err) {
      if (!isCurrent()) return;
      setDisplayError(
        err instanceof Error && err.message
          ? err.message
          : t('kitchen.externalDisplay.openFailed', 'Failed to open kitchen display')
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
    void bridge.invoke('kds-display-publish', null).catch(() => {});
    setDisplayCapabilities(previous => previous ? { ...previous, activePresentations: previous.activePresentations?.filter(item => item.contentType !== KITCHEN_DISPLAY_CONTENT_TYPE) } : null);
    setIsDisplayBusy(true);
    setDisplayNotice(null);
    setDisplayError(null);
    try {
      // Closes exactly the window this owner opened or adopted; owning none closes nothing.
      presentation.observe(displayCapabilities);
      const result = await presentation.release(bridge);
      if (!isCurrent()) return;
      if (result && !result.success) {
        setDisplayError(result.error || t('kitchen.externalDisplay.closeFailed', 'Failed to close kitchen display'));
      } else {
        setDisplayNotice(t('kitchen.externalDisplay.stopped', 'External kitchen display stopped.'));
      }
      // Native truth after the close: a closing window keeps its screen occupied until destroyed.
      await fetchExternalDisplayCapabilities();
    } catch (err) {
      if (!isCurrent()) return;
      setDisplayError(
        err instanceof Error && err.message
          ? err.message
          : t('kitchen.externalDisplay.closeFailed', 'Failed to close kitchen display')
      );
    } finally {
      if (isCurrent()) setIsDisplayBusy(false);
    }
  };

  // Native capability checks are local IPC, never cloud polling. Detect monitor/window closure
  // and follow a closing window until its screen is free again.
  useEffect(() => {
    if (!hasKitchenPresentation) return;
    const timer = setInterval(() => void fetchExternalDisplayCapabilities(), 2000);
    return () => clearInterval(timer);
  }, [hasKitchenPresentation, fetchExternalDisplayCapabilities]);
  useEffect(() => {
    setDisplayCapabilities(null); setIsDisplayBusy(false);
    return () => {
      displayGeneration.current++;
      coordinator.configure('', false);
      void bridge.invoke('kds-display-publish', null).catch(() => {});
      // Only the window this owner opened or adopted closes; a newer session keeps its own.
      void presentation.release(bridge).catch(() => {});
    };
  }, [bridge, coordinator, identityScope, presentation]);
  return { identityScope, sessionId, loading, orders, stations, stationFilter, viewMode, soundEnabled, autoRefresh, error, stale, isLive, displayCapabilities, displayNotice, displayError, isDisplayBusy, isIdentityResolving, isIdentityReady, missing, activeExternalDisplay, externalDisplays, setStationFilter, setViewMode, setSoundEnabled, setAutoRefresh, refreshIdentity, fetchOrders, handleBumpOrder, openExternalDisplay, closeExternalDisplay };
}

export type KdsModel = ReturnType<typeof useKitchenDisplayOwner>;
// Board data only: no command, monitor list, display control or presentation token reaches the connected display.
const KDS_SNAPSHOT_KEYS = ['identityScope', 'sessionId', 'loading', 'orders', 'stations', 'stationFilter', 'viewMode', 'soundEnabled', 'autoRefresh', 'error', 'stale', 'isLive', 'isIdentityResolving', 'isIdentityReady', 'missing', 'activeExternalDisplay'] as const;
export type KdsSnapshot = Pick<KdsModel, (typeof KDS_SNAPSHOT_KEYS)[number]>;
const toKdsSnapshot = (model: KdsModel): KdsSnapshot =>
  JSON.parse(JSON.stringify(Object.fromEntries(KDS_SNAPSHOT_KEYS.map((key) => [key, model[key]])))) as KdsSnapshot;
export const KdsContext = createContext<{ model: KdsModel; attach: () => () => void } | null>(null);

export function KitchenDisplayProvider({ children }: { children: React.ReactNode }) {
  const [consumers, setConsumers] = useState(0);
  const model = useKitchenDisplayOwner(consumers > 0);
  const attach = useCallback(() => {
    setConsumers(value => value + 1);
    return () => setConsumers(value => Math.max(0, value - 1));
  }, []);
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => {
    // Only the terminal-scoped board crosses local IPC; the presentation token stays in this window.
    const snapshot = model.activeExternalDisplay && model.identityScope ? toKdsSnapshot(model) : null;
    void getBridge().invoke('kds-display-publish', snapshot).catch(() => {});
  }, [model]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const stop = await listen<{ scope?: unknown; session?: unknown; action?: unknown; value?: unknown; status?: unknown }>('kds-display-intent', ({ payload }) => {
        if (!payload || typeof payload !== 'object') return;
        const current = modelRef.current;
        // Only the connected display of this exact scope and owner session may act.
        if (!current.activeExternalDisplay || !current.identityScope || payload.scope !== current.identityScope) return;
        if (!current.sessionId || payload.session !== current.sessionId) return;
        switch (payload.action) {
          case 'bump': if (typeof payload.value === 'string' && isKitchenStatus(payload.status)) void current.handleBumpOrder(payload.value, payload.status); break;
          case 'refresh': void current.fetchOrders(true); break;
          case 'station': if (typeof payload.value === 'string') current.setStationFilter(payload.value); break;
          case 'view': if (payload.value === 'grid' || payload.value === 'list') current.setViewMode(payload.value); break;
          case 'sound': if (typeof payload.value === 'boolean') current.setSoundEnabled(payload.value); break;
          case 'auto': if (typeof payload.value === 'boolean') current.setAutoRefresh(payload.value); break;
        }
      });
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);
  return <KdsContext.Provider value={{ model, attach }}>{children}</KdsContext.Provider>;
}
