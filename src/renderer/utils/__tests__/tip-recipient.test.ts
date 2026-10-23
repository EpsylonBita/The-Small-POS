import { describe, expect, it } from 'vitest';
import { resolveOrderTipRecipient, tipPaymentFields } from '../tip-recipient';

const MARIA = '5a1f0000-0000-4000-8000-000000000001';
const items = [
  { name: 'Haircut', service_id: 'haircut', staff_id: MARIA, metadata: { staff_id: MARIA, staff_name: 'Maria' } },
  { name: 'Shampoo', menu_item_id: 'shampoo' },
];

describe('order tip recipient (OrderFlow routing)', () => {
  it('sends a staff tip to a stylist of the order lines, leaving the shift to native', () => {
    expect(resolveOrderTipRecipient({ tipAmount: 5, requestedRole: 'staff', requestedStaffId: MARIA, items,
      waiterId: 'cashier-staff', waiterShiftId: 'cashier-shift' }))
      .toEqual({ tipRecipientRole: 'staff', tipRecipientStaffId: MARIA });
  });

  it('never names a staff member the order lines do not carry', () => {
    expect(resolveOrderTipRecipient({ tipAmount: 5, requestedRole: 'staff', requestedStaffId: 'someone-else', items }))
      .toEqual({ tipRecipientRole: 'staff', tipRecipientStaffId: undefined });
    expect(resolveOrderTipRecipient({ tipAmount: 5, requestedRole: 'staff', items }))
      .toEqual({ tipRecipientRole: 'staff', tipRecipientStaffId: undefined });
  });

  it('keeps the waiter, cashier and driver rules as they were', () => {
    expect(resolveOrderTipRecipient({ tipAmount: 2, requestedRole: 'waiter', items: [], waiterId: 'w', waiterShiftId: 'ws' }))
      .toEqual({ tipRecipientRole: 'waiter', tipRecipientStaffId: 'w', tipRecipientStaffShiftId: 'ws' });
    expect(resolveOrderTipRecipient({ tipAmount: 2, requestedRole: 'cashier', items, waiterId: 'w' }))
      .toEqual({ tipRecipientRole: 'cashier' });
    expect(resolveOrderTipRecipient({ tipAmount: 2, requestedRole: 'driver', items: [] }))
      .toEqual({ tipRecipientRole: 'driver' });
    expect(resolveOrderTipRecipient({ tipAmount: 0, requestedRole: 'staff', requestedStaffId: MARIA, items })).toEqual({});
    expect(resolveOrderTipRecipient({ tipAmount: 2, requestedRole: 'chef', items })).toEqual({});
  });

  it('puts the stylist id on the payment only for a staff tip', () => {
    expect(tipPaymentFields({ amount: 5, recipientRole: 'staff', recipientStaffId: MARIA, recipientStaffName: 'Maria' }))
      .toEqual({ tipAmount: 5, tipRecipientRole: 'staff', tipRecipientStaffId: MARIA });
    expect(tipPaymentFields({ amount: 5, recipientRole: 'cashier', recipientStaffId: MARIA }))
      .toEqual({ tipAmount: 5, tipRecipientRole: 'cashier' });
    expect(tipPaymentFields(null)).toEqual({ tipAmount: undefined, tipRecipientRole: undefined });
  });
});
