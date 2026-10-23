/**
 * The till's own connectivity check, as the native side last reported it.
 *
 * The native sync loop probes `GET /api/health` every cycle and emits
 * `network_status` (`network:status` in the renderer), with hysteresis: it
 * reports offline only after two failed probes in a row. `navigator.onLine`
 * only says the network card has a link. It stays true through an ISP outage
 * while the shop's router is up (offline week audit, 21/10/2026).
 *
 * Passive: this module only listens. It never makes a network call of its own.
 */
import { offEvent, onEvent } from '../../lib';

export const NATIVE_NETWORK_STATUS_EVENT = 'network:status';

export type ServerReachabilityListener = (reachable: boolean, previous: boolean | null) => void;

let lastReachable: boolean | null = null;
let installed = false;
const listeners = new Set<ServerReachabilityListener>();

function handleNativeNetworkStatus(payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const isOnline = (payload as { isOnline?: unknown }).isOnline;
  if (typeof isOnline !== 'boolean') {
    return;
  }
  const previous = lastReachable;
  lastReachable = isOnline;
  for (const listener of [...listeners]) {
    try {
      listener(isOnline, previous);
    } catch {
      // One listener cannot keep the others from hearing the change.
    }
  }
}

function ensureInstalled(): void {
  if (installed) {
    return;
  }
  try {
    onEvent(NATIVE_NETWORK_STATUS_EVENT, handleNativeNetworkStatus);
    installed = true;
  } catch {
    // No event bridge (a test double without one): the verdict stays unknown.
  }
}

function browserReportsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** The last native verdict: true reachable, false unreachable, null not reported yet. */
export function getServerReachable(): boolean | null {
  ensureInstalled();
  return lastReachable;
}

/**
 * True when the till knows it cannot reach the admin server: the browser has
 * no network, or the till's own check says the server is unreachable.
 */
export function isTillKnownOffline(): boolean {
  return browserReportsOffline() || getServerReachable() === false;
}

/**
 * True only when the till's own check says the admin server is reachable. A
 * link on the network card (`navigator.onLine`) alone is not enough.
 */
export function isServerConfirmedReachable(): boolean {
  return !browserReportsOffline() && getServerReachable() === true;
}

export function subscribeServerReachability(listener: ServerReachabilityListener): () => void {
  ensureInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Calls `onRestored` when connectivity comes back: the browser `online`
 * event, or the till's own check turning reachable after it said unreachable.
 * The native loop reports every cycle, so only that transition counts.
 */
export function subscribeConnectivityRestored(onRestored: () => void): () => void {
  const unsubscribeNative = subscribeServerReachability((reachable, previous) => {
    if (reachable && previous === false) {
      onRestored();
    }
  });
  const handleOnline = () => {
    onRestored();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline);
  }
  return () => {
    unsubscribeNative();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
    }
  };
}

/** Tests only: forget the last verdict and every subscriber. */
export function resetServerReachabilityForTests(): void {
  if (installed) {
    try {
      offEvent(NATIVE_NETWORK_STATUS_EVENT, handleNativeNetworkStatus);
    } catch {
      // Nothing to detach from.
    }
  }
  installed = false;
  lastReachable = null;
  listeners.clear();
}
