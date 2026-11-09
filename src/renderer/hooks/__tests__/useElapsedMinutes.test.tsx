import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useElapsedMinutes } from '../useElapsedMinutes';

const NOW = new Date('2026-11-06T13:10:00.000Z').getTime();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();

describe('useElapsedMinutes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    // Unmount first: the shared clock lives across tests until its last card goes.
    cleanup();
    vi.useRealTimers();
  });

  // Founder 06/11/2026: an active order stayed at 28m until its card was rebuilt.
  it('moves on while the card stays on the screen', () => {
    const { result } = renderHook(() => useElapsedMinutes(minutesAgo(28)));
    expect(result.current).toBe(28);

    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current).toBe(29);
  });

  it('renders a card only when its own minute changes', () => {
    let renders = 0;
    const createdAt = minutesAgo(5);
    renderHook(() => {
      renders += 1;
      return useElapsedMinutes(createdAt);
    });
    const first = renders;

    act(() => {
      vi.advanceTimersByTime(45000);
    });
    expect(renders).toBe(first);

    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(renders).toBe(first + 1);
  });

  it('shares one clock between cards and stops it with the last one', () => {
    const first = renderHook(() => useElapsedMinutes(minutesAgo(1)));
    const second = renderHook(() => useElapsedMinutes(minutesAgo(2)));
    expect(vi.getTimerCount()).toBe(1);

    first.unmount();
    expect(vi.getTimerCount()).toBe(1);

    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is right the moment the window is back in front', () => {
    const { result } = renderHook(() => useElapsedMinutes(minutesAgo(10)));

    vi.setSystemTime(NOW + 30 * 60000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(result.current).toBe(40);
  });

  it('shows zero for an order without a usable time', () => {
    expect(renderHook(() => useElapsedMinutes(null)).result.current).toBe(0);
    expect(renderHook(() => useElapsedMinutes('not a date')).result.current).toBe(0);
  });
});
