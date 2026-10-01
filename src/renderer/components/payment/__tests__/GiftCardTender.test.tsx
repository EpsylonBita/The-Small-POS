import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hasModule: vi.fn() }));

// The API singleton needs a bridge at import; every call here goes through injected fakes.
vi.mock('../../../../lib', () => ({ getBridge: () => ({}) }));
vi.mock('../../../hooks/useAcquiredModules', () => ({
  MODULE_IDS: { GIFT_CARDS: 'gift_cards' },
  useAcquiredModules: () => ({ hasModule: mocks.hasModule }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      if (typeof options === 'string') return options;
      const values = (options ?? {}) as Record<string, unknown>;
      const template = typeof values.defaultValue === 'string' ? values.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''));
    },
  }),
}));

import { GiftCardTender } from '../GiftCardTender';
import {
  GiftCardCheckoutService,
  type GiftCardCheckoutBridge,
  type GiftCardOrdinaryHold,
  type GiftCardTenderEvent,
} from '../../../services/GiftCardCheckoutService';

const SCOPE = { organizationId: 'org-1', terminalId: 'term-1' };
const CARD_NUMBER = '6000111122224321';
const STATUS = {
  enabled: true,
  configured: true,
  unavailable: false,
  moduleEnabled: true,
  terminalEnabled: true,
  supportsLookup: true,
  supportsIssue: false,
  supportsReload: false,
  supportsRedeem: true,
  supportsHistory: false,
  currency: 'EUR',
  reason: null,
};
const CARD = {
  id: 'card-1',
  maskedNumber: '•••• 4321',
  balance: 50,
  initialBalance: 50,
  currency: 'EUR',
  status: 'active',
  expiresAt: null,
  issuedAt: null,
};
const PAYMENT = {
  localPaymentId: 'pay-1',
  remotePaymentId: 'remote-pay-1',
  method: 'gift_card',
  amountCents: 2000,
  currency: 'EUR',
  transactionRef: 'gift_card:tx-1',
};
/** One `applied` row exactly as native gift_card_reconcile_order reports it. */
const NATIVE_ROW = {
  idempotencyKey: 'native-key-1',
  localPaymentId: 'pay-1',
  remotePaymentId: 'remote-pay-1',
  amountCents: 2000,
  currency: 'EUR',
};
const RECOVERED = {
  localPaymentId: 'pay-1',
  remotePaymentId: 'remote-pay-1',
  method: 'gift_card',
  amountCents: 2000,
  currency: 'EUR',
  transactionRef: null,
};
const CLEAR = { success: true, applied: [], abandoned: 0, unresolved: 0, reconciliationPending: false };
const PENDING = {
  success: false,
  code: 'GIFT_CARD_RECONCILIATION_PENDING',
  applied: [],
  abandoned: 0,
  unresolved: 1,
  reconciliationPending: true,
};
/** Native readiness while the order's receipt operation is started but unconfirmed. */
const RECEIPT_PENDING = {
  success: false,
  status: 'unsupported',
  code: 'GIFT_CARD_FISCAL_ALREADY_STARTED',
  error: null,
  certified: false,
  fiscalReceiptNumber: null,
  cloudRoute: 'allowed',
  orderId: 'order-1',
  order: {
    status: 'pending',
    code: 'GIFT_CARD_FISCAL_RECONCILIATION_REQUIRED',
    error: null,
    certified: false,
    fiscalReceiptNumber: null,
    orderId: 'order-1',
    operationId: 'op-1',
    requiresReconciliation: true,
  },
};
/** Native fiscal reconcile returning the original operation. */
const RECEIPT_REPLAYED = {
  success: true,
  status: 'approved',
  code: null,
  error: null,
  certified: false,
  fiscalReceiptNumber: null,
  orderId: 'order-1',
  operationId: 'op-1',
  alreadyIssued: true,
  requiresReconciliation: false,
};
const UNCERTAIN_TEXT = 'The gift card result is not confirmed. Do not collect again; check again first.';
const CHECKING_TEXT = 'Checking earlier gift card attempts…';

