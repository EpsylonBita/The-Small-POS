/**
 * useCardReader Hook
 *
 * Detects magnetic stripe reader (MSR) card swipes via keyboard-wedge mode.
 * MSR readers inject track data as rapid keystrokes, similar to barcode scanners.
 *
 * Detection: MSR Track 1 starts with '%', Track 2 starts with ';', both end with '?'
 *
 * This hook listens to DOM keydown events and differentiates between
 * barcode scans and card swipes based on prefix/suffix characters.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export interface CardData {
  track1: string | null;
  track2: string | null;
  cardNumber: string | null;
  expiry: string | null;
  holderName: string | null;
  raw: string;
}

export interface CardReaderState {
  lastSwipe: CardData | null;
  isReading: boolean;
  swipeCount: number;
}

export interface CardReaderOptions {
  enabled?: boolean;
  maxKeystrokeDelay?: number;
  onSwipe?: (card: CardData) => void;
}

export interface UseCardReader {
  state: CardReaderState;
  clearLastSwipe: () => void;
  resetSwipeCount: () => void;
}

/**
 * Parse MSR Track 1 data: %B1234567890123456^LASTNAME/FIRSTNAME^2512...?
 */
function parseTrack1(track: string): Partial<CardData> {
  const match = track.match(/%B?(\d{13,19})\^([^/]+)\/([^\\^]+)\^(\d{4})/);
  if (!match) return {};

  return {
    cardNumber: match[1],
    holderName: `${match[3].trim()} ${match[2].trim()}`,
    expiry: `${match[4].substring(2, 4)}/${match[4].substring(0, 2)}`,
  };
}

/**
 * Parse MSR Track 2 data: ;1234567890123456=2512...?
 */
function parseTrack2(track: string): Partial<CardData> {
  const match = track.match(/;(\d{13,19})=(\d{4})/);
  if (!match) return {};

  return {
    cardNumber: match[1],
    expiry: `${match[2].substring(2, 4)}/${match[2].substring(0, 2)}`,
  };
}

export function useCardReader(options: CardReaderOptions = {}): UseCardReader {
  const { enabled = true, maxKeystrokeDelay = 50, onSwipe } = options;

  const [state, setState] = useState<CardReaderState>({
    lastSwipe: null,
    isReading: false,
    swipeCount: 0,
  });

  const bufferRef = useRef<string>('');
  const lastKeystrokeRef = useRef<number>(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const onSwipeRef = useRef(onSwipe);

  useEffect(() => {
    onSwipeRef.current = onSwipe;
  }, [onSwipe]);

  const processSwipe = useCallback((raw: string) => {
    let track1: string | null = null;
    let track2: string | null = null;
    let cardData: Partial<CardData> = {};

    // Detect Track 1 (%...?)
    const t1Match = raw.match(/%[^?]*\?/);
    if (t1Match) {
      track1 = t1Match[0];
      cardData = { ...cardData, ...parseTrack1(track1) };
    }

    // Detect Track 2 (;...?)
    const t2Match = raw.match(/;[^?]*\?/);
    if (t2Match) {
      track2 = t2Match[0];
      cardData = { ...cardData, ...parseTrack2(track2) };
    }

    const card: CardData = {
      track1,
      track2,
      cardNumber: cardData.cardNumber || null,
      expiry: cardData.expiry || null,
      holderName: cardData.holderName || null,
      raw,
    };

    console.log('[CardReader] Card swipe detected:', card.cardNumber ? `****${card.cardNumber.slice(-4)}` : 'unknown');

    setState((prev) => ({
      lastSwipe: card,
      isReading: false,
      swipeCount: prev.swipeCount + 1,
    }));

    if (onSwipeRef.current) {
      onSwipeRef.current(card);
    }
  }, []);

  const clearBuffer = useCallback(() => {
    bufferRef.current = '';
    setState((prev) => ({ ...prev, isReading: false }));
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const now = Date.now();
      const timeSinceLastKey = now - lastKeystrokeRef.current;

      // Check if this could be MSR input (starts with % or ;)
      const isNewSwipe = (event.key === '%' || event.key === ';') && bufferRef.current.length === 0;
      const isMSRInput = bufferRef.current.startsWith('%') || bufferRef.current.startsWith(';');
      const isRapidInput = timeSinceLastKey < maxKeystrokeDelay || bufferRef.current.length === 0;

      // End of swipe (? character followed by Enter)
      if (event.key === 'Enter' && isMSRInput && bufferRef.current.length > 10) {
        event.preventDefault();
        event.stopPropagation();
        processSwipe(bufferRef.current);
        bufferRef.current = '';
        return;
      }

      // ? marks end of track data
      if (event.key === '?' && isMSRInput) {
        bufferRef.current += event.key;
        lastKeystrokeRef.current = now;
        event.preventDefault();
        return;
      }

      // Only accept printable characters for MSR
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (!isRapidInput && !isNewSwipe) {
          clearBuffer();
          return;
        }

        if (isNewSwipe || isMSRInput) {
          bufferRef.current += event.key;
          lastKeystrokeRef.current = now;

          if (bufferRef.current.length >= 3) {
            setState((prev) => ({ ...prev, isReading: true }));
          }

          // Prevent if we're clearly reading a card swipe
          if (isMSRInput && bufferRef.current.length >= 5) {
            event.preventDefault();
            event.stopPropagation();
          }

          // Clear timeout
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(clearBuffer, maxKeystrokeDelay * 5);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });

    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [enabled, maxKeystrokeDelay, processSwipe, clearBuffer]);

  const clearLastSwipe = useCallback(() => {
    setState((prev) => ({ ...prev, lastSwipe: null }));
  }, []);

  const resetSwipeCount = useCallback(() => {
    setState((prev) => ({ ...prev, swipeCount: 0 }));
  }, []);

  return { state, clearLastSwipe, resetSwipeCount };
}

export default useCardReader;
