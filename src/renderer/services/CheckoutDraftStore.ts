import { getBridge } from '../../lib';
import { refreshTerminalCredentialCache } from './terminal-credentials';

export interface CheckoutDraftScope {
  organizationId: string;
  branchId: string;
  terminalId: string;
}

export interface CheckoutDraft {
  schemaVersion: 1;
  draftId: string;
  checkoutRequestId: string;
  phase: 'editing' | 'checkout_pending';
  cartItems: any[];
  context: Record<string, any>;
  state: Record<string, any>;
  submission?: Record<string, any>;
}

export interface CheckoutDraftReply {
  success: boolean;
  draft: CheckoutDraft | null;
  generation: number;
  scope: CheckoutDraftScope;
  invalidation?: { reason: 'edit_target_cancelled'; orderId: string };
}

export interface CheckoutDraftInspection {
  success: boolean;
  outcome: 'saved' | 'held' | 'uncertain' | 'not_found' | 'declined' | 'not_sent' | 'not_charged';
  order?: any;
  orderId?: string;
  payments?: any[];
  canCollect: false;
  /**
   * Native: nothing on this till could have charged the card (no order, no
   * terminal row, no held payment, and no cash register that drives a card
   * terminal), so only the cashier can say what the bank POS shows.
   */
  cashierCanConfirmCard?: boolean;
  /** Native: a press of this checkout is still running and may yet write it. */
  checkoutInProgress?: boolean;
}

/** Payments no provider collects before the order exists (Tomikro 21/10/2026). */
const TILL_RECORDED_METHODS = ['cash', 'pending', 'table'];

type DraftTransport = (command: string, input: Record<string, any>) => Promise<any>;

export class LegacyShiftCurrencyConfirmationRequired extends Error {
  constructor(readonly shiftId: string, readonly currency: string) {
    super('LEGACY_SHIFT_CURRENCY_CONFIRMATION_REQUIRED');
  }
}
const nativeTransport: DraftTransport = (command, input) => getBridge().invoke(command, input);

/**
 * A refusal raised here, before or after native, never reached the native
 * support log (Tomikro 21/10/2026: a failed freeze left no trace). Native
 * errors arrive as strings and are logged where they happen.
 */
export function draftFailureClass(cause: unknown): string | null {
  if (!(cause instanceof Error)) return null;
  const code = cause.message;
  const ownCode = code.startsWith('CHECKOUT_');
  if (!ownCode && !(cause instanceof TypeError || cause instanceof RangeError || cause instanceof ReferenceError)) return null;
  if (/CHECKOUT_DRAFT_CHANGED|CHECKOUT_REQUEST_ID_CHANGED|VERSION_CHANGED/.test(code)) return 'version_changed';
  if (/SCOPE/.test(code)) return 'scope_changed';
  if (/AWAITING_RECONCILIATION|CHECKOUT_DRAFT_INVALID/.test(code)) return 'invalid';
  if (/STORAGE_UNAVAILABLE|NOT_READY/.test(code)) return 'storage_unavailable';
  return 'unclassified';
}
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
// Native JSON object key order is not the renderer's insertion order.
const draftSignature = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

// Confirmation may add receipt evidence; the admitted money and identity stay frozen.
export function confirmPaymentAdmission(draft: CheckoutDraft, paymentData: Record<string, any>): CheckoutDraft {
  const next = copy(draft);
  const { ordinaryOwner: _owner, ...durablePayment } = paymentData;
  const original = next.submission?.paymentData;
  const withoutEvidence = (value: Record<string, any>) => { const result = { ...value }; delete result.metadata; return result; };
  if (next.phase !== 'checkout_pending' || !original ||
    !['admitted', 'confirmed'].includes(next.state.paymentAdmission) ||
    draftSignature(withoutEvidence(original)) !== draftSignature(withoutEvidence(durablePayment))) {
    throw new Error('CHECKOUT_DRAFT_PAYMENT_CHANGED');
  }
  next.submission!.paymentData = durablePayment;
  next.state.paymentAdmission = 'confirmed';
  return next;
}

function isPaymentAdmissionConfirmation(previous: CheckoutDraft, next: CheckoutDraft): boolean {
  if (previous.state.paymentAdmission !== 'admitted' || next.state.paymentAdmission !== 'confirmed') return false;
  try { return draftSignature(confirmPaymentAdmission(previous, next.submission?.paymentData || {})) === draftSignature(next); }
  catch { return false; }
}

