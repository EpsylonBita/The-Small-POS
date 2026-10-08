import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getStore: vi.fn() }));
vi.mock('../../services/CheckoutDraftStore', async original => ({ ...await original<typeof import('../../services/CheckoutDraftStore')>(), getCheckoutDraftStore: mocks.getStore }));
import { CheckoutDraftStore, createCheckoutDraft } from '../../services/CheckoutDraftStore';
import { useCheckoutDraftPersistence } from '../useCheckoutDraftPersistence';
const scope = { organizationId: 'org', branchId: 'branch', terminalId: 'terminal' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const snapshot = { cartItems: [{ id: 'coffee', notes: 'without sugar' }], context: { orderType: 'dine-in', selectedTable: { id: 'table' } }, state: { manualDiscountValue: 2 } };
afterEach(cleanup);
function setup(read: ReturnType<typeof deferred<any>>, write?: ReturnType<typeof deferred<any>>) {
  let generation = 1; const native = vi.fn(async (command: string, input: any) => {
    if (command === 'checkout_draft_get') return read.promise;
    if (command === 'checkout_draft_inspect') return { success: true, outcome: 'not_found', canCollect: false };
    if (write) await write.promise;
    return { success: true, scope, generation: ++generation, draft: command === 'checkout_draft_delete' ? null : input.draft };
  });
  mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native)); return native;
}
describe('checkout draft hydration and admission', () => {
  it('does not hydrate or overwrite an archived cancelled-target editor', async () => {
    const read = deferred<any>(); const native = setup(read);
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await act(async () => read.resolve({ success: true, scope, generation: 2, draft: null,
      invalidation: { reason: 'edit_target_cancelled', orderId: 'original-order' } }));
    expect(result.current.status).toBe('invalidated');
    expect(result.current.error).toBe('draftTargetCancelled');
    expect(result.current.restored).toBeNull();
    await expect(result.current.persist(snapshot)).rejects.toThrow('NOT_READY');
    expect(native.mock.calls.map(call => call[0])).toEqual(['checkout_draft_get']);
  });
  it('closes the editable lifecycle when its target is cancelled after hydration', async () => {
    const native = vi.fn(async (command: string) => {
      if (command === 'checkout_draft_get') return { success: true, scope, generation: 1, draft: null };
      throw new Error('CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED');
    });
    mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    act(() => result.current.markHydrated());
    await act(async () => { await result.current.persist(snapshot).catch(result.current.failedSave); });
    expect(result.current.status).toBe('invalidated');
    expect(result.current.error).toBe('draftTargetCancelled');
    await expect(result.current.freeze(snapshot, { action: 'edit_settlement' })).rejects.toThrow('AWAITING_RECONCILIATION');
  });
  it('does not overwrite initial empty UI while loading; restores saved context before autosave', async () => {
    const read = deferred<any>(); const native = setup(read); const saved = { ...createCheckoutDraft(), ...snapshot };
    const { result, unmount } = renderHook(() => useCheckoutDraftPersistence(true));
    await expect(result.current.persist(snapshot)).rejects.toThrow('NOT_READY');
    await act(async () => read.resolve({ success: true, scope, generation: 1, draft: saved }));
    expect(result.current.status).toBe('loaded'); expect(result.current.restored).toEqual(saved); expect(native).toHaveBeenCalledTimes(2);
    act(() => result.current.markHydrated()); await act(async () => { expect(await result.current.persist(snapshot)).toBe(saved.checkoutRequestId); });
    expect(native).toHaveBeenCalledTimes(2); unmount(); expect(native).toHaveBeenCalledTimes(2);
  });
  it('awaits durable frozen payload before checkout dispatch, and prevents concurrent autosave changes', async () => {
    const read = deferred<any>(); const write = deferred<any>(); const native = setup(read, write);
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await act(async () => read.resolve({ success: true, scope, generation: 1, draft: null })); act(() => result.current.markHydrated());
    const dispatch = vi.fn(); let admission!: Promise<string>;
    act(() => { admission = result.current.freeze(snapshot, { method: 'card', amount: 8 }).then(id => { dispatch(id); return id; }); });
    await waitFor(() => expect(native).toHaveBeenCalledTimes(2)); expect(dispatch).not.toHaveBeenCalled();
    await expect(result.current.persist({ ...snapshot, cartItems: [] })).rejects.toThrow('AWAITING_RECONCILIATION');
    await act(async () => { write.resolve(undefined); await admission; });
    expect(dispatch).toHaveBeenCalledWith(result.current.identity()); expect(result.current.restored?.submission).toEqual({ method: 'card', amount: 8 });
    await expect(result.current.clear(false)).rejects.toThrow('AWAITING_RECONCILIATION');
  });
  it('read failure blocks hydration and checkout; never writes an empty replacement', async () => {
    const native = vi.fn(async () => { throw new Error('read unavailable'); }); mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('draftReadFailed'); await expect(result.current.persist(snapshot)).rejects.toThrow('NOT_READY');
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('ignores late hydration after modal closes and retains storage on unmount', async () => {
    const read = deferred<any>(); const native = setup(read); const { result, rerender } = renderHook(({ enabled }) => useCheckoutDraftPersistence(enabled), { initialProps: { enabled: true } });
    rerender({ enabled: false }); await act(async () => read.resolve({ success: true, scope, generation: 1, draft: { ...createCheckoutDraft(), ...snapshot } }));
    expect(result.current.restored).toBeNull(); await expect(result.current.persist(snapshot)).rejects.toThrow('NOT_READY'); expect(native).toHaveBeenCalledTimes(1);
  });
});


describe('restored editing-phase money protection', () => {
  it('retains the exact confirmed edit in memory when the durable freeze fails', async () => {
    const native = vi.fn(async (command: string) => {
      if (command === 'checkout_draft_get') return { success: true, scope, generation: 0, draft: null };
      throw new Error('disk full');
    });
    mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    act(() => result.current.markHydrated());
    const submission = { action: 'edit_settlement', settlementRequest: { client_event_id: result.current.identity(), action: { type: 'collect', method: 'card' } } };
    await act(async () => { await expect(result.current.freeze(snapshot, submission)).rejects.toThrow('disk full'); });
    expect(result.current.restored?.submission).toEqual(submission);
    expect(result.current.isPending()).toBe(true);
    expect(result.current.error).toBe('draftSaveFailed');
    await expect(result.current.persist(snapshot)).rejects.toThrow('AWAITING_RECONCILIATION');
  });
  it('explicit native refusal resumes hydration and rotates identity without invoking checkout', async () => {
    const draft = { ...createCheckoutDraft(), ...snapshot, phase: 'checkout_pending' as const,
      submission: { clientRequestId: 'original', paymentData: { method: 'card' } } };
    draft.checkoutRequestId = 'original';
    const { submission: _submission, ...editable } = draft;
    const resumed = { ...editable, phase: 'editing' as const, checkoutRequestId: 'renewed', context: { ...draft.context, checkoutRequestId: 'renewed' } };
    const native = vi.fn(async (command: string) => ({ success: true, scope,
      generation: command === 'checkout_draft_get' ? 1 : 2, draft: command === 'checkout_draft_get' ? draft : resumed }));
    mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    act(() => result.current.markHydrated());
    expect(native).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.resumeDeclined(); });
    expect(result.current.status).toBe('loaded'); expect(result.current.restored).toEqual(resumed);
    expect(result.current.identity()).toBe('renewed'); expect(result.current.isPending()).toBe(false);
    await expect(result.current.persist(snapshot)).rejects.toThrow('NOT_READY');
    act(() => result.current.markHydrated());
    expect(native.mock.calls.map(call => call[0])).toEqual(['checkout_draft_get', 'checkout_draft_resume_declined']);
  });
  it('closing and reopening during native resume cannot apply an old reply to the new modal owner', async () => {
    const old = { ...createCheckoutDraft(), ...snapshot, phase: 'checkout_pending' as const };
    const renewed = { ...old, phase: 'editing' as const, checkoutRequestId: 'renewed', context: { ...old.context, checkoutRequestId: 'renewed' } };
    const gate = deferred<any>();
    const first = new CheckoutDraftStore(scope, async command => command === 'checkout_draft_get'
      ? { success: true, scope, generation: 1, draft: old } : gate.promise);
    const other = { ...createCheckoutDraft(), ...snapshot, phase: 'checkout_pending' as const };
    const second = new CheckoutDraftStore(scope, async () => ({ success: true, scope, generation: 1, draft: other }));
    mocks.getStore.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { result, rerender } = renderHook(({ enabled }) => useCheckoutDraftPersistence(enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.status).toBe('loaded')); act(() => result.current.markHydrated());
    let resume!: Promise<unknown>; act(() => { resume = result.current.resumeDeclined().catch(error => error); });
    rerender({ enabled: false }); rerender({ enabled: true });
    await waitFor(() => expect(result.current.identity()).toBe(other.checkoutRequestId));
    await act(async () => { gate.resolve({ success: true, scope, generation: 2, draft: renewed }); });
    expect(await resume).toEqual(new Error('CHECKOUT_DRAFT_CHANGED'));
    expect(result.current.restored).toEqual(other); expect(result.current.identity()).toBe(other.checkoutRequestId);
  });
  it('an unresolved original provider reservation freezes editing before any new checkout is admitted', async () => {
    const draft = { ...createCheckoutDraft(), ...snapshot };
    const native = vi.fn(async (command: string, input: any) => command === 'checkout_draft_inspect'
      ? { success: true, outcome: 'uncertain', canCollect: false }
      : { success: true, scope, generation: command === 'checkout_draft_get' ? 1 : 2, draft: input.draft || draft });
    mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    expect(result.current.restored?.phase).toBe('checkout_pending'); expect(result.current.identity()).toBe(draft.checkoutRequestId);
    act(() => result.current.markHydrated()); await expect(result.current.persist(snapshot)).rejects.toThrow('AWAITING_RECONCILIATION');
    expect(native).toHaveBeenCalledWith('checkout_draft_put', expect.objectContaining({ draft: expect.objectContaining({ phase: 'checkout_pending' }) }));
  });
  it('an unavailable inspection cannot turn a restored editing preimage into collection permission', async () => {
    const draft = { ...createCheckoutDraft(), ...snapshot };
    const native = vi.fn(async (command: string) => { if (command === 'checkout_draft_get') return { success: true, scope, generation: 1, draft }; throw new Error('inspect unavailable'); });
    mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await waitFor(() => expect(result.current.status).toBe('error'));
    await expect(result.current.persist(snapshot)).rejects.toThrow('NOT_READY');
    expect(native.mock.calls.map(call => call[0])).toEqual(['checkout_draft_get', 'checkout_draft_inspect']);
  });
});

