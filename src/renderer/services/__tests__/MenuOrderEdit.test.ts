import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitMenuOrderEdit, deriveMenuEditChanges, menuEditRequest, menuEditRefundAction, previewMenuOrderEdit, type MenuOrderEditData } from '../MenuOrderEdit';
import type { PlatformBridge } from '../../../lib/ipc-adapter';

const data: MenuOrderEditData = { orderId: 'original-six', client_event_id: 'stable-edit', expected_version: 3, expected_local_version: 1,
  items: [{ id: 'original-item', name: 'Coffee', quantity: 1, price: 6 }, { name: 'Added', quantity: 1, price: 4.5 }], total: 10.5 };
const quotedFinancials = { totalAmount:10.5, subtotal:10.5, taxAmount:0, discountAmount:0, discountPercentage:0, deliveryFee:0, tipAmount:0, quote:{ total_amount:10.5,manual_discount_mode:'fixed',manual_discount_value:0,coupon_discount_amount:0 } };
const preview = { quotedFinancials, success: true, canonicalExpectedVersion: 3, localExpectedVersion: 1, paidTotal: 6, ledgerPaidTotal: 6, nextTotal: 10.5,
  requiredAction: 'collect', paymentStatus: 'paid', completedPayments: [{ id: 'original-payment', method: 'card', remainingRefundable: 6 }] };
const action = { type: 'collect' as const, payments: [{ orderId: data.orderId, method: 'cash' as const, amount: 4.5, paymentOrigin: 'manual' as const }] };
function orders() { return { previewEditSettlement: vi.fn().mockResolvedValue(preview),
  applyEditSettlement: vi.fn().mockResolvedValue({ success: true }), updateItems: vi.fn() } as unknown as PlatformBridge['orders']; }

