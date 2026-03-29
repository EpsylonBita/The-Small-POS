import { useEffect, useRef } from 'react'
import { emitCompatEvent, offEvent, onEvent, type WindowState } from '../../lib'
import {
  getActiveUiBlockers,
  type UiBlockerSnapshot,
} from '../services/uiBlockerRegistry'

const FREEZE_WATCHDOG_EVENT = 'freeze-watchdog:suspected'
const SAMPLE_INTERVAL_MS = 2000
const LAG_THRESHOLD_MS = 1500
const REQUIRED_CONSECUTIVE_BREACHES = 2
const EMISSION_COOLDOWN_MS = 30000
const MAX_SNAPSHOTS = 10

interface FreezeSyncSummary {
  isOnline: boolean
  lastSync: string | null
  pendingItems: number
  queuedRemote: number
  syncInProgress: boolean
  backpressureDeferred: number
  failedPaymentItems: number
  error: string | null
}

export interface FreezeSnapshot {
  timestamp: string
  lagMs: number
  consecutiveBreaches: number
  route: string
  visibilityState: DocumentVisibilityState
  hasFocus: boolean
  navigatorOnline: boolean
  windowState: WindowState
  activeElement: {
    tagName: string | null
    id: string | null
    className: string | null
  }
  sync: FreezeSyncSummary | null
  blockers: UiBlockerSnapshot[]
}

declare global {
  interface Window {
    __POS_FREEZE_WATCHDOG__?: {
      snapshots: FreezeSnapshot[]
      lastSnapshot?: FreezeSnapshot
    }
  }
}

function normalizeSyncSummary(payload: any): FreezeSyncSummary {
  return {
    isOnline:
      typeof payload?.isOnline === 'boolean' ? payload.isOnline : navigator.onLine,
    lastSync:
      typeof payload?.lastSync === 'string'
        ? payload.lastSync
        : typeof payload?.lastSyncAt === 'string'
          ? payload.lastSyncAt
          : null,
    pendingItems:
      typeof payload?.pendingItems === 'number'
        ? payload.pendingItems
        : typeof payload?.pendingChanges === 'number'
          ? payload.pendingChanges
          : 0,
    queuedRemote:
      typeof payload?.queuedRemote === 'number' ? payload.queuedRemote : 0,
    syncInProgress: payload?.syncInProgress === true,
    backpressureDeferred:
      typeof payload?.backpressureDeferred === 'number'
        ? payload.backpressureDeferred
        : 0,
    failedPaymentItems:
      typeof payload?.failedPaymentItems === 'number'
        ? payload.failedPaymentItems
        : 0,
    error: typeof payload?.error === 'string' ? payload.error : null,
  }
}

function readActiveElementSnapshot() {
  const activeElement = document.activeElement as HTMLElement | null

  return {
    tagName: activeElement?.tagName ?? null,
    id: activeElement?.id || null,
    className:
      typeof activeElement?.className === 'string' && activeElement.className.trim()
        ? activeElement.className
        : null,
  }
}

export function useFreezeWatchdog({
  enabled,
  windowState,
}: {
  enabled: boolean
  windowState: WindowState
}): void {
  const syncSummaryRef = useRef<FreezeSyncSummary | null>(null)
  const onlineRef = useRef<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const windowStateRef = useRef(windowState)

  useEffect(() => {
    windowStateRef.current = windowState
  }, [windowState])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return
    }

    const handleSyncStatus = (payload: any) => {
      const normalized = normalizeSyncSummary(payload)
      syncSummaryRef.current = normalized
      onlineRef.current = normalized.isOnline
    }

    const handleNetworkStatus = (payload: any) => {
      if (typeof payload?.isOnline === 'boolean') {
        onlineRef.current = payload.isOnline
      }
    }

    onEvent('sync:status', handleSyncStatus)
    onEvent('network:status', handleNetworkStatus)

    let previousTick = performance.now()
    let consecutiveBreaches = 0
    let lastEmissionAt = 0

    const timer = window.setInterval(() => {
      const now = performance.now()
      const lagMs = Math.max(0, now - previousTick - SAMPLE_INTERVAL_MS)
      previousTick = now

      if (document.visibilityState !== 'visible') {
        consecutiveBreaches = 0
        return
      }

      if (lagMs >= LAG_THRESHOLD_MS) {
        consecutiveBreaches += 1
      } else {
        consecutiveBreaches = 0
        return
      }

      if (consecutiveBreaches < REQUIRED_CONSECUTIVE_BREACHES) {
        return
      }

      const emittedAt = Date.now()
      if (emittedAt - lastEmissionAt < EMISSION_COOLDOWN_MS) {
        return
      }

      lastEmissionAt = emittedAt
      consecutiveBreaches = 0

      const snapshot: FreezeSnapshot = {
        timestamp: new Date(emittedAt).toISOString(),
        lagMs,
        consecutiveBreaches: REQUIRED_CONSECUTIVE_BREACHES,
        route: window.location.hash || '#/',
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        navigatorOnline: onlineRef.current,
        windowState: windowStateRef.current,
        activeElement: readActiveElementSnapshot(),
        sync: syncSummaryRef.current,
        blockers: getActiveUiBlockers(),
      }

      const store = (window.__POS_FREEZE_WATCHDOG__ ??= { snapshots: [] })
      store.lastSnapshot = snapshot
      store.snapshots = [...store.snapshots, snapshot].slice(-MAX_SNAPSHOTS)

      emitCompatEvent(FREEZE_WATCHDOG_EVENT, snapshot)
      console.warn('[FreezeWatchdog] Suspected renderer stall', snapshot)
    }, SAMPLE_INTERVAL_MS)

    return () => {
      window.clearInterval(timer)
      offEvent('sync:status', handleSyncStatus)
      offEvent('network:status', handleNetworkStatus)
    }
  }, [enabled])
}
