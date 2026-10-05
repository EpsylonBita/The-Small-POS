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
const nativeTransport: DraftTransport = (command, input) => getBridge().invoke(command, input);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

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

  constructor(private scope: CheckoutDraftScope, private readonly transport: DraftTransport = nativeTransport) {}

  private accept(reply: CheckoutDraftReply): CheckoutDraft | null {
    if (!reply?.success || !Number.isSafeInteger(reply.generation) || reply.generation < 0 ||
      reply.scope?.organizationId !== this.scope.organizationId || reply.scope?.branchId !== this.scope.branchId ||
      !reply.scope?.terminalId) throw new Error('CHECKOUT_DRAFT_STORAGE_UNAVAILABLE');
    if (reply.draft) validateCheckoutDraft(reply.draft);
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
      if (this.draft?.phase === 'checkout_pending' && JSON.stringify(this.draft) !== JSON.stringify(snapshot)) {
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

  clear(draftId: string, accepted = false): Promise<void> {
    return this.ordered(async () => {
      await this.load();
      if (!this.draft || this.draft.draftId !== draftId) throw new Error('CHECKOUT_DRAFT_CHANGED');
      if (!accepted && this.draft.phase !== 'editing') throw new Error('CHECKOUT_DRAFT_AWAITING_RECONCILIATION');
      this.accept(await this.transport('checkout_draft_delete', {
        ...this.scope, expectedGeneration: this.generation,
      }));
      this.retired.add(draftId);
      this.loaded = Promise.resolve(null);
    });
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
