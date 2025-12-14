/**
 * Barcode Scanner Context
 * 
 * Provides app-wide barcode scanner detection.
 * Allows any component to subscribe to barcode scan events.
 */

import React, { createContext, useContext, useCallback, useState, useEffect, useRef } from 'react';
import { useBarcodeScanner, BarcodeScannerState } from '../hooks/useBarcodeScanner';

interface BarcodeScannerContextValue {
  /** Current scanner state */
  state: BarcodeScannerState;
  /** Whether the scanner is enabled */
  enabled: boolean;
  /** Enable/disable the scanner */
  setEnabled: (enabled: boolean) => void;
  /** Subscribe to scan events, returns unsubscribe function */
  subscribe: (callback: (barcode: string) => void) => () => void;
  /** Clear the last barcode */
  clearLastBarcode: () => void;
  /** Simulate a barcode scan (for testing) */
  simulateScan: (barcode: string) => void;
  /** Reset scan count */
  resetScanCount: () => void;
}

const BarcodeScannerContext = createContext<BarcodeScannerContextValue | null>(null);

interface BarcodeScannerProviderProps {
  children: React.ReactNode;
  /** Default enabled state */
  defaultEnabled?: boolean;
  /** Maximum time between keystrokes (ms) */
  maxKeystrokeDelay?: number;
  /** Minimum barcode length */
  minBarcodeLength?: number;
}

export const BarcodeScannerProvider: React.FC<BarcodeScannerProviderProps> = ({
  children,
  defaultEnabled = true,
  maxKeystrokeDelay = 50,
  minBarcodeLength = 3,
}) => {
  const [enabled, setEnabled] = useState(defaultEnabled);
  const subscribersRef = useRef<Set<(barcode: string) => void>>(new Set());

  // Callback when barcode is scanned
  const handleScan = useCallback((barcode: string) => {
    console.log('[BarcodeScannerContext] Broadcasting barcode to', subscribersRef.current.size, 'subscribers');
    subscribersRef.current.forEach(callback => {
      try {
        callback(barcode);
      } catch (error) {
        console.error('[BarcodeScannerContext] Subscriber error:', error);
      }
    });
  }, []);

  const { state, clearLastBarcode, simulateScan, resetScanCount } = useBarcodeScanner({
    enabled,
    maxKeystrokeDelay,
    minBarcodeLength,
    onScan: handleScan,
  });

  // Subscribe function
  const subscribe = useCallback((callback: (barcode: string) => void) => {
    subscribersRef.current.add(callback);
    console.log('[BarcodeScannerContext] Subscriber added, total:', subscribersRef.current.size);
    
    return () => {
      subscribersRef.current.delete(callback);
      console.log('[BarcodeScannerContext] Subscriber removed, total:', subscribersRef.current.size);
    };
  }, []);

  const value: BarcodeScannerContextValue = {
    state,
    enabled,
    setEnabled,
    subscribe,
    clearLastBarcode,
    simulateScan,
    resetScanCount,
  };

  return (
    <BarcodeScannerContext.Provider value={value}>
      {children}
    </BarcodeScannerContext.Provider>
  );
};

/**
 * Hook to access barcode scanner context
 */
export function useBarcodeScannerContext(): BarcodeScannerContextValue {
  const context = useContext(BarcodeScannerContext);
  if (!context) {
    throw new Error('useBarcodeScannerContext must be used within BarcodeScannerProvider');
  }
  return context;
}

/**
 * Hook to subscribe to barcode scans
 * Automatically unsubscribes on unmount
 */
export function useOnBarcodeScan(callback: (barcode: string) => void, deps: any[] = []): void {
  const { subscribe } = useBarcodeScannerContext();
  const callbackRef = useRef(callback);

  // Update callback ref when callback changes
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback, ...deps]);

  useEffect(() => {
    const wrappedCallback = (barcode: string) => {
      callbackRef.current(barcode);
    };
    
    const unsubscribe = subscribe(wrappedCallback);
    return unsubscribe;
  }, [subscribe]);
}

export default BarcodeScannerContext;

