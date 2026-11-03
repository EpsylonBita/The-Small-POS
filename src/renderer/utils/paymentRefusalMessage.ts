type Translate = (key: string, options?: Record<string, unknown>) => unknown;

const PAYMENT_REFUSALS: Record<string, string> = {
  PAYMENT_INVALID_REQUEST: 'invalidRequest',
  PAYMENT_ORDER_NOT_FOUND: 'orderNotFound',
  PAYMENT_GHOST_ORDER: 'ghostOrder',
  PAYMENT_COLLECTOR_SHIFT_REQUIRED: 'collectorShiftRequired',
  PAYMENT_COLLECTOR_NOT_DRAWER_OWNER: 'collectorNotDrawerOwner',
  PAYMENT_DRIVER_EARNING_REQUIRED: 'driverEarningRequired',
  EDIT_LOCAL_STORAGE_BUSY: 'storageBusy',
  EDIT_LOCAL_STORAGE_LOCKED: 'storageBusy',
  EDIT_LOCAL_STORAGE_CONSTRAINT: 'storageConstraint',
  EDIT_LOCAL_STORAGE_IO: 'storageIo',
  EDIT_LOCAL_STORAGE_OTHER: 'storageOther',
};

/** General payment guidance; null leaves the caller's existing fallback intact. */
export function paymentRefusalMessage(error: unknown, t: Translate): string | null {
  const text = typeof error === 'string' ? error
    : error instanceof Error ? error.message
      : typeof (error as { message?: unknown } | null)?.message === 'string'
        ? (error as { message: string }).message : '';
  for (const code of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const key = Object.prototype.hasOwnProperty.call(PAYMENT_REFUSALS, code) ? PAYMENT_REFUSALS[code] : null;
    if (key) return String(t(`modals.payment.refusals.${key}`));
  }
  return null;
}
