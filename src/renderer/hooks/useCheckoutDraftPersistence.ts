import { useCallback, useEffect, useRef, useState } from 'react';
import { createCheckoutDraft, getCheckoutDraftStore, type CheckoutDraft, type CheckoutDraftStore } from '../services/CheckoutDraftStore';

/** Hydration is explicit: an empty first render must never overwrite a saved cart. */
export function useCheckoutDraftPersistence(enabled: boolean) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'ready' | 'error' | 'invalidated'>('loading');
  const [restored, setRestored] = useState<CheckoutDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const store = useRef<CheckoutDraftStore | null>(null);
  const current = useRef<CheckoutDraft>(createCheckoutDraft());
  const active = useRef(false);
  const lastSaved = useRef('');
  const epoch = useRef(0);

  useEffect(() => {
    if (!enabled) { active.current = false; return; }
    const generation = ++epoch.current;
    active.current = false;
    setStatus('loading');
    setError(null);
    void getCheckoutDraftStore().then(async owner => {
      let draft = await owner.load();
      if (generation !== epoch.current) return;
      if (owner.invalidation?.reason === 'edit_target_cancelled') {
        setRestored(null);
        setError('draftTargetCancelled');
        setStatus('invalidated');
        return;
      }
      if (draft?.phase === 'editing') {
        // An old editable preimage must not hide a provider reservation or held
        // payment under the same identity, even if its modal was never acknowledged.
        const proof = await owner.inspect(draft.checkoutRequestId);
        if (proof.outcome !== 'not_found') {
          draft = { ...draft, phase: 'checkout_pending' };
          await owner.save(draft);
        }
      }
      if (generation !== epoch.current) return;
      store.current = owner;
      current.current = draft || createCheckoutDraft();
      lastSaved.current = draft ? JSON.stringify(draft) : '';
      setRestored(draft);
      setStatus('loaded');
    }).catch(() => {
      if (generation !== epoch.current) return;
      setError('draftReadFailed');
      setStatus('error');
    });
    return () => { ++epoch.current; active.current = false; };
  }, [enabled]);

  const markHydrated = useCallback(() => { active.current = true; setStatus('ready'); }, []);

  const persist = useCallback(async (snapshot: Pick<CheckoutDraft, 'cartItems' | 'context' | 'state'>) => {
    if (!active.current || !store.current) throw new Error('CHECKOUT_DRAFT_NOT_READY');
    if (current.current.phase === 'checkout_pending') throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
    const draft = { ...current.current, ...snapshot };
    const signature = JSON.stringify(draft);
    if (signature !== lastSaved.current) {
      try { await store.current.save(draft); }
      catch (cause) {
        if (String(cause).includes('CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED')) {
          active.current = false;
          setError('draftTargetCancelled');
          setStatus('invalidated');
        }
        throw cause;
      }
      if (current.current.phase === 'editing') current.current = draft;
      lastSaved.current = signature;
    }
    setError(null);
    return draft.checkoutRequestId;
  }, []);

  const freeze = useCallback(async (snapshot: Pick<CheckoutDraft, 'cartItems' | 'context' | 'state'>, submission: Record<string, any>) => {
    if (!active.current || !store.current || current.current.phase === 'checkout_pending') throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
    const draft: CheckoutDraft = { ...current.current, ...snapshot, phase: 'checkout_pending', submission };
    // Freeze before the native await so a concurrent autosave cannot change its preimage.
    current.current = draft;
    setRestored(draft);
    try { await store.current.save(draft); }
    catch (cause) { setError('draftSaveFailed'); throw cause; }
    lastSaved.current = JSON.stringify(draft);
    setError(null);
    return draft.checkoutRequestId;
  }, []);

  const clear = useCallback(async (accepted: boolean) => {
    if (!store.current || (!accepted && !active.current)) throw new Error('CHECKOUT_DRAFT_NOT_READY');
    const draft = current.current;
    await store.current.clear(draft.draftId, accepted);
    current.current = createCheckoutDraft();
    lastSaved.current = '';
    active.current = false;
    setRestored(null);
  }, []);

  const failedSave = useCallback((cause?: unknown) => {
    if (String(cause).includes('CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED')) return;
    setError('draftSaveFailed');
  }, []);

  const resumeDeclined = useCallback(async () => {
    if (!active.current || !store.current || current.current.phase !== 'checkout_pending') throw new Error('CHECKOUT_DRAFT_NOT_READY');
    const owner = store.current;
    const generation = epoch.current;
    const requestId = current.current.checkoutRequestId;
    const resumed = await owner.resumeDeclined(requestId);
    if (generation !== epoch.current || !active.current || owner !== store.current || current.current.checkoutRequestId !== requestId) {
      throw new Error('CHECKOUT_DRAFT_CHANGED');
    }
    current.current = resumed;
    lastSaved.current = JSON.stringify(resumed);
    active.current = false;
    setError(null);
    setRestored(resumed);
    setStatus('loaded');
    return resumed;
  }, []);

  /**
   * Fix 4 (06/10/2026): a frozen order correction whose confirmed attempt the
   * native journal proved never applied must not leave the menu disabled
   * forever (also after a restart). Retire that frozen draft and open a fresh
   * editing draft with the same cart, a new identity (a new edit event) and
   * the refused event it replaces. Native re-proves non-application before
   * the new event may supersede it; nothing is collected or returned here.
   */
  const renewRefusedEdit = useCallback(async (supersedesEvent: string) => {
    const previous = current.current;
    if (!active.current || !store.current || previous.phase !== 'checkout_pending' ||
      previous.context?.editMode !== true || previous.submission?.action !== 'edit_settlement' ||
      previous.submission?.client_event_id !== supersedesEvent) {
      throw new Error('CHECKOUT_DRAFT_NOT_READY');
    }
    const owner = store.current;
    const generation = epoch.current;
    const fresh = createCheckoutDraft();
    const context = { ...previous.context, supersedesEditEvent: supersedesEvent };
    if ('checkoutRequestId' in context) context.checkoutRequestId = fresh.checkoutRequestId;
    const renewed: CheckoutDraft = { ...fresh, cartItems: previous.cartItems, context, state: previous.state };
    await owner.clear(previous.draftId, true);
    await owner.save(renewed);
    if (generation !== epoch.current || owner !== store.current) throw new Error('CHECKOUT_DRAFT_CHANGED');
    current.current = renewed;
    lastSaved.current = JSON.stringify(renewed);
    active.current = false;
    setError(null);
    setRestored(renewed);
    setStatus('loaded');
    return renewed;
  }, []);

  return { status, restored, error, markHydrated, persist, freeze, clear, failedSave, resumeDeclined, renewRefusedEdit,
    checkAdmission: async (context: { orderId?: string } = {}) => {
      if (!active.current || !store.current || current.current.phase === 'checkout_pending') throw new Error('CHECKOUT_DRAFT_NOT_READY');
      return store.current.checkAdmission(context);
    },
    identity: () => current.current.checkoutRequestId,
    isPending: () => current.current.phase === 'checkout_pending',
    inspect: () => {
      if (!store.current) throw new Error('CHECKOUT_DRAFT_NOT_READY');
      return store.current.inspect(current.current.checkoutRequestId);
    },
  };
}