const fn = (value?: unknown) => vi.fn(async (..._args: unknown[]): Promise<unknown> => value);

function reconciled(applied: unknown[]) {
  return {
    success: true,
    code: null,
    error: null,
    orderId: 'order-1',
    applied,
    abandoned: 0,
    unresolved: 0,
    reconciliationPending: false,
    localSettlement: {},
  };
}

function deferred() {
  let settle: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: unknown) => settle(value) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function snapshot(orderId: string, total: number, paid: number) {
  return {
    success: true,
    orderId,
    orderTotal: total,
    netPaid: paid,
    outstandingAmount: Math.round((total - paid) * 100) / 100,
    completedPayments: [],
    generation: `gen-${paid}`,
  };
}

function setup() {
  let paid = 0;
  const bridge = {
    giftCardCheckout: {
      redeemForOrder: fn(),
      reconcileOrder: fn(CLEAR),
      fiscalReadiness: fn(),
      fiscalFinalize: fn(),
      fiscalReconcile: fn(),
    },
    payments: {
      getSettlementSnapshot: vi.fn(async (orderId: unknown): Promise<unknown> => snapshot(String(orderId), 20, paid)),
      recordPayment: fn(),
      processPayment: fn(),
    },
    ecr: { processPayment: fn() },
  };
  const service = new GiftCardCheckoutService({ bridge: () => bridge as unknown as GiftCardCheckoutBridge });
  const api = {
    getStatus: vi.fn(async (): Promise<any> => ({ ok: true, data: STATUS })),
    lookup: vi.fn(async (_cardNumber: string): Promise<any> => ({ ok: true, data: { card: CARD, transactions: [] } })),
  };
  const events: GiftCardTenderEvent[] = [];
  const onEvent = vi.fn((event: GiftCardTenderEvent) => {
    events.push(event);
  });
  return { bridge, service, api, events, onEvent, settle: (amount: number) => (paid = amount) };
}

type Harness = ReturnType<typeof setup>;

function view(h: Harness, props: Partial<React.ComponentProps<typeof GiftCardTender>> = {}) {
  return (
    <GiftCardTender
      orderId="order-1"
      orderSynced
      currency="EUR"
      scope={SCOPE}
      online
      service={h.service}
      api={h.api}
      onEvent={h.onEvent}
      {...props}
    />
  );
}

function expectNoGenericWrites(h: Harness) {
  expect(h.bridge.payments.recordPayment).not.toHaveBeenCalled();
  expect(h.bridge.payments.processPayment).not.toHaveBeenCalled();
  expect(h.bridge.ecr.processPayment).not.toHaveBeenCalled();
}

function storedText(): string {
  return [localStorage, sessionStorage]
    .flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index) ?? '';
        return `${key}=${storage.getItem(key) ?? ''}`;
      }),
    )
    .join('\n');
}

async function enterCard() {
  fireEvent.change(screen.getByLabelText('Gift card number'), { target: { value: CARD_NUMBER } });
  const check = screen.getByRole('button', { name: 'Check card' });
  await waitFor(() => expect(check).toBeEnabled());
  return check;
}

/** Another checkout control debiting the same order through the shared service. */
function otherDebit(h: Harness) {
  return h.service.redeem(SCOPE, {
    orderId: 'order-1',
    cardNumber: '6000111122229999',
    amountCents: 500,
    currency: 'EUR',
    card: CARD,
  });
}

