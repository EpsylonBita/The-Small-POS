import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../locales/en.json';
import type { GiftReturnView } from '../../../../lib/ipc-contracts';
import { GIFT_RETURN_PENDING_EXISTS } from '../../../lib/gift-card-returns';
import { formatCurrency } from '../../../utils/format';
import OrderDetailsModal from '../OrderDetailsModal';

// The real OrderDetailsModal mounts the real RefundVoidModal; only the native bridge is scripted.

type Listener = (payload?: unknown) => void;

const i18nMock = vi.hoisted(() => ({
  translator(dictionary: Record<string, unknown>) {
    const lookup = (key: string): unknown =>
      key.split('.').reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        dictionary,
      );
    return (key: string, options?: unknown): string => {
      const values =
        options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
      const found = lookup(key);
      const template =
        typeof found === 'string'
          ? found
          : typeof values.defaultValue === 'string'
            ? values.defaultValue
            : typeof options === 'string'
              ? options
              : key;
      return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) =>
        values[name] === undefined ? '' : String(values[name]),
      );
    };
  },
}));

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(payload?: unknown) => void>>(),
  shift: {
    staff: null as null | { staffId: string; name: string; databaseStaffId: string },
    activeShift: { id: 'shift-1', staff_id: 'staff-1' },
  },
  bridge: {
    orders: { getById: vi.fn(), getByCustomerPhone: vi.fn() },
    payments: {
      getOrderPayments: vi.fn(),
      getPaidItems: vi.fn(),
      getSettlementSnapshot: vi.fn(),
      voidPayment: vi.fn(),
    },
    refunds: {
      getPaymentBalance: vi.fn(),
      listOrderAdjustments: vi.fn(),
      refundPayment: vi.fn(),
    },
    giftReturns: { authorize: vi.fn(), status: vi.fn(), begin: vi.fn(), recover: vi.fn() },
    terminalConfig: { getOrganizationId: vi.fn(), getBranchId: vi.fn(), getTerminalId: vi.fn() },
  },
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const dictionary = (await import('../../../../locales/en.json')).default as unknown as Record<
    string,
    unknown
  >;
  const t = i18nMock.translator(dictionary);
  const i18n = { language: 'en', resolvedLanguage: 'en', changeLanguage: async () => undefined };
  return { ...actual, useTranslation: () => ({ t, i18n, ready: true }) };
});

vi.mock('../../../../lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBridge: () => mocks.bridge,
  onEvent: (event: string, handler: Listener) => {
    const handlers = mocks.listeners.get(event) ?? new Set<Listener>();
    handlers.add(handler);
    mocks.listeners.set(event, handlers);
  },
  offEvent: (event: string, handler: Listener) => {
    mocks.listeners.get(event)?.delete(handler);
  },
}));

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: () => undefined }),
}));

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key, language: 'en', setLanguage: () => undefined }),
}));

vi.mock('../../../contexts/shift-context', () => ({ useShift: () => mocks.shift }));

vi.mock('../../../services/MenuService', () => ({
  menuService: {
    getMenuItems: async () => [],
    getMenuCategories: async () => [],
    getIngredients: async () => [],
  },
}));

vi.mock('../../ui/PlatformHeldPaymentNotice', () => ({
  PlatformHeldPaymentNotice: () => null,
  usePlatformHeldNotice: () => null,
}));

const tr = i18nMock.translator(en as unknown as Record<string, unknown>);

const ORDER_ID = 'order-1';
const STAFF = { staffId: 'staff-1', name: 'Ana', databaseStaffId: 'staff-1' };
const FUTURE = '2099-01-01T00:00:00.000Z';

// -- Scripted native state ------------------------------------------------------

const world = {
  paymentStatus: 'paid',
  returnedCents: 0,
  pendingKey: null as string | null,
  returns: [] as GiftReturnView[],
};

const orderRow = (paymentStatus = world.paymentStatus) => ({
  id: ORDER_ID,
  order_number: 'ORD-1',
  status: 'completed',
  order_type: 'pickup',
  total_amount: 15,
  payment_status: paymentStatus,
  items: [],
  created_at: '2026-09-28T10:00:00.000Z',
});

