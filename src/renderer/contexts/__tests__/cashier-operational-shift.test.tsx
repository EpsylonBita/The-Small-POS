import React from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CashierGateContext, CashierWaiterContext, useCashierOperationsLocked, useOperationalShift } from '../cashier-gate-context';

afterEach(cleanup);

describe('cashier day ownership for operational admission', () => {
  const wrapper = (locked: boolean, waiter = false) => ({ children }: { children: React.ReactNode }) => (
    <CashierWaiterContext.Provider value={waiter}>
      <CashierGateContext.Provider value={locked}>{children}</CashierGateContext.Provider>
    </CashierWaiterContext.Provider>
  );

  it('keeps main-terminal admission open through personal shift restoration', () => {
    const hook = renderHook(({ active }) => useOperationalShift(active), {
      initialProps: { active: true }, wrapper: wrapper(false),
    });
    hook.rerender({ active: false });
    expect(hook.result.current).toBe(true);
    hook.rerender({ active: true });
    expect(hook.result.current).toBe(true);
  });

  it.each([false, true])('blocks a closed root day despite an active personal shift (waiter=%s)', waiter => {
    const hook = renderHook(() => useOperationalShift(true), { wrapper: wrapper(true, waiter) });
    expect(hook.result.current).toBe(false);
  });

  it.each([false, true])('still requires the waiter personal shift (active=%s)', active => {
    const hook = renderHook(() => useOperationalShift(active), { wrapper: wrapper(false, true) });
    expect(hook.result.current).toBe(active);
  });

  it.each([false, true])('preserves standalone personal admission without a root owner (active=%s)', active => {
    const hook = renderHook(() => ({ active: useOperationalShift(active), locked: useCashierOperationsLocked() }));
    expect(hook.result.current).toEqual({ active, locked: false });
  });
});
