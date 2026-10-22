import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmPaymentAdmission as confirmedAdmissionDraft, createCheckoutDraft, getCheckoutDraftStore, type CheckoutDraft, type CheckoutDraftStore } from '../services/CheckoutDraftStore';

// Native refuses with this exact code on the binding lease, before touching
// SQLite, while a terminal binding decision drains. Tomikro's windows lasted
// 0.1–3 s (18–19/10/2026), so retry for about 10 s with the same body and CAS.
const PREWRITE_SCOPE_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 3000, 3000] as const;

function isPrewriteScopeRefusal(cause: unknown): boolean {
  const code = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : null;
  return code === 'REPAIR_SCOPE_TRANSITION_PENDING';
}

async function retryPrewriteScopeRefusal(write: () => Promise<unknown>, isCurrent: () => boolean): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (!isCurrent()) throw new Error('CHECKOUT_DRAFT_CHANGED');
    try {
      await write();
      return;
    } catch (cause) {
      if (!isCurrent()) throw new Error('CHECKOUT_DRAFT_CHANGED');
      if (!isPrewriteScopeRefusal(cause) || attempt >= PREWRITE_SCOPE_RETRY_DELAYS_MS.length) throw cause;
      await new Promise(resolve => setTimeout(resolve, PREWRITE_SCOPE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

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
  const pendingSave = useRef(false);
  const freezeInFlight = useRef<CheckoutDraft | null>(null);
  const persistRequest = useRef(0);

  useEffect(() => {
    if (!enabled) { active.current = false; return; }
    const generation = ++epoch.current;
    active.current = false;
    pendingSave.current = false;
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
        } else {
          // A crash before payment confirmation can leave the local points
          // secured while the retained cart is still editable. Release that
          // original reservation before its balance is loaded again.
          await owner.releaseEditableLoyaltyReservation(draft);
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

  const persist = useCallback(async (snapshot: Pick<CheckoutDraft, 'cartItems' | 'context' | 'state'>,
    options: { retryPrewriteRefusal?: boolean } = {}) => {
    if (!active.current || !store.current) throw new Error('CHECKOUT_DRAFT_NOT_READY');
    if (current.current.phase === 'checkout_pending') throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
    const owner = store.current;
    const generation = epoch.current;
    const request = ++persistRequest.current;
    const draft = { ...current.current, ...snapshot };
    const signature = JSON.stringify(draft);
    if (signature !== lastSaved.current) {
      // Only an explicit checkout waits out a binding refusal. A newer save of
      // the cart supersedes it, so an older snapshot is never written over it.
      const isCurrent = () => request === persistRequest.current && generation === epoch.current &&
        active.current && owner === store.current && current.current.phase === 'editing';
      try {
        if (options.retryPrewriteRefusal) await retryPrewriteScopeRefusal(() => owner.save(draft), isCurrent);
        else await owner.save(draft);
      }
      catch (cause) {
        if (generation !== epoch.current || owner !== store.current) throw new Error('CHECKOUT_DRAFT_CHANGED');
        if (String(cause).includes('CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED')) {
          active.current = false;
          setError('draftTargetCancelled');
          setStatus('invalidated');
        }
        throw cause;
      }
      if (generation !== epoch.current || !active.current || owner !== store.current) throw new Error('CHECKOUT_DRAFT_CHANGED');
      // An autosave queued before freeze must not clear its failure or replace its preimage.
      if ((current.current as CheckoutDraft).phase === 'checkout_pending') return draft.checkoutRequestId;
      if (current.current.phase === 'editing') current.current = draft;
      lastSaved.current = signature;
    }
    setError(null);
    return draft.checkoutRequestId;
  }, []);

  const freeze = useCallback(async (snapshot: Pick<CheckoutDraft, 'cartItems' | 'context' | 'state'>, submission: Record<string, any>) => {
    if (!active.current || !store.current || current.current.phase === 'checkout_pending') throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
    const draft: CheckoutDraft = JSON.parse(JSON.stringify({ ...current.current, ...snapshot, phase: 'checkout_pending', submission }));
    const owner = store.current;
    const generation = epoch.current;
    const isCurrent = () => generation === epoch.current && active.current && owner === store.current && current.current === draft;
    // Freeze before the native await so a concurrent autosave cannot change its preimage.
    current.current = draft;
    pendingSave.current = true;
    freezeInFlight.current = draft;
    setRestored(draft);
    try {
      // Nothing has dispatched payment work: retain this invocation's original
      // snapshot/CAS while the brief binding transition drains.
      await retryPrewriteScopeRefusal(() => owner.save(draft), isCurrent);
    }
    catch (cause) {
      // A stale owner after reopening is an expected cancellation, not a failure.
      if (isCurrent()) { setError('draftSaveFailed'); owner.reportFailure('save', cause, draft.phase); }
      throw cause;
    }
    finally { if (freezeInFlight.current === draft) freezeInFlight.current = null; }
    if (!isCurrent()) throw new Error('CHECKOUT_DRAFT_CHANGED');
    pendingSave.current = false;
    lastSaved.current = JSON.stringify(draft);
    setError(null);
    return draft.checkoutRequestId;
  }, []);

  // Tomikro 21/10/2026: a failed freeze is before any collection. When native
  // proves it never committed, the cart is editable again; Pay retries it.
  const abandonFailedFreeze = useCallback(async () => {
    const draft = current.current;
    if (!active.current || !store.current || freezeInFlight.current || !pendingSave.current ||
      draft.phase !== 'checkout_pending' || draft.state.paymentAdmission !== 'admitted') throw new Error('CHECKOUT_DRAFT_NOT_READY');
    const owner = store.current;
    const generation = epoch.current;
    let editing: CheckoutDraft;
    try { editing = await owner.abandonUncommittedFreeze(draft); }
    catch (cause) {
      if (String(cause).includes('CHECKOUT_DRAFT_FREEZE_COMMITTED') && generation === epoch.current && current.current === draft) {
        // It committed after all: the frozen request is durable and recovery owns it.
        pendingSave.current = false;
        lastSaved.current = JSON.stringify(draft);
        setError(null);
      } else owner.reportFailure('read', cause, draft.phase);
      throw cause;
    }
    if (generation !== epoch.current || owner !== store.current || current.current !== draft) throw new Error('CHECKOUT_DRAFT_CHANGED');
    // The store wrote this editable cart before answering.
    current.current = editing;
    lastSaved.current = JSON.stringify(editing);
    pendingSave.current = false;
    setError(null);
    setRestored(editing);
    return editing;
  }, []);

  const confirmPaymentAdmission = useCallback(async (paymentData: Record<string, any>) => {
    if (!active.current || !store.current) throw new Error('CHECKOUT_DRAFT_NOT_READY');
    const draft = confirmedAdmissionDraft(current.current, paymentData);
    const owner = store.current;
    const generation = epoch.current;
    const isCurrent = () => generation === epoch.current && active.current && owner === store.current && current.current === draft;
    current.current = draft;
    pendingSave.current = true;
    freezeInFlight.current = draft;
    setRestored(draft);
    try { await retryPrewriteScopeRefusal(() => owner.save(draft), isCurrent); }
    catch (cause) {
      // A stale owner after reopening is an expected cancellation, not a failure.
      if (isCurrent()) { setError('draftSaveFailed'); owner.reportFailure('save', cause, draft.phase); }
      throw cause;
    }
    finally { if (freezeInFlight.current === draft) freezeInFlight.current = null; }
    if (!isCurrent()) throw new Error('CHECKOUT_DRAFT_CHANGED');
    pendingSave.current = false;
    lastSaved.current = JSON.stringify(draft);
    setError(null);
    return draft.submission!;
  }, []);

  const cancelPaymentAdmission = useCallback(async (options: { confirmed?: boolean; automatic?: boolean } = {}) => {
    if (!active.current || !store.current || freezeInFlight.current) throw new Error('CHECKOUT_DRAFT_NOT_READY');
    const owner = store.current;
    const draft = current.current;
    const editing = await owner.cancelPaymentAdmission(options);
    if (owner !== store.current || current.current !== draft || !active.current) throw new Error('CHECKOUT_DRAFT_CHANGED');
    current.current = editing;
    lastSaved.current = JSON.stringify(editing);
    pendingSave.current = false;
    setRestored(editing);
    setError(null);
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

  // A manager parked the frozen checkout: the slot is free and the next
  // checkout gets a new identity, exactly as after an accepted one.
  const park = useCallback(async () => {
    if (!active.current || !store.current || freezeInFlight.current || current.current.phase !== 'checkout_pending') {
      throw new Error('CHECKOUT_DRAFT_NOT_READY');
    }
    const owner = store.current;
    const generation = epoch.current;
    const draft = current.current;
    await owner.park(draft.checkoutRequestId);
    if (generation !== epoch.current || owner !== store.current || current.current !== draft) throw new Error('CHECKOUT_DRAFT_CHANGED');
    current.current = createCheckoutDraft();
    lastSaved.current = '';
    pendingSave.current = false;
    active.current = false;
    setError(null);
    setRestored(null);
  }, []);

  const failedSave = useCallback((cause?: unknown) => {
    // An explicit no-cause call also reports a failed controlled hydration.
    if ((cause !== undefined && !active.current) || String(cause).includes('CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED') ||
      String(cause).includes('CHECKOUT_DRAFT_CHANGED') || current.current.phase === 'checkout_pending') return;
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

  return { status, restored, error, markHydrated, persist, freeze, clear, park, failedSave, resumeDeclined, renewRefusedEdit,
    abandonFailedFreeze,
    /** A freeze whose write did not confirm, before any collection. */
    hasUncommittedFreeze: () => pendingSave.current && current.current.phase === 'checkout_pending' &&
      current.current.state.paymentAdmission === 'admitted',
    checkAdmission: async (context: { orderId?: string } = {}) => {
      if (!active.current || !store.current || current.current.phase === 'checkout_pending') throw new Error('CHECKOUT_DRAFT_NOT_READY');
      return store.current.checkAdmission(context);
    },
    confirmPaymentAdmission,
    cancelPaymentAdmission,
    identity: () => current.current.checkoutRequestId,
    isPending: () => current.current.phase === 'checkout_pending',
    hasSubmission: () => Boolean(current.current.submission),
    /** A renewed refused correction: it supersedes an attempt the native journal still holds. */
    supersedesEdit: () => typeof current.current.context?.supersedesEditEvent === 'string' &&
      current.current.context.supersedesEditEvent.length > 0,
    inspect: async () => {
      if (!store.current) throw new Error('CHECKOUT_DRAFT_NOT_READY');
      const owner = store.current;
      const generation = epoch.current;
      const draft = current.current;
      // Recovery cannot race this same invocation's pending write/backoff and
      // dispatch the original callback before freeze itself acknowledges it.
      if (freezeInFlight.current === draft) throw new Error('CHECKOUT_DRAFT_SAVE_IN_PROGRESS');
      const isCurrent = () => generation === epoch.current && owner === store.current && current.current === draft;
      if (pendingSave.current) {
        if (!active.current) throw new Error('CHECKOUT_DRAFT_NOT_READY');
        try { await owner.retryFrozenSave(draft, () => isCurrent() && active.current); }
        catch (cause) {
          if (isCurrent()) { setError('draftSaveFailed'); owner.reportFailure('save', cause, draft.phase); }
          throw cause;
        }
        if (!isCurrent()) throw new Error('CHECKOUT_DRAFT_CHANGED');
        pendingSave.current = false;
        lastSaved.current = JSON.stringify(draft);
        setError(null);
      }
      const proof = await owner.inspect(draft.checkoutRequestId);
      if (!isCurrent()) throw new Error('CHECKOUT_DRAFT_CHANGED');
      return proof;
    },
  };
}
