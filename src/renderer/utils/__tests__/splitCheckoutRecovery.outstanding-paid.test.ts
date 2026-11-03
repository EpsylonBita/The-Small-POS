import { describe, expect, it } from 'vitest';

import { outstandingHasRecordedPayment } from '../splitCheckoutRecovery';

// Coordinator 01/11, founder «Ναι, έτσι»: the outstanding window offers «Cancel order», and its ✕ leaves the order
// pending, only while nothing is paid. Any recorded portion keeps the split in charge and hides the cancel.
describe('outstandingHasRecordedPayment', () => {
  it('reads an untouched order as unpaid', () => {
    expect(outstandingHasRecordedPayment({ orderTotal: 20, outstandingAmount: 20, existingPayments: [] })).toBe(false);
    expect(outstandingHasRecordedPayment({ orderTotal: 20, outstandingAmount: 20 })).toBe(false);
    expect(outstandingHasRecordedPayment({ orderTotal: 20, outstandingAmount: 20, existingPayments: null })).toBe(false);
  });

  it('ignores sub-cent rounding between the total and the balance', () => {
    expect(outstandingHasRecordedPayment({ orderTotal: 20, outstandingAmount: 19.996, existingPayments: [] })).toBe(false);
  });

  it('sees a recorded portion through the payment rows', () => {
    expect(outstandingHasRecordedPayment({
      orderTotal: 20,
      outstandingAmount: 20,
      existingPayments: [{ id: 'p-1', method: 'cash', amount: 5, status: 'completed' }],
    })).toBe(true);
  });

  it('sees a recorded portion through the balance alone', () => {
    expect(outstandingHasRecordedPayment({ orderTotal: 20, outstandingAmount: 15, existingPayments: [] })).toBe(true);
  });

  it('treats a fully paid order (a gift-card receipt reentry at zero) as paid', () => {
    expect(outstandingHasRecordedPayment({ orderTotal: 20, outstandingAmount: 0, existingPayments: [] })).toBe(true);
  });
});
