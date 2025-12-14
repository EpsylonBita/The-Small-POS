/**
 * useBarcodeScanner Hook
 * 
 * Global barcode scanner detection for POS system.
 * Detects rapid keystrokes from barcode scanners (keyboard wedge mode).
 * 
 * Barcode scanners typically:
 * - Type characters very fast (< 50ms between keystrokes)
 * - End with Enter key
 * - Type alphanumeric characters and some special chars
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export interface BarcodeScannerOptions {
  /** Maximum time between keystrokes to be considered a scan (default: 50ms) */
  maxKeystrokeDelay?: number;
  /** Minimum barcode length to be valid (default: 3) */
  minBarcodeLength?: number;
  /** Maximum barcode length (default: 50) */
  maxBarcodeLength?: number;
  /** Callback when a barcode is detected */
  onScan?: (barcode: string) => void;
  /** Whether the scanner is enabled (default: true) */
  enabled?: boolean;
  /** Prefix characters that indicate start of barcode (optional) */
  prefixCharacters?: string[];
  /** Suffix characters that indicate end of barcode (default: ['Enter']) */
  suffixCharacters?: string[];
  /** Whether to prevent default on barcode input (default: true) */
  preventDefault?: boolean;
}

export interface BarcodeScannerState {
  /** Last scanned barcode */
  lastBarcode: string | null;
  /** Whether currently receiving a scan */
  isScanning: boolean;
  /** Timestamp of last scan */
  lastScanTime: number | null;
  /** Number of successful scans in this session */
  scanCount: number;
}

export interface UseBarcodeScanner {
  /** Current scanner state */
  state: BarcodeScannerState;
  /** Clear the last barcode */
  clearLastBarcode: () => void;
  /** Manually trigger a barcode scan (for testing) */
  simulateScan: (barcode: string) => void;
  /** Reset scan count */
  resetScanCount: () => void;
}

/**
 * Hook for detecting barcode scanner input
 * Works with USB barcode scanners in keyboard wedge mode
 */
export function useBarcodeScanner(options: BarcodeScannerOptions = {}): UseBarcodeScanner {
  const {
    maxKeystrokeDelay = 50,
    minBarcodeLength = 3,
    maxBarcodeLength = 50,
    onScan,
    enabled = true,
    suffixCharacters = ['Enter'],
    preventDefault = true,
  } = options;

  const [state, setState] = useState<BarcodeScannerState>({
    lastBarcode: null,
    isScanning: false,
    lastScanTime: null,
    scanCount: 0,
  });

  // Use refs to avoid stale closures
  const bufferRef = useRef<string>('');
  const lastKeystrokeRef = useRef<number>(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const onScanRef = useRef(onScan);

  // Update ref when onScan changes
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  // Process the scanned barcode
  const processBarcode = useCallback((barcode: string) => {
    if (barcode.length >= minBarcodeLength && barcode.length <= maxBarcodeLength) {
      console.log('[BarcodeScanner] Detected barcode:', barcode);
      
      setState(prev => ({
        lastBarcode: barcode,
        isScanning: false,
        lastScanTime: Date.now(),
        scanCount: prev.scanCount + 1,
      }));

      // Call the callback
      if (onScanRef.current) {
        onScanRef.current(barcode);
      }
    } else {
      // Invalid barcode length, reset
      setState(prev => ({ ...prev, isScanning: false }));
    }
    bufferRef.current = '';
  }, [minBarcodeLength, maxBarcodeLength]);

  // Clear buffer after timeout (user is typing normally)
  const clearBuffer = useCallback(() => {
    bufferRef.current = '';
    setState(prev => ({ ...prev, isScanning: false }));
  }, []);

  // Main keydown handler
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const now = Date.now();
      const timeSinceLastKey = now - lastKeystrokeRef.current;

      // Check if this could be a barcode scan (rapid input)
      const isRapidInput = timeSinceLastKey < maxKeystrokeDelay || bufferRef.current.length === 0;

      // Check for suffix (end of barcode)
      if (suffixCharacters.includes(event.key)) {
        if (bufferRef.current.length >= minBarcodeLength && isRapidInput) {
          // This is a barcode scan!
          if (preventDefault) {
            event.preventDefault();
            event.stopPropagation();
          }
          processBarcode(bufferRef.current);
        } else {
          // Not a barcode, clear buffer
          clearBuffer();
        }
        return;
      }

      // Only accept printable characters
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (timeSinceLastKey > maxKeystrokeDelay && bufferRef.current.length > 0) {
          // Too slow, user is typing normally - clear and start fresh
          clearBuffer();
        }

        bufferRef.current += event.key;
        lastKeystrokeRef.current = now;

        // Update scanning state
        if (bufferRef.current.length >= 2) {
          setState(prev => ({ ...prev, isScanning: true }));
        }

        // Clear timeout and set new one
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(clearBuffer, maxKeystrokeDelay * 3);

        // Prevent if we're likely scanning
        if (bufferRef.current.length >= minBarcodeLength && preventDefault) {
          // Check if input is focused - don't prevent if user is in an input
          const activeEl = document.activeElement;
          const isInputFocused = activeEl?.tagName === 'INPUT' || 
                                  activeEl?.tagName === 'TEXTAREA' ||
                                  (activeEl as HTMLElement)?.isContentEditable;
          
          // Only prevent if not in an input field
          if (!isInputFocused) {
            event.preventDefault();
          }
        }
      }
    };

    // Add listener with capture to get events first
    document.addEventListener('keydown', handleKeyDown, { capture: true });

    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [enabled, maxKeystrokeDelay, minBarcodeLength, suffixCharacters, preventDefault, processBarcode, clearBuffer]);

  const clearLastBarcode = useCallback(() => {
    setState(prev => ({ ...prev, lastBarcode: null }));
  }, []);

  const simulateScan = useCallback((barcode: string) => {
    processBarcode(barcode);
  }, [processBarcode]);

  const resetScanCount = useCallback(() => {
    setState(prev => ({ ...prev, scanCount: 0 }));
  }, []);

  return {
    state,
    clearLastBarcode,
    simulateScan,
    resetScanCount,
  };
}

export default useBarcodeScanner;

