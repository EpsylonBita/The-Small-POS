/**
 * The incoming-order alert loop: which orders wait for this register's
 * accept / decline, and the sound that rings for them — at once for a new
 * order and every INCOMING_ORDER_ALERT_REPEAT_MS while one waits, following
 * the app audio setting. The efood page's own sound switch plays no part: it
 * mutes only efood's webview.
 *
 * A module, not a component, so a render error in the alert dialog
 * (IncomingOrderAlertHost) cannot stop it: IncomingOrderAlertManager starts
 * it at the App level, outside the dialog's error boundary, while a user is
 * logged in, and configures its scope (the Orders screen's order filter; off
 * on waiter terminals). The dialog shows this same queue
 * (useIncomingOrderAlertQueue). Background: services/incomingOrderAlert.ts.
 */
import { useSyncExternalStore } from 'react';

import type { Order } from '../types/orders';
import { useOrderStore } from '../hooks/useOrderStore';
import { offEvent, onEvent } from '../../lib';
import { isAppAudioEnabled, playAppAudioTones, subscribeAppAudio } from './appAudio';
import { playSelectedPlatformSound } from './platformNotificationSound';
import {
  INCOMING_ORDER_ALERT_REPEAT_MS,
  INCOMING_ORDER_SAFETY_REFRESH_MS,
  recordIncomingOrderAlertEvent,
  type IncomingOrderAlertEvent,
  type IncomingOrderAlertLogEntry,
} from './incomingOrderAlert';
import { resolveFoodDeliveryShortCode } from '../utils/foodDeliveryMetadata';
import { getVisibleOrderNumber } from '../utils/orderNumberUtils';
import { getOrderPluginId } from '../../../../shared/order-approval';

type OrderFilter = (order: Order) => boolean;

export interface IncomingOrderAlertLoopConfig {
  /** False on a waiter terminal (the main register accepts), as on Android. */
  enabled: boolean;
  /** The Orders screen's own order filter (dashboardOrderScope.ts); none = every order. */
  orderFilter?: OrderFilter;
  /** Where staff are, for the log (layout view, or the route outside the layout). */
  view: string;
}

/** A replay closer than this to the last play would only restart the clip. */
const MIN_REPLAY_GAP_MS = 2_000;

const EMPTY_QUEUE: readonly Order[] = Object.freeze([]) as readonly Order[];

interface SeenOrder {
  firstSeenAt: number;
  escalated: boolean;
  order: Order;
}

let config: IncomingOrderAlertLoopConfig = { enabled: true, orderFilter: undefined, view: 'unknown' };
let holders = 0;
let teardown: (() => void) | null = null;
let queue: readonly Order[] = EMPTY_QUEUE;
const queueListeners = new Set<() => void>();
const seen = new Map<string, SeenOrder>();
let headId: string | null = null;

let stopSound: (() => void) | null = null;
let repeatTimer: ReturnType<typeof setTimeout> | null = null;
let loopActive = false;
let lastPlayAt = 0;

/** What staff match the order by: the platform's short code, else our number. */
export function incomingOrderHeadlineNumber(order: Order): string {
  return resolveFoodDeliveryShortCode(order) || getVisibleOrderNumber(order) || String(order?.id ?? '').slice(0, 8);
}

// --- Log -------------------------------------------------------------------

export function logIncomingOrderAlertEvent(
  event: IncomingOrderAlertEvent,
  order: Order,
  extra: Partial<IncomingOrderAlertLogEntry> = {},
): void {
  try {
    const now = Date.now();
    const firstSeenAt = seen.get(order.id)?.firstSeenAt ?? now;
    let orderNumber: string | null = null;
    try {
      orderNumber = incomingOrderHeadlineNumber(order);
    } catch {
      orderNumber = null;
    }
    let platform: string | null = null;
    try {
      platform = getOrderPluginId(order);
    } catch {
      platform = null;
    }
    recordIncomingOrderAlertEvent({
      at: new Date(now).toISOString(),
      event,
      orderId: String(order?.id ?? ''),
      orderNumber,
      platform,
      view: config.view,
      waitedMs: Math.max(0, now - firstSeenAt),
      pendingCount: queue.length,
      audioEnabled: safeAudioEnabled(),
      ...extra,
    });
  } catch (error) {
    console.warn('[IncomingOrderAlert] could not log an alert event', error);
  }
}

// --- Sound -----------------------------------------------------------------

