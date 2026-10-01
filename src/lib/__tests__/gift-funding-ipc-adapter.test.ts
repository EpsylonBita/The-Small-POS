import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter';
import type {
  GiftFundingAttemptResponse,
  GiftFundingAttemptResult,
  GiftFundingAttemptView,
  GiftFundingAuthorizeManagerRequest,
  GiftFundingAuthorizeManagerResponse,
  GiftFundingAvailability,
  GiftFundingAvailabilityRequest,
  GiftFundingAvailabilityResponse,
  GiftFundingCancelRequest,
  GiftFundingCloseBlockerResponse,
  GiftFundingCompleteRequest,
  GiftFundingDrawerView,
  GiftFundingGrantRequest,
  GiftFundingPrepareRequest,
  GiftFundingRefreshDrawerResponse,
  GiftFundingStatusResponse,
  GiftFundingUnresolvedAttempt,
} from '../ipc-contracts';

beforeEach(() => {
  invoke.mockReset();
});

const ATTEMPT_KEY = '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const STAFF_ID = '5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e';
const MANAGER_ID = 'd16c7d8e-9fa0-4b1c-8d3e-4f5a6b7c8d9f';
const SHIFT_ID = '3a7e9b8c-4d2c-4e3f-8b1c-2d3e4f5a6b7c';
const DRAWER_ID = '4b8fac9d-5e3d-4f40-9c2d-3e4f5a6b7c8d';
const CARD_ID = '9d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a';

const attempt: GiftFundingAttemptView = {
  attemptKey: ATTEMPT_KEY,
  organizationId: '6da1cebf-7a5f-4b62-9e4f-5a6b7c8d9eaf',
  branchId: '7eb2dfc0-8b6a-4c73-8f5a-6b7c8d9eafb0',
  terminalId: 'terminal-main-01',
  staffId: STAFF_ID,
  operation: 'issue',
  mode: 'cash_confirmed',
  cardId: null,
  amountCents: 5000,
  currency: 'EUR',
  reason: 'Birthday gift card',
  drawerId: DRAWER_ID,
  shiftId: SHIFT_ID,
  state: 'prepared',
  intentId: null,
  unresolved: true,
  possiblySent: false,
  collectionPermitted: false,
  lastCode: null,
  result: null,
  verifiedCapture: false,
  fiscalReceipt: false,
  createdAt: '2026-09-29T09:00:00.000Z',
  updatedAt: '2026-09-29T09:00:00.000Z',
};

const result: GiftFundingAttemptResult = {
  cardId: CARD_ID,
  creditId: 'bf4a5b6c-7d8e-4f9a-8b1c-2d3e4f5a6b7c',
  acknowledgementId: 'c05b6c7d-8e9f-4a0b-9c2d-3e4f5a6b7c8d',
  cardBalanceCents: 5000,
  cardNumberHash: '5f0c1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1',
  completedAt: '2026-09-29T09:01:00.000Z',
};

const completed: GiftFundingAttemptView = {
  ...attempt,
  cardId: CARD_ID,
  state: 'completed',
  intentId: 'ae3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b',
  unresolved: false,
  possiblySent: true,
  collectionPermitted: false,
  result,
  updatedAt: '2026-09-29T09:01:00.000Z',
};

const drawer: GiftFundingDrawerView = {
  openingKey: '2f6d8f7a-3c1b-4d2e-9a0b-1c2d3e4f5a6b',
  shiftId: SHIFT_ID,
  drawerId: DRAWER_ID,
  staffId: STAFF_ID,
  currency: 'EUR',
  version: 3,
  acknowledgementId: result.acknowledgementId,
  giftCashCents: 5000,
  ordinaryExpectedCents: 15000,
  expectedCents: 20000,
};

const unresolved: GiftFundingUnresolvedAttempt = {
  attemptKey: ATTEMPT_KEY,
  state: 'collection_started',
  mode: 'cash_confirmed',
  amountCents: 5000,
  currency: 'EUR',
  shiftId: SHIFT_ID,
};

const authorization = { staffId: MANAGER_ID, expiresAt: '2026-09-29T09:05:00.000Z' };

const prepare: GiftFundingPrepareRequest = {
  staffId: STAFF_ID,
  mode: 'cash_confirmed',
  operation: 'issue',
  amountCents: 5000,
  currency: 'EUR',
  reason: 'Birthday gift card',
};

const cashComplete: GiftFundingCompleteRequest = {
  attemptKey: ATTEMPT_KEY,
  evidence: { kind: 'operator_cash_confirmation', amountCents: 5000, currency: 'EUR', confirmed: true },
};