describe('a refused order correction (06/10/2026)', () => {
  const frozenEdit = () => {
    const draft = { ...createCheckoutDraft(), ...snapshot, phase: 'checkout_pending' as const,
      context: { editMode: true, editOrderId: 'paid-order', orderType: 'pickup' },
      submission: { action: 'edit_settlement', orderId: 'paid-order', client_event_id: '' } };
    draft.submission.client_event_id = draft.checkoutRequestId;
    return draft;
  };
  it('renews the frozen editor once with the same cart, a new identity and the attempt it replaces', async () => {
    const draft = frozenEdit();
    let stored: any = draft; let generation = 1;
    const native = vi.fn(async (command: string, input: any) => {
      if (command === 'checkout_draft_get') return { success: true, scope, generation, draft: stored };
      if (command === 'checkout_draft_inspect') return { success: true, outcome: 'uncertain', canCollect: false };
      stored = command === 'checkout_draft_delete' ? null : input.draft;
      return { success: true, scope, generation: ++generation, draft: stored };
    });
    mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    act(() => result.current.markHydrated());
    expect(result.current.isPending()).toBe(true);
    await expect(result.current.renewRefusedEdit('another-event')).rejects.toThrow('NOT_READY');
    await act(async () => { await result.current.renewRefusedEdit(draft.checkoutRequestId); });
    expect(result.current.status).toBe('loaded');
    expect(result.current.isPending()).toBe(false);
    expect(result.current.identity()).not.toBe(draft.checkoutRequestId);
    expect(stored).toMatchObject({ phase: 'editing', cartItems: draft.cartItems, state: draft.state,
      context: { editMode: true, editOrderId: 'paid-order', supersedesEditEvent: draft.checkoutRequestId } });
    expect(stored.submission).toBeUndefined();
    expect(stored.draftId).not.toBe(draft.draftId);
    expect(native.mock.calls.map(call => call[0])).toEqual(['checkout_draft_get', 'checkout_draft_delete', 'checkout_draft_put']);
  });
});

describe('closing the order menu (1.4.125, stuck edit)', () => {
  it('reports a recorded submission and a renewed refused correction from the hydrated draft', async () => {
    const renewed = { ...createCheckoutDraft(), ...snapshot, context: { editMode: true, editOrderId: 'paid-order', supersedesEditEvent: 'refused' } };
    const native = vi.fn(async (command: string, input: any) => command === 'checkout_draft_inspect'
      ? { success: true, outcome: 'not_found', canCollect: false }
      : { success: true, scope, generation: 2, draft: command === 'checkout_draft_get' ? renewed : input.draft });
    mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    act(() => result.current.markHydrated());
    expect(result.current.supersedesEdit()).toBe(true);
    expect(result.current.hasSubmission()).toBe(false);
    await act(async () => { await result.current.freeze(snapshot, { action: 'edit_settlement' }); });
    expect(result.current.hasSubmission()).toBe(true);
    expect(result.current.supersedesEdit()).toBe(false);
  });
});
