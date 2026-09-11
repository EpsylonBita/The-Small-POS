import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIntegrationRefresh } from '../useIntegrationRefresh';

describe('visible integrations refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('deduplicates manual and poll requests, pauses in background and cleans up', async () => {
    let finish: (value: boolean) => void = () => undefined;
    const load = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useIntegrationRefresh('branch-1', load, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    act(() => { void result.current(); vi.advanceTimersByTime(60_000); });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); vi.advanceTimersByTime(60_000); });
    expect(load).toHaveBeenCalledTimes(1);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(load).toHaveBeenCalledTimes(2);
    unmount();
    act(() => { vi.advanceTimersByTime(60_000); window.dispatchEvent(new Event('online')); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidates old scope results and refreshes the new scope after an old request finishes', async () => {
    let finish: (value: boolean) => void = () => undefined;
    let current: () => boolean = () => false;
    const load = vi.fn((isCurrent: () => boolean) => {
      current = isCurrent;
      return new Promise<boolean>(resolve => { finish = resolve; });
    });
    const reset = vi.fn();
    const { rerender } = renderHook(({ scope }) => useIntegrationRefresh(scope, load, reset), { initialProps: { scope: 'old' } });
    await act(async () => { await Promise.resolve(); });
    const oldCurrent = current;
    rerender({ scope: 'new' });
    expect(oldCurrent()).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(current()).toBe(true);
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('recovers a pending scope refresh after blur even when the focus event was missed', async () => {
    let finish: (value: boolean) => void = () => undefined;
    const guards: Array<() => boolean> = [];
    const load = vi.fn((isCurrent: () => boolean) => {
      guards.push(isCurrent);
      return new Promise<boolean>(resolve => { finish = resolve; });
    });
    const { rerender } = renderHook(({ scope }) => useIntegrationRefresh(scope, load, vi.fn()), { initialProps: { scope: 'old' } });
    await act(async () => { await Promise.resolve(); });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); });
    rerender({ scope: 'new' });
    expect(guards[0]?.()).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    // Focus returns while listeners were rebound; no focus event reaches the hook.
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(async () => { finish(true); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(guards[1]?.()).toBe(true);
  });

  it('does not poll a blurred remount, and recovers from current document focus on the next tick', async () => {
    const load = vi.fn(async () => true);
    const first = renderHook(() => useIntegrationRefresh('old', load, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    first.unmount();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    renderHook(() => useIntegrationRefresh('new', load, vi.fn()));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(load).toHaveBeenCalledTimes(1);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