// Split tender: cash 5 + gift card 10.
const paymentRows = () => [
  {
    id: 'pay-cash',
    order_id: ORDER_ID,
    method: 'cash',
    amount: 5,
    status: 'completed',
    created_at: '2026-09-28T10:00:00.000Z',
  },
  {
    id: 'pay-gift',
    order_id: ORDER_ID,
    method: 'gift_card',
    amount: 10,
    status: 'completed',
    created_at: '2026-09-28T10:01:00.000Z',
  },
];

// Native settlement: every completed row minus per-payment returns.
const settlement = (
  netPaid = 15 - world.returnedCents / 100,
  outstanding = world.returnedCents / 100,
) => ({ success: true, orderId: ORDER_ID, netPaid, outstandingAmount: outstanding });

const giftView = (
  overrides: Partial<GiftReturnView> & Pick<GiftReturnView, 'returnKey'>,
): GiftReturnView => ({
  localPaymentId: 'pay-gift',
  localOrderId: ORDER_ID,
  action: 'refund',
  state: 'completed',
  currency: 'EUR',
  grossCents: 1000,
  requestedCents: 400,
  reason: 'Damaged',
  staffId: STAFF.staffId,
  sendCount: 1,
  lastCode: null,
  authRequired: false,
  createdAt: '2026-09-28T10:05:00.000Z',
  updatedAt: '2026-09-28T10:05:00.000Z',
  proof: null,
  ...overrides,
});

/** Native commits a return to the original card; the order becomes partially paid. */
const commitReturn = (
  returnKey: string,
  cents: number,
  reason: string,
  action: 'refund' | 'void' = 'refund',
) => {
  world.returnedCents += cents;
  world.pendingKey = null;
  world.paymentStatus = 'partially_paid';
  const done = giftView({
    returnKey,
    action,
    reason,
    requestedCents: action === 'void' ? null : cents,
    proof: {
      returnId: `ret-${returnKey}`,
      paymentAdjustmentId: `adj-${returnKey}`,
      returnedCents: cents,
      totalReturnedCents: world.returnedCents,
      remainingCents: 1000 - world.returnedCents,
      paymentStatus: 'completed',
      orderPaymentStatus: 'partially_paid',
      orderRemainingCents: world.returnedCents,
      cardBalanceCents: 2000 + world.returnedCents,
      replayed: false,
      completedAt: '2026-09-28T10:05:01.000Z',
    } as NonNullable<GiftReturnView['proof']>,
  });
  world.returns = [done, ...world.returns.filter((row) => row.returnKey !== returnKey)];
  return done;
};

const completed = (row: GiftReturnView) => ({
  success: true,
  contract: 'atomic_return_v1',
  outcome: 'completed',
  return: row,
});

const statusResponse = () => ({
  success: true,
  contract: 'atomic_return_v1',
  advisory: true,
  authorization: { active: true, staffId: STAFF.staffId, usableUntil: FUTURE },
  original: {
    localPaymentId: 'pay-gift',
    eligible: world.pendingKey === null,
    code: world.pendingKey === null ? null : GIFT_RETURN_PENDING_EXISTS,
    currency: 'EUR',
    grossCents: 1000,
    returnedCents: world.returnedCents,
    remainingCents: 1000 - world.returnedCents,
    pendingReturnKey: world.pendingKey,
  },
  returns: world.returns,
});

// -- Held and failing calls -----------------------------------------------------

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
}

const defer = (): Deferred => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const gates = new Map<string, Array<{ skip: number; mode: 'hold' | 'fail'; deferred: Deferred }>>();

/** After `skip` calls pass, the next call to `name` is held for the test to answer, or fails. */
const arm = (name: string, mode: 'hold' | 'fail', skip = 0): Deferred => {
  const deferred = defer();
  gates.set(name, [...(gates.get(name) ?? []), { skip, mode, deferred }]);
  return deferred;
};

