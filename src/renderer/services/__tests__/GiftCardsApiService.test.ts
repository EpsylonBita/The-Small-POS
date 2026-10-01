import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib', () => ({
  getBridge: () => ({}),
}));

import {
  GiftCardAttemptStore,
  GiftCardsApiService,
  mapGiftCardsStatus,
  normalizeGiftCardNumber,
  parseAmountToCents,
} from '../GiftCardsApiService';

type SentOptions = { method: string; body?: Record<string, unknown> };

const CARD = {
  id: 'card-1',
  card_number_last4: '7788',
  masked_number: '****7788',
  initial_balance: 25,
  balance: 25,
  currency: 'EUR',
  status: 'active',
};

const SCOPE = { organizationId: 'org-1', terminalId: 'term-1' };

const ok = (data: Record<string, unknown>, status = 200) => ({ success: true, status, data });

function createService(responses: Array<unknown>) {
  const calls: Array<{ path: string; options: SentOptions }> = [];
  const invoke = vi.fn(async (_channel: string, ...args: unknown[]) => {
    const [path, options] = args as [string, SentOptions];
    calls.push({ path, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  let counter = 0;
  const store = new GiftCardAttemptStore(() => `key-${++counter}`);
  return { service: new GiftCardsApiService({ invoke }, store), calls, invoke };
}

const keyOf = (call: { options: SentOptions }) => call.options.body?.idempotency_key;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseAmountToCents', () => {
  it('accepts positive amounts with at most two decimals', () => {
    expect(parseAmountToCents('10')).toBe(1000);
    expect(parseAmountToCents('10.5')).toBe(1050);
    expect(parseAmountToCents('10,55')).toBe(1055);
    expect(parseAmountToCents(' 7.00 ')).toBe(700);
    expect(parseAmountToCents(12.34)).toBe(1234);
    expect(parseAmountToCents('999999')).toBe(99_999_900);
  });

  it('rejects zero, negatives, NaN, more than two decimals and out-of-range values', () => {
    for (const value of ['0', '0.00', '-5', '10.555', '1e3', 'abc', '', 'NaN', '1000000', '1.2.3']) {
      expect(parseAmountToCents(value)).toBeNull();
    }
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.001]) {
      expect(parseAmountToCents(value)).toBeNull();
    }
    expect(parseAmountToCents(null)).toBeNull();
  });
});

describe('normalizeGiftCardNumber', () => {
  it('mirrors the server normalization', () => {
    expect(normalizeGiftCardNumber('gc12-3456 7788')).toBe('GC1234567788');
    expect(normalizeGiftCardNumber('short')).toBeNull();
    expect(normalizeGiftCardNumber('bad!chars123')).toBeNull();
  });
});

describe('mapGiftCardsStatus', () => {
  it('fails closed when readiness flags are missing', () => {
    const status = mapGiftCardsStatus({ success: true });
    expect(status.enabled).toBe(false);
    expect(status.supportsIssue).toBe(false);
    expect(status.moduleEnabled).toBe(false);
  });

  it('reports readiness only when the server affirms it', () => {
    const status = mapGiftCardsStatus({
      success: true,
      configured: true,
      enabled: true,
      unavailable: false,
      gift_cards: {
        configured: true,
        enabled: true,
        unavailable: false,
        module_enabled: true,
        terminal_enabled: true,
        supports_lookup: true,
        supports_issue: true,
        supports_reload: true,
        supports_redeem: true,
        supports_history: true,
      },
    });
    expect(status.enabled).toBe(true);
    expect(status.supportsRedeem).toBe(true);
  });
});

