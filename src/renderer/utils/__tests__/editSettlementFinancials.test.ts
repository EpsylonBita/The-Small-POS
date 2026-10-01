import { describe, expect, it } from 'vitest';
import {
  deriveEditSettlementFinancials,
  resolveEditSettlementRefundAmount,
} from '../editSettlementFinancials';

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

// Review of the 29/09/2026 fixes: a paid order whose local payment rows are
// missing (offline, restore timed out) was asked to refund money no local
// row held — `paidTotal` counts that proven money — and could not be saved.
describe('edit settlement refund amount', () => {
  it('refunds what the native preview says the local rows hold beyond the new total', () => {
    // Paid 15.00, 10.00 held locally, edited down to 8.00.
    expect(
      resolveEditSettlementRefundAmount({ refundAmount: 2, ledgerPaidTotal: 10, paidTotal: 15, nextTotal: 8 }),
    ).toBe(2);
    expect(resolveEditSettlementRefundAmount({ refundAmount: 0, paidTotal: 10, nextTotal: 8 })).toBe(0);
  });

  it('never refunds proven money no local row holds when the native amount is absent', () => {
    expect(resolveEditSettlementRefundAmount({ ledgerPaidTotal: 0, paidTotal: 10, nextTotal: 8 })).toBe(0);
    expect(resolveEditSettlementRefundAmount({ ledgerPaidTotal: 10.1, paidTotal: 15, nextTotal: 8 })).toBe(2.1);
    // Only a preview that carries neither falls back to the paid total.
    expect(resolveEditSettlementRefundAmount({ paidTotal: 10, nextTotal: 8.5 })).toBe(1.5);
    expect(resolveEditSettlementRefundAmount({ refundAmount: null, paidTotal: 'x', nextTotal: 8 })).toBe(0);
  });
});