const route =
  (name: string, answer: (...args: any[]) => unknown) =>
  async (...args: any[]): Promise<unknown> => {
    const queue = gates.get(name);
    const gate = queue?.[0];
    if (gate && gate.skip > 0) {
      gate.skip -= 1;
    } else if (gate) {
      queue!.shift();
      if (gate.mode === 'fail') throw new Error(`${name} unavailable`);
      return gate.deferred.promise;
    }
    return answer(...args);
  };

const emit = (event: string) => {
  mocks.listeners.get(event)?.forEach((handler) => handler(undefined));
};

afterEach(cleanup);

beforeEach(() => {
  world.paymentStatus = 'paid';
  world.returnedCents = 0;
  world.pendingKey = null;
  world.returns = [];
  gates.clear();
  mocks.listeners.clear();
  mocks.shift.staff = { ...STAFF };
  const { bridge } = mocks;
  bridge.orders.getById.mockImplementation(route('getById', () => orderRow()));
  bridge.orders.getByCustomerPhone.mockImplementation(
    route('getByCustomerPhone', () => ({ success: true, orders: [] })),
  );
  bridge.payments.getOrderPayments.mockImplementation(route('getOrderPayments', () => paymentRows()));
  bridge.payments.getPaidItems.mockImplementation(route('getPaidItems', () => []));
  bridge.payments.getSettlementSnapshot.mockImplementation(
    route('getSettlementSnapshot', () => settlement()),
  );
  bridge.payments.voidPayment.mockImplementation(route('voidPayment', () => ({ success: true })));
  bridge.refunds.getPaymentBalance.mockImplementation(
    route('getPaymentBalance', () => ({ originalAmount: 5, totalRefunds: 0, remaining: 5 })),
  );
  bridge.refunds.listOrderAdjustments.mockImplementation(route('listOrderAdjustments', () => []));
  bridge.refunds.refundPayment.mockImplementation(route('refundPayment', () => ({ success: true })));
  bridge.giftReturns.authorize.mockImplementation(
    route('authorize', () => ({
      success: true,
      contract: 'atomic_return_v1',
      staffId: STAFF.staffId,
      usableUntil: FUTURE,
    })),
  );
  bridge.giftReturns.status.mockImplementation(route('status', () => statusResponse()));
  bridge.giftReturns.begin.mockImplementation(
    route('begin', () => {
      throw new Error('begin was not scripted');
    }),
  );
  bridge.giftReturns.recover.mockImplementation(
    route('recover', ({ returnKey }: { returnKey: string }) => {
      const row = world.returns.find((attempt) => attempt.returnKey === returnKey);
      if (!row || row.state !== 'completed') throw new Error('recover was not scripted');
      // Native returns an already completed proof without another send.
      return completed(row);
    }),
  );
  bridge.terminalConfig.getOrganizationId.mockImplementation(() => 'org-1');
  bridge.terminalConfig.getBranchId.mockImplementation(() => 'branch-1');
  bridge.terminalConfig.getTerminalId.mockImplementation(() => 'terminal-1');
});

const scriptBegin = (answer: (payload: any) => unknown) =>
  mocks.bridge.giftReturns.begin.mockImplementation(route('begin', answer));

// -- Operator steps -------------------------------------------------------------

const renderDetails = () => {
  const onClose = vi.fn();
  const ui = (isOpen: boolean) => (
    <OrderDetailsModal isOpen={isOpen} orderId={ORDER_ID} onClose={onClose} />
  );
  const utils = render(ui(true));
  return {
    ...utils,
    reopen: () => {
      utils.rerender(ui(false));
      utils.rerender(ui(true));
    },
    rerenderOpen: () => utils.rerender(ui(true)),
  };
};

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

const coverageText = (paid: number, outstanding: number) =>
  tr('modals.refund.gift.netCoverage', {
    paid: formatCurrency(paid),
    outstanding: formatCurrency(outstanding),
  });

const expectCoverage = (paid: number, outstanding: number) =>
  waitFor(() =>
    expect(screen.getByTestId('order-details-net-coverage')).toHaveTextContent(
      coverageText(paid, outstanding),
    ),
  );

