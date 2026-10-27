import React, { createContext, useContext } from 'react';

export const CashierGateContext = createContext<boolean | null>(null);
export const CashierWaiterContext = createContext(false);
export const CashierRecoveryContext = createContext(false);
export type CashierRecoveryActions = {
  resolving: boolean;
  waiter: boolean;
  pendingZ: boolean;
  checkIn: () => void;
  completeZ: () => void;
  settings: () => void;
  logout: () => void;
};
export const RecoveryActionsContext = createContext<CashierRecoveryActions | null>(null);
/** Gate-owned lifecycle actions, or null outside the global cashier gate. */
export function useCashierRecoveryActions(): Pick<CashierRecoveryActions, 'completeZ' | 'checkIn'> | null {
  return useContext(RecoveryActionsContext);
}
export const useCashierOperationsLocked = () => useContext(CashierGateContext) === true;
/** Body portals escape the operational boundary. Hide them without losing drafts. */
export function useCashierPortalProps() {
  const locked = useCashierOperationsLocked();
  const recovery = useContext(CashierRecoveryContext);
  const hidden = locked && !recovery;
  return {
    inert: hidden || undefined,
    'aria-hidden': hidden || undefined,
    'data-cashier-recovery': recovery ? 'true' as const : undefined,
    style: { visibility: hidden ? 'hidden' as const : undefined },
  };
}
export function useOperationalShift(isShiftActive: boolean): boolean {
  const cashierDayBlocked = useContext(CashierGateContext);
  const isWaiterTerminal = useContext(CashierWaiterContext);
  if (cashierDayBlocked === true) return false;
  if (cashierDayBlocked === false && !isWaiterTerminal) return true;
  return isShiftActive;
}
export function CashierRecovery({ children }: { children: React.ReactNode }) {
  return <CashierRecoveryContext.Provider value={true}>{children}</CashierRecoveryContext.Provider>;
}