export function validateCheckoutDraft(value: unknown): asserts value is CheckoutDraft {
  const draft = value as CheckoutDraft;
  if (!draft || draft.schemaVersion !== 1 || !draft.draftId || !draft.checkoutRequestId ||
    !['editing', 'checkout_pending'].includes(draft.phase) || !Array.isArray(draft.cartItems) ||
    !draft.context || !draft.state || typeof draft.context !== 'object' || typeof draft.state !== 'object') {
    throw new Error('CHECKOUT_DRAFT_INVALID');
  }
}

/** Ordered native writes, generation CAS and an immutable checkout preimage. */
export class CheckoutDraftStore {
  private generation: number | null = null;
  private draft: CheckoutDraft | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private loaded: Promise<CheckoutDraft | null> | null = null;
  private retired = new Set<string>();
  private retiredCheckouts = new Set<string>();
  private editingTicket = 0;
  invalidation: CheckoutDraftReply['invalidation'];

  constructor(private scope: CheckoutDraftScope, private readonly transport: DraftTransport = nativeTransport) {}

  private validateReply(reply: CheckoutDraftReply): void {
    if (!reply?.success || !Number.isSafeInteger(reply.generation) || reply.generation < 0 ||
      reply.scope?.organizationId !== this.scope.organizationId || reply.scope?.branchId !== this.scope.branchId ||
      !reply.scope?.terminalId) throw new Error('CHECKOUT_DRAFT_STORAGE_UNAVAILABLE');
    if (reply.draft) validateCheckoutDraft(reply.draft);
  }

  private accept(reply: CheckoutDraftReply): CheckoutDraft | null {
    this.validateReply(reply);
    this.invalidation = !reply.draft && reply.invalidation?.reason === 'edit_target_cancelled' ? reply.invalidation : undefined;
    this.scope = { ...reply.scope };
    this.generation = reply.generation;
    this.draft = reply.draft ? copy(reply.draft) : null;
    return this.draft ? copy(this.draft) : null;
  }

  load(): Promise<CheckoutDraft | null> {
    if (!this.loaded) {
      this.loaded = this.transport('checkout_draft_get', this.scope).then(reply => this.accept(reply));
      // A failed read stays a failed admission; it cannot become an empty draft.
    }
    return this.loaded.then(draft => draft ? copy(draft) : null);
  }

  private ordered<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  save(draft: CheckoutDraft): Promise<CheckoutDraft | null> {
    validateCheckoutDraft(draft);
    const snapshot = copy(draft);
    // Tomikro 21/10/2026: every cart change queued its own durable write and
    // "Complete order" waited behind all of them. An editable snapshot that a
    // newer one replaced while it waited is not written; the newer one carries
    // it. A frozen checkout (freeze, confirmation) is always written.
    const ticket = snapshot.phase === 'editing' ? ++this.editingTicket : this.editingTicket;
    return this.ordered(async () => {
      await this.load();
      if (snapshot.phase === 'editing' && ticket !== this.editingTicket && this.draft?.phase !== 'checkout_pending') {
        return this.draft ? copy(this.draft) : null;
      }
      if (this.retired.has(snapshot.draftId)) throw new Error('CHECKOUT_DRAFT_CHANGED');
      if (this.retiredCheckouts.has(snapshot.checkoutRequestId)) throw new Error('CHECKOUT_REQUEST_ID_CHANGED');
      if (this.draft?.phase === 'checkout_pending' && draftSignature(this.draft) !== draftSignature(snapshot) &&
        !isPaymentAdmissionConfirmation(this.draft, snapshot)) {
        throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
      }
      const reply = await this.transport('checkout_draft_put', {
        ...this.scope, expectedGeneration: this.generation, draft: snapshot,
      });
      const result = this.accept(reply);
      this.loaded = Promise.resolve(result);
      return result;
    });
  }