const cardComplete: GiftFundingCompleteRequest = {
  attemptKey: ATTEMPT_KEY,
  evidence: {
    kind: 'external_card_recorded',
    amountCents: 5000,
    currency: 'EUR',
    confirmed: true,
    provider: 'viva',
    merchantId: 'M-100200',
    terminalReference: 'T-0042',
    transactionReference: 'TX-7f3a9c',
  },
};

const cancel: GiftFundingCancelRequest = { attemptKey: ATTEMPT_KEY, reason: 'Customer changed their mind' };

const managerPin: GiftFundingAuthorizeManagerRequest = { staffId: MANAGER_ID, pin: '482915' };

const grant: GiftFundingGrantRequest = {
  staffId: MANAGER_ID,
  operation: 'reload',
  cardId: CARD_ID,
  amountCents: 1000,
  currency: 'EUR',
  reason: 'Service recovery',
};

const availabilityRequest: GiftFundingAvailabilityRequest = { staffId: STAFF_ID, authority: 'cashier' };

const availability: GiftFundingAvailability = {
  staffId: STAFF_ID,
  authority: 'cashier',
  organizationId: attempt.organizationId,
  branchId: attempt.branchId,
  terminalId: attempt.terminalId,
  configured: true,
  enabled: true,
  unavailable: false,
  currency: 'EUR',
  configurationRequired: null,
  fundingConfigured: true,
  modes: {
    cash_confirmed: { supported: true, ready: false, reason: 'ACCOUNTING_INTEGRATION_REQUIRED' },
    external_card_recorded: { supported: true, ready: true, reason: null },
    manager_grant: { supported: true, ready: false, reason: 'OPERATOR_OR_FUNDING_UNAVAILABLE' },
    verified_capture: { supported: false, ready: false, reason: 'VERIFIED_CAPTURE_UNAVAILABLE' },
  },
  operator: { ready: true, reason: null, returnPayments: true },
  verifiedCapture: false,
  fiscalReceipt: false,
};

/** Every bridge method in CHANNEL_MAP order, with its exact native command. */
const envelopeCases: ReadonlyArray<{
  method: keyof TauriBridge['giftFunding'];
  command: string;
  payload: object;
  call: (bridge: TauriBridge) => Promise<unknown>;
}> = [
  { method: 'prepare', command: 'gift_funding_prepare', payload: prepare, call: (b) => b.giftFunding.prepare(prepare) },
  {
    method: 'beginCollection',
    command: 'gift_funding_begin_collection',
    payload: { attemptKey: ATTEMPT_KEY },
    call: (b) => b.giftFunding.beginCollection({ attemptKey: ATTEMPT_KEY }),
  },
  { method: 'complete', command: 'gift_funding_complete', payload: cardComplete, call: (b) => b.giftFunding.complete(cardComplete) },
  { method: 'cancel', command: 'gift_funding_cancel', payload: cancel, call: (b) => b.giftFunding.cancel(cancel) },
  {
    method: 'recover',
    command: 'gift_funding_recover',
    payload: { attemptKey: ATTEMPT_KEY },
    call: (b) => b.giftFunding.recover({ attemptKey: ATTEMPT_KEY }),
  },
  {
    method: 'authorizeManager',
    command: 'gift_funding_authorize_manager',
    payload: managerPin,
    call: (b) => b.giftFunding.authorizeManager(managerPin),
  },
  { method: 'grant', command: 'gift_funding_grant', payload: grant, call: (b) => b.giftFunding.grant(grant) },
  {
    method: 'status',
    command: 'gift_funding_status',
    payload: { attemptKey: ATTEMPT_KEY },
    call: (b) => b.giftFunding.status({ attemptKey: ATTEMPT_KEY }),
  },
  {
    method: 'refreshDrawer',
    command: 'gift_funding_refresh_drawer',
    payload: { staffId: STAFF_ID },
    call: (b) => b.giftFunding.refreshDrawer({ staffId: STAFF_ID }),
  },
  {
    method: 'closeBlocker',
    command: 'gift_funding_close_blocker',
    payload: { shiftId: SHIFT_ID },
    call: (b) => b.giftFunding.closeBlocker({ shiftId: SHIFT_ID }),
  },
  {
    method: 'availability',
    command: 'gift_funding_availability',
    payload: availabilityRequest,
    call: (b) => b.giftFunding.availability(availabilityRequest),
  },
];

