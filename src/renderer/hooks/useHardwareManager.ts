/**
 * useHardwareManager Hook
 *
 * Aggregates all peripheral device status and provides centralized
 * control for hardware management.
 *
 * Used in System Health / Diagnostics pages.
 */

import { useState, useEffect, useCallback } from 'react';
import { getBridge, isBrowser, offEvent, onEvent } from '../../lib';

export interface PeripheralStatus {
  connected: boolean;
  [key: string]: any;
}

export interface HardwareStatus {
  scale: PeripheralStatus;
  customerDisplay: PeripheralStatus;
  serialScanner: PeripheralStatus;
  loyaltyReader: PeripheralStatus;
}

export interface UseHardwareManager {
  status: HardwareStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  reconnect: (deviceType: string) => Promise<void>;
}

const DEFAULT_STATUS: HardwareStatus = {
  scale: { connected: false },
  customerDisplay: { connected: false },
  serialScanner: { connected: false },
  loyaltyReader: { connected: false },
};

export function useHardwareManager(autoRefresh = false, intervalMs = 30000): UseHardwareManager {
  const bridge = getBridge();
  const [status, setStatus] = useState<HardwareStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (isBrowser()) {
      setStatus(DEFAULT_STATUS);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const result = (await bridge.invoke('hardware:get-status')) as HardwareStatus;
      setStatus(result || DEFAULT_STATUS);
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus(DEFAULT_STATUS);
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  const reconnect = useCallback(async (deviceType: string) => {
    try {
      setError(null);
      await bridge.invoke('hardware:reconnect', deviceType);
      // Refresh status after reconnect
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [bridge, refresh]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh from backend events; no renderer polling timer.
  useEffect(() => {
    if (!autoRefresh) return;

    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncRefreshAt = Date.now();

    const scheduleRefresh = (delayMs = 250, force = false) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (!force) {
          const now = Date.now();
          if (now - lastSyncRefreshAt < intervalMs) {
            return;
          }
          lastSyncRefreshAt = now;
        }
        void refresh();
      }, delayMs);
    };

    const handleSyncStatus = () => {
      scheduleRefresh(300, false);
    };

    const handleSyncComplete = () => {
      scheduleRefresh(200, false);
    };

    const handleHardwareConfigUpdate = () => {
      scheduleRefresh(150, true);
    };

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleSyncComplete);
    onEvent('hardware-config:update', handleHardwareConfigUpdate);
    onEvent('terminal-config-updated', handleHardwareConfigUpdate);

    return () => {
      disposed = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleSyncComplete);
      offEvent('hardware-config:update', handleHardwareConfigUpdate);
      offEvent('terminal-config-updated', handleHardwareConfigUpdate);
    };
  }, [autoRefresh, intervalMs, refresh]);

  return { status, loading, error, refresh, reconnect };
}

export default useHardwareManager;