const openGiftPanel = async () => {
  const entry = await screen.findByTestId('order-details-void-refund');
  await waitFor(() => expect(entry).toBeEnabled());
  fireEvent.click(entry);
  fireEvent.click(await screen.findByTestId('gift-return-open-pay-gift'));
  await screen.findByTestId('gift-return-authorize-form');
};

const authorize = async () => {
  await waitFor(() => expect(screen.getByTestId('gift-return-authorize')).toBeEnabled());
  fireEvent.change(screen.getByTestId('gift-return-pin'), { target: { value: '1234' } });
  fireEvent.click(screen.getByTestId('gift-return-authorize'));
};

const requestReturn = async (amount: string, reason: string) => {
  fireEvent.change(await screen.findByTestId('gift-return-amount'), { target: { value: amount } });
  fireEvent.change(screen.getByTestId('gift-return-reason'), { target: { value: reason } });
  fireEvent.click(screen.getByTestId('gift-return-review'));
  fireEvent.click(await screen.findByTestId('gift-return-confirm'));
};

const lastByClass = (className: string) => {
  const nodes = document.querySelectorAll(`.${className}`);
  return nodes[nodes.length - 1] as HTMLElement;
};

describe('OrderDetailsModal with RefundVoidModal: original-card gift returns', () => {
  it('returns exactly 4.00 of a cash 5 + gift 10 order to the card and shows net 11 without any payout', async () => {
    scriptBegin(() => completed(commitReturn('rk-1', 400, 'Damaged')));
    renderDetails();
    await expectCoverage(15, 0);
    await openGiftPanel();
    await authorize();

    // Sub-cent input never reaches native.
    fireEvent.change(await screen.findByTestId('gift-return-amount'), { target: { value: '4.005' } });
    fireEvent.change(screen.getByTestId('gift-return-reason'), { target: { value: 'Damaged' } });
    fireEvent.click(screen.getByTestId('gift-return-review'));
    expect(screen.getByTestId('gift-return-notice')).toHaveTextContent(
      tr('modals.refund.gift.invalidAmount'),
    );

    fireEvent.change(screen.getByTestId('gift-return-amount'), { target: { value: '4.00' } });
    fireEvent.click(screen.getByTestId('gift-return-review'));
    expect(screen.getByTestId('gift-return-frozen-amount')).toHaveTextContent(
      formatCurrency(4, 'EUR'),
    );
    fireEvent.click(screen.getByTestId('gift-return-confirm'));

    await expectCoverage(11, 4);
    // A second return is offered only from the refreshed native original.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('gift-return-original')).getByText(formatCurrency(6, 'EUR')),
      ).toBeInTheDocument(),
    );
    expect(mocks.bridge.giftReturns.begin).toHaveBeenCalledTimes(1);
    expect(mocks.bridge.giftReturns.begin).toHaveBeenCalledWith({
      localPaymentId: 'pay-gift',
      action: 'refund',
      amountCents: 400,
      reason: 'Damaged',
    });
    expect(mocks.bridge.refunds.refundPayment).not.toHaveBeenCalled();
    expect(mocks.bridge.payments.voidPayment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('order-details-gift-refresh-failed')).toBeNull();
    expect(screen.getByTestId('order-details-void-refund')).toBeEnabled();
  });

  it('sends a void without any client amount', async () => {
    scriptBegin(() => completed(commitReturn('rk-void', 1000, 'Wrong card', 'void')));
    renderDetails();
    await expectCoverage(15, 0);
    await openGiftPanel();
    await authorize();

    fireEvent.click(await screen.findByTestId('gift-return-action-void'));
    expect(screen.getByTestId('gift-return-void-note')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('gift-return-reason'), { target: { value: 'Wrong card' } });
    fireEvent.click(screen.getByTestId('gift-return-review'));
    expect(screen.getByTestId('gift-return-frozen-amount')).toHaveTextContent(
      tr('modals.refund.gift.voidNoAmount'),
    );
    fireEvent.click(screen.getByTestId('gift-return-confirm'));

    await expectCoverage(5, 10);
    expect(mocks.bridge.giftReturns.begin).toHaveBeenCalledWith({
      localPaymentId: 'pay-gift',
      action: 'void',
      reason: 'Wrong card',
    });
    expect(mocks.bridge.giftReturns.begin.mock.calls[0][0]).not.toHaveProperty('amountCents');
    expect(mocks.bridge.payments.voidPayment).not.toHaveBeenCalled();
  });

  it('keeps a lost begin retained and recovers the same original after the dialog reopens', async () => {
    scriptBegin(() => {
      // Native persisted the original before the reply was lost.
      world.pendingKey = 'rk-1';
      world.returns = [giftView({ returnKey: 'rk-1', state: 'pending', sendCount: 1 })];
      throw new Error('reply lost');
    });
    mocks.bridge.giftReturns.recover.mockImplementation(
      route('recover', ({ returnKey }: { returnKey: string }) =>
        completed(commitReturn(returnKey, 400, 'Damaged')),
      ),
    );
    renderDetails();
    await expectCoverage(15, 0);
    await openGiftPanel();
    await authorize();
    await requestReturn('4.00', 'Damaged');
    await screen.findByTestId('gift-return-retained');

    fireEvent.click(screen.getByTestId('refund-modal-close'));
    await waitFor(() => expect(screen.queryByTestId('gift-return-panel')).toBeNull());
    expect(screen.getByTestId('order-details-net-coverage')).toHaveTextContent(coverageText(15, 0));

    await openGiftPanel();
    await authorize();
    fireEvent.click(await screen.findByTestId('gift-return-recover'));

    await expectCoverage(11, 4);
    expect(mocks.bridge.giftReturns.recover).toHaveBeenCalledWith({ returnKey: 'rk-1' });
    expect(mocks.bridge.giftReturns.begin).toHaveBeenCalledTimes(1);
    expect(mocks.bridge.refunds.refundPayment).not.toHaveBeenCalled();
  });

  it('checks a completed own return by its key after remount, then allows a second partial', async () => {
    // Committed earlier; its reply and status were lost before this mount.
    commitReturn('rk-1', 400, 'Damaged');
    scriptBegin(() => completed(commitReturn('rk-2', 200, 'Second')));
    renderDetails();
    await expectCoverage(11, 4);
    await openGiftPanel();
    await authorize();

    // Completed history does not block a fresh return, and its proof can be checked.
    await screen.findByTestId('gift-return-form');
    fireEvent.click(screen.getByTestId('gift-return-proof-check-rk-1'));
    await waitFor(() =>
      expect(screen.getByTestId('gift-return-notice')).toHaveTextContent(
        tr('modals.refund.gift.proofConfirmed', { amount: formatCurrency(4, 'EUR') }),
      ),
    );
    await screen.findByTestId('gift-return-form');
    expect(mocks.bridge.giftReturns.recover).toHaveBeenCalledWith({ returnKey: 'rk-1' });
    expect(mocks.bridge.giftReturns.begin).not.toHaveBeenCalled();

    await requestReturn('2.00', 'Second');
    await expectCoverage(9, 6);
    expect(mocks.bridge.giftReturns.begin).toHaveBeenCalledTimes(1);
    expect(mocks.bridge.giftReturns.begin).toHaveBeenCalledWith({
      localPaymentId: 'pay-gift',
      action: 'refund',
      amountCents: 200,
      reason: 'Second',
    });
    expect(mocks.bridge.giftReturns.recover).toHaveBeenCalledTimes(1);
  });

  it('fences a held completion at the backdrop close intent, and the original stays recoverable', async () => {
    const held = arm('begin', 'hold');
    renderDetails();
    await expectCoverage(15, 0);
    await openGiftPanel();
    await authorize();
    await requestReturn('4.00', 'Damaged');
    await screen.findByTestId('gift-return-sending');
    const snapshotReads = mocks.bridge.payments.getSettlementSnapshot.mock.calls.length;
    const orderReads = mocks.bridge.orders.getById.mock.calls.length;

    fireEvent.click(lastByClass('liquid-glass-modal-backdrop'));
    // The exit animation keeps the panel mounted, but its held reply is already fenced.
    expect(screen.getByTestId('gift-return-panel')).toBeInTheDocument();
    await act(async () => {
      held.resolve(completed(commitReturn('rk-1', 400, 'Damaged')));
    });
    await flush();

    expect(screen.queryByTestId('gift-return-completed')).toBeNull();
    expect(mocks.bridge.payments.getSettlementSnapshot.mock.calls.length).toBe(snapshotReads);
    expect(mocks.bridge.orders.getById.mock.calls.length).toBe(orderReads);
    expect(screen.getByTestId('order-details-net-coverage')).toHaveTextContent(coverageText(15, 0));

    const closingShell = lastByClass('liquid-glass-modal-shell');
    fireEvent.animationEnd(closingShell);
    // JSDOM lacks AnimationEvent, so React also listens for the WebKit event.
    fireEvent(closingShell, new Event('webkitAnimationEnd', { bubbles: true }));
    await waitFor(() => expect(screen.queryByTestId('gift-return-panel')).toBeNull());

    // The durable native original is proved later by its key, without another send.
    await openGiftPanel();
    await authorize();
    fireEvent.click(await screen.findByTestId('gift-return-proof-check-rk-1'));
    await expectCoverage(11, 4);
    expect(mocks.bridge.giftReturns.begin).toHaveBeenCalledTimes(1);
    expect(mocks.bridge.giftReturns.recover).toHaveBeenCalledWith({ returnKey: 'rk-1' });
  });

  it('drops held parent reads after a same-order close and reopen answered in reverse order', async () => {
    scriptBegin(() => completed(commitReturn('rk-1', 400, 'Damaged')));
    const details = renderDetails();
    await expectCoverage(15, 0);
    await openGiftPanel();
    await authorize();
    await screen.findByTestId('gift-return-form');

    // The panel's own reread passes; the parent's reread after it is held.
    const staleOrder = arm('getById', 'hold', 1);
    const stalePaidItems = arm('getPaidItems', 'hold');
    const staleSettlement = arm('getSettlementSnapshot', 'hold', 1);
    await requestReturn('4.00', 'Damaged');
    await waitFor(() => expect(mocks.bridge.payments.getPaidItems).toHaveBeenCalledTimes(2));

    details.reopen();
    await expectCoverage(11, 4);
    expect(screen.getByTestId('order-details-void-refund')).toHaveTextContent(
      tr('modals.refund.gift.action'),
    );

    // The pre-close reads now answer with pre-return values.
    await act(async () => {
      staleOrder.resolve(orderRow('paid'));
      stalePaidItems.resolve([]);
      staleSettlement.resolve(settlement(15, 0));
    });
    await flush();

    expect(screen.getByTestId('order-details-net-coverage')).toHaveTextContent(coverageText(11, 4));
    expect(screen.getByTestId('order-details-void-refund')).toHaveTextContent(
      tr('modals.refund.gift.action'),
    );
    expect(screen.queryByTestId('order-details-gift-refresh-failed')).toBeNull();
  });

  it('keeps the proof but blocks fresh actions until a failed parent reread succeeds', async () => {
    scriptBegin(() => completed(commitReturn('rk-1', 400, 'Damaged')));
    renderDetails();
    await expectCoverage(15, 0);
    await openGiftPanel();
    await authorize();
    await screen.findByTestId('gift-return-form');

    // The panel's own reread passes; the parent's order read fails.
    arm('getById', 'fail', 1);
    await requestReturn('4.00', 'Damaged');

    await screen.findByTestId('gift-return-reread-retry');
    expect(screen.getByTestId('gift-return-completed')).toHaveTextContent(
      tr('modals.refund.gift.rereadFailed'),
    );
    expect(screen.getByTestId('gift-return-notice')).toHaveTextContent(
      tr('modals.refund.gift.completed', {
        amount: formatCurrency(4, 'EUR'),
        remaining: formatCurrency(6, 'EUR'),
      }),
    );
    expect(screen.queryByTestId('gift-return-form')).toBeNull();
    expect(await screen.findByTestId('order-details-gift-refresh-failed')).toHaveTextContent(
      tr('modals.refund.gift.orderRefreshFailed'),
    );
    expect(screen.getByTestId('order-details-void-refund')).toBeDisabled();

    fireEvent.click(screen.getByTestId('gift-return-reread-retry'));
    await screen.findByTestId('gift-return-form');
    await waitFor(() =>
      expect(screen.queryByTestId('order-details-gift-refresh-failed')).toBeNull(),
    );
    expect(screen.getByTestId('order-details-void-refund')).toBeEnabled();
    await expectCoverage(11, 4);
    expect(mocks.bridge.giftReturns.begin).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary cash refunds on their existing path with no gift return call', async () => {
    renderDetails();
    await expectCoverage(15, 0);
    fireEvent.click(await screen.findByTestId('order-details-void-refund'));
    const cashRow = await screen.findByTestId('refund-payment-pay-cash');
    fireEvent.click(within(cashRow).getByRole('button', { name: tr('modals.refund.refundButton') }));
    fireEvent.change(await screen.findByRole('spinbutton'), { target: { value: '5' } });
    const reasons = document.querySelectorAll('textarea');
    fireEvent.change(reasons[reasons.length - 1], { target: { value: 'Cold food' } });
    fireEvent.click(screen.getByRole('button', { name: tr('modals.refund.confirmRefund') }));

    await waitFor(() =>
      expect(mocks.bridge.refunds.refundPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: 'pay-cash',
          amount: 5,
          orderId: ORDER_ID,
          refundMethod: 'cash',
        }),
      ),
    );
    for (const call of Object.values(mocks.bridge.giftReturns)) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(screen.queryByTestId('gift-return-panel')).toBeNull();
  });

  it('drops a held authorization when the terminal configuration changes', async () => {
    const held = arm('authorize', 'hold');
    renderDetails();
    await expectCoverage(15, 0);
    await openGiftPanel();
    await authorize();
    await waitFor(() =>
      expect(mocks.bridge.giftReturns.authorize).toHaveBeenCalledWith({
        staffId: STAFF.staffId,
        pin: '1234',
      }),
    );

    act(() => emit('terminal-config-updated'));
    await act(async () => {
      held.resolve({
        success: true,
        contract: 'atomic_return_v1',
        staffId: STAFF.staffId,
        usableUntil: FUTURE,
      });
    });
    await flush();

    expect(mocks.bridge.giftReturns.status).not.toHaveBeenCalled();
    expect(screen.getByTestId('gift-return-authorize-form')).toBeInTheDocument();
    expect(screen.getByTestId('gift-return-notice')).toHaveTextContent(
      tr('modals.refund.gift.contextChanged'),
    );
  });

  it('ends a held begin when the selected staff changes', async () => {
    const held = arm('begin', 'hold');
    const details = renderDetails();
    await expectCoverage(15, 0);
    await openGiftPanel();
    await authorize();
    await requestReturn('4.00', 'Damaged');
    await screen.findByTestId('gift-return-sending');
    const snapshotReads = mocks.bridge.payments.getSettlementSnapshot.mock.calls.length;

    mocks.shift.staff = { staffId: 'staff-2', name: 'Bo', databaseStaffId: 'staff-2' };
    details.rerenderOpen();
    await screen.findByTestId('gift-return-authorize-form');
    await act(async () => {
      held.resolve(completed(commitReturn('rk-1', 400, 'Damaged')));
    });
    await flush();

    expect(screen.queryByTestId('gift-return-completed')).toBeNull();
    expect(mocks.bridge.payments.getSettlementSnapshot.mock.calls.length).toBe(snapshotReads);
    expect(mocks.bridge.giftReturns.status).toHaveBeenCalledTimes(1);
  });
});
