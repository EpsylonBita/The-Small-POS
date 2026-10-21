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
}

type DraftTransport = (command: string, input: Record<string, any>) => Promise<any>;

export class LegacyShiftCurrencyConfirmationRequired extends Error {
  constructor(readonly shiftId: string, readonly currency: string) {
    super('LEGACY_SHIFT_CURRENCY_CONFIRMATION_REQUIRED');
  }
}
const nativeTransport: DraftTransport = (command, input) => getBridge().invoke(command, input);
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
    return this.ordered(async () => {
      await this.load();
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

  cancelPaymentAdmission(): Promise<CheckoutDraft> {
    return this.ordered(async () => {
      await this.load();
      if (this.draft?.phase === 'editing' && this.draft.state.paymentAdmissionCancelled === true) {
        await this.releaseEditableLoyaltyReservation(this.draft);
        return copy(this.draft);
      }
      if (this.draft?.phase !== 'checkout_pending' || this.draft.state.paymentAdmission !== 'admitted') throw new Error('CHECKOUT_DRAFT_CHANGED');
      const proof = await this.inspect(this.draft.checkoutRequestId);
      if (proof.outcome !== 'not_found') throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
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
