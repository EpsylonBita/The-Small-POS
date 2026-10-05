import { recordedFolioCurrency } from './folio-currency';

/** A computed summary owns the aggregate unit, including an explicit unknown/mixed result. */
export function shiftSummaryCurrency(summary: unknown, shift: unknown): string | null {
  const record = summary ?? shift;
  return record && typeof record === 'object'
    ? recordedFolioCurrency((record as { currency?: unknown }).currency)
    : null;
}
