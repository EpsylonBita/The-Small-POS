import React, { createContext, useContext } from 'react';

export const CashierGateContext = createContext(false);
export const CashierRecoveryContext = createContext(false);
export const useCashierOperationsLocked = () => useContext(CashierGateContext);
export function CashierRecovery({ children }: { children: React.ReactNode }) {
  return <CashierRecoveryContext.Provider value={true}>{children}</CashierRecoveryContext.Provider>;
}
