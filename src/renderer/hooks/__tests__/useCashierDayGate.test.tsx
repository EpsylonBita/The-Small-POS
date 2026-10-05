import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCashierDayGate } from '../useCashierDayGate';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), listeners: new Map<string, (payload?: any) => void>(),
  shift: { id: 'driver', status: 'active', role_type: 'driver' } as any,
  identity: { branchId: 'branch-1', terminalId: 'terminal-1' },
}));
vi.mock('../../contexts/shift-context', () => ({ useShift: () => ({ staff: null, activeShift: mocks.shift }) }));
vi.mock('../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => mocks.identity }));
vi.mock('../../utils/active-cashier', () => ({ resolveActiveCashierShift: mocks.resolve }));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ shifts: { getActiveForBranch: vi.fn() } }),
  onEvent: (event: string, handler: any) => mocks.listeners.set(event, handler),
  offEvent: (event: string) => mocks.listeners.delete(event),
}));
const cashier = { id: 'cashier-1', status: 'active', role_type: 'cashier' };
beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue(cashier);
  mocks.listeners.clear();
  mocks.shift = { id: 'driver', status: 'active', role_type: 'driver' };
  mocks.identity = { branchId: 'branch-1', terminalId: 'terminal-1' };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => cleanup());

describe('useCashierDayGate', () => {
  it('starts locked while restoration is unresolved, even with another staff shift', async () => {
    let finish!: (value: unknown) => void;
    mocks.resolve.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useCashierDayGate());
    expect(result.current.isResolving).toBe(true);
    expect(result.current.isBlocked).toBe(true);
    await act(async () => { finish(null); });
    expect(result.current.isBlocked).toBe(true);
    expect(result.current.isResolving).toBe(false);
  });

  it('last cashier checkout locks immediately despite a remaining driver, and replacement manager unlocks', async () => {
    const { result } = renderHook(() => useCashierDayGate());
    await waitFor(() => expect(result.current.isBlocked).toBe(false));
    mocks.resolve.mockResolvedValue(null);
    await act(async () => { mocks.listeners.get('shift-updated')?.({ status: 'closed', shiftId: cashier.id }); });
    expect(result.current.isBlocked).toBe(true);
    mocks.resolve.mockResolvedValue({ ...cashier, id: 'manager-1', role_type: 'manager' });
    await act(async () => { mocks.listeners.get('shift-updated')?.({ status: 'active' }); });
    expect(result.current.isBlocked).toBe(false);
  });

  it('vetoes just-closed cache through an outage until fresh authoritative replacement is found', async () => {
    mocks.shift = cashier;
    const { result } = renderHook(() => useCashierDayGate());
    await waitFor(() => expect(result.current.isBlocked).toBe(false));
    mocks.resolve.mockImplementation(async params => params.activeShift || null);
    await act(async () => { mocks.listeners.get('shift-updated')?.({ status: 'closed', shiftId: cashier.id }); });
    expect(result.current.isBlocked).toBe(true);
    expect(mocks.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ activeShift: null }));
    await act(async () => { await result.current.recheck(); });
    expect(result.current.isBlocked).toBe(true);
  });

  it('keeps the day open when another cashier remains', async () => {
    const { result } = renderHook(() => useCashierDayGate());
    await waitFor(() => expect(result.current.isBlocked).toBe(false));
    mocks.resolve.mockResolvedValue({ ...cashier, id: 'replacement' });
    await act(async () => { mocks.listeners.get('shift-updated')?.({ status: 'closed', shiftId: cashier.id }); });
    expect(result.current.isBlocked).toBe(false);
  });

  it('routine sync does not mask known-open operations while refreshing', async () => {
    const { result } = renderHook(() => useCashierDayGate());
    await waitFor(() => expect(result.current.isBlocked).toBe(false));
    mocks.resolve.mockImplementation(() => new Promise(() => {}));
    act(() => { mocks.listeners.get('sync:complete')?.(); });
    expect(result.current.isResolving).toBe(false);
    expect(result.current.isBlocked).toBe(false);
  });

  it('fences a stale open response after the newer close response', async () => {
    const { result } = renderHook(() => useCashierDayGate());
    await waitFor(() => expect(result.current.isBlocked).toBe(false));
    let finish!: (value: unknown) => void;
    mocks.resolve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => { mocks.listeners.get('sync:complete')?.(); });
    mocks.resolve.mockResolvedValue(null);
    await act(async () => { mocks.listeners.get('shift-updated')?.({ status: 'closed', shiftId: cashier.id }); });
    await act(async () => { finish(cashier); });
    expect(result.current.isBlocked).toBe(true);
  });

  it('pins waiter checks to the governing parent and removes subscriptions/timer', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() => useCashierDayGate({ isMobileWaiter: true, parentTerminalId: 'main-parent' }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'main-parent' })));
    unmount();
    expect(mocks.listeners.size).toBe(0);
    expect(clear).toHaveBeenCalled();
  });
});