function safeAudioEnabled(): boolean {
  try {
    return isAppAudioEnabled();
  } catch {
    return false;
  }
}

function clearRepeatTimer(): void {
  if (repeatTimer !== null) {
    clearTimeout(repeatTimer);
    repeatTimer = null;
  }
}

function stopCurrentSound(): void {
  const stop = stopSound;
  stopSound = null;
  try {
    stop?.();
  } catch {
    // A sound that cannot stop is already gone.
  }
}

function playAlertOnce(): void {
  stopCurrentSound();
  if (!safeAudioEnabled()) return;
  lastPlayAt = Date.now();
  try {
    // playSelectedPlatformSound keeps the one stop handle through its whole
    // fallback chain (selected clip -> default clip -> tones).
    stopSound = playSelectedPlatformSound({
      volume: 0.9,
      onFallbackToTones: () => playAppAudioTones([{ frequency: 880, start: 0, duration: 0.45 }], 0.18),
    });
  } catch (error) {
    console.warn('[IncomingOrderAlert] the alert sound could not start', error);
  }
}

function stopLoop(): void {
  loopActive = false;
  clearRepeatTimer();
  stopCurrentSound();
}

function restartLoop(): void {
  clearRepeatTimer();
  loopActive = true;
  const tick = () => {
    if (!loopActive) return;
    playAlertOnce();
    repeatTimer = setTimeout(tick, INCOMING_ORDER_ALERT_REPEAT_MS);
  };
  tick();
}

/**
 * The watchdog escalated: ring again now (unless the alert just played) and
 * keep the 30 s rhythm from here.
 */
export function ringIncomingOrderAlertAgain(): void {
  if (queue.length === 0 || !safeAudioEnabled()) return;
  if (Date.now() - lastPlayAt < MIN_REPLAY_GAP_MS) return;
  restartLoop();
}

// --- Queue -----------------------------------------------------------------

function computeQueue(): readonly Order[] {
  if (!config.enabled) return EMPTY_QUEUE;
  let pending: unknown;
  try {
    pending = useOrderStore.getState().pendingExternalOrders;
  } catch (error) {
    console.warn('[IncomingOrderAlert] could not read the order store', error);
    return queue;
  }
  if (!Array.isArray(pending) || pending.length === 0) return EMPTY_QUEUE;
  const filter = config.orderFilter;
  const next = (pending as Order[]).filter((order) => {
    if (!order || typeof order.id !== 'string' || !order.id) return false;
    if (!filter) return true;
    try {
      return filter(order);
    } catch (error) {
      // An order the filter cannot read still rings: a missed order costs
      // more than one alert too many.
      console.warn('[IncomingOrderAlert] order filter failed; alerting for the order', error);
      return true;
    }
  });
  return next.length === 0 ? EMPTY_QUEUE : next;
}

