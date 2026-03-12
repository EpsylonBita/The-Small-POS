/**
 * useScale Hook
 *
 * Connects to a weighing scale via serial port and provides live weight readings.
 * Auto-connects based on terminal settings (scale_enabled + scale_port).
 *
 * Weight changes are received via Tauri events from the Rust backend.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getBridge } from '../../lib';

export interface ScaleReading {
  weight: number;
  unit: string;
  stable: boolean;
  raw?: string;
  timestamp?: string;
}

export interface ScaleState {
  connected: boolean;
  reading: ScaleReading | null;
  error: string | null;
}

export interface UseScale {
  state: ScaleState;
  connect: (port?: string, baudRate?: number, protocol?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  tare: () => Promise<void>;
  readWeight: () => Promise<ScaleReading | null>;
}

interface ScaleReadWeightResult {
  success?: boolean;
  weight?: number;
  unit?: string;
  stable?: boolean;
  raw?: string;
}

const bridge = getBridge();
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function useScale(
  autoConnect = false,
  settings?: { scale_port?: string; scale_baud_rate?: number; scale_protocol?: string }
): UseScale {
  const [state, setState] = useState<ScaleState>({
    connected: false,
    reading: null,
    error: null,
  });

  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Subscribe to weight change events
  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        const unlisten = await listen<ScaleReading>('scale_weight_changed', (event) => {
          if (mounted) {
            setState((prev) => ({
              ...prev,
              connected: true,
              reading: event.payload,
              error: null,
            }));
          }
        });
        unlistenRef.current = unlisten;
      } catch (e) {
        console.warn('[useScale] Failed to listen for scale events:', e);
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

  // Auto-connect based on settings
  useEffect(() => {
    if (autoConnect && settings?.scale_port) {
      const port = settings.scale_port;
      const baud = settings.scale_baud_rate || 9600;
      const protocol = settings.scale_protocol || 'generic';

      bridge.hardware.scaleConnect({ port, baud, protocol }).catch((e) => {
        console.warn('[useScale] Auto-connect failed:', e);
        setState((prev) => ({ ...prev, error: getErrorMessage(e) }));
      });
    }
  }, [autoConnect, settings?.scale_port, settings?.scale_baud_rate, settings?.scale_protocol]);

  const connect = useCallback(
    async (port?: string, baudRate?: number, protocol?: string) => {
      try {
        setState((prev) => ({ ...prev, error: null }));
        await bridge.hardware.scaleConnect({
          port: port || settings?.scale_port || 'COM3',
          baud: baudRate || settings?.scale_baud_rate || 9600,
          protocol: protocol || settings?.scale_protocol || 'generic',
        });
        setState((prev) => ({ ...prev, connected: true }));
      } catch (e) {
        setState((prev) => ({ ...prev, error: getErrorMessage(e) }));
      }
    },
    [settings]
  );

  const disconnect = useCallback(async () => {
    try {
      await bridge.hardware.scaleDisconnect();
      setState({ connected: false, reading: null, error: null });
    } catch (e) {
      setState((prev) => ({ ...prev, error: getErrorMessage(e) }));
    }
  }, []);

  const tare = useCallback(async () => {
    try {
      await bridge.hardware.scaleTare();
    } catch (e) {
      setState((prev) => ({ ...prev, error: getErrorMessage(e) }));
    }
  }, []);

  const readWeight = useCallback(async (): Promise<ScaleReading | null> => {
    try {
      const result = (await bridge.hardware.scaleReadWeight()) as ScaleReadWeightResult;
      if (result?.success && result.weight !== undefined) {
        return {
          weight: result.weight,
          unit: result.unit || 'kg',
          stable: result.stable ?? true,
          raw: result.raw,
        };
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  return { state, connect, disconnect, tare, readWeight };
}

export default useScale;