describe('GiftCardTender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasModule.mockReturnValue(true);
  });
  afterEach(cleanup);

  it('recovers before the debit, lets native book the payment and keeps no card number', async () => {
    const h = setup();
    h.bridge.giftCardCheckout.redeemForOrder.mockImplementation(async () => {
      h.settle(20);
      return {
        success: true,
        replayed: false,
        recovered: false,
        reconciliationPending: false,
        orderId: 'order-1',
        remoteOrderId: 'remote-order-1',
        idempotencyKey: 'native-key-1',
        payment: PAYMENT,
        localSettlement: { outstandingCents: 0 },
        fiscal: { success: false, status: 'ready', orderId: 'order-1', requiresFinalize: true },
      };
    });
    h.bridge.giftCardCheckout.fiscalFinalize.mockResolvedValue({
      success: true,
      status: 'approved',
      orderId: 'order-1',
      certified: false,
      fiscalReceiptNumber: null,
    });
    render(view(h));

    const check = await enterCard();
    expect(h.bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledWith({ orderId: 'order-1' });
    expect(screen.getByText('Due 20.00 EUR')).toBeInTheDocument();
    fireEvent.click(check);
    expect(await screen.findByText('Card •••• 4321 · balance 50.00 EUR')).toBeInTheDocument();
    expect(h.api.lookup).toHaveBeenCalledExactlyOnceWith(CARD_NUMBER);
    expect(screen.getByLabelText('Amount to charge')).toHaveValue('20.00');
    fireEvent.click(screen.getByRole('button', { name: 'Charge gift card' }));
    expect(await screen.findByText('Gift card payment recorded: 20.00 EUR')).toBeInTheDocument();

    const redeem = h.bridge.giftCardCheckout.redeemForOrder;
    expect(redeem).toHaveBeenCalledExactlyOnceWith({
      orderId: 'order-1',
      cardNumber: CARD_NUMBER,
      amount: 20,
      currency: 'EUR',
    });
    expect(h.bridge.giftCardCheckout.reconcileOrder.mock.invocationCallOrder[0]).toBeLessThan(
      redeem.mock.invocationCallOrder[0],
    );
    expect(screen.getByLabelText('Gift card number')).toHaveValue('');
    expect(screen.getByText('Nothing is outstanding on this order.')).toBeInTheDocument();
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'financial',
        source: 'redeem',
        orderId: 'order-1',
        adopted: [expect.objectContaining({ localPaymentId: 'pay-1', amountCents: 2000, method: 'gift_card' })],
        coverage: expect.objectContaining({ outstandingCents: 0 }),
      }),
    );

    // The receipt follows native readiness; a finalize is never a second debit.
    expect(screen.getByText('Receipt ready to issue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Issue receipt' }));
    expect(await screen.findByText('Receipt approved · Register support not certified')).toBeInTheDocument();
    expect(h.bridge.giftCardCheckout.fiscalFinalize).toHaveBeenCalledExactlyOnceWith({ orderId: 'order-1' });
    expect(screen.queryByRole('button', { name: 'Issue receipt' })).toBeNull();
    expect(redeem).toHaveBeenCalledTimes(1);
    expectNoGenericWrites(h);
    expect(JSON.stringify(h.events)).not.toContain(CARD_NUMBER);
    expect(document.body.innerHTML).not.toContain(CARD_NUMBER);
    expect(storedText()).not.toContain(CARD_NUMBER);
  });

  it('adopts a lost-reply gift once from the exact native row and only probes its pending receipt', async () => {
    const h = setup();
    h.bridge.giftCardCheckout.redeemForOrder.mockImplementation(async () => {
      h.settle(20);
      throw new Error('ipc closed');
    });
    render(view(h));

    fireEvent.click(await enterCard());
    fireEvent.click(await screen.findByRole('button', { name: 'Charge gift card' }));
    expect(await screen.findByText(UNCERTAIN_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText('Gift card number')).toHaveValue('');
    expect(h.events.some((event) => event.type === 'financial')).toBe(false);

    h.bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(reconciled([NATIVE_ROW]));
    h.bridge.giftCardCheckout.fiscalReadiness.mockResolvedValueOnce(RECEIPT_PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Receipt pending confirmation')).toBeInTheDocument();

    expect(h.events.filter((event) => event.type === 'financial')).toEqual([
      {
        type: 'financial',
        orderId: 'order-1',
        source: 'recovery',
        adopted: [RECOVERED],
        coverage: expect.objectContaining({ outstandingCents: 0, netPaidCents: 2000 }),
      },
    ]);
    expect(h.service.getAdmission(SCOPE, 'order-1')).toMatchObject({
      state: 'clear',
      fiscalPending: true,
      giftDebitAllowed: false,
      ordinaryCollectionAllowed: true,
    });
    // A pending receipt is only probed: never issued again, never a second debit.
    expect(screen.queryByRole('button', { name: 'Issue receipt' })).toBeNull();
    h.bridge.giftCardCheckout.fiscalReconcile.mockResolvedValueOnce(RECEIPT_REPLAYED);
    fireEvent.click(screen.getByRole('button', { name: 'Check receipt' }));
    expect(await screen.findByText('Receipt approved · Register support not certified')).toBeInTheDocument();
    expect(h.bridge.giftCardCheckout.fiscalReconcile).toHaveBeenCalledExactlyOnceWith({ orderId: 'order-1' });
    expect(h.bridge.giftCardCheckout.fiscalFinalize).not.toHaveBeenCalled();
    expect(h.bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledTimes(1);
    expectNoGenericWrites(h);
    const shared = JSON.stringify(h.events);
    expect(shared).not.toContain('native-key-1');
    expect(shared).not.toContain(CARD_NUMBER);
  });

  it('blocks gift and ordinary collection while an attempt is unresolved, then admits both after recovery', async () => {
    const h = setup();
    h.bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(PENDING);
    render(view(h));

    expect(await screen.findByText(UNCERTAIN_TEXT)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Gift card number'), { target: { value: CARD_NUMBER } });
    expect(screen.getByRole('button', { name: 'Check card' })).toBeDisabled();
    const admissions = () => h.events.filter((event) => event.type === 'admission');
    expect(admissions().at(-1)).toMatchObject({
      orderId: 'order-1',
      admission: { state: 'unresolved', giftDebitAllowed: false, ordinaryCollectionAllowed: false },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check card' })).toBeEnabled());
    expect(screen.queryByText(UNCERTAIN_TEXT)).toBeNull();
    expect(h.bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(2);
    expect(admissions().at(-1)).toMatchObject({
      orderId: 'order-1',
      admission: { state: 'clear', giftDebitAllowed: true, ordinaryCollectionAllowed: true },
    });
    // The host's ordinary cash/card control reads the same admission; nothing is journaled here.
    await expect(h.service.admitOrdinaryCollection(SCOPE, 'order-1')).resolves.toMatchObject({
      ordinaryCollectionAllowed: true,
    });
    expect(h.bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
    expectNoGenericWrites(h);
  });

  it('blocks the gift debit while another control holds the order for ordinary collection', async () => {
    const h = setup();
    render(view(h));
    const check = await enterCard();
    const admissions = () => h.events.filter((event) => event.type === 'admission');

    const held: { hold?: GiftCardOrdinaryHold } = {};
    act(() => {
      const claim = h.service.claimOrdinaryCollection(SCOPE, 'order-1');
      if (claim.claimed) held.hold = claim.hold;
    });
    const hold = held.hold;
    if (!hold) throw new Error('claim refused');
    await waitFor(() => expect(check).toBeDisabled());
    expect(screen.getByText('Earlier gift card attempts must be checked first.')).toBeInTheDocument();
    expect(admissions().at(-1)).toMatchObject({
      orderId: 'order-1',
      admission: {
        state: 'clear',
        giftDebitAllowed: false,
        ordinaryCollectionAllowed: false,
        reservation: { kind: 'ordinary', status: 'busy' },
      },
    });

    // That control stopped before any send, so the gift debit is available again.
    act(() => {
      h.service.resolveOrdinaryCollection(hold, { outcome: 'not_sent', basis: 'before_send' });
    });
    await waitFor(() => expect(check).toBeEnabled());
    expect(admissions().at(-1)).toMatchObject({ admission: { giftDebitAllowed: true, reservation: null } });
    expect(h.bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
    expectNoGenericWrites(h);
  });

  it('keeps a newer uncertain debit over an older recovery that finishes later', async () => {
    const h = setup();
    const coverageRead = deferred();
    h.bridge.payments.getSettlementSnapshot.mockImplementationOnce(() => coverageRead.promise);
    h.bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(CLEAR).mockResolvedValueOnce(PENDING);
    h.bridge.giftCardCheckout.redeemForOrder.mockRejectedValueOnce(new Error('ipc closed'));
    render(view(h));
    await waitFor(() => expect(h.service.getAdmission(SCOPE, 'order-1').state).toBe('clear'));

    // Another control debits the order while the mount recovery still reads coverage; the reply is lost.
    await act(async () => {
      await otherDebit(h);
    });
    await waitFor(() => expect(h.bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(UNCERTAIN_TEXT)).toBeInTheDocument();

    await act(async () => {
      coverageRead.resolve(snapshot('order-1', 20, 0));
      await tick();
    });
    expect(screen.getByText(UNCERTAIN_TEXT)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(h.events.filter((event) => event.type === 'admission').at(-1)).toMatchObject({
      admission: { state: 'unresolved', ordinaryCollectionAllowed: false },
    });
    expect(h.service.getAdmission(SCOPE, 'order-1')).toMatchObject({
      state: 'unresolved',
      giftDebitAllowed: false,
      ordinaryCollectionAllowed: false,
    });
    expect(h.bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(2);
    expect(h.bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledTimes(1);
    expectNoGenericWrites(h);
  });

  it('never lets an automatic recovery end the busy state of a lookup still in flight', async () => {
    const h = setup();
    const lookup = deferred();
    h.api.lookup.mockImplementationOnce(() => lookup.promise);
    h.bridge.giftCardCheckout.redeemForOrder.mockResolvedValueOnce({
      success: true,
      orderId: 'order-1',
      reconciliationPending: false,
      payment: { ...PAYMENT, localPaymentId: 'pay-2', amountCents: 500 },
    });
    render(view(h));
    const check = await enterCard();
    fireEvent.click(check);
    await waitFor(() => expect(check).toBeDisabled());

    // Another control's debit settles, so this tender re-runs native recovery meanwhile.
    await act(async () => {
      await otherDebit(h);
      for (let turn = 0; turn < 5; turn += 1) await tick();
    });
    expect(h.bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(CHECKING_TEXT)).toBeNull();
    expect(check).toBeDisabled();

    await act(async () => {
      lookup.resolve({ ok: true, data: { card: CARD, transactions: [] } });
      await tick();
    });
    expect(await screen.findByText('Card •••• 4321 · balance 50.00 EUR')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge gift card' })).toBeEnabled();
    expect(h.bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledTimes(1);
  });

  it('shows actionable refusals and never looks up or debits while a precondition fails', async () => {
    const h = setup();
    mocks.hasModule.mockReturnValue(false);
    const { rerender } = render(view(h));

    expect(screen.getByText('The Gift Cards module is not active for this store.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Gift card number')).toBeNull();
    // Earlier attempts are still recovered after the module stops being active.
    await waitFor(() =>
      expect(h.bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledWith({ orderId: 'order-1' }),
    );

    mocks.hasModule.mockReturnValue(true);
    const cases: Array<[Partial<React.ComponentProps<typeof GiftCardTender>>, string]> = [
      [{ online: false }, 'Gift cards need a connection. Reconnect and try again.'],
      [{ orderSynced: false }, 'Wait until the order is synced, then try again.'],
      [
        { selectedItemIds: ['item-1'] },
        'Gift cards can pay an amount split only. Switch to an amount split or use another tender.',
      ],
      [{ currency: 'eur' }, 'The card currency does not match the order currency.'],
      [{ orderId: null }, 'Create the order before taking a gift card.'],
    ];
    for (const [props, message] of cases) {
      rerender(view(h, props));
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByLabelText('Gift card number')).toBeNull();
    }
    expect(h.api.lookup).not.toHaveBeenCalled();
    expect(h.bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
  });

  it('drops a stale recovery after the order changes and clears the typed card number', async () => {
    const h = setup();
    const staleOrder = deferred();
    h.bridge.giftCardCheckout.reconcileOrder.mockImplementationOnce(() => staleOrder.promise);
    const { rerender } = render(view(h));
    expect(await screen.findByText(CHECKING_TEXT)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Gift card number'), { target: { value: CARD_NUMBER } });

    rerender(view(h, { orderId: 'order-2' }));
    const since = h.events.length;
    expect(screen.getByLabelText('Gift card number')).toHaveValue('');
    await waitFor(() =>
      expect(h.bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledWith({ orderId: 'order-2' }),
    );
    await act(async () => {
      staleOrder.resolve(reconciled([NATIVE_ROW]));
    });

    await enterCard();
    expect(h.events.some((event) => event.type === 'financial')).toBe(false);
    expect(h.events.slice(since).every((event) => event.orderId === 'order-2')).toBe(true);
    expect(h.bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
  });

  it('fences a recovery that finishes after the organization or terminal changed', async () => {
    const h = setup();
    const staleScope = deferred();
    h.bridge.giftCardCheckout.reconcileOrder
      .mockImplementationOnce(() => staleScope.promise)
      .mockResolvedValueOnce(PENDING);
    const { rerender } = render(view(h));
    expect(await screen.findByText(CHECKING_TEXT)).toBeInTheDocument();

    const nextScope = { organizationId: 'org-2', terminalId: 'term-9' };
    rerender(view(h, { scope: nextScope }));
    const since = h.events.length;
    expect(await screen.findByText(UNCERTAIN_TEXT)).toBeInTheDocument();
    await act(async () => {
      staleScope.resolve(reconciled([NATIVE_ROW]));
      await tick();
    });

    expect(screen.getByText(UNCERTAIN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(h.events.some((event) => event.type === 'financial')).toBe(false);
    expect(
      h.events
        .slice(since)
        .every((event) => event.type !== 'admission' || event.admission.organizationId === 'org-2'),
    ).toBe(true);
    expect(h.service.getAdmission(nextScope, 'order-1').state).toBe('unresolved');
    expect(h.service.getAdmission(SCOPE, 'order-1').state).toBe('clear');
  });

  it('pays an amount-only split portion at its fixed amount and leaves the rest to cash or card', async () => {
    const h = setup();
    h.bridge.giftCardCheckout.redeemForOrder.mockImplementation(async () => {
      h.settle(10);
      return {
        success: true,
        orderId: 'order-1',
        reconciliationPending: false,
        payment: { ...PAYMENT, amountCents: 1000 },
        fiscal: { success: false, status: 'partial', orderId: 'order-1' },
      };
    });
    render(view(h, { split: { groupId: 'split-1', portionId: 'portion-1' }, fixedAmountCents: 1000 }));

    fireEvent.click(await enterCard());
    const amount = await screen.findByLabelText('Amount to charge');
    expect(amount).toHaveValue('10.00');
    expect(amount).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Charge gift card' }));

    expect(
      await screen.findByText('Collect the rest with cash or card; the receipt follows that payment'),
    ).toBeInTheDocument();
    expect(h.bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledExactlyOnceWith({
      orderId: 'order-1',
      cardNumber: CARD_NUMBER,
      amount: 10,
      currency: 'EUR',
      split: { groupId: 'split-1', portionId: 'portion-1' },
    });
    expect(screen.getByText('Due 10.00 EUR')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue receipt' })).toBeNull();
    expect(h.bridge.giftCardCheckout.fiscalFinalize).not.toHaveBeenCalled();
    expectNoGenericWrites(h);
  });

  it('refuses an expired card before any debit and shows a native staff refusal without retrying', async () => {
    const h = setup();
    h.api.lookup.mockResolvedValueOnce({ ok: true, data: { card: { ...CARD, status: 'expired' }, transactions: [] } });
    h.bridge.giftCardCheckout.redeemForOrder.mockResolvedValue({
      success: false,
      code: 'GIFT_CARD_STAFF_SESSION_REQUIRED',
      orderId: 'order-1',
    });
    render(view(h));

    const check = await enterCard();
    fireEvent.click(check);
    expect(await screen.findByText('This gift card has expired.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge gift card' })).toBeDisabled();

    fireEvent.click(check);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Charge gift card' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Charge gift card' }));
    expect(
      await screen.findByText('A signed-in staff session is required. Sign in again and retry.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Gift card number')).toHaveValue('');
    expect(h.bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledTimes(1);
    expect(h.events.some((event) => event.type === 'financial')).toBe(false);
    expectNoGenericWrites(h);
  });
});