function sameQueue(left: readonly Order[], right: readonly Order[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((order, index) => order === right[index]);
}

function notifyQueueListeners(): void {
  for (const listener of [...queueListeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[IncomingOrderAlert] queue listener failed', error);
    }
  }
}

function applyQueueChange(): void {
  const now = Date.now();
  const queuedIds = new Set(queue.map((order) => order.id));
  let arrived = false;

  for (const order of queue) {
    const known = seen.get(order.id);
    if (known) {
      known.order = order;
      continue;
    }
    arrived = true;
    seen.set(order.id, { firstSeenAt: now, escalated: false, order });
    logIncomingOrderAlertEvent('alerting', order);
  }
  for (const [orderId, info] of Array.from(seen.entries())) {
    if (queuedIds.has(orderId)) continue;
    logIncomingOrderAlertEvent('resolved', info.order, { escalated: info.escalated });
    seen.delete(orderId);
  }

  const nextHeadId = queue[0]?.id ?? null;
  const headChanged = nextHeadId !== headId;
  headId = nextHeadId;

  if (queue.length === 0 || !safeAudioEnabled()) {
    stopLoop();
    return;
  }
  if (arrived || headChanged || !loopActive) {
    restartLoop();
  }
}

function refresh(): void {
  const next = computeQueue();
  if (!config.enabled && seen.size > 0) {
    // Switched off (a waiter terminal): forget silently, nothing was answered.
    seen.clear();
    headId = null;
  }
  if (sameQueue(next, queue)) {
    return;
  }
  queue = next;
  try {
    applyQueueChange();
  } catch (error) {
    console.error('[IncomingOrderAlert] alert loop update failed', error);
  }
  notifyQueueListeners();
}

function onAudioSettingChanged(): void {
  if (queue.length === 0) return;
  if (!safeAudioEnabled()) {
    stopLoop();
  } else if (!loopActive) {
    restartLoop();
  }
}

// --- Lifecycle --------------------------------------------------------------

function install(): () => void {
  const unsubscribeStore = useOrderStore.subscribe((state: any, previous: any) => {
    if (state?.pendingExternalOrders !== previous?.pendingExternalOrders) refresh();
  });

  // The app audio preference is loaded while someone listens; the loop is
  // that listener even when no settings screen is open.
  const unsubscribeAudio = subscribeAppAudio(onAudioSettingChanged);

  // The order store's event listeners are installed by initializeOrders(),
  // which only the dashboards used to call; call it here too (idempotent) so
  // a register that starts on another page still hears `order-created`.
  const { initializeOrders } = useOrderStore.getState() as { initializeOrders?: () => Promise<void> | void };
  if (typeof initializeOrders === 'function') {
    Promise.resolve()
      .then(() => initializeOrders())
      .catch((error: unknown) => {
        console.warn('[IncomingOrderAlert] order store initialisation failed; the sync-tick refresh keeps trying', error);
      });
  }

  // Safety net: re-read the local cache after a Rust sync tick (the pull
  // that materialises platform orders), at most once per
  // INCOMING_ORDER_SAFETY_REFRESH_MS. A missed event cannot hide a pulled
  // order for longer, and there is still no renderer polling loop.
  let lastRefreshAt = Date.now();
  const refreshAfterSyncTick = () => {
    const now = Date.now();
    if (now - lastRefreshAt < INCOMING_ORDER_SAFETY_REFRESH_MS) return;
    lastRefreshAt = now;
    const { silentRefresh } = useOrderStore.getState() as { silentRefresh?: () => Promise<void> };
    if (typeof silentRefresh === 'function') {
      void Promise.resolve()
        .then(() => silentRefresh())
        .catch(() => {});
    }
  };
  onEvent('sync:status', refreshAfterSyncTick);

  refresh();

  return () => {
    offEvent('sync:status', refreshAfterSyncTick);
    try {
      unsubscribeStore();
    } catch {
      // already gone
    }
    unsubscribeAudio();
    stopLoop();
    seen.clear();
    headId = null;
    if (queue !== EMPTY_QUEUE) {
      queue = EMPTY_QUEUE;
      notifyQueueListeners();
    }
  };
}

/**
 * Start the loop (reference-counted); the returned function releases this
 * holder. The loop stops when the last holder releases it.
 */
export function startIncomingOrderAlertLoop(): () => void {
  holders += 1;
  if (holders === 1) {
    teardown = install();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0 && teardown) {
      const stop = teardown;
      teardown = null;
      stop();
    }
  };
}

export function configureIncomingOrderAlertLoop(patch: Partial<IncomingOrderAlertLoopConfig>): void {
  const next = { ...config, ...patch };
  const scopeChanged = next.enabled !== config.enabled || next.orderFilter !== config.orderFilter;
  config = next;
  if (scopeChanged && teardown) refresh();
}

export function getIncomingOrderAlertQueue(): readonly Order[] {
  return queue;
}

export function subscribeIncomingOrderAlertQueue(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

/** The orders waiting for this register's accept / decline, oldest first. */
export function useIncomingOrderAlertQueue(): readonly Order[] {
  return useSyncExternalStore(subscribeIncomingOrderAlertQueue, getIncomingOrderAlertQueue, getIncomingOrderAlertQueue);
}

/** The watchdog fired for these orders (their «resolved» entry says so). */
export function markIncomingOrdersEscalated(orderIds: readonly string[]): void {
  for (const orderId of orderIds) {
    const info = seen.get(orderId);
    if (info) info.escalated = true;
  }
}

/** When this register first saw the order waiting (for the log). */
export function getIncomingOrderFirstSeenAt(orderId: string): number | null {
  return seen.get(orderId)?.firstSeenAt ?? null;
}

/** Test-only: stop everything and forget all state. */
export function __resetIncomingOrderAlertLoopForTests(): void {
  const stop = teardown;
  teardown = null;
  holders = 0;
  stop?.();
  stopLoop();
  seen.clear();
  headId = null;
  queue = EMPTY_QUEUE;
  lastPlayAt = 0;
  config = { enabled: true, orderFilter: undefined, view: 'unknown' };
  notifyQueueListeners();
}
