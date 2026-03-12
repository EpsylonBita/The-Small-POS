/**
 * useLoyaltyReader Hook
 *
 * Handles NFC/RFID loyalty card reader events.
 * Subscribes to `loyalty_card_scanned` Tauri events emitted by the Rust backend.
 *
 * For keyboard-wedge NFC readers: also processes card UIDs that come through
 * as rapid keystrokes (similar to barcode scanners but with hex UIDs).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getBridge } from '../../lib';

export interface LoyaltyCard {
  uid: string;
  timestamp: string;
}

export interface LoyaltyReaderState {
  connected: boolean;
  lastCard: LoyaltyCard | null;
  error: string | null;
}

export interface UseLoyaltyReader {
  state: LoyaltyReaderState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  processCard: (uid: string) => Promise<void>;
  clearLastCard: () => void;
}

const bridge = getBridge();
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function useLoyaltyReader(
  autoStart = false,
  onCardScanned?: (card: LoyaltyCard) => void
): UseLoyaltyReader {
  const [state, setState] = useState<LoyaltyReaderState>({
    connected: false,
    lastCard: null,
    error: null,
  });

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const onCardRef = useRef(onCardScanned);

  useEffect(() => {
    onCardRef.current = onCardScanned;
  }, [onCardScanned]);

  // Subscribe to loyalty_card_scanned events
  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        const unlisten = await listen<LoyaltyCard>('loyalty_card_scanned', (event) => {
          if (mounted) {
            setState((prev) => ({
              ...prev,
              lastCard: event.payload,
            }));
            if (onCardRef.current) {
              onCardRef.current(event.payload);
            }
          }
        });
        unlistenRef.current = unlisten;
      } catch (e) {
        console.warn('[useLoyaltyReader] Failed to listen for card events:', e);
      }
    };

    setup();

    return () => {
      mounted = false;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

  // Auto-start
  useEffect(() => {
    if (autoStart) {
      bridge.hardware.loyaltyReaderStart()
        .then(() => setState((prev) => ({ ...prev, connected: true })))
        .catch((e) => console.warn('[useLoyaltyReader] Auto-start failed:', e));
    }
  }, [autoStart]);

  const start = useCallback(async () => {
    try {
      setState((prev) => ({ ...prev, error: null }));
      await bridge.hardware.loyaltyReaderStart();
      setState((prev) => ({ ...prev, connected: true }));
    } catch (e) {
      setState((prev) => ({ ...prev, error: getErrorMessage(e) }));
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await bridge.hardware.loyaltyReaderStop();
      setState((prev) => ({ ...prev, connected: false }));
    } catch (e) {
      setState((prev) => ({ ...prev, error: getErrorMessage(e) }));
    }
  }, []);

  const processCard = useCallback(async (uid: string) => {
    try {
      await bridge.hardware.loyaltyProcessCard(uid);
    } catch (e) {
      console.warn('[useLoyaltyReader] processCard failed:', e);
    }
  }, []);

  const clearLastCard = useCallback(() => {
    setState((prev) => ({ ...prev, lastCard: null }));
  }, []);

  return { state, start, stop, processCard, clearLastCard };
}

export default useLoyaltyReader;
