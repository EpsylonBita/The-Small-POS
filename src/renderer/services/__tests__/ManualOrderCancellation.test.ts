import { describe, expect, it, vi } from 'vitest';
import { prepareManualOrderCancellation, commitManualOrderCancellation, manualCancellationFailureKey, manualCancellationFailureOptions } from '../ManualOrderCancellation';

describe('manual return and cancellation IPC', () => {
  it('retains the same original plan and request on retry; no payment or provider call', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ success: true, orderId: 'order', requiresReturn: true, amountCents: 600, currency: 'EUR', generation: 'ledger-v1' })
      .mockRejectedValueOnce(new Error('Response lost')).mockResolvedValueOnce({ success: true, duplicate: true });
    const plan = await prepareManualOrderCancellation({ invoke }, 'order');
    await expect(commitManualOrderCancellation({ invoke }, plan, 'Mistake', 'cash_drawer')).rejects.toThrow('Response lost');
    await commitManualOrderCancellation({ invoke }, plan, 'Mistake', 'cash_drawer');
    expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[2]);
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['order_prepare_manual_cancel', 'order_cancel_manual_refund', 'order_cancel_manual_refund']);
    expect(invoke.mock.calls[1][1]).toMatchObject({ generation: 'ledger-v1', returnChannel: 'cash_drawer', reason: 'Mistake' });
  });
  it('never turns failed, mismatched or provider-only preflight into a manual plan', async () => {
    for (const result of [{ success: false }, { success: true, orderId: 'foreign' }, { success: true, orderId: 'order', requiresReturn: false }]) {
      const invoke = vi.fn().mockResolvedValue(result);
      await expect(prepareManualOrderCancellation({ invoke }, 'order')).rejects.toThrow();
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });
});


describe('staff handback and canonical table routing', () => {
  it('supports a cash handback after the customer already received every refund', async () => {
    const invoke=vi.fn().mockResolvedValueOnce({success:true,orderId:'order',requiresReturn:false,requiresHandback:true,amountCents:0,currency:'EUR',generation:'custody-1'}).mockResolvedValue({success:true});
    const plan=await prepareManualOrderCancellation({invoke},'order');
    expect(plan.requiresReturn).toBe(false);
    await commitManualOrderCancellation({invoke},plan,'Already refunded','cash_drawer');
    expect(invoke.mock.calls[1][1]).toMatchObject({generation:'custody-1'});
  });
  it('preserves the original canonical event and refuses the ordinary local cancellation command for a table', async () => {
    const invoke=vi.fn().mockResolvedValue({success:true,orderId:'order',tableSessionId:'session',requestId:'original-event',requiresReturn:true,amountCents:1050,currency:'EUR',generation:'ledger-1',pending:true,reason:'Original reason',returnChannel:'bank'});
    const plan=await prepareManualOrderCancellation({invoke},'order');
    expect(plan).toMatchObject({requestId:'original-event',pending:true,reason:'Original reason',returnChannel:'bank'});
    await expect(commitManualOrderCancellation({invoke},plan,'Original reason','bank')).rejects.toThrow('TABLE_CANONICAL_CANCELLATION_REQUIRED');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});


it('keeps an unpaid canonical table on the reason-only approved route', async () => {
  const invoke=vi.fn().mockResolvedValue({success:true,orderId:'order',tableSessionId:'session',requestId:'event',requiresReturn:false,requiresHandback:false,amountCents:0,currency:null,generation:'unpaid-1'});
  const plan=await prepareManualOrderCancellation({invoke},'order');
  expect(plan).toMatchObject({requiresReturn:false,tableSessionId:'session',requestId:'event'});
  await expect(commitManualOrderCancellation({invoke},plan,'Mistake','cash_drawer')).rejects.toThrow('TABLE_CANONICAL_CANCELLATION_REQUIRED');
  expect(invoke).toHaveBeenCalledTimes(1);
});

// Review 06/10/2026: each new refusal has its own plain explanation.
it('names the platform, mirrored-receipt and saved-attempt refusals', () => {
  const key = (code: string) => manualCancellationFailureKey(new Error(code));
  expect(key('PLATFORM_ORDER_RETURN_REQUIRED')).toBe('modals.orderCancellation.platformOrderReturn');
  expect(key('ORIGINAL_RECEIPT_CHECK_UNAVAILABLE')).toBe('modals.orderCancellation.receiptCheckUnavailable');
  expect(key('TABLE_CANCELLATION_REFUSED: refused')).toBe('modals.orderCancellation.refusedByServer');
  expect(key('TABLE_CANCELLATION_PENDING')).toBe('modals.orderCancellation.cancellationPending');
  expect(key('TABLE_CANCELLATION_COMMITTED: done')).toBe('modals.orderCancellation.releaseCommitted');
  expect(manualCancellationFailureKey('TABLE_CANCELLATION_RELEASE_WAIT:12')).toBe('modals.orderCancellation.releaseWait');
  expect(manualCancellationFailureOptions('TABLE_CANCELLATION_RELEASE_WAIT:12')).toEqual({ minutes: 12 });
  expect(manualCancellationFailureOptions(new Error('PAYMENT_SYNC_REQUIRED'))).toEqual({});
  // Existing codes keep their messages.
  expect(key('ORIGINAL_PROVIDER_RETURN_REQUIRED')).toBe('modals.orderCancellation.originalReturnRequired');
  expect(key('PAYMENT_CONNECTION_STATUS_UNAVAILABLE')).toBe('modals.orderCancellation.connectionUnavailable');
});
