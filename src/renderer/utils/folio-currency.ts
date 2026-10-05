/** A folio retains its original unit. Current store settings only admit NEW charges. */
export function recordedFolioCurrency(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}
export function canChargeFolio(folioCurrency: unknown, storeCurrency: string | null): boolean {
  return Boolean(storeCurrency && recordedFolioCurrency(folioCurrency) === storeCurrency);
}
export function commonFolioCurrency(folios: ReadonlyArray<{ currency?: string | null }>): string | null {
  if (!folios.length) return null;
  const first = recordedFolioCurrency(folios[0].currency);
  return first && folios.every(folio => recordedFolioCurrency(folio.currency) === first) ? first : null;
}

/** Freeze with the order metadata so the native SQLite row/outbox retains it.
 * Existing frozen snapshots never resolve against a later store setting.
 */
export function freezeRoomChargeCurrency(input: {
  metadata?: unknown; currency?: unknown; storeCurrency: string | null;
  roomId: string | null;
}): { currency: string; metadata: Record<string, unknown> } {
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata as Record<string, unknown> : {};
  const prior = metadata.room_charge && typeof metadata.room_charge === 'object'
    ? metadata.room_charge as Record<string, unknown> : null;
  const retained = recordedFolioCurrency(prior?.currency);
  const explicit = recordedFolioCurrency(input.currency);
  if (prior && !retained) throw new Error('FOLIO_CURRENCY_UNAVAILABLE');
  if (retained) {
    if (explicit && explicit !== retained) throw new Error('FOLIO_CURRENCY_MISMATCH');
    if (prior?.room_id && prior.room_id !== input.roomId) throw new Error('FOLIO_ROOM_MISMATCH');
    return { currency: retained, metadata };
  }
  if (!input.storeCurrency) throw new Error('FOLIO_CURRENCY_UNAVAILABLE');
  if (input.currency != null && explicit !== input.storeCurrency) throw new Error('FOLIO_CURRENCY_MISMATCH');
  return { currency: input.storeCurrency, metadata: {
    ...metadata, room_charge: { currency: input.storeCurrency, room_id: input.roomId },
  } };
}