describe('GiftCardsApiService', () => {
  it('treats a status answered from the native offline cache as offline', async () => {
    const { service } = createService([
      { success: true, status: 200, data: { success: true, enabled: true }, meta: { source: 'cache' } },
    ]);
    const result = await service.getStatus();
    expect(result).toMatchObject({ ok: false, kind: 'offline' });
  });

  it('maps a 403 module denial to module_disabled', async () => {
    const { service } = createService([
      { success: false, status: 403, error: 'MODULE_REQUIRED', data: { code: 'GIFT_CARDS_MODULE_DISABLED' } },
    ]);
    const result = await service.getStatus();
    expect(result).toMatchObject({ ok: false, kind: 'module_disabled' });
  });

  it('looks up a normalized card number and maps the masked card and history', async () => {
    const { service, calls } = createService([
      ok({
        success: true,
        card: CARD,
        transactions: [{ id: 'tx-1', transaction_type: 'issue', amount: 25, balance_after: 25, currency: 'EUR' }],
      }),
    ]);
    const result = await service.lookup('gc12 3456-7788');
    expect(calls[0]).toEqual({
      path: '/api/pos/gift-cards/lookup',
      options: { method: 'POST', body: { card_number: 'GC1234567788' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.card).toMatchObject({ maskedNumber: '****7788', balance: 25, currency: 'EUR', status: 'active' });
    expect(result.data.transactions).toHaveLength(1);
  });

  it('reuses the same idempotency key after an unknown outcome and rotates it after success', async () => {
    const { service, calls } = createService([
      { success: false, error: 'Request timed out' },
      { success: false, status: 502, error: 'Bad gateway' },
      ok({ success: true, card: CARD, card_number: 'GC1234567788' }, 201),
      ok({ success: true, card: CARD, card_number: 'GC0000009999' }, 201),
    ]);
    const input = { amountCents: 2500, currency: 'eur' };

    await expect(service.issue(SCOPE, input)).resolves.toMatchObject({ ok: false, kind: 'unknown' });
    await expect(service.issue(SCOPE, input)).resolves.toMatchObject({ ok: false, kind: 'unknown' });
    expect(service.hasPendingAttempt(SCOPE, 'issue')).toBe(true);
    const success = await service.issue(SCOPE, input);
    expect(success).toMatchObject({ ok: true, data: { cardNumber: 'GC1234567788' } });
    expect(service.hasPendingAttempt(SCOPE, 'issue')).toBe(false);
    await service.issue(SCOPE, input);

    expect(calls.map(keyOf)).toEqual(['key-1', 'key-1', 'key-1', 'key-2']);
    expect(calls[0].options.body).toEqual({ amount: 25, currency: 'EUR', idempotency_key: 'key-1' });
  });

  it('binds keys to every value-affecting field and to the terminal scope', async () => {
    const failure = { success: false, error: 'offline' };
    const { service, calls } = createService([failure, failure, failure, failure, failure]);

    await service.issue(SCOPE, { amountCents: 1000, currency: 'EUR' });
    await service.issue(SCOPE, { amountCents: 1500, currency: 'EUR' });
    await service.issue(SCOPE, { amountCents: 1000, currency: 'EUR' });
    await service.issue({ organizationId: 'org-2', terminalId: 'term-1' }, { amountCents: 1000, currency: 'EUR' });
    await service.issue({ organizationId: 'org-1', terminalId: 'term-2' }, { amountCents: 1000, currency: 'EUR' });

    expect(calls.map(keyOf)).toEqual(['key-1', 'key-2', 'key-1', 'key-3', 'key-4']);
    expect(service.hasPendingAttempt({ organizationId: 'org-9', terminalId: 'term-1' }, 'issue')).toBe(false);
  });

  it('blocks a concurrent duplicate mutation while the first is in flight', async () => {
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(() => pending);
    const service = new GiftCardsApiService({ invoke }, new GiftCardAttemptStore(() => 'key-a'));
    const input = { cardId: 'card-1', cardNumber: 'GC1234567788', amountCents: 500, currency: 'EUR' };

    const first = service.reload(SCOPE, input);
    await expect(service.reload(SCOPE, input)).resolves.toMatchObject({ ok: false, kind: 'busy' });
    release(ok({ success: true, card: { ...CARD, balance: 30 } }));
    await expect(first).resolves.toMatchObject({ ok: true, data: { card: { balance: 30 } } });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid input locally without sending anything', async () => {
    const { service, invoke } = createService([]);
    const card = { cardId: 'card-1', cardNumber: 'GC1234567788', currency: 'EUR' };

    await expect(service.issue(SCOPE, { amountCents: 0, currency: 'EUR' })).resolves.toMatchObject({ kind: 'invalid' });
    await expect(service.issue(SCOPE, { amountCents: 10.5, currency: 'EUR' })).resolves.toMatchObject({ kind: 'invalid' });
    await expect(service.issue(SCOPE, { amountCents: 1000, currency: '' })).resolves.toMatchObject({
      kind: 'invalid',
      code: 'GIFT_CARD_CURRENCY_REQUIRED',
    });
    await expect(service.issue({ organizationId: 'org-1' }, { amountCents: 1000, currency: 'EUR' })).resolves.toMatchObject({
      kind: 'invalid',
      code: 'GIFT_CARD_TERMINAL_SCOPE_REQUIRED',
    });
    await expect(service.redeem(SCOPE, { ...card, amountCents: -100 })).resolves.toMatchObject({ kind: 'invalid' });
    await expect(service.lookup('abc')).resolves.toMatchObject({ kind: 'invalid' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends management redemption without an order and keeps the key after a rejection', async () => {
    const { service, calls } = createService([
      { success: false, status: 409, error: 'GIFT_CARD_INSUFFICIENT_BALANCE' },
      ok({ success: true, card: { ...CARD, balance: 20 } }),
    ]);
    const input = { cardId: 'card-1', cardNumber: 'GC1234567788', amountCents: 500, currency: 'EUR', note: 'Manual fix' };

    await expect(service.redeem(SCOPE, input)).resolves.toMatchObject({
      ok: false,
      kind: 'rejected',
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
    });
    await expect(service.redeem(SCOPE, input)).resolves.toMatchObject({ ok: true });
    expect(calls[0]).toEqual({
      path: '/api/pos/gift-cards/redeem',
      options: {
        method: 'POST',
        body: {
          card_id: 'card-1',
          card_number: 'GC1234567788',
          amount: 5,
          currency: 'EUR',
          note: 'Manual fix',
          idempotency_key: 'key-1',
        },
      },
    });
    expect(keyOf(calls[1])).toBe('key-1');
    expect(calls[0].options.body).not.toHaveProperty('order_id');
  });

  it('never logs, even when the transport throws', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { service } = createService([new Error('socket closed GC1234567788'), new Error('socket closed')]);

    await expect(service.lookup('GC1234567788')).resolves.toMatchObject({ ok: false, kind: 'unavailable' });
    await expect(service.issue(SCOPE, { cardNumber: 'GC1234567788', amountCents: 100, currency: 'EUR' })).resolves.toMatchObject({
      ok: false,
      kind: 'unknown',
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed on cached transaction history', async () => {
    const { service, calls } = createService([
      { success: true, status: 200, data: { success: true, transactions: [] }, meta: { source: 'cache', offlineFallback: true } },
    ]);
    await expect(service.getTransactions('card-1', 500)).resolves.toMatchObject({ ok: false, kind: 'offline' });
    expect(calls[0].path).toBe('/api/pos/gift-cards/transactions?card_id=card-1&limit=100');
  });
});