  /** Explicit recovery of a failed freeze, including a committed write whose ACK was lost. */
  retryFrozenSave(draft: CheckoutDraft, isCurrent: () => boolean): Promise<CheckoutDraft> {
    validateCheckoutDraft(draft);
    const snapshot = copy(draft);
    if (snapshot.phase !== 'checkout_pending') throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
    return this.ordered(async () => {
      await this.load();
      if (!isCurrent() || this.retired.has(snapshot.draftId) || this.retiredCheckouts.has(snapshot.checkoutRequestId)) {
        throw new Error('CHECKOUT_DRAFT_CHANGED');
      }
      const reply: CheckoutDraftReply = await this.transport('checkout_draft_get', this.scope);
      this.validateReply(reply);
      if (!isCurrent() || reply.scope.terminalId !== this.scope.terminalId || reply.invalidation ||
        reply.generation < this.generation!) throw new Error('CHECKOUT_DRAFT_CHANGED');
      if (draftSignature(reply.draft) === draftSignature(snapshot)) {
        // Fresh complete scoped readback proves this exact frozen request is durable.
        const result = this.accept(reply)!;
        this.loaded = Promise.resolve(result);
        return result;
      }
      if (reply.generation !== this.generation || draftSignature(reply.draft) !== draftSignature(this.draft) ||
        (reply.draft && ((reply.draft.phase !== 'editing' && !isPaymentAdmissionConfirmation(reply.draft, snapshot)) || reply.draft.draftId !== snapshot.draftId ||
          reply.draft.checkoutRequestId !== snapshot.checkoutRequestId))) throw new Error('CHECKOUT_DRAFT_CHANGED');
      const saved: CheckoutDraftReply = await this.transport('checkout_draft_put', {
        ...this.scope, expectedGeneration: this.generation, draft: snapshot,
      });
      this.validateReply(saved);
      if (!isCurrent() || saved.scope.terminalId !== this.scope.terminalId ||
        saved.generation !== reply.generation + 1 ||
        draftSignature(saved.draft) !== draftSignature(snapshot)) throw new Error('CHECKOUT_DRAFT_CHANGED');
      const result = this.accept(saved)!;
      this.loaded = Promise.resolve(result);
      return result;
    });
  }

  /**
   * Tomikro 21/10/2026: `confirmed` also ends a confirmed admission whose order
   * was never written, for money no provider collects (cash, split, a card this
   * till records by hand). `automatic` (no cashier answer) additionally needs
   * native proof that nothing on this till could have charged a card. Native
   * must find nothing for the attempt and no press of it still running.
   */
  cancelPaymentAdmission(options: { confirmed?: boolean; automatic?: boolean } = {}): Promise<CheckoutDraft> {
    return this.ordered(async () => {
      await this.load();
      if (this.draft?.phase === 'editing' && this.draft.state.paymentAdmissionCancelled === true) {
        await this.releaseEditableLoyaltyReservation(this.draft);
        return copy(this.draft);
      }
      const payment = this.draft?.submission?.paymentData;
      const tillRecorded = TILL_RECORDED_METHODS.includes(payment?.method) ||
        (payment?.method === 'card' && !payment?.metadata?.provider && !payment?.metadata?.confirmation);
      const admission = this.draft?.state.paymentAdmission;
      if (this.draft?.phase !== 'checkout_pending' ||
        !(admission === 'admitted' || (options.confirmed === true && admission === 'confirmed' && tillRecorded)) ||
        (options.automatic === true && !tillRecorded)) throw new Error('CHECKOUT_DRAFT_CHANGED');
      const proof = await this.inspect(this.draft.checkoutRequestId);
      if (proof.outcome !== 'not_found' || proof.checkoutInProgress === true ||
        (options.automatic === true && payment?.method === 'card' && proof.cashierCanConfirmCard !== true)) {
        throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
      }
      const editing = copy(this.draft);
      editing.phase = 'editing';
      delete editing.submission;
      delete editing.state.paymentAdmission;
      editing.state.paymentAdmissionCancelled = true;
      // Invalidate the replayable discount first. A failed release is retried
      // from this editable draft, never from its old secured submission.
      const result = this.accept(await this.transport('checkout_draft_put', { ...this.scope, expectedGeneration: this.generation, draft: editing }));
      this.loaded = Promise.resolve(result);
      await this.releaseEditableLoyaltyReservation(editing);
      return result!;
    });
  }

