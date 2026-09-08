import { describe, expect, it } from 'vitest';
import { deriveEditSettlementFinancials } from '../editSettlementFinancials';

describe('edited gross-price VAT', () => {
  it('recalculates 4 → 8 → 4 euros without retaining the previous rounded tax', () => {
    const initial = { subtotal: 4, total_amount: 4, tax_amount: 0.77 };
    const increased = deriveEditSettlementFinancials(initial, [{ quantity: 2, unit_price: 4 }], 'pickup', 24);
    expect(increased).toMatchObject({ totalAmount: 8, subtotal: 8, taxAmount: 1.55 });
    const reduced = deriveEditSettlementFinancials(increased, [{ quantity: 1, unit_price: 4 }], 'pickup', 24);
    expect(reduced).toMatchObject({ totalAmount: 4, taxAmount: 0.77 });
  });
  it('extracts VAT after discount, excluding delivery and gratuity from item VAT', () => {
    expect(deriveEditSettlementFinancials(
      { discount_amount: 2, delivery_fee: 3, tip_amount: 1 },
      [{ quantity: 1, unit_price: 10 }], 'delivery', 24,
    )).toMatchObject({ totalAmount: 12, taxAmount: 1.55 });
  });
  it('honors explicit zero tax and ignores absent/null aliases', () => {
    expect(deriveEditSettlementFinancials(
      { tax_rate: 0, tax_amount: 1 }, [{ quantity: 1, unit_price: 4 }], 'pickup', 24,
    ).taxAmount).toBe(0);
    expect(deriveEditSettlementFinancials(
      { tax_rate: null, taxRate: 24 }, [{ quantity: 1, unit_price: 4 }], 'pickup', 0,
    ).taxAmount).toBe(0.77);
  });
});
