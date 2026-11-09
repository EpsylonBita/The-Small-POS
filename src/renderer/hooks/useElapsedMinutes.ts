import { useCallback, useSyncExternalStore } from 'react';

// Often enough that a card turns within seconds of its minute. Each card re-renders only when its own minute changes.
const TICK_MS = 15000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const notify = () => listeners.forEach((listener) => listener());

// A hidden window slows its timers, and the figure must be right the moment the till is back in front.
const notifyWhenVisible = () => {
  if (document.visibilityState === 'visible') notify();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(notify, TICK_MS);
    document.addEventListener('visibilitychange', notifyWhenVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', notifyWhenVisible);
    }
  };
};

const elapsedMinutesSince = (createdAt: string | null | undefined): number => {
  const createdMs = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  return Number.isFinite(createdMs) ? Math.floor((Date.now() - createdMs) / 60000) : 0;
};

/**
 * Whole minutes since `createdAt`, kept current (founder 06/11/2026: an order stayed at 28m). The order grid and its
 * memoized cards do not render again by themselves, so a figure read on render stands still. One clock serves every
 * card on the screen, so a full grid costs one timer.
 */
export const useElapsedMinutes = (createdAt: string | null | undefined): number => {
  const getSnapshot = useCallback(() => elapsedMinutesSince(createdAt), [createdAt]);
  return useSyncExternalStore(subscribe, getSnapshot);
};
