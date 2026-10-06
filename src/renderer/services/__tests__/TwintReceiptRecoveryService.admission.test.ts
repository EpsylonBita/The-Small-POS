/**
 * Fix review 06/10/2026: the TWINT QR for an existing order was shown before
 * any check, so every refusal of the receipt's save came after the customer
 * had paid. The admission is asked first and refuses with the save's own
 * codes; the manager's way out sends the PIN with the one decision.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scope: 'org|branch|terminal' as string | null,
  configuration: vi.fn(),
  list: vi.fn(),
  invoke: vi.fn(),
  preflight: vi.fn(),
}));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ payments: { listUnsavedPayments: mocks.list }, invoke: mocks.invoke }),
}));
vi.mock('../TwintManualQrService', () => ({
  currentTwintScope: () => mocks.scope,
  loadTwintManualConfiguration: mocks.configuration,
}));
vi.mock('../GiftCardCheckoutService', () => ({
  giftCardCheckoutService: { preflightOrdinaryCollection: mocks.preflight },
}));
vi.mock('../../hooks/useOrderStore', () => ({
  retainedOrdinaryOwner: vi.fn(),
  ordinaryCollectionView: vi.fn(),
  probeOrdinaryOwner: vi.fn(),
}));

import {
  admitTwintCollection,
  resolveReturnedTwintReceipt,
  twintAdmissionReason,
} from '../TwintReceiptRecoveryService';

const configuration = { scope: 'org|branch|terminal', currency: 'CHF', qrImageData: 'data:image/png;base64,AA==' };
const pendingReceipt = {
  idempotencyKey: 'pending', orderId: 'existing-order', kind: 'manual_twint_payment', method: 'twint',
  manualScope: 'org|branch|terminal', manualReceiptConfirmed: true, currency: 'CHF', amount: 12, amountCents: 1200,
};
const admitted = (outstandingCents = 1200) => ({ success: true, twintAdmission: { admitted: true, outstandingCents, currency: 'CHF' } });

beforeEach(() => {
  mocks.scope = 'org|branch|terminal';
  mocks.configuration.mockReset().mockResolvedValue(configuration);
  mocks.list.mockReset().mockResolvedValue({ success: true, payments: [] });
  mocks.invoke.mockReset().mockResolvedValue(admitted());
  mocks.preflight.mockReset().mockResolvedValue({ proceed: true });
});

describe('admitTwintCollection', () => {
  it('admits an existing order only on the native admission of its exact outstanding amount', async () => {
    await expect(admitTwintCollection({ orderId: 'existing-order', amount: 12 })).resolves.toEqual({ admitted: true, configuration });
    expect(mocks.invoke).toHaveBeenCalledWith('payment:get-settlement-snapshot', { orderId: 'existing-order', twintAdmission: true });
    mocks.invoke.mockResolvedValue(admitted(1100));
    await expect(admitTwintCollection({ orderId: 'existing-order', amount: 12 }))
      .resolves.toEqual({ admitted: false, code: 'TWINT_RECEIPT_OUTSTANDING_AMOUNT_CHANGED' });
  });

  it('passes the native refusal code through, before any QR', async () => {
    mocks.invoke.mockResolvedValue({ success: true, twintAdmission: { admitted: false, code: 'PAYMENT_NOT_SAVED_PENDING' } });
    await expect(admitTwintCollection({ orderId: 'existing-order', amount: 12 }))
      .resolves.toEqual({ admitted: false, code: 'PAYMENT_NOT_SAVED_PENDING' });
    mocks.invoke.mockRejectedValue(new Error('native unavailable'));
    await expect(admitTwintCollection({ orderId: 'existing-order', amount: 12 }))
      .resolves.toEqual({ admitted: false, code: 'TWINT_ADMISSION_UNAVAILABLE' });
    mocks.invoke.mockResolvedValue({ success: true });
    await expect(admitTwintCollection({ orderId: 'existing-order', amount: 12 }))
      .resolves.toEqual({ admitted: false, code: 'TWINT_ADMISSION_UNAVAILABLE' });
  });

  it('refuses while a receipt of the order is retained, or its status cannot be read', async () => {
    mocks.list.mockResolvedValue({ success: true, payments: [pendingReceipt] });
    await expect(admitTwintCollection({ orderId: 'existing-order', amount: 12 }))
      .resolves.toEqual({ admitted: false, code: 'TWINT_RECEIPT_PENDING' });
    mocks.list.mockRejectedValue(new Error('store unavailable'));
    await expect(admitTwintCollection({ orderId: 'existing-order', amount: 12 }))
      .resolves.toEqual({ admitted: false, code: 'TWINT_RECEIPT_STATUS_UNAVAILABLE' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('needs a fresh configuration of this very till', async () => {
    mocks.configuration.mockResolvedValue({ ...configuration, scope: 'other|branch|terminal' });
    await expect(admitTwintCollection({ amount: 12 })).resolves.toEqual({ admitted: false, code: 'TWINT_CONFIGURATION_UNAVAILABLE' });
    mocks.configuration.mockRejectedValue(new Error('offline'));
    await expect(admitTwintCollection({ amount: 12 })).resolves.toEqual({ admitted: false, code: 'TWINT_CONFIGURATION_UNAVAILABLE' });
    mocks.scope = null;
    await expect(admitTwintCollection({ amount: 12 })).resolves.toEqual({ admitted: false, code: 'TWINT_CONFIGURATION_UNAVAILABLE' });
  });

  it('asks the gift preflight of the held collection now, not after the customer paid', async () => {
    const hold = { token: 'hold' } as never;
    mocks.preflight.mockResolvedValue({ proceed: false, code: 'GIFT_CARD_RECOVERY_REQUIRED' });
    await expect(admitTwintCollection({ orderId: 'existing-order', amount: 12, hold }))
      .resolves.toEqual({ admitted: false, code: 'GIFT_CARD_RECOVERY_REQUIRED' });
    expect(mocks.preflight).toHaveBeenCalledWith(hold);
  });

  it('refuses when the till changes scope during the checks', async () => {
    mocks.invoke.mockImplementation(async () => { mocks.scope = 'other|branch|terminal'; return admitted(); });
    await expect(admitTwintCollection({ orderId: 'existing-order', amount: 12 }))
      .resolves.toEqual({ admitted: false, code: 'TWINT_RECEIPT_SCOPE_CHANGED' });
  });

  it('explains every refusal in one of the till sentences', () => {
    expect(twintAdmissionReason('TWINT_RECEIPT_PENDING')).toBe('pending');
    expect(twintAdmissionReason('PAYMENT_NOT_SAVED_PENDING')).toBe('notSaved');
    expect(twintAdmissionReason('PLATFORM_HELD_NOT_COLLECTABLE')).toBe('platformHeld');
    expect(twintAdmissionReason('TWINT_RECEIPT_OUTSTANDING_AMOUNT_CHANGED')).toBe('amountChanged');
    expect(twintAdmissionReason('DIRECT_SALE_RECONCILIATION_REQUIRED')).toBe('reconcile');
    expect(twintAdmissionReason('GIFT_CARD_RECOVERY_REQUIRED')).toBe('reconcile');
    expect(twintAdmissionReason('TWINT_CURRENCY_UNAVAILABLE')).toBe('unavailable');
  });
});

describe('resolveReturnedTwintReceipt', () => {
  it('sends the manager PIN with the one decision, and only when given', async () => {
    mocks.invoke.mockResolvedValue({ success: true, result: 'resolved' });
    await resolveReturnedTwintReceipt({ idempotencyKey: 'key', reference: 'TW-1', resolvedBy: 'staff', managerPin: ' 2468 ' });
    expect(mocks.invoke).toHaveBeenLastCalledWith('payment:resolve-unsaved', {
      idempotencyKey: 'key', outcome: 'twint_returned_to_customer', reference: 'TW-1', resolvedBy: 'staff', managerPin: '2468',
    });
    await resolveReturnedTwintReceipt({ idempotencyKey: 'key', reference: 'TW-1' });
    expect(mocks.invoke).toHaveBeenLastCalledWith('payment:resolve-unsaved', {
      idempotencyKey: 'key', outcome: 'twint_returned_to_customer', reference: 'TW-1', resolvedBy: null,
    });
  });
});
