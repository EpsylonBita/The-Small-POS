import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), getById: vi.fn() }));
vi.mock('../../../lib', () => ({ getBridge: () => ({ invoke: native.invoke, orders: { getById: native.getById } }) }));
import { prepareTableCancellation, tableCancellationFields } from '../TableManualCancellation';

const localId = '11111111-1111-4111-8111-111111111111';
const canonicalId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const plan = { success: true, orderId: localId, tableSessionId: sessionId, requiresReturn: false,
  requiresHandback: false, amountCents: 0, currency: null, generation: 'original-ledger', requestId: 'original-cancel-event' };

describe('canonical table cancellation identity', () => {
  beforeEach(() => {
    native.invoke.mockReset().mockResolvedValue(plan);
    native.getById.mockReset().mockResolvedValue({ id: localId, supabaseId: canonicalId, tableSessionId: sessionId });
  });

  it('accepts the native local plan only when its authoritative order maps the requested canonical UUID and check', async () => {
    const prepared = await prepareTableCancellation(canonicalId, sessionId);
    expect(prepared).toEqual(plan);
    expect(native.getById).toHaveBeenCalledWith(canonicalId);
    expect(tableCancellationFields(prepared)).toEqual({ clientEventId: 'original-cancel-event' });
    expect(native.invoke).toHaveBeenCalledWith('order_prepare_manual_cancel', { orderId: canonicalId, tableSessionId: sessionId });
  });

  it('accepts the native snake-case canonical mapping without changing a retained approval identity', async () => {
    native.getById.mockResolvedValue({ id: localId, supabase_id: canonicalId, table_session_id: sessionId });
    native.invoke.mockResolvedValue({ ...plan, pending: true, reason: 'Original reason' });
    expect(await prepareTableCancellation(canonicalId, sessionId)).toMatchObject({ orderId: localId, requestId: plan.requestId, reason: 'Original reason' });
  });

  it.each([
    null,
    { id: 'foreign-local', supabaseId: canonicalId, tableSessionId: sessionId },
    { id: localId, supabaseId: 'foreign-canonical', tableSessionId: sessionId },
    { id: localId, supabaseId: canonicalId, tableSessionId: 'foreign-session' },
  ])('refuses a missing or unrelated authoritative mapping: %j', async mapping => {
    native.getById.mockResolvedValue(mapping);
    await expect(prepareTableCancellation(canonicalId, sessionId)).rejects.toThrow('CANCELLATION_PAYMENT_CHANGED');
  });

  it('keeps the original same-ID path and refuses a different plan check before looking up an alias', async () => {
    native.invoke.mockResolvedValue({ ...plan, orderId: canonicalId });
    expect(await prepareTableCancellation(canonicalId, sessionId)).toMatchObject({ orderId: canonicalId });
    expect(native.getById).not.toHaveBeenCalled();
    native.invoke.mockResolvedValue({ ...plan, tableSessionId: 'foreign-session' });
    await expect(prepareTableCancellation(canonicalId, sessionId)).rejects.toThrow('CANCELLATION_PAYMENT_CHANGED');
    expect(native.getById).not.toHaveBeenCalled();
  });
});
