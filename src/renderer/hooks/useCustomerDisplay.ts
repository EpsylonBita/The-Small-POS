/**
 * useCustomerDisplay Hook
 *
 * Controls the customer-facing display (VFD/LCD pole display).
 * Auto-connects based on terminal settings.
 *
 * Usage: Display item names/prices during order, show total at payment.
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface DisplayState {
  connected: boolean;
  error: string | null;
}

export interface UseCustomerDisplay {
  state: DisplayState;
  connect: (connectionType?: string, target?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  showLine: (line1: string, line2: string) => Promise<void>;
  showItem: (name: string, price: number, qty: number, currency?: string) => Promise<void>;
  showTotal: (subtotal: number, tax: number, total: number, currency?: string) => Promise<void>;
  showWelcome: () => Promise<void>;
  clear: () => Promise<void>;
}

export function useCustomerDisplay(
  autoConnect = false,
  settings?: { customer_display_enabled?: boolean; display_port?: string; display_connection_type?: string }
): UseCustomerDisplay {
  const [state, setState] = useState<DisplayState>({
    connected: false,
    error: null,
  });

  // Auto-connect
  useEffect(() => {
    if (autoConnect && settings?.customer_display_enabled) {
      const connType = settings.display_connection_type || 'serial';
      const target = settings.display_port || 'COM4';

      invoke('display_connect', { arg0: connType, arg1: target })
        .then(() => setState({ connected: true, error: null }))
        .catch((e) => {
          console.warn('[useCustomerDisplay] Auto-connect failed:', e);
          setState({ connected: false, error: String(e) });
        });
    }
  }, [autoConnect, settings?.customer_display_enabled, settings?.display_port, settings?.display_connection_type]);

  const connect = useCallback(async (connectionType?: string, target?: string) => {
    try {
      setState((prev) => ({ ...prev, error: null }));
      await invoke('display_connect', {
        arg0: connectionType || 'serial',
        arg1: target || 'COM4',
      });
      setState({ connected: true, error: null });
    } catch (e: any) {
      setState({ connected: false, error: e?.message || String(e) });
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await invoke('display_disconnect');
      setState({ connected: false, error: null });
    } catch (e: any) {
      setState((prev) => ({ ...prev, error: e?.message || String(e) }));
    }
  }, []);

  const showLine = useCallback(async (line1: string, line2: string) => {
    try {
      await invoke('display_show_line', { arg0: line1, arg1: line2 });
    } catch (e) {
      console.warn('[useCustomerDisplay] showLine failed:', e);
    }
  }, []);

  const showItem = useCallback(async (name: string, price: number, qty: number, currency = '$') => {
    try {
      await invoke('display_show_item', { arg0: name, arg1: price, arg2: qty, arg3: currency });
    } catch (e) {
      console.warn('[useCustomerDisplay] showItem failed:', e);
    }
  }, []);

  const showTotal = useCallback(async (subtotal: number, tax: number, total: number, currency = '$') => {
    try {
      await invoke('display_show_total', { arg0: subtotal, arg1: tax, arg2: total, arg3: currency });
    } catch (e) {
      console.warn('[useCustomerDisplay] showTotal failed:', e);
    }
  }, []);

  const showWelcome = useCallback(async () => {
    try {
      await invoke('display_show_line', { arg0: '   THE SMALL POS', arg1: '    Welcome!' });
    } catch (e) {
      console.warn('[useCustomerDisplay] showWelcome failed:', e);
    }
  }, []);

  const clear = useCallback(async () => {
    try {
      await invoke('display_clear');
    } catch (e) {
      console.warn('[useCustomerDisplay] clear failed:', e);
    }
  }, []);

  return { state, connect, disconnect, showLine, showItem, showTotal, showWelcome, clear };
}

export default useCustomerDisplay;
