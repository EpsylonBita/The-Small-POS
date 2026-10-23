import { describe, expect, it, vi } from 'vitest';
import {
  loyaltyCheckoutMessageKey,
  LoyaltyCheckoutRefused,
  LoyaltyRedemptionUnconfirmed,
  saveOrderWithLoyalty,
  secureLoyaltyCheckout,
} from '../LoyaltyCheckout';

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

// Ω11 (22/10/2026): points are redeemed only with a live server answer.
describe('typed live redemption answers', () => {
  it.each([
    [{ success: false, errorCode: 'LOYALTY_REDEEM_OFFLINE' }, 'loyalty.redeem.offlineRefused'],
    [{ success: false, errorCode: 'LOYALTY_REDEEM_REFUSED', reason: 'HTTP_400' }, 'loyalty.redeem.refusedBody'],
    [{ success: false, errorCode: 'LOYALTY_REDEEM_REFUSED', reason: 'LOYALTY_REDEMPTION_RELEASED' }, 'loyalty.redeem.releasedForCheckout'],
    [{ success: false }, null],
  ])('offline or refused: nothing is saved, the sale continues without points (%o)', async (answer, key) => {
    const loyalty = setup();
    loyalty.redeemPoints.mockResolvedValue(answer as any);
    const save = vi.fn();
    const refusal = await saveOrderWithLoyalty(order, redemption, loyalty, save).catch(error => error);
    expect(refusal).toBeInstanceOf(LoyaltyCheckoutRefused);
    expect(loyaltyCheckoutMessageKey(refusal)).toBe(key);
    expect(save).not.toHaveBeenCalled();
    expect(loyalty.releaseRedemption).toHaveBeenCalledWith({ orderId: 'checkout-1' });
  });

  it('unconfirmed: keeps the attempt for Retry and never releases it', async () => {
    const loyalty = setup();
    loyalty.redeemPoints.mockResolvedValue({ success: false, errorCode: 'LOYALTY_REDEEM_UNCONFIRMED' } as any);
    const save = vi.fn();
    const pending = await saveOrderWithLoyalty(order, redemption, loyalty, save).catch(error => error);
    expect(pending).toBeInstanceOf(LoyaltyRedemptionUnconfirmed);
    expect(pending).not.toBeInstanceOf(LoyaltyCheckoutRefused);
    expect(loyaltyCheckoutMessageKey(pending)).toBe('loyalty.redeem.confirmationRequired');
    expect(save).not.toHaveBeenCalled();
    expect(loyalty.releaseRedemption).not.toHaveBeenCalled();
    // Retry sends the same checkout identity; the server's replay confirms it.
    loyalty.redeemPoints.mockResolvedValue({ success: true, alreadyRedeemed: true } as any);
    await secureLoyaltyCheckout(order, redemption, loyalty);
    expect(loyalty.redeemPoints).toHaveBeenLastCalledWith({ customerId: '11111111-1111-4111-8111-111111111111', points: 100, orderId: 'checkout-1', checkoutReservation: true });
    expect(loyalty.releaseRedemption).not.toHaveBeenCalled();
  });

  it('a refusal whose release is not confirmed is reported as such', async () => {
    const loyalty = setup();
    loyalty.redeemPoints.mockResolvedValue({ success: false, errorCode: 'LOYALTY_REDEEM_OFFLINE' } as any);
    loyalty.releaseRedemption.mockResolvedValue({ success: false } as any);
    await expect(secureLoyaltyCheckout(order, redemption, loyalty)).rejects.toThrow('LOYALTY_RELEASE_NOT_CONFIRMED');
  });
});
