export interface SatelliteHandoverInput {
  branchId: string;
  terminalId: string;
  satelliteShiftId: string;
  openingCash: number;
  countedCash: number;
  currency: string;
  closedBy?: string | null;
}

/** Native owns the durable intent, server confirmation and exactly-once drawer credit. */
export async function submitSatelliteHandover(
  shifts: { recordSatelliteHandover(input: SatelliteHandoverInput): Promise<unknown> },
  input: SatelliteHandoverInput,
): Promise<{ status: 'pending' } | { status: 'applied'; currency: string; expected: number; counted: number; variance: number }> {
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('SHIFT_CURRENCY_UNAVAILABLE');
  const response = await shifts.recordSatelliteHandover(input) as any;
  const outcome = response?.data ?? response;
  if (outcome?.success === true && outcome.applied === true) {
    const proof = outcome.handover;
    const expected = proof?.expected_cash_cents;
    const counted = proof?.counted_cash_cents;
    const variance = proof?.cash_variance_cents;
    if (proof?.currency !== input.currency || ![expected,counted,variance].every(Number.isSafeInteger)
      || counted !== Math.round(input.countedCash * 100) || counted - expected !== variance) {
      throw new Error('HANDOVER_CONFIRMATION_REQUIRED');
    }
    return {status:'applied',currency:proof.currency,expected:expected/100,counted:counted/100,variance:variance/100};
  }
  if (outcome?.success === true && outcome.pending === true) return { status: 'pending' };
  throw new Error(outcome?.error || 'HANDOVER_CONFIRMATION_REQUIRED');
}
