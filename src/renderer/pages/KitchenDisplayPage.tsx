import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
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
import { motion, AnimatePresence } from 'framer-motion';
import {
  BellRing,
  ChefHat,
  Clock,
  CheckCircle,
  AlertTriangle,
  HandPlatter,
  Timer,
  Utensils,
  Coffee,
  Flame,
  Snowflake,
  RefreshCw,
  Volume2,
  VolumeX,
  Play,
  Pause,
  LayoutGrid,
  List,
  Monitor,
  ScreenShare,
  X
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
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
  isExternalDisplayFree,
  liveExternalPresentation,
} from '../services/ExternalDisplayOwnership';
import { useModules } from '../contexts/module-context';
import { useResolvedPosIdentity } from '../hooks/useResolvedPosIdentity';
import { useOrderStore } from '../hooks/useOrderStore';
import { formatCompactOrderNumberForDisplay } from '../utils/orderNumberUtils';

/** Kitchen board stage. "Collected" orders leave the board; none of these is a canonical order status. */
type KitchenStatus = KitchenBoardStatus;

interface KitchenOrder {
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

interface KdsStation {
  id: string;
  name: string;
  station_type: string;
}

// Background sync can land orders in SQLite without a store event; re-hydrate the
// local store after sync at most this often. Local IPC only.
const LOCAL_REHYDRATE_MIN_MS = 30000;
const KITCHEN_DISPLAY_CONTENT_TYPE = 'kitchen_display';
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

function isKitchenExternalDisplayWindow(): boolean {
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

type KdsModel = ReturnType<typeof useKitchenDisplayOwner>;
// Board data only: no command, monitor list, display control or presentation token reaches the connected display.
const KDS_SNAPSHOT_KEYS = ['identityScope', 'sessionId', 'loading', 'orders', 'stations', 'stationFilter', 'viewMode', 'soundEnabled', 'autoRefresh', 'error', 'stale', 'isLive', 'isIdentityResolving', 'isIdentityReady', 'missing', 'activeExternalDisplay'] as const;
type KdsSnapshot = Pick<KdsModel, (typeof KDS_SNAPSHOT_KEYS)[number]>;
const toKdsSnapshot = (model: KdsModel): KdsSnapshot =>
  JSON.parse(JSON.stringify(Object.fromEntries(KDS_SNAPSHOT_KEYS.map((key) => [key, model[key]])))) as KdsSnapshot;
const KdsContext = createContext<{ model: KdsModel; attach: () => () => void } | null>(null);

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

function LocalKitchenDisplayPage() {
  const context = useContext(KdsContext);
  if (!context) throw new Error('Kitchen display requires its persistent owner');
  useEffect(() => context.attach(), [context.attach]);
  return <KitchenDisplayView model={context.model} externalWindow={false} />;
}

function ExternalKitchenDisplayPage() {
  const [snapshot, setSnapshot] = useState<KdsSnapshot | null>(null);
  useEffect(() => {
    let disposed = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await getBridge().invoke('kds-display-snapshot');
        if (!disposed) setSnapshot(next || null);
      } catch { if (!disposed) setSnapshot(null); }
      finally { reading = false; }
    };
    void read();
    // Reads only the Rust memory snapshot. No API, credentials, orders store or subscription.
    const timer = setInterval(() => void read(), 500);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  if (!snapshot) return <div className="h-screen bg-black" />;
  const intent = (action: string, value?: unknown, status?: KitchenStatus) =>
    getBridge().invoke('kds-display-intent', { scope: snapshot.identityScope, session: snapshot.sessionId, action, value, status }).catch(() => {});
  const model = {
    ...snapshot,
    // The receiver never controls a screen: it holds no monitor list, display state or token.
    displayCapabilities: null, displayNotice: null, displayError: null, isDisplayBusy: false, externalDisplays: [],
    setStationFilter: (value: string) => { void intent('station', value); },
    setViewMode: (value: string) => { void intent('view', value); },
    setSoundEnabled: (value: boolean) => { void intent('sound', value); },
    setAutoRefresh: (value: boolean) => { void intent('auto', value); },
    refreshIdentity: () => intent('refresh'),
    fetchOrders: () => intent('refresh'),
    handleBumpOrder: (id: string, status?: KitchenStatus) =>
      intent('bump', id, status ?? snapshot.orders.find(order => order.id === id)?.status),
    openExternalDisplay: async () => {}, closeExternalDisplay: async () => {},
  } as KdsModel;
  return <KitchenDisplayView model={model} externalWindow />;
}

function KitchenDisplayView({ model, externalWindow }: { model: KdsModel; externalWindow: boolean }) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const { loading, stations, stationFilter, viewMode, soundEnabled, autoRefresh, error, stale, isLive, displayCapabilities, displayNotice, displayError, isDisplayBusy, isIdentityResolving, isIdentityReady, missing, activeExternalDisplay, externalDisplays, setStationFilter, setViewMode, setSoundEnabled, setAutoRefresh, refreshIdentity, fetchOrders, handleBumpOrder, openExternalDisplay, closeExternalDisplay } = model;
  const freeExternalDisplays = externalDisplays.filter(isExternalDisplayFree);
  const runningDisplayId = activeExternalDisplay
    ? liveExternalPresentation(displayCapabilities, KITCHEN_DISPLAY_CONTENT_TYPE)?.displayId
    : undefined;
  const orders = model.stationFilter === 'all' ? model.orders : model.orders.filter(order =>
    order.station_id === model.stationFilter || order.items.some(item => item.station === model.stationFilter));
  // Format order type for display using i18n (handles both legacy and new formats)
  const formatOrderType = (type: string): string => {
    // Map to translation keys (use existing orderType namespace)
    const keyMap: Record<string, string> = {
      'dine-in': 'orderType.dineIn',
      'dine_in': 'orderType.dineIn',  // legacy
      'pickup': 'orderType.pickup',
      'takeaway': 'orderType.takeaway',
      'delivery': 'orderType.delivery',
      'drive-through': 'orderType.driveThrough',
      'room_service': 'orderType.roomService',
    };
    const key = keyMap[type];
    return key ? t(key, type) : type;  // fallback to raw type if no translation
  };

  const getOrderTypeTextColor = (type: string): string => {
    const colors: Record<string, string> = {
      'dine-in': 'text-yellow-500',
      'dine_in': 'text-yellow-500',
      'pickup': 'text-amber-500',
      'takeaway': 'text-green-500',
      'delivery': 'text-emerald-500',
      'drive-through': 'text-red-500',
      'room_service': 'text-amber-500',
    };
    return colors[type] || 'text-gray-500';
  };

  const getTimeSinceOrder = (createdAt: string): string => {
    const diff = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('kitchen.justNow', 'Just now');
    if (mins < 60) return `${mins} ${t('kitchen.min', 'min')}`;
    return t('kitchen.hoursAgo', '{{hours}}h {{mins}}m', { hours: Math.floor(mins / 60), mins: mins % 60 });
  };

  const getTimeColor = (createdAt: string): string => {
    const diff = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins > 20) return 'text-red-500';
    if (mins > 10) return 'text-yellow-500';
    return 'text-green-500';
  };

