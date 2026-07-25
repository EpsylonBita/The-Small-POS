export interface DriverReturnInput {
  openingAmount: number;
  cashCollected: number;
  expenses: number;
  tipsReceived?: number;
}

export function calculateDriverReturn({
  openingAmount,
  cashCollected,
  expenses,
  tipsReceived = 0,
}: DriverReturnInput): number {
  return Math.round((openingAmount + cashCollected - expenses - tipsReceived) * 100) / 100;
}