  /** Best effort: one fixed code in the native support log, never the cart. */
  reportFailure(operation: 'save' | 'read', cause: unknown, phase: CheckoutDraft['phase']): void {
    const failureClass = draftFailureClass(cause);
    if (!failureClass) return;
    void Promise.resolve()
      .then(() => this.transport('checkout_draft_report_failure', { operation, failureClass, draftPhase: phase }))
      .catch(() => undefined);
  }

  /**
   * Tomikro 21/10/2026: a freeze whose write failed comes before any
   * collection. A fresh native read decides. If the slot still holds the
   * editable cart (or nothing), the frozen write never committed: the cart is
   * written back as editable (CAS), then its admission's points are released,
   * and Pay retries. Review 22/10/2026: it stayed in memory only, so closing
   * the app before the next change lost it. If the slot holds the frozen
   * request after all, recovery owns it.
   */
  abandonUncommittedFreeze(snapshot: CheckoutDraft): Promise<CheckoutDraft> {
    return this.ordered(async () => {
      const reply: CheckoutDraftReply = await this.transport('checkout_draft_get', this.scope);
      this.validateReply(reply);
      if (reply.invalidation || reply.scope.terminalId !== this.scope.terminalId) throw new Error('CHECKOUT_DRAFT_CHANGED');
      if (draftSignature(reply.draft) === draftSignature(snapshot)) {
        const committed = this.accept(reply);
        this.loaded = Promise.resolve(committed);
        throw new Error('CHECKOUT_DRAFT_FREEZE_COMMITTED');
      }
      if (reply.draft && (reply.draft.phase !== 'editing' || reply.draft.draftId !== snapshot.draftId ||
        reply.draft.checkoutRequestId !== snapshot.checkoutRequestId)) throw new Error('CHECKOUT_DRAFT_CHANGED');
      const durable = this.accept(reply);
      this.loaded = Promise.resolve(durable);
      const editing = copy(snapshot);
      editing.phase = 'editing';
      delete editing.submission;
      delete editing.state.paymentAdmission;
      editing.state.paymentAdmissionCancelled = true;
      // As cancelPaymentAdmission: the editable cart is durable before its
      // reservation is released, so a failed release retries from it.
      const result = this.accept(await this.transport('checkout_draft_put', { ...this.scope, expectedGeneration: this.generation, draft: editing }));
      this.loaded = Promise.resolve(result);
      await this.releaseEditableLoyaltyReservation(editing);
      return result!;
    });
  }

  async releaseEditableLoyaltyReservation(draft: CheckoutDraft): Promise<void> {
    if (draft.phase !== 'editing' || !draft.state.appliedLoyaltyRedemption) return;
    const reply = await this.transport('loyalty_release_redemption', { arg0: { orderId: draft.checkoutRequestId } });
    if (reply?.success !== true) throw new Error('LOYALTY_RELEASE_NOT_CONFIRMED');
  }

  clear(draftId: string, accepted = false): Promise<void> {
    return this.ordered(async () => {
      await this.load();
      if ((this.draft && this.draft.draftId !== draftId) || (!this.draft && accepted)) throw new Error('CHECKOUT_DRAFT_CHANGED');
      if (!accepted && this.draft && this.draft.phase !== 'editing') throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
      if (!accepted && this.draft) await this.releaseEditableLoyaltyReservation(this.draft);
      this.accept(await this.transport('checkout_draft_delete', {
        ...this.scope, expectedGeneration: this.generation,
      }));
      this.retired.add(draftId);
      this.loaded = Promise.resolve(null);
    });
  }

  async checkAdmission(context: { orderId?: string } = {}): Promise<string> {
    await this.load();
    const reply = await this.transport('checkout_draft_check_admission', { ...this.scope, ...context });
    if (reply?.success === false && reply.code === 'LEGACY_SHIFT_CURRENCY_CONFIRMATION_REQUIRED' &&
      typeof reply.shiftId === 'string' && reply.shiftId && /^[A-Z]{3}$/.test(reply.currency || '')) {
      throw new LegacyShiftCurrencyConfirmationRequired(reply.shiftId, reply.currency);
    }
    if (reply?.success !== true || !/^[A-Z]{3}$/.test(reply.currency || '')) throw new Error('STORE_CURRENCY_UNAVAILABLE');
    return reply.currency;
  }