  const StationIcon = ({ station }: { station: string }) => {
    switch (station) {
      case 'grill': return <Flame className="w-4 h-4 text-amber-500" />;
      case 'cold': return <Snowflake className="w-4 h-4 text-slate-500" />;
      case 'hot': return <Utensils className="w-4 h-4 text-red-500" />;
      case 'dessert': return <Coffee className="w-4 h-4 text-yellow-500" />;
      case 'drinks': return <Coffee className="w-4 h-4 text-emerald-500" />;
      default: return <ChefHat className="w-4 h-4" />;
    }
  };

  const stats = {
    pending: orders.filter(o => o.status === 'pending').length,
    preparing: orders.filter(o => o.status === 'preparing').length,
    ready: orders.filter(o => o.status === 'ready').length,
    total: orders.length,
    avgTime: orders.length > 0 ? Math.round(orders.reduce((sum, o) => sum + (Date.now() - new Date(o.created_at).getTime()) / 60000, 0) / orders.length) : 0
  };
  const showMissingContext = !isIdentityResolving && !isIdentityReady;

  const OrderCard = ({ order }: { order: KitchenOrder }) => {
    const timeColor = getTimeColor(order.created_at);
    const isLiveDraft = order.isDraft;
    const isReady = !isLiveDraft && order.status === 'ready';
    const orderLabel = isLiveDraft
      ? t('kitchen.liveDraft.badge', 'Live Draft')
      : formatCompactOrderNumberForDisplay(order.order_number);
    return (
      <motion.div
        initial={false}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className={`p-4 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} ${order.priority === 'rush' ? 'ring-2 ring-red-500' : isReady ? 'ring-2 ring-emerald-500/70' : ''}`}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-xl font-bold leading-tight">
              {orderLabel}
            </span>
            {isReady && (
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${isDark ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-emerald-300 bg-emerald-50 text-emerald-700'}`}>
                <BellRing className="h-3.5 w-3.5" />
                {t('kitchen.ready', 'Ready')}
              </span>
            )}
            <span className={`text-xs font-medium ${getOrderTypeTextColor(order.order_type)}`}>
              {formatOrderType(order.order_type)}
            </span>
            {isLiveDraft && (
              <span className="text-xs font-medium text-amber-400">
                {t('kitchen.liveDraft.subtitle', 'Live cart in progress')}
              </span>
            )}
            {order.table_number && <span className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{order.table_number}</span>}
          </div>
          <div className={`flex shrink-0 items-center gap-1 ${timeColor}`}>
            <Clock className="w-4 h-4" />
            <span className="text-sm font-medium">{getTimeSinceOrder(order.created_at)}</span>
          </div>
        </div>
        <div className="space-y-2 mb-4">
          {order.items.map((item) => (
            <div key={item.id} className={`flex items-center justify-between gap-2 p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
              <div className="flex min-w-0 items-center gap-2">
                <StationIcon station={item.station} />
                <span className="font-medium">{item.quantity}x</span>
                <div className="min-w-0">
                  <span className="break-words">{item.name}</span>
                  {item.modifiers && item.modifiers.length > 0 && (
                    <p className={`break-words text-xs ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{item.modifiers.join(', ')}</p>
                  )}
                </div>
              </div>
              {item.notes && <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{item.notes}</span>}
            </div>
          ))}
        </div>
        {order.notes && (
          <div className={`mb-3 p-2 rounded-xl ${isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
            <p className="text-sm text-yellow-600">{order.notes}</p>
          </div>
        )}
        {isLiveDraft ? (
          <div className={`w-full py-3 rounded-xl text-center font-medium ${isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-gray-100 text-gray-600'}`}>
            {t('kitchen.liveDraft.noAction', 'Waiting for checkout')}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void handleBumpOrder(order.id, order.status)}
            className={`w-full py-3 rounded-xl font-medium transition-all active:scale-[0.98] ${order.status === 'pending' ? 'bg-yellow-400 text-black active:bg-yellow-300' : order.status === 'preparing' ? 'bg-green-500 text-white active:bg-green-600' : isDark ? 'border border-zinc-600 bg-zinc-800 text-zinc-100 active:bg-zinc-700' : 'border border-gray-300 bg-gray-100 text-gray-900 active:bg-gray-200'}`}
          >
            {order.status === 'pending' ? (
              <><Play className="w-4 h-4 inline mr-2" />{t('kitchen.startPreparing', 'Start Preparing')}</>
            ) : order.status === 'preparing' ? (
              <><CheckCircle className="w-4 h-4 inline mr-2" />{t('kitchen.markReady', 'Mark Ready')}</>
            ) : (
              <><HandPlatter className="w-4 h-4 inline mr-2" />{t('kitchen.markCollected', 'Mark Collected')}</>
            )}
          </button>
        )}
      </motion.div>
    );
  };

  return (
    <div className={`h-full min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide p-4 md:p-5 ${externalWindow || isDark ? 'bg-black text-zinc-100' : 'bg-[#fdfaf5] text-gray-900'} ${externalWindow ? 'h-screen' : ''}`}>
      {/* Header + Stats Card */}
      <div className={`rounded-2xl border mb-5 px-4 py-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-bold tracking-tight">
            {t('kitchen.title', 'Kitchen Display')}
          </h1>
          <p className={`mt-1 truncate text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t('kitchen.subtitle', 'Real-time order preparation')}
            {autoRefresh && isLive ? ` • ${t('common.live', 'Live')}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!externalWindow && (
            <>
              {activeExternalDisplay ? (
                <button
                  type="button"
                  onClick={() => void closeExternalDisplay()}
                  disabled={isDisplayBusy}
                  className="p-3 rounded-xl border border-red-500/40 bg-red-500/10 text-red-300 transition-all active:scale-95 active:bg-red-500/20 disabled:opacity-60 disabled:active:scale-100"
                  aria-label={t('kitchen.externalDisplay.stop', 'Stop external display')}
                >
                  <X className="w-5 h-5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void openExternalDisplay()}
                  disabled={isDisplayBusy || !displayCapabilities?.supported || freeExternalDisplays.length === 0}
                  className={`p-3 rounded-xl border transition-all active:scale-95 disabled:opacity-60 disabled:active:scale-100 ${isDark ? 'border-amber-400/40 bg-amber-500/10 text-amber-200 active:bg-amber-500/20' : 'border-amber-300 bg-amber-50 text-amber-800 active:bg-amber-100'}`}
                  aria-label={t('kitchen.externalDisplay.open', 'Open on connected display')}
                >
                  <ScreenShare className="w-5 h-5" />
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
            aria-label={viewMode === 'grid' ? t('kitchen.view.list', 'List view') : t('kitchen.view.grid', 'Grid view')}
            className={`p-3 rounded-xl border transition-all active:scale-95 ${isDark ? 'bg-zinc-900 border-zinc-700 active:bg-zinc-800' : 'bg-white border-gray-300 active:bg-gray-100'}`}
          >
            {viewMode === 'grid' ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
          </button>
          <button
            type="button"
            onClick={() => setSoundEnabled(!soundEnabled)}
            aria-label={soundEnabled ? t('kitchen.sound.disable', 'Mute sound') : t('kitchen.sound.enable', 'Enable sound')}
            className={`p-3 rounded-xl border transition-all active:scale-95 ${isDark ? 'bg-zinc-900 border-zinc-700 active:bg-zinc-800' : 'bg-white border-gray-300 active:bg-gray-100'}`}
          >
            {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
          </button>
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            aria-label={autoRefresh ? t('kitchen.autoRefresh.pause', 'Pause live refresh') : t('kitchen.autoRefresh.resume', 'Resume live refresh')}
            className={`p-3 rounded-xl border transition-all active:scale-95 ${isDark ? 'bg-zinc-900 border-zinc-700 active:bg-zinc-800' : 'bg-white border-gray-300 active:bg-gray-100'} ${autoRefresh ? 'text-green-500' : ''}`}
          >
            {autoRefresh ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>
          <button
            type="button"
            onClick={() => {
              if (isIdentityReady) {
                void fetchOrders(true);
                return;
              }
              void refreshIdentity();
            }}
            disabled={loading}
            aria-label={t('common.refresh', 'Refresh')}
            className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all shadow-sm active:scale-95 ${
              isDark
                ? 'border border-white/80 bg-white text-black active:bg-zinc-200'
                : 'border border-black bg-black text-white active:bg-zinc-800'
            } ${loading ? 'opacity-60 cursor-not-allowed active:scale-100' : ''}`}
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><AlertTriangle className="w-5 h-5 text-yellow-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.pending', 'Pending')}</p>
              <p className="text-2xl font-bold">{stats.pending}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><ChefHat className="w-5 h-5 text-amber-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.preparing', 'Preparing')}</p>
              <p className="text-2xl font-bold">{stats.preparing}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><BellRing className="w-5 h-5 text-emerald-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.ready', 'Ready')}</p>
              <p className="text-2xl font-bold">{stats.ready}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><CheckCircle className="w-5 h-5 text-green-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.total', 'Total')}</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><Timer className="w-5 h-5 text-slate-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.avgTime', 'Avg Time')}</p>
              <p className="text-2xl font-bold">{stats.avgTime} {t('kitchen.min', 'min')}</p>
            </div>
          </div>
        </div>
      </div>
      </div>

      {!externalWindow && displayCapabilities?.supported && (
        <div className={`rounded-2xl border mb-5 p-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <div className="mb-3 flex items-center gap-2">
            <Monitor className="h-5 w-5 text-amber-400" />
            <h2 className="font-bold">
              {t('kitchen.externalDisplay.connectedDisplays', 'Connected monitors and TVs')}
            </h2>
          </div>
          {externalDisplays.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
              {externalDisplays.map((display) => display.id === runningDisplayId ? (
                <div
                  key={display.id}
                  aria-current="true"
                  className={`min-w-[210px] rounded-xl border px-3 py-3 text-left ${isDark ? 'border-amber-400/40 bg-amber-500/10' : 'border-amber-300 bg-amber-50'}`}
                >
                  <div className="font-semibold">{display.name}</div>
                  <div className={isDark ? 'text-sm text-zinc-400' : 'text-sm text-gray-600'}>
                    {display.size?.width || 0} x {display.size?.height || 0}
                  </div>
                  <div className={`mt-1 text-xs font-semibold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                    {t('kitchen.externalDisplay.runningHere', 'Running here')}
                  </div>
                </div>
              ) : (
                // Another content or a closing window holds this screen until the native side frees it.
                <button
                  key={display.id}
                  type="button"
                  onClick={() => void openExternalDisplay(display)}
                  disabled={isDisplayBusy || !isExternalDisplayFree(display)}
                  className={`min-w-[210px] rounded-xl border px-3 py-3 text-left transition-all active:scale-[0.98] ${
                    isDark
                      ? 'border-zinc-700 bg-zinc-900 active:bg-zinc-800'
                      : 'border-gray-200 bg-gray-50 active:bg-gray-100'
                  } disabled:opacity-60 disabled:active:scale-100`}
                >
                  <div className="font-semibold">{display.name}</div>
                  <div className={isDark ? 'text-sm text-zinc-400' : 'text-sm text-gray-600'}>
                    {display.size?.width || 0} x {display.size?.height || 0}
                  </div>
                  {!isExternalDisplayFree(display) && (
                    <div className={`mt-1 text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                      {t('kitchen.externalDisplay.inUse', 'In use')}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
          <p className={`mt-3 text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t(
              'kitchen.externalDisplay.help',
              'Connect an HDMI display or an OS-level wireless display, then select it here.'
            )}
          </p>
        </div>
      )}

      {(displayNotice || displayError || displayCapabilities?.error) && !externalWindow && (
        <div
          className={`mb-5 rounded-xl border px-4 py-3 text-sm font-medium ${
            displayError || displayCapabilities?.error
              ? 'border-red-500/40 bg-red-500/10 text-red-200'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {displayError || displayCapabilities?.error || displayNotice}
        </div>
      )}

      {/* Station Filter */}
      <div className="flex gap-2 mb-5 overflow-x-auto pb-2 scrollbar-hide">
        {[{ id: 'all', name: t('kitchen.allStations', 'All'), station_type: 'all' } as KdsStation, ...stations].map((station) => (
          <button
            key={station.id}
            onClick={() => setStationFilter(station.id === 'all' ? 'all' : station.id)}
            className={`px-4 py-2 rounded-xl font-medium whitespace-nowrap transition-all border active:scale-[0.98] ${stationFilter === (station.id === 'all' ? 'all' : station.id) ? 'bg-yellow-400 text-black border-yellow-400' : isDark ? 'bg-zinc-950 text-zinc-300 border-zinc-800 active:bg-zinc-900' : 'bg-white text-gray-600 border-gray-200 active:bg-gray-100'}`}
          >
            {station.id === 'all' ? t('kitchen.allStations', 'All') : station.name}
          </button>
        ))}
      </div>

      {/* Orders Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className={`p-6 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} animate-pulse`}>
              <div className={`h-6 rounded w-1/2 mb-4 ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
              <div className="space-y-2">
                <div className={`h-10 rounded ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
                <div className={`h-10 rounded ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
              </div>
              <div className={`h-12 rounded mt-4 ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
            </div>
          ))}
        </div>
      ) : showMissingContext ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-amber-500 opacity-75" />
          <h3 className="text-xl font-semibold mb-2">
            {t('kitchen.contextMissing.title', 'Kitchen context is missing')}
          </h3>
          <p className={`mb-4 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t(
              'kitchen.contextMissing.body',
              missing.branch
                ? 'This terminal is not assigned to a branch. Check terminal settings and try again.'
                : 'Kitchen context is incomplete. Check terminal settings and try again.'
            )}
          </p>
          <button
            onClick={() => {
              void refreshIdentity();
            }}
            className="px-6 py-2 rounded-xl bg-yellow-400 text-black font-medium transition-all active:scale-[0.98] active:bg-yellow-300"
          >
            <RefreshCw className="w-4 h-4 inline mr-2" />
            {t('kitchen.contextMissing.action', 'Retry Context')}
          </button>
        </div>
      ) : error ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-red-500 opacity-75" />
          <h3 className="text-xl font-semibold mb-2 text-red-500">{t('kitchen.loadError', 'Unable to Load Orders')}</h3>
          <p className={`mb-4 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{error}</p>
          <button
            onClick={() => {
              void fetchOrders(true);
            }}
            className="px-6 py-2 rounded-xl bg-yellow-400 text-black font-medium transition-all active:scale-[0.98] active:bg-yellow-300"
          >
            <RefreshCw className="w-4 h-4 inline mr-2" />
            {t('common.retry', 'Retry')}
          </button>
        </div>
      ) : orders.length === 0 ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <ChefHat className="w-16 h-16 mx-auto mb-4 text-gray-400 opacity-50" />
          <h3 className="text-xl font-semibold mb-2">{t('kitchen.noOrders', 'No Active Orders')}</h3>
          <p className={isDark ? 'text-zinc-400' : 'text-gray-600'}>{t('kitchen.noOrdersDesc', 'New orders will appear here automatically')}</p>
        </div>
      ) : (
        <AnimatePresence initial={false}>
          <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4' : 'space-y-4'}>
            {orders.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </div>
        </AnimatePresence>
      )}
    </div>
  );
};

const KitchenDisplayPage: React.FC = () => isKitchenExternalDisplayWindow()
  ? <ExternalKitchenDisplayPage /> : <LocalKitchenDisplayPage />;
export default KitchenDisplayPage;
