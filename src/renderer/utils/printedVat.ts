import { computeOwnerConfiguredVat } from '../../../../shared/services/ReceiptVat';

/**
 * The VAT the till shows (founder rule 07/10/2026, `shared/services/ReceiptVat.ts`).
 *
 * Every order now stores its canonical computed VAT in `tax_amount`, but a
 * screen shows only what the customer slip prints: with an active fiscal
 * plugin (or a myDATA fiscal device) the computed VAT, otherwise the VAT of
 * the rate the owner set in Admin → POS settings → Taxes, included in the
 * prices, and nothing when no rate (or 0%) is set. The native order readers
 * resolve that rule and send it as `printedVatAmount`; an order object that
 * does not carry it shows no VAT. Prices always include VAT, so a shown VAT
 * is never added to any total.
 */

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The VAT an order shows, 0 when its slip prints no VAT line. */
export function readPrintedVatAmount(order: unknown): number {
  const source = record(order);
  const raw = source.printedVatAmount ?? source.printed_vat_amount;
  if (raw === null || raw === undefined || raw === '') return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The owner's VAT rate (`tax.default_tax_rate`), null when not set. */
export function readOwnerVatRatePercent(
  getSetting: <T = unknown>(category: string, key: string, defaultValue?: T) => T | undefined,
): number | null {
  const raw = getSetting<number | string | null>('tax', 'default_tax_rate', undefined);
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }
  const rate = Number(raw);
  return Number.isFinite(rate) ? rate : null;
}

/**
 * The VAT a price preview shows for an amount that already includes it: the
 * owner's configured rate, 0 when no rate (or 0%) is set. Never added on top.
 */
export function ownerVatIncludedIn(amountIncludingVat: number, ratePercent: number | null): number {
  return computeOwnerConfiguredVat({ totalAmount: amountIncludingVat, tipAmount: 0, ratePercent }) ?? 0;
}