describe('editing immediately after a local payment correction', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED', 'EDIT_PREVIOUS_SETTLEMENT_SYNC_REQUIRED'])(
    'syncs once and obtains a fresh quote before collecting when %s', async code => {
      const bridge = orders();
      const read = vi.mocked(bridge.previewEditSettlement);
      read.mockRejectedValueOnce(code);
      const sync = { force: vi.fn(async () => {
        expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
      }) };
      const proposed = { ...data, expected_local_version: undefined };
      const frozenInput = JSON.stringify(proposed);
      const result = await previewMenuOrderEdit(bridge, proposed, sync);
      expect(result.preflight.requiredAction).toBe('collect');
      expect(result.preview.nextTotal - result.preview.paidTotal).toBe(4.5);
      expect(sync.force).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[1][0]).toEqual(read.mock.calls[0][0]);
      expect(read.mock.calls[2][0]).toMatchObject({ client_event_id:'stable-edit', expected_version:3 });
      expect(JSON.stringify(proposed)).toBe(frozenInput);
      expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
      expect(bridge.updateItems).not.toHaveBeenCalled();
    },
  );

  it('uses the original order preview as proof even if unrelated sync work failed', async () => {
    const bridge = orders();
    vi.mocked(bridge.previewEditSettlement).mockRejectedValueOnce(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'));
    const sync = { force: vi.fn().mockRejectedValue(new Error('Unrelated queued row failed')) };
    await expect(previewMenuOrderEdit(bridge, data, sync)).resolves.toMatchObject({ preflight:{kind:'settlement'} });
    expect(sync.force).toHaveBeenCalledTimes(1);
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });

  it('runs a second owned pass when payment ACK precedes the updated order snapshot', async () => {
    vi.useFakeTimers();
    const bridge = orders();
    vi.mocked(bridge.previewEditSettlement)
      .mockRejectedValueOnce(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'))
      .mockRejectedValueOnce(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'));
    const sync = { force: vi.fn().mockResolvedValue(undefined) };
    const outcome = previewMenuOrderEdit(bridge, data, sync);
    await vi.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toMatchObject({preflight:{requiredAction:'collect'}});
    expect(sync.force).toHaveBeenCalledTimes(2);
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });

  it.each(['EDIT_ORIGINAL_PROVIDER_REFUND_REQUIRED','EDIT_SETTLEMENT_VERSION_CHANGED','EDIT_CANONICAL_ORIGINAL_CHANGED'])(
    'does not retry the non-transient refusal %s', async code => {
      const bridge = orders();
      vi.mocked(bridge.previewEditSettlement).mockRejectedValue(new Error(code));
      const sync = {force:vi.fn()};
      await expect(previewMenuOrderEdit(bridge,data,sync)).rejects.toThrow(code);
      expect(sync.force).not.toHaveBeenCalled();
      expect(bridge.previewEditSettlement).toHaveBeenCalledTimes(1);
      expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
    },
  );

  it('joins an in-flight receipt owner before spending the follow-up pull', async () => {
    vi.useFakeTimers();
    const bridge = orders();
    vi.mocked(bridge.previewEditSettlement)
      .mockRejectedValueOnce(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'))
      .mockRejectedValueOnce(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'));
    const sync = {
      force:vi.fn().mockResolvedValue(undefined),
      getStatus:vi.fn().mockResolvedValueOnce({syncInProgress:true}).mockResolvedValue({syncInProgress:false}),
    };
    const outcome = previewMenuOrderEdit(bridge,data,sync);
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.force).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toMatchObject({preflight:{requiredAction:'collect'}});
    expect(sync.force).toHaveBeenCalledTimes(2);
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });

  it('keeps a genuinely changed canonical order blocked after the pending receipt drains', async () => {
    const bridge = orders();
    vi.mocked(bridge.previewEditSettlement)
      .mockRejectedValueOnce(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'))
      .mockRejectedValueOnce(new Error('EDIT_CANONICAL_ORIGINAL_CHANGED'));
    const sync = {force:vi.fn().mockResolvedValue(undefined)};
    await expect(previewMenuOrderEdit(bridge,data,sync)).rejects.toThrow('EDIT_CANONICAL_ORIGINAL_CHANGED');
    expect(bridge.previewEditSettlement).toHaveBeenCalledTimes(2);
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });

  it('returns control after a bounded offline wait without freezing or resubmitting money', async () => {
    vi.useFakeTimers();
    const bridge = orders();
    vi.mocked(bridge.previewEditSettlement).mockRejectedValue(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'));
    const sync = {force:vi.fn().mockRejectedValue(new Error('offline'))};
    const outcome = expect(previewMenuOrderEdit(bridge,data,sync)).rejects.toThrow('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED');
    await vi.advanceTimersByTimeAsync(12_000);
    await outcome;
    expect(sync.force).toHaveBeenCalledTimes(2);
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
    expect(bridge.updateItems).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a late sync completion after timeout instead of opening a delayed money picker', async () => {
    vi.useFakeTimers();
    const bridge = orders();
    vi.mocked(bridge.previewEditSettlement).mockRejectedValueOnce(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'));
    let resolveSync!: () => void;
    const sync = {force:vi.fn(() => new Promise<void>(resolve => {resolveSync=resolve;}))};
    const outcome = expect(previewMenuOrderEdit(bridge,data,sync)).rejects.toThrow('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED');
    await vi.advanceTimersByTimeAsync(12_000);
    await outcome;
    resolveSync();
    await vi.runAllTimersAsync();
    expect(bridge.previewEditSettlement).toHaveBeenCalledTimes(1);
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });

  it('times out without overlapping another owner that remains busy', async () => {
    vi.useFakeTimers();
    const bridge = orders();
    vi.mocked(bridge.previewEditSettlement).mockRejectedValue(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'));
    const sync = {force:vi.fn().mockResolvedValue(undefined),getStatus:vi.fn().mockResolvedValue({syncInProgress:true})};
    const outcome = expect(previewMenuOrderEdit(bridge,data,sync)).rejects.toThrow('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED');
    await vi.advanceTimersByTimeAsync(12_000);
    await outcome;
    expect(sync.force).toHaveBeenCalledTimes(1);
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not auto-retry a frozen recovery submission', async () => {
    const bridge = orders();
    vi.mocked(bridge.previewEditSettlement).mockRejectedValue(new Error('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED'));
    const sync = {force:vi.fn()};
    await expect(previewMenuOrderEdit(bridge,{...data,action:'edit_settlement'},sync)).rejects.toThrow('EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED');
    expect(sync.force).not.toHaveBeenCalled();
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });
});

describe('menu paid edit settlement', () => {
  it.each([
    ['percentage',9.9,1.1,{manual_discount_mode:'percentage',manual_discount_value:10,coupon_discount_amount:0}],
    ['clamped fixed',0,11,{manual_discount_mode:'fixed',manual_discount_value:20,coupon_discount_amount:0}],
    ['coupon after manual',7,4,{manual_discount_mode:'fixed',manual_discount_value:2,coupon_discount_amount:2}],
  ])('freezes authoritative %s quote before the immutable money request', async (_name,total,discount,rules) => {
    const bridge=orders();
    const financials={...quotedFinancials,totalAmount:total,subtotal:11,discountAmount:discount,quote:{...rules,total_amount:total}};
    vi.mocked(bridge.previewEditSettlement).mockResolvedValue({...preview,nextTotal:total,quotedFinancials:financials} as any);
    const result=await previewMenuOrderEdit(bridge,{...data,total:10});
    expect(result.preflight.financials).toEqual(financials);
    let frozen:any;
    await commitMenuOrderEdit(bridge,{...data,total:Number(total),financials},action,{beforeCommit:async value=>{frozen=value;}});
    expect(frozen.total).toBe(total);expect(frozen.settlementRequest.financials).toEqual(financials);
    const altered={...financials,totalAmount:Number(total)+0.01};
    await expect(previewMenuOrderEdit(bridge,{...data,financials:altered})).rejects.toThrow('EDIT_CANONICAL_QUOTE_CHANGED');
  });

  it('allocates refunds over retained original portions without using platform money', () => {
    const originals = { ...preview, completedPayments: [
      { id: 'card-a', method: 'card', remainingRefundable: 1 },
      { id: 'cash-b', method: 'cash', remainingRefundable: 1.5 },
      { id: 'platform', method: 'other', remainingRefundable: 10, platformSettlement: true },
    ] } as any;
    expect(menuEditRefundAction(originals, 2, 'cash', 'Correction')).toEqual({ type: 'refund', refunds: [
      { paymentId: 'cash-b', amount: 1.5, refundMethod: 'cash', reason: 'Correction' },
      { paymentId: 'card-a', amount: 0.5, refundMethod: 'cash', reason: 'Correction' },
    ] });
    expect(() => menuEditRefundAction(originals, 3, 'cash', 'Correction')).toThrow('REFUND_NO_ELIGIBLE_PAYMENT');
  });
  it('routes paid editing through read-only settlement preflight, carrying its version before any write', async () => {
    const bridge = orders();
    expect((await previewMenuOrderEdit(bridge, { ...data, expected_version: 1, expected_local_version: undefined })).preflight).toEqual({ kind: 'settlement', financials:quotedFinancials, requiredAction: 'collect', canonicalExpectedVersion: 3, localExpectedVersion: 1 });
    expect(bridge.previewEditSettlement).toHaveBeenLastCalledWith(expect.objectContaining({ client_event_id: 'stable-edit', expected_version: 1 }));
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
    expect(bridge.updateItems).not.toHaveBeenCalled();
  });
  it('refuses missing canonical proof or a changed second preview before any confirmation', async () => {
    const bridge = orders();
    vi.mocked(bridge.previewEditSettlement).mockResolvedValue({ ...preview, canonicalExpectedVersion: undefined } as any);
    await expect(previewMenuOrderEdit(bridge, data)).rejects.toThrow('EDIT_CANONICAL_PREFLIGHT_REQUIRED');
    vi.mocked(bridge.previewEditSettlement).mockResolvedValue({ ...preview, canonicalExpectedVersion: 4 } as any);
    await expect(previewMenuOrderEdit(bridge, data)).rejects.toThrow('EDIT_SETTLEMENT_VERSION_CHANGED');
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });
  it('routes proven unchanged-item metadata edits without manual provider settlement', async () => {
    const bridge=orders();vi.mocked(bridge.previewEditSettlement).mockResolvedValue({ ...preview, metadataOnly:true } as any);
    expect((await previewMenuOrderEdit(bridge,{ ...data, renderer_local_version:1, orderUpdates:{ customerName:'Corrected' } })).preflight.kind).toBe('metadata');
    expect(bridge.previewEditSettlement).toHaveBeenCalledTimes(2);
    expect(bridge.previewEditSettlement).toHaveBeenLastCalledWith(expect.objectContaining({ client_event_id:'stable-edit', expectedLocalVersion:1 }));
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });
  it('refuses a changed original metadata snapshot before any write or money confirmation', async () => {
    const bridge=orders();
    vi.mocked(bridge.previewEditSettlement).mockResolvedValueOnce({ ...preview, metadataOnly:true } as any)
      .mockRejectedValueOnce(new Error('EDIT_CANONICAL_ORIGINAL_CHANGED'));
    await expect(previewMenuOrderEdit(bridge,{ ...data, renderer_local_version:1 })).rejects.toThrow('EDIT_CANONICAL_ORIGINAL_CHANGED');
    expect(bridge.updateItems).not.toHaveBeenCalled();
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });
  it('keeps unpaid editing on the ordinary route', async () => {
    const bridge = orders();vi.mocked(bridge.previewEditSettlement).mockResolvedValue({ ...preview, paidTotal: 0, paymentStatus: 'pending', completedPayments: [] } as any);
    expect((await previewMenuOrderEdit(bridge, data)).preflight.kind).toBe('ordinary');
    expect(bridge.previewEditSettlement).toHaveBeenCalledTimes(1);
  });
  it('awaits durable freeze of the exact delta before dispatch, then replays without another freeze or choice', async () => {
    const bridge = orders();let release!: () => void;
    let saved: Record<string, unknown> = {};
    const lifecycle = { beforeCommit: vi.fn(async (submission: Record<string, unknown>) => {
      saved = submission;await new Promise<void>(resolve => { release = resolve; });
    }) };
    const pending = commitMenuOrderEdit(bridge, data, action, lifecycle);
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
    release();await pending;
    const request = vi.mocked(bridge.applyEditSettlement).mock.calls[0][0];
    expect(request.action).toEqual(action);
    expect(request).toMatchObject({ expected_version: 3, expected_local_version: 1 });
    expect(saved.settlementRequest).toEqual(request);
    await commitMenuOrderEdit(bridge, saved as unknown as MenuOrderEditData, action);
    expect(bridge.applyEditSettlement).toHaveBeenNthCalledWith(2, request);
    expect(lifecycle.beforeCommit).toHaveBeenCalledTimes(1);
  });
  it('never dispatches if freeze fails', async () => {
    const bridge = orders();
    await expect(commitMenuOrderEdit(bridge, data, action, { beforeCommit: async () => { throw new Error('disk full'); } })).rejects.toThrow('disk full');
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });
  it('does not report a semantic false reply or lost reply as a committed edit', async () => {
    const bridge = orders();const beforeCommit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge.applyEditSettlement).mockResolvedValueOnce({ success: false, error: 'SHIFT_CURRENCY_UNAVAILABLE' });
    await expect(commitMenuOrderEdit(bridge, data, action, { beforeCommit })).rejects.toThrow('SHIFT_CURRENCY_UNAVAILABLE');
    vi.mocked(bridge.applyEditSettlement).mockRejectedValueOnce(new Error('IPC lost'));
    await expect(commitMenuOrderEdit(bridge, data, action, { beforeCommit })).rejects.toThrow('IPC lost');
  });
  it('refuses a tampered recovery identity before IPC', async () => {
    const bridge = orders();
    await expect(commitMenuOrderEdit(bridge, { ...data, action: 'edit_settlement', settlementRequest: { ...data, orderId: 'other', action } }, action)).rejects.toThrow('RECOVERY_ORIGINAL_REQUEST_REQUIRED');
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
  });
});


describe('staged fulfillment and header corrections', () => {
  const original = { order_type: 'pickup', total_amount: 10.5, delivery_fee: 0,
    customer_name: 'Original', items: [{ quantity: 1, unit_price: 10.5 }] };
  it('stages pickup10.50 to delivery11.50 without changing the original or writing before confirmation', async () => {
    const before = JSON.stringify(original);
    const staged = { orderUpdates: { customerName: 'Selected', deliveryAddress: 'New street', deliveryAddressId: null }, deliveryFee: 0 };
    const changes = deriveMenuEditChanges(original, [{ quantity: 1, unit_price: 11.5 }], 'delivery', staged);
    expect(changes).toMatchObject({ total: 11.5, financials: { totalAmount: 11.5, deliveryFee: 0 }, orderUpdates: { orderType: 'delivery', customerName: 'Selected', deliveryAddressId: null } });
    expect(JSON.stringify(original)).toBe(before);
    const bridge = orders(); const edited = { ...data, ...changes };
    await previewMenuOrderEdit(bridge, edited);
    expect(bridge.applyEditSettlement).not.toHaveBeenCalled();
    expect(bridge.previewEditSettlement).toHaveBeenLastCalledWith(expect.objectContaining({ orderUpdates: changes.orderUpdates, financials: changes.financials }));
    let frozen: any;
    await commitMenuOrderEdit(bridge, edited, action, { beforeCommit: async value => { frozen=value; } });
    expect(frozen.settlementRequest).toMatchObject({ orderUpdates: changes.orderUpdates, financials: changes.financials });
    await commitMenuOrderEdit(bridge, frozen, action);
    expect(bridge.applyEditSettlement).toHaveBeenNthCalledWith(2, frozen.settlementRequest);
  });
  it('clears all delivery attribution only in the final typed request while retaining original discount/tip offset', () => {
    const source = { ...original, order_type: 'delivery', total_amount: 12, delivery_fee: 2 };
    const next = deriveMenuEditChanges(source, [{ quantity: 1, unit_price: 10.5 }], 'pickup');
    expect(next.total).toBe(10);
    expect(next.orderUpdates).toMatchObject({ orderType: 'pickup', deliveryAddress: null, deliveryAddressId: null,
      deliveryLatitude: null, deliveryLongitude: null, deliveryZoneId: null, driverId: null });
    expect(source.total_amount).toBe(12);
    expect(menuEditRequest({ ...data, ...next })).toMatchObject({ orderUpdates: next.orderUpdates, financials: { totalAmount: 10, deliveryFee: 0 } });
  });
  it('keeps the same frozen header and totals on unpaid preview too', async () => {
    const bridge = orders();vi.mocked(bridge.previewEditSettlement).mockResolvedValue({ ...preview, paidTotal: 0, paymentStatus: 'pending', completedPayments: [] } as any);
    const changes = deriveMenuEditChanges(original, original.items, 'delivery', { deliveryFee: 2, orderUpdates: { customerName:'Chosen' } });
    expect((await previewMenuOrderEdit(bridge, { ...data, ...changes })).preflight.kind).toBe('ordinary');
    expect(bridge.previewEditSettlement).toHaveBeenCalledWith(expect.objectContaining({ financials: { totalAmount:12.5, deliveryFee:2 }, orderUpdates: changes.orderUpdates }));
  });
});
