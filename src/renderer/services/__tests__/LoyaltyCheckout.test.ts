import { describe, expect, it, vi } from 'vitest';
import { saveOrderWithLoyalty, LoyaltyCheckoutRefused } from '../LoyaltyCheckout';

const order = { clientRequestId: 'checkout-1', customer_id: '11111111-1111-4111-8111-111111111111' };
const redemption = { customer_id: '11111111-1111-4111-8111-111111111111', points_redeemed: 100 };
const setup = () => ({ redeemPoints: vi.fn(async () => ({ success: true })), releaseRedemption: vi.fn(async () => ({ success: true })) });

describe('loyalty checkout', () => {
  it('secures the debit under the retained checkout identity before saving', async () => {
    const loyalty = setup();
    const save = vi.fn(async () => {
      expect(loyalty.redeemPoints).toHaveBeenCalledWith({ customerId: '11111111-1111-4111-8111-111111111111', points: 100, orderId: 'checkout-1', checkoutReservation: true });
      return { success: true };
    });
    await saveOrderWithLoyalty(order, redemption, loyalty, save);
    expect(loyalty.releaseRedemption).not.toHaveBeenCalled();
  });

  it.each([false, 'throw'])('stops before saving when the debit is refused (%s)', async (failure) => {
    const loyalty = setup();
    loyalty.redeemPoints.mockImplementation(async () => {
      if (failure === 'throw') throw new Error('Insufficient balance');
      return { success: false };
    });
    const save = vi.fn();
    await expect(saveOrderWithLoyalty(order, redemption, loyalty, save)).rejects.toBeInstanceOf(LoyaltyCheckoutRefused);
    expect(save).not.toHaveBeenCalled();
    expect(loyalty.releaseRedemption).toHaveBeenCalledWith({ orderId: 'checkout-1' });
  });

  it('keeps an admitted debit after a definitive save failure and recovers without another debit', async () => {
    const loyalty = setup();
    await saveOrderWithLoyalty(order, redemption, loyalty, async () => ({ success: false }), { redemptionSecured: true });
    expect(loyalty.releaseRedemption).not.toHaveBeenCalled();
    await saveOrderWithLoyalty(order, redemption, loyalty, async () => ({ success: true }), { redemptionSecured: true });
    expect(loyalty.redeemPoints).not.toHaveBeenCalled();
  });

  it.each([{ success: false, paymentNotSaved: true }, { success: false, outcomeUnknown: true }])('keeps the original debit when money recovery is pending', async (result) => {
    const loyalty = setup();
    await saveOrderWithLoyalty(order, redemption, loyalty, async () => result);
    expect(loyalty.releaseRedemption).not.toHaveBeenCalled();
  });
});


it('retains the original debit when a save throws without a definitive outcome', async () => {
  const loyalty = setup();
  await expect(saveOrderWithLoyalty(order, redemption, loyalty, async () => { throw new Error('Lost save reply'); })).rejects.toThrow('Lost save reply');
  expect(loyalty.releaseRedemption).not.toHaveBeenCalled();
});


it('never re-secures or releases a confirmed receipt redemption during save recovery', async () => {
  const loyalty = setup();
  loyalty.redeemPoints.mockRejectedValue(new Error('Program inactive after collection'));
  const result = await saveOrderWithLoyalty(order, redemption, loyalty, async () => ({ success: false }), { redemptionSecured: true, receiptConfirmed: true });
  expect(result.success).toBe(false);
  expect(loyalty.redeemPoints).not.toHaveBeenCalled();
  expect(loyalty.releaseRedemption).not.toHaveBeenCalled();
});
