/**
 * GiftCardsApiService - Windows POS client for the terminal-authenticated
 * `/api/pos/gift-cards/*` contract (status, lookup, issue, reload, redeem,
 * transactions). Android parity reference: POSSystemMobile `GiftCardsScreen`
 * and the gift card methods of its `AdminApiService`.
 *
 * Money rules:
 * - Card numbers are bearer credentials. They are never logged, never stored
 *   in a persistent or generic cache, and the pending-attempt store keeps only
 *   a digest of each request.
 * - Every mutation carries an idempotency key. The key stays bound to the same
 *   terminal scope, action and value-affecting fields until the server
 *   confirms success, so a retry after a failed or unknown outcome can never
 *   apply the same change twice. Mutations are never queued offline.
 * - Amounts are validated as whole cents before anything is sent.
 */

import { getBridge } from '../../lib';

const API_BASE = '/api/pos/gift-cards';
const FETCH_CHANNEL = 'api:fetch-from-admin';
const CARD_NUMBER_PATTERN = /^[A-Z0-9]{8,64}$/;
const AMOUNT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const MODULE_DISABLED_CODES = ['GIFT_CARDS_MODULE_DISABLED', 'MODULE_REQUIRED'];
const SERVICE_UNAVAILABLE_CODES = ['GIFT_CARDS_SCHEMA_UNAVAILABLE', 'GIFT_CARDS_NOT_CONFIGURED'];

/** Mirrors the server's `z.number().positive().max(999999)`. */
export const GIFT_CARD_MAX_AMOUNT_CENTS = 99_999_900;

export type GiftCardMutationAction = 'issue' | 'reload' | 'redeem';

type AdminFetchOptions = { method: 'GET' | 'POST'; body?: Record<string, unknown> };

/** The bridge entry points this service needs; tests inject a fake. */
export interface GiftCardsBridge {
  invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  adminApi?: {
    fetchFromAdmin: (path: string, options?: AdminFetchOptions) => Promise<unknown>;
  };
}

export interface GiftCardScope {
  organizationId?: string | null;
  terminalId?: string | null;
}

export interface GiftCardsStatus {
  enabled: boolean;
  configured: boolean;
  unavailable: boolean;
  moduleEnabled: boolean;
  terminalEnabled: boolean;
  supportsLookup: boolean;
  supportsIssue: boolean;
  supportsReload: boolean;
  supportsRedeem: boolean;
  supportsHistory: boolean;
  /** Currency the server reports for issuing new cards; null means not configured. */
  currency: string | null;
  reason: string | null;
}

export interface GiftCard {
  id: string;
  maskedNumber: string;
  balance: number;
  initialBalance: number | null;
  currency: string | null;
  status: string;
  expiresAt: string | null;
  issuedAt: string | null;
}

export interface GiftCardTransaction {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number | null;
  currency: string | null;
  note: string | null;
  orderId: string | null;
  createdAt: string | null;
}

/**
 * - `invalid`: rejected locally, nothing was sent.
 * - `busy`: the same action is already in flight for this terminal.
 * - `offline`: the answer came from the native offline cache.
 * - `unknown`: a mutation got no trustworthy answer; retry with the same key.
 */
export type GiftCardsFailureKind =
  | 'invalid'
  | 'busy'
  | 'offline'
  | 'module_disabled'
  | 'unavailable'
  | 'not_found'
  | 'rejected'
  | 'unknown';

export interface GiftCardsFailure {
  ok: false;
  kind: GiftCardsFailureKind;
  status: number | null;
  code: string | null;
}

export type GiftCardsResult<T> = { ok: true; data: T } | GiftCardsFailure;

export interface GiftCardLookupResult {
  card: GiftCard;
  transactions: GiftCardTransaction[];
}

export interface GiftCardIssueResult {
  card: GiftCard;
  /** Full number, returned only at issuance when the server generated or matched it. */
  cardNumber: string | null;
}