describe('bridge.giftFunding', () => {
  it.each(envelopeCases)('$method sends the single arg0 envelope to $command', async ({ command, payload, call }) => {
    const response = { success: true };
    invoke.mockResolvedValue(response);

    await expect(call(new TauriBridge())).resolves.toBe(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(command, { arg0: payload });
    const args = invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(['arg0']);
  });

  it('maps each channel to its bridge method and derives the exact native command', () => {
    const mapped = Object.entries(CHANNEL_MAP)
      .filter(([channel]) => channel.startsWith('gift-funding:'))
      .map(([channel, path]) => [path, channel.replace(/[:-]/g, '_')]);
    expect(mapped).toEqual(envelopeCases.map(({ method, command }) => [`giftFunding.${method}`, command]));
    // No separate funding clear: clearing stays on shiftFinancialOpening.clearAuthorization().
    expect(Object.keys(new TauriBridge().giftFunding)).toEqual(envelopeCases.map(({ method }) => method));
  });

  it('always sends status and closeBlocker an arg0 object and returns their results unchanged', async () => {
    const status: GiftFundingStatusResponse = { success: true, attempts: [attempt, completed] };
    const blocker: GiftFundingCloseBlockerResponse = {
      success: true,
      blocked: true,
      shiftId: SHIFT_ID,
      unresolved: [unresolved],
    };
    invoke.mockResolvedValueOnce(status).mockResolvedValueOnce(blocker);
    const bridge = new TauriBridge();

    await expect(bridge.giftFunding.status()).resolves.toStrictEqual(status);
    await expect(bridge.giftFunding.closeBlocker()).resolves.toStrictEqual(blocker);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'gift_funding_status', { arg0: {} });
    expect(invoke).toHaveBeenNthCalledWith(2, 'gift_funding_close_blocker', { arg0: {} });
  });

  it('authorizes the manager with only the staff id and transient PIN and returns no credential', async () => {
    const response: GiftFundingAuthorizeManagerResponse = { success: true, authorization };
    invoke.mockResolvedValue(response);

    await expect(new TauriBridge().giftFunding.authorizeManager(managerPin)).resolves.toStrictEqual(response);
    expect(invoke).toHaveBeenCalledWith('gift_funding_authorize_manager', {
      arg0: { staffId: MANAGER_ID, pin: '482915' },
    });
    const args = invoke.mock.calls[0]?.[1] as { arg0: Record<string, unknown> };
    expect(Object.keys(args.arg0).sort()).toEqual(['pin', 'staffId']);
    expect(Object.keys(authorization).sort()).toEqual(['expiresAt', 'staffId']);
  });

  it('reads availability with only the staff id and authority and returns the projection or refusal unchanged', async () => {
    const managerRequest: GiftFundingAvailabilityRequest = { staffId: MANAGER_ID, authority: 'manager' };
    const ready: GiftFundingAvailabilityResponse = { success: true, availability };
    const refused: GiftFundingAvailabilityResponse = {
      success: false,
      code: 'HOSTED_AUTHORIZATION_CHANGED',
      error: 'The authorization changed during the read; check again',
    };
    invoke.mockResolvedValueOnce(ready).mockResolvedValueOnce(refused);
    const bridge = new TauriBridge();

    await expect(bridge.giftFunding.availability(availabilityRequest)).resolves.toStrictEqual(ready);
    await expect(bridge.giftFunding.availability(managerRequest)).resolves.toStrictEqual(refused);
    expect(invoke).toHaveBeenNthCalledWith(1, 'gift_funding_availability', {
      arg0: { staffId: STAFF_ID, authority: 'cashier' },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'gift_funding_availability', {
      arg0: { staffId: MANAGER_ID, authority: 'manager' },
    });
    for (const call of invoke.mock.calls) {
      expect(Object.keys((call[1] as { arg0: Record<string, unknown> }).arg0).sort()).toEqual(['authority', 'staffId']);
    }
    expect(Object.keys(refused).sort()).toEqual(['code', 'error', 'success']);
  });

  it('sends cash and external card completion evidence unchanged', async () => {
    invoke.mockResolvedValue({ success: true, attempt: completed });
    const bridge = new TauriBridge();
    await bridge.giftFunding.complete(cashComplete);
    await bridge.giftFunding.complete(cardComplete);

    const sent = invoke.mock.calls.map((call) => (call[1] as { arg0: GiftFundingCompleteRequest }).arg0);
    expect(sent).toStrictEqual([cashComplete, cardComplete]);
    expect(Object.keys(sent[0]?.evidence ?? {}).sort()).toEqual(['amountCents', 'confirmed', 'currency', 'kind']);
    expect(Object.keys(sent[1]?.evidence ?? {}).sort()).toEqual([
      'amountCents',
      'confirmed',
      'currency',
      'kind',
      'merchantId',
      'provider',
      'terminalReference',
      'transactionReference',
    ]);
  });

  it('passes the transient card number of a completed issue through unchanged', async () => {
    const response: GiftFundingAttemptResponse = { success: true, attempt: completed, cardNumber: 'GC-TEST-0000-0042' };
    invoke.mockResolvedValue(response);
    await expect(new TauriBridge().giftFunding.complete(cashComplete)).resolves.toStrictEqual(response);
  });

  it('returns the refreshed drawer unchanged', async () => {
    const response: GiftFundingRefreshDrawerResponse = { success: true, drawer };
    invoke.mockResolvedValue(response);
    await expect(new TauriBridge().giftFunding.refreshDrawer({ staffId: STAFF_ID })).resolves.toStrictEqual(response);
  });

  it('returns native refusals unchanged, including a retained attempt', async () => {
    const retained: GiftFundingAttemptResponse = {
      success: false,
      code: 'GIFT_FUNDING_OUTCOME_UNKNOWN',
      error: 'The funding outcome is unknown; recover the attempt before retrying',
      attempt: { ...attempt, state: 'complete_pending', possiblySent: true, lastCode: 'GIFT_FUNDING_OUTCOME_UNKNOWN' },
    };
    const bare: GiftFundingAttemptResponse = {
      success: false,
      code: 'MANAGER_AUTHORIZATION_REQUIRED',
      error: 'A separate manager authorization is required',
    };
    invoke.mockResolvedValueOnce(retained).mockResolvedValueOnce(bare);
    const bridge = new TauriBridge();

    await expect(bridge.giftFunding.recover({ attemptKey: ATTEMPT_KEY })).resolves.toStrictEqual(retained);
    await expect(bridge.giftFunding.grant(grant)).resolves.toStrictEqual(bare);
  });

  it('surfaces a native invocation rejection to the caller', async () => {
    invoke.mockRejectedValue(new Error('lock: poisoned'));
    const bridge = new TauriBridge();
    await expect(bridge.giftFunding.prepare(prepare)).rejects.toThrow('lock: poisoned');
    await expect(bridge.giftFunding.closeBlocker()).rejects.toThrow('lock: poisoned');
  });

  it('declares no PIN, staff session or raw card number in the native views', () => {
    const credentialKeys = (value: object) =>
      Object.keys(value).filter((key) => key !== 'cardNumberHash' && /pin|session|card_?number$/i.test(key));
    const availabilityViews = [availability, availability.operator, ...Object.values(availability.modes)];
    for (const view of [attempt, completed, result, drawer, unresolved, authorization, ...availabilityViews]) {
      expect(credentialKeys(view)).toEqual([]);
    }
    expect(Object.keys(result)).toContain('cardNumberHash');
    expect([completed.verifiedCapture, completed.fiscalReceipt]).toEqual([false, false]);
    expect([availability.verifiedCapture, availability.fiscalReceipt]).toEqual([false, false]);
  });

  it('registers exactly the eleven gift funding channels and keeps the checkout and opening channels', () => {
    expect(Object.entries(CHANNEL_MAP).filter(([channel]) => channel.startsWith('gift-funding:'))).toEqual([
      ['gift-funding:prepare', 'giftFunding.prepare'],
      ['gift-funding:begin-collection', 'giftFunding.beginCollection'],
      ['gift-funding:complete', 'giftFunding.complete'],
      ['gift-funding:cancel', 'giftFunding.cancel'],
      ['gift-funding:recover', 'giftFunding.recover'],
      ['gift-funding:authorize-manager', 'giftFunding.authorizeManager'],
      ['gift-funding:grant', 'giftFunding.grant'],
      ['gift-funding:status', 'giftFunding.status'],
      ['gift-funding:refresh-drawer', 'giftFunding.refreshDrawer'],
      ['gift-funding:close-blocker', 'giftFunding.closeBlocker'],
      ['gift-funding:availability', 'giftFunding.availability'],
    ]);
    expect(Object.values(CHANNEL_MAP).filter((path) => path.startsWith('giftFunding.'))).toHaveLength(11);
    expect(Object.entries(CHANNEL_MAP).filter(([channel]) => channel.startsWith('gift-card:'))).toHaveLength(5);
    expect(
      Object.entries(CHANNEL_MAP).filter(([channel]) => channel.startsWith('shift:financial-opening')),
    ).toHaveLength(4);
  });
});
