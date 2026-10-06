import React, { createContext, useContext } from 'react';

export const CashierGateContext = createContext<boolean | null>(null);
export const CashierWaiterContext = createContext(false);
export const CashierRecoveryContext = createContext(false);
export const useCashierOperationsLocked = () => useContext(CashierGateContext) === true;
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