export interface GiftCardBalanceResult {
  card: GiftCard | null;
}

export interface GiftCardIssueInput {
  cardNumber?: string | null;
  amountCents: number;
  currency: string;
  note?: string | null;
}

export interface GiftCardBalanceInput {
  cardId: string;
  cardNumber: string;
  amountCents: number;
  currency: string;
  note?: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asNumber = (value: unknown): number | null => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** Same normalization as the server: strip spaces and dashes, uppercase, 8-64 alphanumerics. */
export function normalizeGiftCardNumber(input: string | null | undefined): string | null {
  const normalized = String(input ?? '').replace(/[\s-]+/g, '').toUpperCase();
  return CARD_NUMBER_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeCurrencyCode(input: unknown): string | null {
  const normalized = typeof input === 'string' ? input.trim().toUpperCase() : '';
  return CURRENCY_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Parse a cashier-entered amount into whole cents. Accepts a dot or comma
 * decimal separator; rejects zero, negatives, NaN, more than two decimals and
 * anything above the server maximum.
 */
export function parseAmountToCents(input: string | number | null | undefined): number | null {
  let raw: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    raw = String(input);
  } else {
    raw = String(input ?? '').trim();
  }
  if (!AMOUNT_PATTERN.test(raw)) return null;
  const [whole, fraction = ''] = raw.replace(',', '.').split('.');
  return validCents(Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}

const validCents = (cents: number): number | null =>
  Number.isSafeInteger(cents) && cents > 0 && cents <= GIFT_CARD_MAX_AMOUNT_CENTS ? cents : null;

export const centsToAmount = (cents: number): number => cents / 100;

export function mapGiftCard(value: unknown): GiftCard | null {
  const record = asRecord(value);
  const id = asString(record.id);
  const balance = asNumber(record.balance);
  if (!id || balance === null) return null;
  const last4 = asString(record.card_number_last4);
  return {
    id,
    maskedNumber: asString(record.masked_number) ?? (last4 ? `****${last4}` : '****'),
    balance,
    initialBalance: asNumber(record.initial_balance),
    currency: normalizeCurrencyCode(record.currency),
    status: asString(record.status)?.toLowerCase() ?? 'unknown',
    expiresAt: asString(record.expires_at),
    issuedAt: asString(record.issued_at) ?? asString(record.created_at),
  };
}

export function mapGiftCardTransaction(value: unknown): GiftCardTransaction | null {
  const record = asRecord(value);
  const id = asString(record.id);
  const amount = asNumber(record.amount);
  if (!id || amount === null) return null;
  return {
    id,
    type: asString(record.transaction_type)?.toLowerCase() ?? 'unknown',
    amount,
    balanceAfter: asNumber(record.balance_after),
    currency: normalizeCurrencyCode(record.currency),
    note: asString(record.note),
    orderId: asString(record.order_id),
    createdAt: asString(record.created_at),
  };
}

const mapTransactions = (value: unknown): GiftCardTransaction[] =>
  Array.isArray(value)
    ? value
        .map(mapGiftCardTransaction)
        .filter((entry): entry is GiftCardTransaction => entry !== null)
    : [];

/** Status flags fail closed: anything the server did not affirm is false. */
export function mapGiftCardsStatus(payload: Record<string, unknown>): GiftCardsStatus {
  const source = asRecord(payload.gift_cards ?? payload.config ?? payload);
  const unavailable = payload.unavailable === true || source.unavailable === true;
  return {
    enabled: source.enabled === true && payload.enabled !== false && !unavailable,
    configured: source.configured === true && payload.configured !== false,
    unavailable,
    moduleEnabled: source.module_enabled === true,
    terminalEnabled: source.terminal_enabled === true,
    supportsLookup: source.supports_lookup === true,
    supportsIssue: source.supports_issue === true,
    supportsReload: source.supports_reload === true,
    supportsRedeem: source.supports_redeem === true,
    supportsHistory: source.supports_history === true,
    currency: normalizeCurrencyCode(source.currency ?? payload.currency),
    reason: asString(payload.error) ?? asString(source.reason),
  };
}

interface NativeAdminResponse {
  success: boolean;
  payload: Record<string, unknown>;
  status: number | null;
  fromCache: boolean;
  codes: string[];
}

const collectCodes = (...records: Record<string, unknown>[]): string[] =>
  records.flatMap((record) =>
    [record.code, record.error, record.message].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );

function readNativeResponse(raw: unknown): NativeAdminResponse {
  const envelope = asRecord(raw);
  const isEnvelope = typeof envelope.success === 'boolean';
  const payload = asRecord(isEnvelope ? envelope.data : raw);
  const meta = asRecord(envelope.meta);
  return {
    success: (isEnvelope ? envelope.success === true : true) && payload.success !== false,
    payload,
    status: typeof envelope.status === 'number' ? envelope.status : null,
    fromCache: meta.source === 'cache' || meta.offlineFallback === true,
    codes: collectCodes(envelope, payload, asRecord(envelope.details)),
  };
}

const matchesAny = (codes: string[], known: string[]): boolean =>
  codes.some((code) => known.some((candidate) => code.includes(candidate)));

function classifyFailure(
  response: NativeAdminResponse,
  context: 'read' | 'lookup' | 'mutation',
): GiftCardsFailure {
  const failure = (kind: GiftCardsFailureKind): GiftCardsFailure => ({
    ok: false,
    kind,
    status: response.status,
    code: response.codes.find((code) => ERROR_CODE_PATTERN.test(code)) ?? null,
  });
  if (response.fromCache) return failure('offline');
  if (matchesAny(response.codes, MODULE_DISABLED_CODES)) return failure('module_disabled');
  if (matchesAny(response.codes, SERVICE_UNAVAILABLE_CODES)) return failure('unavailable');
  const status = response.status;
  if (status === 404) return failure(context === 'read' ? 'unavailable' : 'not_found');
  if (status !== null && status >= 400 && status < 500) return failure('rejected');
  // 5xx, a missing status or a transport error: a mutation may or may not
  // have been applied, so it stays retryable with the same idempotency key.
  return failure(context === 'mutation' ? 'unknown' : 'unavailable');
}

const invalid = (code: string): GiftCardsFailure => ({ ok: false, kind: 'invalid', status: null, code });

/** FNV-1a digest so the attempt store never holds a raw card number. */
function digest(parts: ReadonlyArray<string | number>): string {
  const text = parts.join('\u001f');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x5bd1e995) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

const toScopeKey = (scope: GiftCardScope | null | undefined): string | null => {
  const organizationId = asString(scope?.organizationId);
  const terminalId = asString(scope?.terminalId);
  return organizationId && terminalId ? JSON.stringify([organizationId, terminalId]) : null;
};

const createIdempotencyKey = (): string => {
  const key = globalThis.crypto?.randomUUID?.();
  if (!key) throw new Error('GIFT_CARD_IDEMPOTENCY_UNAVAILABLE');
  return key;
};

/**
 * In-memory idempotency keys for gift card mutations. Each slot is the
 * organization + terminal scope, the action and a digest of every
 * value-affecting field; its key is kept until the server confirms success.
 * Nothing here is persisted and no slot is visible from another scope.
 */
export class GiftCardAttemptStore {
  private readonly keys = new Map<string, string>();

  constructor(private readonly createKey: () => string = createIdempotencyKey) {}

  resolve(slot: string): string {
    const existing = this.keys.get(slot);
    if (existing) return existing;
    const key = this.createKey();
    this.keys.set(slot, key);
    return key;
  }

  settle(slot: string, key: string): void {
    if (this.keys.get(slot) === key) this.keys.delete(slot);
  }

  hasPending(prefix: string): boolean {
    for (const slot of this.keys.keys()) {
      if (slot.startsWith(prefix)) return true;
    }
    return false;
  }
}

export const sharedGiftCardAttempts = new GiftCardAttemptStore();

export class GiftCardsApiService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly bridge: GiftCardsBridge = getBridge() as unknown as GiftCardsBridge,
    private readonly attempts: GiftCardAttemptStore = sharedGiftCardAttempts,
  ) {}

  async getStatus(): Promise<GiftCardsResult<GiftCardsStatus>> {
    const response = await this.send(`${API_BASE}/status`, { method: 'GET' });
    // A status answered from the native offline cache is not current
    // readiness, so it fails closed like any other failure.
    if (!response.success || response.fromCache) return classifyFailure(response, 'read');
    return { ok: true, data: mapGiftCardsStatus(response.payload) };
  }

  async lookup(cardNumber: string): Promise<GiftCardsResult<GiftCardLookupResult>> {
    const normalized = normalizeGiftCardNumber(cardNumber);
    if (!normalized) return invalid('GIFT_CARD_NUMBER_INVALID');
    const response = await this.send(`${API_BASE}/lookup`, {
      method: 'POST',
      body: { card_number: normalized },
    });
    if (!response.success) return classifyFailure(response, 'lookup');
    const card = mapGiftCard(response.payload.card);
    if (!card) {
      return { ok: false, kind: 'unavailable', status: response.status, code: 'GIFT_CARD_RESPONSE_INVALID' };
    }
    return { ok: true, data: { card, transactions: mapTransactions(response.payload.transactions) } };
  }

  async getTransactions(cardId: string, limit = 20): Promise<GiftCardsResult<GiftCardTransaction[]>> {
    const id = asString(cardId);
    if (!id) return invalid('GIFT_CARD_ID_REQUIRED');
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 20));
    const query = new URLSearchParams({ card_id: id, limit: String(safeLimit) });
    const response = await this.send(`${API_BASE}/transactions?${query.toString()}`, { method: 'GET' });
    // A cached history is not proof of the current balance; fail closed.
    if (!response.success || response.fromCache) return classifyFailure(response, 'read');
    return { ok: true, data: mapTransactions(response.payload.transactions ?? response.payload.data) };
  }

  async issue(scope: GiftCardScope, input: GiftCardIssueInput): Promise<GiftCardsResult<GiftCardIssueResult>> {
    const amountCents = validCents(input.amountCents);
    const currency = normalizeCurrencyCode(input.currency);
    const rawNumber = asString(input.cardNumber);
    const cardNumber = rawNumber ? normalizeGiftCardNumber(rawNumber) : null;
    const note = asString(input.note);
    if (amountCents === null) return invalid('GIFT_CARD_AMOUNT_INVALID');
    if (!currency) return invalid('GIFT_CARD_CURRENCY_REQUIRED');
    if (rawNumber && !cardNumber) return invalid('GIFT_CARD_NUMBER_INVALID');

    return this.mutate(
      scope,
      'issue',
      [cardNumber ?? '', amountCents, currency, note ?? ''],
      (idempotencyKey) => ({
        ...(cardNumber ? { card_number: cardNumber } : {}),
        amount: centsToAmount(amountCents),
        currency,
        ...(note ? { note } : {}),
        idempotency_key: idempotencyKey,
      }),
      (payload) => {
        const card = mapGiftCard(payload.card);
        return card ? { card, cardNumber: asString(payload.card_number) } : null;
      },
    );
  }

  reload(scope: GiftCardScope, input: GiftCardBalanceInput): Promise<GiftCardsResult<GiftCardBalanceResult>> {
    return this.adjustBalance(scope, 'reload', input);
  }

  /**
   * Management redemption: a manual balance deduction outside any order. It
   * never sends `order_id`; paying an order with a gift card belongs to checkout.
   */
  redeem(scope: GiftCardScope, input: GiftCardBalanceInput): Promise<GiftCardsResult<GiftCardBalanceResult>> {
    return this.adjustBalance(scope, 'redeem', input);
  }

  hasPendingAttempt(scope: GiftCardScope, action: GiftCardMutationAction): boolean {
    const scopeKey = toScopeKey(scope);
    return scopeKey ? this.attempts.hasPending(`${scopeKey}|${action}|`) : false;
  }

  private async adjustBalance(
    scope: GiftCardScope,
    action: 'reload' | 'redeem',
    input: GiftCardBalanceInput,
  ): Promise<GiftCardsResult<GiftCardBalanceResult>> {
    const cardId = asString(input.cardId);
    const cardNumber = normalizeGiftCardNumber(input.cardNumber);
    const amountCents = validCents(input.amountCents);
    const currency = normalizeCurrencyCode(input.currency);
    const note = asString(input.note);
    if (!cardId || !cardNumber) return invalid('GIFT_CARD_REQUIRED');
    if (amountCents === null) return invalid('GIFT_CARD_AMOUNT_INVALID');
    if (!currency) return invalid('GIFT_CARD_CURRENCY_REQUIRED');

    return this.mutate(
      scope,
      action,
      [cardId, cardNumber, amountCents, currency, note ?? ''],
      (idempotencyKey) => ({
        card_id: cardId,
        card_number: cardNumber,
        amount: centsToAmount(amountCents),
        currency,
        ...(note ? { note } : {}),
        idempotency_key: idempotencyKey,
      }),
      (payload) => ({ card: mapGiftCard(payload.card) }),
    );
  }

  private async mutate<T>(
    scope: GiftCardScope,
    action: GiftCardMutationAction,
    fingerprint: ReadonlyArray<string | number>,
    buildBody: (idempotencyKey: string) => Record<string, unknown>,
    readSuccess: (payload: Record<string, unknown>) => T | null,
  ): Promise<GiftCardsResult<T>> {
    const scopeKey = toScopeKey(scope);
    if (!scopeKey) return invalid('GIFT_CARD_TERMINAL_SCOPE_REQUIRED');
    const lane = `${scopeKey}|${action}`;
    if (this.inFlight.has(lane)) return { ok: false, kind: 'busy', status: null, code: null };

    const slot = `${lane}|${digest(fingerprint)}`;
    let idempotencyKey: string;
    try {
      idempotencyKey = this.attempts.resolve(slot);
    } catch {
      return invalid('GIFT_CARD_IDEMPOTENCY_UNAVAILABLE');
    }

    this.inFlight.add(lane);
    try {
      const response = await this.send(`${API_BASE}/${action}`, {
        method: 'POST',
        body: buildBody(idempotencyKey),
      });
      if (response.success && response.payload.success === true) {
        const data = readSuccess(response.payload);
        if (data !== null) {
          this.attempts.settle(slot, idempotencyKey);
          return { ok: true, data };
        }
      }
      // The key is kept: failed, rejected and unknown outcomes retry with it.
      return response.success
        ? { ok: false, kind: 'unknown', status: response.status, code: 'GIFT_CARD_RESPONSE_INVALID' }
        : classifyFailure(response, 'mutation');
    } finally {
      this.inFlight.delete(lane);
    }
  }

  private async send(path: string, options: AdminFetchOptions): Promise<NativeAdminResponse> {
    try {
      if (typeof this.bridge.invoke === 'function') {
        return readNativeResponse(await this.bridge.invoke(FETCH_CHANNEL, path, options));
      }
      if (this.bridge.adminApi?.fetchFromAdmin) {
        return readNativeResponse(await this.bridge.adminApi.fetchFromAdmin(path, options));
      }
    } catch {
      // No logging: request bodies can carry a card number. A transport error
      // has no HTTP status and is classified by the caller.
    }
    return { success: false, payload: {}, status: null, fromCache: false, codes: [] };
  }
}

export const giftCardsApiService = new GiftCardsApiService();

export default giftCardsApiService;
