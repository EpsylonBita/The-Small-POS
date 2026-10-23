import { calculateGreeceOrderVat, type GreeceOrderVatInput } from '../../../../shared/services/GreeceOrderVat';
import { resolvePrintVatOnReceipt } from '../../../../shared/services/ReceiptVat';
import { settingBoolean, type TerminalSettingReader } from './branchVatSettings';

/**
 * The VAT the till shows (founder rule 21/10/2026, `shared/services/ReceiptVat.ts`).
 *
 * Every order carries ONE VAT, the computed `tax_amount` the server stores and
 * the till adopts; the Z always totals it. A screen shows what the customer
 * slip prints: that VAT when a fiscal plugin is active (or a myDATA fiscal
 * device is set up) or the owner turned on «VAT on receipts», nothing
 * otherwise. The native order readers resolve that rule and send it as
 * `printedVatAmount`; an order object that does not carry it shows no VAT.
 * Prices always include VAT, so a shown VAT is never added to any total, and
 * no screen computes VAT at the owner's rate any more.
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

/** The owner's 07/10 VAT rate (`tax.default_tax_rate`), null when not set. Read only while the switch is missing. */
function readOwnerVatRatePercent(getSetting: TerminalSettingReader): number | null {
  const raw = getSetting<number | string | null>('tax', 'default_tax_rate', undefined);
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }
  const rate = Number(raw);
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Whether this till's slips print VAT without a fiscal plugin: the owner's
 * «VAT on receipts» switch (`tax.vat_print_on_receipt`), else, until the feed
 * delivered it, an owner rate above 0 %. A fiscal plugin also prints it; that
 * verdict is native and already in `printedVatAmount`.
 */
export function readSlipsPrintVat(getSetting: TerminalSettingReader, fiscalActive = false): boolean {
  if (settingBoolean(getSetting<unknown>('tax', 'vat_registered')) === false) return false;
  return fiscalActive || resolvePrintVatOnReceipt({
    printVatOnReceipt: settingBoolean(getSetting<unknown>('tax', 'vat_print_on_receipt')),
    ratePercent: readOwnerVatRatePercent(getSetting),
  });
}

/** The VAT the server will store for an order that is still a cart (prices include it). */
export function previewOrderVat(input: GreeceOrderVatInput): number {
  return calculateGreeceOrderVat(input).taxAmount;
}
