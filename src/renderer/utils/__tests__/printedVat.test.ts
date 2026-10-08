import { describe, expect, it } from 'vitest';
import { ownerVatIncludedIn, readOwnerVatRatePercent, readPrintedVatAmount } from '../printedVat';

const reader = (values: Record<string, unknown>) =>
  (<T = unknown>(category: string, key: string, defaultValue?: T): T | undefined => {
    const value = values[`${category}.${key}`];
    return (value === undefined ? defaultValue : value) as T | undefined;
  });

describe('the VAT a screen shows (founder rule 07/10/2026)', () => {
  it('shows the native printed VAT and never the stored canonical VAT', () => {
    // Tomikro / an unset-rate store: the order stores 2.52 of VAT, the slip prints none.
    expect(readPrintedVatAmount({ taxAmount: 2.52, tax_amount: 2.52, printedVatAmount: null })).toBe(0);
    // An order object from a reader that does not resolve the rule shows none.
    expect(readPrintedVatAmount({ taxAmount: 2.52 })).toBe(0);
    expect(readPrintedVatAmount({ printedVatAmount: 2.52 })).toBe(2.52);
    expect(readPrintedVatAmount({ printed_vat_amount: '4.44' })).toBe(4.44);
    expect(readPrintedVatAmount({ printedVatAmount: 0 })).toBe(0);
    expect(readPrintedVatAmount(null)).toBe(0);
  });

  it('reads the owner rate from tax.default_tax_rate only', () => {
    expect(readOwnerVatRatePercent(reader({}))).toBeNull();
    expect(readOwnerVatRatePercent(reader({ 'tax.tax_rate_percentage': 24, 'general.tax_rate': 24 }))).toBeNull();
    expect(readOwnerVatRatePercent(reader({ 'tax.default_tax_rate': '0' }))).toBe(0);
    expect(readOwnerVatRatePercent(reader({ 'tax.default_tax_rate': 24 }))).toBe(24);
    expect(readOwnerVatRatePercent(reader({ 'tax.default_tax_rate': 'abc' }))).toBeNull();
  });

  it('previews the owner VAT inside the price and nothing without a rate', () => {
    expect(ownerVatIncludedIn(13, 24)).toBe(2.52);
    expect(ownerVatIncludedIn(13, 0)).toBe(0);
    expect(ownerVatIncludedIn(13, null)).toBe(0);
    expect(ownerVatIncludedIn(21.1, 13)).toBe(2.43);
  });
});
