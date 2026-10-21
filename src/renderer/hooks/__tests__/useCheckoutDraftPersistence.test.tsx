import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getStore: vi.fn() }));
vi.mock('../../services/CheckoutDraftStore', async original => ({ ...await original<typeof import('../../services/CheckoutDraftStore')>(), getCheckoutDraftStore: mocks.getStore }));
import { CheckoutDraftStore, createCheckoutDraft } from '../../services/CheckoutDraftStore';
import { useCheckoutDraftPersistence } from '../useCheckoutDraftPersistence';
const scope = { organizationId: 'org', branchId: 'branch', terminalId: 'terminal' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const snapshot = { cartItems: [{ id: 'coffee', notes: 'without sugar' }], context: { orderType: 'dine-in', selectedTable: { id: 'table' } }, state: { manualDiscountValue: 2 } };
afterEach(() => { cleanup(); vi.useRealTimers(); });
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
    const callsBeforeInspection = native.mock.calls.length;
    await expect(result.current.inspect()).rejects.toThrow('CHECKOUT_DRAFT_SAVE_IN_PROGRESS');
    expect(native).toHaveBeenCalledTimes(callsBeforeInspection);
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

describe('bounded prewrite scope-transition retry', () => {
  async function ready(failures: number, cause: unknown = 'REPAIR_SCOPE_TRANSITION_PENDING') {
    let puts = 0;
    const native = vi.fn(async (command: string, input: any) => {
      if (command === 'checkout_draft_get') return { success: true, scope, generation: 7, draft: null };
      if (++puts <= failures) throw cause;
      return { success: true, scope, generation: 8, draft: input.draft };
    });
    mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const view = renderHook(({ enabled }) => useCheckoutDraftPersistence(enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(view.result.current.status).toBe('loaded'));
    act(() => view.result.current.markHydrated());
    vi.useFakeTimers();
    return { ...view, native, writes: () => native.mock.calls.filter(call => call[0] === 'checkout_draft_put') };
  }

  it.each(['string', 'Error'] as const)('retries the exact %s prewrite refusal and dispatches only after unchanged draft acknowledgement', async kind => {
    const { result, writes } = await ready(2, kind === 'string' ? 'REPAIR_SCOPE_TRANSITION_PENDING' : new Error('REPAIR_SCOPE_TRANSITION_PENDING'));
    const originalId = result.current.identity();
    const draftInput = structuredClone(snapshot);
    const submission = { clientRequestId: originalId, paymentData: { method: 'card', amount: 8 } };
    const dispatch = vi.fn();
    let completed!: Promise<unknown>;
    await act(async () => { completed = result.current.freeze(draftInput, submission).then(dispatch).catch(error => error); });
    expect(writes()).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
    // Caller-owned objects changing while the gate drains cannot change the captured preimage.
    draftInput.cartItems[0].notes = 'changed after confirmation';
    submission.paymentData.amount = 99;
    await act(async () => vi.advanceTimersByTimeAsync(99));
    expect(writes()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(writes()).toHaveLength(2);
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await completed;
    expect(writes()).toHaveLength(3);
    const attempts = writes().map(call => call[1]);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[2]).toEqual(attempts[0]);
    expect(attempts[2]).toMatchObject({ ...scope, expectedGeneration: 7, draft: { checkoutRequestId: originalId, phase: 'checkout_pending',
      cartItems: snapshot.cartItems, submission: { paymentData: { amount: 8 } } } });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(originalId);
    expect(result.current.error).toBeNull();
    expect(result.current.isPending()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exhausts seven retries at 9,850 ms and retains the exact frozen original for explicit inspection', async () => {
    const { result, writes } = await ready(Infinity);
    const originalId = result.current.identity();
    const dispatch = vi.fn();
    let completed!: Promise<unknown>;
    await act(async () => { completed = result.current.freeze(snapshot, { paymentData: { method: 'card', amount: 8 } }).then(dispatch).catch(error => error); });
    await act(async () => vi.advanceTimersByTimeAsync(9849));
    expect(writes()).toHaveLength(7);
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(await completed).toBe('REPAIR_SCOPE_TRANSITION_PENDING');
    expect(writes()).toHaveLength(8);
    expect(result.current.error).toBe('draftSaveFailed');
    expect(result.current.restored).toMatchObject({ checkoutRequestId: originalId, phase: 'checkout_pending', cartItems: snapshot.cartItems });
    expect(result.current.isPending()).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses recovery during backoff without another native operation or completion callback', async () => {
    const { result, native, writes } = await ready(1);
    const dispatch = vi.fn();
    const recoveryDispatch = vi.fn();
    let completed!: Promise<unknown>;
    await act(async () => { completed = result.current.freeze(snapshot, { paymentData: { method: 'cash' } }).then(dispatch).catch(error => error); });
    const callsBeforeInspection = native.mock.calls.length;
    await expect(result.current.inspect().then(recoveryDispatch)).rejects.toThrow('CHECKOUT_DRAFT_SAVE_IN_PROGRESS');
    expect(native).toHaveBeenCalledTimes(callsBeforeInspection);
    expect(writes()).toHaveLength(1);
    expect(recoveryDispatch).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await completed;
    expect(writes()).toHaveLength(2);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(result.current.identity());
    expect(recoveryDispatch).not.toHaveBeenCalled();
  });

  it('does not apply the freeze retry policy to an ordinary editable autosave', async () => {
    const { result, writes } = await ready(1);
    await expect(result.current.persist(snapshot)).rejects.toBe('REPAIR_SCOPE_TRANSITION_PENDING');
    expect(writes()).toHaveLength(1);
    expect(result.current.isPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an explicit checkout save waits out a brief refusal and stays editable', async () => {
    const { result, writes } = await ready(3);
    let saved!: Promise<unknown>;
    await act(async () => { saved = result.current.persist(snapshot, { retryPrewriteRefusal: true }); });
    await act(async () => vi.advanceTimersByTimeAsync(100 + 250 + 500));
    expect(await saved).toBe(result.current.identity());
    expect(writes()).toHaveLength(4);
    expect(new Set(writes().map(call => JSON.stringify(call[1]))).size).toBe(1);
    expect(result.current.isPending()).toBe(false);
    expect(result.current.error).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a newer save of the cart supersedes a waiting checkout save; the older cart is never written', async () => {
    const { result, writes } = await ready(1);
    let waiting!: Promise<unknown>;
    await act(async () => { waiting = result.current.persist(snapshot, { retryPrewriteRefusal: true }).catch(error => error); });
    const newer = { ...snapshot, cartItems: [{ ...snapshot.cartItems[0], notes: 'with sugar' }] };
    await act(async () => { await result.current.persist(newer); });
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(await waiting).toMatchObject({ message: 'CHECKOUT_DRAFT_CHANGED' });
    const carts = writes().map(call => call[1].draft.cartItems[0].notes);
    expect(carts).toEqual(['without sugar', 'with sugar']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an explicit checkout save gives up after about 10 s with the refusal', async () => {
    const { result, writes } = await ready(Infinity);
    let saved!: Promise<unknown>;
    await act(async () => { saved = result.current.persist(snapshot, { retryPrewriteRefusal: true }).catch(error => error); });
    await act(async () => vi.advanceTimersByTimeAsync(9850));
    expect(await saved).toBe('REPAIR_SCOPE_TRANSITION_PENDING');
    expect(writes()).toHaveLength(8);
    expect(result.current.isPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'IPC_RESPONSE_LOST', 'CHECKOUT_DRAFT_VERSION_CHANGED', 'CHECKOUT_DRAFT_SCOPE_CHANGED',
    'REPAIR_RESET_PENDING', 'REPAIR_STAGING_MAINTENANCE_FAILED', 'database is locked',
    'REPAIR_SCOPE_TRANSITION_PENDING extra', 'prefix REPAIR_SCOPE_TRANSITION_PENDING',
    'repair_scope_transition_pending', { message: 'REPAIR_SCOPE_TRANSITION_PENDING' },
  ])('never retries other or lookalike rejection %j', async cause => {
    const { result, writes } = await ready(Infinity, cause);
    let rejected: unknown;
    await act(async () => { rejected = await result.current.freeze(snapshot, { paymentData: { method: 'card' } }).catch(error => error); });
    expect(rejected).toBe(cause);
    expect(writes()).toHaveLength(1);
    expect(result.current.error).toBe('draftSaveFailed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'unmount'] as const)('invalidating the owner by %s during backoff prevents another write and dispatch', async action => {
    const { result, rerender, unmount, writes } = await ready(1);
    const dispatch = vi.fn();
    let completed!: Promise<unknown>;
    await act(async () => { completed = result.current.freeze(snapshot, { paymentData: { method: 'card' } }).then(dispatch).catch(error => error); });
    if (action === 'close') rerender({ enabled: false }); else unmount();
    await act(async () => vi.advanceTimersByTimeAsync(850));
    expect(await completed).toMatchObject({ message: 'CHECKOUT_DRAFT_CHANGED' });
    expect(writes()).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe('restored editing-phase money protection', () => {
  it('an old freeze completion cannot release a new modal owner’s in-flight recovery fence', async () => {
    const firstWrite = deferred<any>();
    const secondWrite = deferred<any>();
    const makeStore = (gate: ReturnType<typeof deferred<any>>) => new CheckoutDraftStore(scope, async (command, input) => {
      if (command === 'checkout_draft_get') return { success: true, scope, generation: 0, draft: null };
      await gate.promise;
      return { success: true, scope, generation: 1, draft: input.draft };
    });
    mocks.getStore.mockResolvedValueOnce(makeStore(firstWrite)).mockResolvedValueOnce(makeStore(secondWrite));
    const { result, rerender } = renderHook(({ enabled }) => useCheckoutDraftPersistence(enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    act(() => result.current.markHydrated());
    const dispatch = vi.fn();
    let oldCompletion!: Promise<unknown>;
    act(() => { oldCompletion = result.current.freeze(snapshot, { paymentData: { method: 'cash' } }).then(dispatch).catch(error => error); });
    const oldIdentity = result.current.identity();
    rerender({ enabled: false }); rerender({ enabled: true });
    await waitFor(() => expect(result.current.identity()).not.toBe(oldIdentity));
    act(() => result.current.markHydrated());
    let newCompletion!: Promise<unknown>;
    act(() => { newCompletion = result.current.freeze(snapshot, { paymentData: { method: 'cash' } }).then(dispatch).catch(error => error); });
    await act(async () => { firstWrite.resolve(undefined); await oldCompletion; });
    expect(await oldCompletion).toMatchObject({ message: 'CHECKOUT_DRAFT_CHANGED' });
    await expect(result.current.inspect()).rejects.toThrow('CHECKOUT_DRAFT_SAVE_IN_PROGRESS');
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => { secondWrite.resolve(undefined); await newCompletion; });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(result.current.identity());
  });

  it('a late successful freeze cannot dispatch checkout after its modal owner closes', async () => {
    const read = deferred<any>(); const write = deferred<any>(); const native = setup(read, write);
    const { result, rerender } = renderHook(({ enabled }) => useCheckoutDraftPersistence(enabled), { initialProps: { enabled: true } });
    await act(async () => read.resolve({ success: true, scope, generation: 0, draft: null }));
    act(() => result.current.markHydrated());
    const dispatch = vi.fn();
    let completion!: Promise<unknown>;
    act(() => { completion = result.current.freeze(snapshot, { paymentData: { method: 'cash' } }).then(dispatch).catch(error => error); });
    await waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    rerender({ enabled: false });
    await act(async () => { write.resolve(undefined); await completion; });
    expect(await completion).toMatchObject({ message: 'CHECKOUT_DRAFT_CHANGED' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a stale recovery read cannot write or inspect after closing and reopening with a new draft', async () => {
    const gate = deferred<any>();
    let reads = 0;
    const firstNative = vi.fn(async (command: string) => {
      if (command === 'checkout_draft_get') return ++reads === 1 ? { success: true, scope, generation: 0, draft: null } : gate.promise;
      throw new Error('disk unavailable');
    });
    const fresh = { ...createCheckoutDraft(), ...snapshot, phase: 'checkout_pending' as const };
    const secondNative = vi.fn(async () => ({ success: true, scope, generation: 3, draft: fresh }));
    mocks.getStore.mockResolvedValueOnce(new CheckoutDraftStore(scope, firstNative)).mockResolvedValueOnce(new CheckoutDraftStore(scope, secondNative));
    const { result, rerender } = renderHook(({ enabled }) => useCheckoutDraftPersistence(enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.status).toBe('loaded')); act(() => result.current.markHydrated());
    await act(async () => { await result.current.freeze(snapshot, { paymentData: { method: 'cash' } }).catch(() => undefined); });
    let recovery!: Promise<unknown>;
    act(() => { recovery = result.current.inspect().catch(error => error); });
    await waitFor(() => expect(reads).toBe(2));
    rerender({ enabled: false }); rerender({ enabled: true });
    await waitFor(() => expect(result.current.identity()).toBe(fresh.checkoutRequestId)); act(() => result.current.markHydrated());
    await act(async () => { gate.resolve({ success: true, scope, generation: 0, draft: null }); await recovery; });
    expect(await recovery).toMatchObject({ message: 'CHECKOUT_DRAFT_CHANGED' });
    expect(firstNative.mock.calls.map(call => call[0])).toEqual(['checkout_draft_get', 'checkout_draft_put', 'checkout_draft_get']);
    expect(result.current.identity()).toBe(fresh.checkoutRequestId);
    expect(result.current.error).toBeNull();
  });

  it('retries the exact failed freeze before inspecting and never admits a fresh checkout', async () => {
    let stored: any = null;
    let generation = 0;
    let failFreeze = true;
    const native = vi.fn(async (command: string, input: any) => {
      if (command === 'checkout_draft_inspect') return { success: true, outcome: 'not_found', canCollect: false };
      if (command === 'checkout_draft_put') {
        if (failFreeze && input.draft.phase === 'checkout_pending') throw new Error('disk unavailable');
        stored = input.draft; generation++;
      }
      return { success: true, scope, generation, draft: stored };
    });
    mocks.getStore.mockResolvedValue(new CheckoutDraftStore(scope, native));
    const { result } = renderHook(() => useCheckoutDraftPersistence(true));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    act(() => result.current.markHydrated());
    const identity = result.current.identity();
    const submission = { clientRequestId: identity, paymentData: { method: 'cash', amount: 8 } };
    await act(async () => { await expect(result.current.freeze(snapshot, submission)).rejects.toThrow('disk unavailable'); });
    await act(async () => { await expect(result.current.inspect()).rejects.toThrow('disk unavailable'); });
    expect(native.mock.calls.some(call => call[0] === 'checkout_draft_inspect')).toBe(false);
    expect(result.current.error).toBe('draftSaveFailed');
    failFreeze = false;
    await act(async () => { expect(await result.current.inspect()).toMatchObject({ outcome: 'not_found', canCollect: false }); });
    expect(stored).toMatchObject({ ...snapshot, checkoutRequestId: identity, phase: 'checkout_pending', submission });
    expect(result.current.error).toBeNull();
    expect(result.current.identity()).toBe(identity);
    expect(result.current.isPending()).toBe(true);
    await expect(result.current.freeze(snapshot, submission)).rejects.toThrow('AWAITING_RECONCILIATION');
    await expect(result.current.persist(snapshot)).rejects.toThrow('AWAITING_RECONCILIATION');
  });

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


it('releases an interrupted editable loyalty reservation before restoring the cart', async () => {
  const draft = { ...createCheckoutDraft(), state: { appliedLoyaltyRedemption: { customerId: 'customer', pointsRedeemed: 100 } } };
  const read = deferred<any>();
  const native = setup(read);
  const { result } = renderHook(() => useCheckoutDraftPersistence(true));
  await act(async () => read.resolve({ success: true, scope, generation: 1, draft }));
  await waitFor(() => expect(result.current.status).toBe('loaded'));
  expect(native).toHaveBeenCalledWith('loyalty_release_redemption', { arg0: { orderId: draft.checkoutRequestId } });
  expect(result.current.restored?.checkoutRequestId).toBe(draft.checkoutRequestId);
});

it('keeps a frozen checkout loyalty debit with the original recovery request', async () => {
  const draft = { ...createCheckoutDraft(), phase: 'checkout_pending' as const, state: { appliedLoyaltyRedemption: { customerId: 'customer', pointsRedeemed: 100 } } };
  const read = deferred<any>();
  const native = setup(read);
  const { result } = renderHook(() => useCheckoutDraftPersistence(true));
  await act(async () => read.resolve({ success: true, scope, generation: 1, draft }));
  await waitFor(() => expect(result.current.status).toBe('loaded'));
  expect(native.mock.calls.some(call => call[0] === 'loyalty_release_redemption')).toBe(false);
});


it('releases an editable cart reservation before deleting its retained draft', async () => {
  const draft = { ...createCheckoutDraft(), state: { appliedLoyaltyRedemption: { pointsRedeemed: 100 } } };
  const commands: string[] = [];
  const owner = new CheckoutDraftStore(scope, async command => {
    commands.push(command);
    if (command === 'loyalty_release_redemption') return { success: true };
    return { success: true, scope, generation: command === 'checkout_draft_get' ? 1 : 2, draft: command === 'checkout_draft_delete' ? null : draft };
  });
  await owner.load();
  await owner.clear(draft.draftId, false);
  expect(commands).toEqual(['checkout_draft_get', 'loyalty_release_redemption', 'checkout_draft_delete']);
});
