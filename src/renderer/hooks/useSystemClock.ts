import { useEffect, useState } from 'react';

export function useSystemClock(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const syncNow = () => {
      if (!cancelled) {
        setNow(new Date());
      }
    };

    const scheduleNextMinuteUpdate = () => {
      const msUntilNextMinute = Math.max(250, 60000 - (Date.now() % 60000));
      timeoutId = setTimeout(() => {
        syncNow();
        if (!cancelled) {
          scheduleNextMinuteUpdate();
        }
      }, msUntilNextMinute);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncNow();
      }
    };

    scheduleNextMinuteUpdate();
    window.addEventListener('focus', syncNow);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      window.removeEventListener('focus', syncNow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return now;
}
