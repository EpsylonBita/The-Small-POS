import { describe, expect, it, vi } from 'vitest';
import { prepareManualOrderCancellation, commitManualOrderCancellation, applyPreparedOrderCancellation, manualCancellationFailureKey, manualCancellationFailureOptions } from '../ManualOrderCancellation';

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


// Founder's dev till, 04/11/2026: a closed check whose money the server still
// holds while this till has no receipt of it is refused as not recorded, with
// its way forward, never as a changed payment that a retry could clear.
it('passes the till\'s not-recorded refusal through and never calls it a changed payment', async () => {
  const invoke = vi.fn().mockRejectedValue('ORDER_PAYMENT_NOT_RECORDED');
  const error = await prepareManualOrderCancellation({ invoke }, 'order').catch((failure: unknown) => failure);
  expect(error).toBe('ORDER_PAYMENT_NOT_RECORDED');
  expect(manualCancellationFailureKey(error)).toBe('orderDashboard.cancelRefusedNotRecorded');
  expect(manualCancellationFailureKey(new Error('CANCELLATION_PAYMENT_CHANGED'))).toBe('modals.orderCancellation.paymentChanged');
});

it('accepts a reason-only cancellation plan when all ordinary money was returned', async () => {
  const invoke = vi.fn().mockResolvedValue({ success: true, orderId: 'order', requiresReturn: false,
    requiresHandback: false, amountCents: 0, currency: null, generation: 'returned-1' });
  const plan = await prepareManualOrderCancellation({ invoke }, 'order');
  expect(plan).toMatchObject({ requiresReturn: false, amountCents: 0, generation: 'returned-1' });
});


describe('shared dashboard/history cancellation commit', () => {
  const base = { orderId: 'order', requestId: 'event', requiresReturn: false, amountCents: 0, currency: null, generation: 'returned-1' } as unknown as import('../ManualOrderCancellation').ManualCancellationPlan;
  it('sends plain whole-order cancellation for an already returned closed table check', async () => {
    const invoke = vi.fn();
    const cancelWithApproval = vi.fn().mockResolvedValue({ success: true });
    const bridge = { invoke, orders: { cancelWithApproval } } as any;
    await applyPreparedOrderCancellation(bridge, { ...base, tableSessionId: 'closed-session' }, 'Already returned', 'cash_drawer', '1234');
    expect(cancelWithApproval).toHaveBeenCalledExactlyOnceWith({ orderId: 'order', reason: 'Already returned',
      tableSessionId: 'closed-session', clientEventId: 'event', managerPin: '1234' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('keeps money in the canonical table transaction while any return remains', async () => {
    const invoke = vi.fn();
    const cancelWithApproval = vi.fn().mockResolvedValue({ success: true });
    await applyPreparedOrderCancellation({ invoke, orders: { cancelWithApproval } } as any,
      { ...base, tableSessionId: 'session', requiresReturn: true, amountCents: 400, currency: 'EUR' }, 'Return', 'bank');
    expect(cancelWithApproval.mock.calls[0][0].manualCancellation).toEqual({ generation: 'returned-1', returnChannel: 'bank' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('cancels an already returned ordinary order without another refund command', async () => {
    const invoke = vi.fn();
    const updateStatus = vi.fn().mockResolvedValue({ success: true });
    await applyPreparedOrderCancellation({ invoke, orders: { updateStatus } } as any, base, 'Returned', 'cash_drawer');
    expect(updateStatus).toHaveBeenCalledExactlyOnceWith('order', 'cancelled', { cancellationReason: 'Returned' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