  async inspect(checkoutRequestId: string): Promise<CheckoutDraftInspection> {
    await this.load();
    if (this.draft?.checkoutRequestId !== checkoutRequestId) throw new Error('CHECKOUT_DRAFT_CHANGED');
    const result = await this.transport('checkout_draft_inspect', { ...this.scope, clientRequestId: checkoutRequestId,
      ...(this.draft.context.editMode ? { editOrderId: this.draft.context.editOrderId,
        clientEventId: this.draft.submission?.client_event_id || checkoutRequestId } : {}),
    });
    if (!result?.success || result.canCollect !== false ||
      !['saved', 'held', 'uncertain', 'not_found', 'declined', 'not_sent', 'not_charged'].includes(result.outcome)) throw new Error('CHECKOUT_DRAFT_RECOVERY_UNAVAILABLE');
    return result;
  }

  /**
   * A manager sets aside a frozen checkout recovery cannot settle (Tomikro
   * 21/10/2026). Native re-proves the attempt under its lock, archives the
   * exact draft and records who approved it; every order, payment, terminal
   * row and held payment keeps its own recovery. The next checkout is new.
   */
  park(checkoutRequestId: string): Promise<void> {
    return this.ordered(async () => {
      await this.load();
      const previous = this.draft;
      if (previous?.phase !== 'checkout_pending' || previous.checkoutRequestId !== checkoutRequestId) throw new Error('CHECKOUT_DRAFT_CHANGED');
      const reply: CheckoutDraftReply = await this.transport('checkout_draft_park', {
        ...this.scope, expectedGeneration: this.generation, draftId: previous.draftId, clientRequestId: checkoutRequestId,
      });
      this.validateReply(reply);
      if (reply.draft || reply.generation <= this.generation!) throw new Error('CHECKOUT_DRAFT_RECOVERY_UNAVAILABLE');
      this.accept(reply);
      this.retired.add(previous.draftId);
      this.retiredCheckouts.add(checkoutRequestId);
      this.loaded = Promise.resolve(null);
    });
  }

  /** Explicit native refusal proof and CAS renew the attempt; this never collects. */
  resumeDeclined(checkoutRequestId: string): Promise<CheckoutDraft> {
    return this.ordered(async () => {
      await this.load();
      const previous = this.draft;
      if (previous?.phase !== 'checkout_pending' || previous.checkoutRequestId !== checkoutRequestId) throw new Error('CHECKOUT_DRAFT_CHANGED');
      const reply = await this.transport('checkout_draft_resume_declined', {
        ...this.scope, expectedGeneration: this.generation, draftId: previous.draftId, clientRequestId: checkoutRequestId,
      });
      const resumed = reply?.draft as CheckoutDraft | undefined;
      const originalContext = { ...previous.context }; delete originalContext.checkoutRequestId;
      const resumedContext = { ...resumed?.context }; delete resumedContext.checkoutRequestId;
      if (!resumed || resumed.phase !== 'editing' || resumed.draftId !== previous.draftId ||
        resumed.checkoutRequestId === checkoutRequestId || resumed.submission !== undefined ||
        resumed.context?.checkoutRequestId !== resumed.checkoutRequestId ||
        JSON.stringify(resumedContext) !== JSON.stringify(originalContext) ||
        JSON.stringify(resumed.cartItems) !== JSON.stringify(previous.cartItems) ||
        JSON.stringify(resumed.state) !== JSON.stringify(previous.state)) throw new Error('CHECKOUT_DRAFT_RECOVERY_UNAVAILABLE');
      const accepted = this.accept(reply)!;
      this.retiredCheckouts.add(checkoutRequestId);
      this.loaded = Promise.resolve(accepted);
      return copy(accepted);
    });
  }
}

export async function getCheckoutDraftStore(): Promise<CheckoutDraftStore> {
  const identity = await refreshTerminalCredentialCache();
  if (!identity?.organizationId || !identity.branchId || !identity.terminalId) throw new Error('CHECKOUT_DRAFT_SCOPE_UNAVAILABLE');
  const scope = { organizationId: identity.organizationId, branchId: identity.branchId, terminalId: identity.terminalId };
  return new CheckoutDraftStore(scope);
}

export function createCheckoutDraft(): CheckoutDraft {
  const id = globalThis.crypto.randomUUID();
  return { schemaVersion: 1, draftId: id, checkoutRequestId: id, phase: 'editing', cartItems: [], context: {}, state: {} };
}
