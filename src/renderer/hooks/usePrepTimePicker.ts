/**
 * The accept window's preparation-time choices, kept live against the
 * order's platform pickup window (founder decision, 01/10/2026: show the
 * limit, lock the longer choices; the default stays 20′).
 *
 * The rules are shared with POSSystemMobile (shared/pickup-window.ts); this
 * hook only keeps the clock moving while a window applies (the maximum
 * shrinks) and reads it again at the moment of accepting.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  buildPrepTimePicker,
  PICKUP_WINDOW_REFRESH_MS,
  readPickupWindow,
  type PrepTimePicker,
} from '../../../../shared/pickup-window';

export interface UsePrepTimePickerResult {
  picker: PrepTimePicker;
  /** The minutes to send if the order is accepted right now. */
  minutesToSend: () => number;
}

export function usePrepTimePicker(params: {
  /** The order's ghost_metadata (object, or the JSON string SQLite keeps). */
  ghostMetadata: unknown;
  options: readonly number[];
  defaultMinutes: number;
  /** What staff picked; null keeps the default. */
  selected: number | null;
}): UsePrepTimePickerResult {
  const { ghostMetadata, options, defaultMinutes, selected } = params;
  const pickupWindow = useMemo(() => readPickupWindow(ghostMetadata), [ghostMetadata]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pickupWindow) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), PICKUP_WINDOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, [pickupWindow]);

  const picker = useMemo(
    () => buildPrepTimePicker({ options, defaultMinutes, selected, window: pickupWindow, now }),
    [options, defaultMinutes, selected, pickupWindow, now],
  );
  const minutesToSend = useCallback(
    () => buildPrepTimePicker({ options, defaultMinutes, selected, window: pickupWindow, now: Date.now() }).selected,
    [options, defaultMinutes, selected, pickupWindow],
  );
  return { picker, minutesToSend };
}
