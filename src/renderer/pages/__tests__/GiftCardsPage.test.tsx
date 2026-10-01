import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GiftFundingAttemptView,
  GiftFundingAvailability,
  GiftFundingAvailabilityAuthority,
  ShiftFinancialOpeningView,
} from '../../../lib/ipc-contracts';

type SentOptions = { method: string; body?: Record<string, unknown> };
type RouteHandler = (options: SentOptions) => unknown;
type Listener = (payload: unknown) => void;

interface ShiftFixture {
  staff: {
    staffId: string;
    name: string;
    role: string;
    branchId: string;
    terminalId: string;
    organizationId?: string;
  } | null;
  activeShift: { id: string; status: 'active' } | null;
  isShiftActive: boolean;
}

const mocks = vi.hoisted(() => ({
  moduleEnabled: true,
  shift: null as unknown as ShiftFixture,
  listeners: new Map<string, Set<Listener>>(),
  bridge: {
    invoke: vi.fn(),
    sync: { getNetworkStatus: vi.fn() },
    terminalConfig: {
      getOrganizationId: vi.fn(),
      getBranchId: vi.fn(),
      getTerminalId: vi.fn(),
    },
  },
  // The native funding client: every reply is a controlled, typed fixture.
  funding: {
    availability: vi.fn(),
    journal: vi.fn(),
    prepare: vi.fn(),
    grant: vi.fn(),
    begin: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
    recover: vi.fn(),
    authorizeManager: vi.fn(),
    drawer: vi.fn(),
    cashierOpening: vi.fn(),
    renewCashier: vi.fn(),
    staffDirectory: vi.fn(),
  },
}));

// Real English strings, so the test also proves the locale keys exist.
vi.mock('react-i18next', async () => {
  const localeModule: unknown = await import('../../../locales/en.json');
  const en = ((localeModule as { default?: unknown }).default ?? localeModule) as Record<string, unknown>;
  const t = (key: string, options?: Record<string, unknown>) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
        en,
      );
    const template =
      typeof value === 'string' ? value : typeof options?.defaultValue === 'string' ? options.defaultValue : key;
    return template.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => String(options?.[name] ?? ''));
  };
  return {
    useTranslation: () => ({ t, i18n: { language: 'en' } }),
    // utils/format loads src/lib/i18n, which registers this plugin.
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../contexts/shift-context', () => ({
  useShift: () => mocks.shift,
}));

vi.mock('../../contexts/module-context', () => ({
  useModules: () => ({
    enabledModules: [],
    isLoading: false,
    error: null,
    isSyncing: false,
    refreshModules: vi.fn(),
    syncModulesFromAdmin: vi.fn(),
    isModuleEnabled: (moduleId: string) => mocks.moduleEnabled && moduleId === 'gift_cards',
  }),
}));

vi.mock('../../../lib', () => ({
  getBridge: () => mocks.bridge,
  onEvent: (channel: string, listener: Listener) => {
    const listeners = mocks.listeners.get(channel) ?? new Set<Listener>();
    listeners.add(listener);
    mocks.listeners.set(channel, listeners);
  },
  offEvent: (channel: string, listener: Listener) => {
    mocks.listeners.get(channel)?.delete(listener);
  },
}));

vi.mock('../../lib/gift-card-funding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/gift-card-funding')>()),
  giftCardFunding: mocks.funding,
}));

import GiftCardsPage from '../GiftCardsPage';
import { buildFundingEvidence, type giftCardFunding } from '../../lib/gift-card-funding';

type FundingClient = typeof giftCardFunding;
type Reply<K extends keyof FundingClient> = FundingClient[K] extends (...args: never[]) => Promise<infer R> ? R : never;

const CARD = {
  id: 'card-1',
  card_number_last4: '7788',
  masked_number: '****7788',
  initial_balance: 25,
  balance: 25,
  currency: 'EUR',
  status: 'active',
};

const TRANSACTION = {
  id: 'tx-1',
  transaction_type: 'issue',
  amount: 25,
  balance_after: 25,
  currency: 'EUR',
  created_at: '2026-09-01T10:00:00Z',
};

const FUTURE = '2099-01-01T00:00:00.000Z';
const ACTOR = { staffId: 'staff-1', organizationId: 'org-1', branchId: 'branch-1', terminalId: 'term-1' };
const REFS = { provider: 'Viva', merchantId: 'M-100', terminalReference: 'T-7', transactionReference: 'TX-42' };
const DIRECTORY = [
  { id: 'staff-1', name: 'Ana' },
  { id: 'mgr-2', name: 'Maria' },
];
const LOGGED_OUT: ShiftFixture = { staff: null, activeShift: null, isShiftActive: false };

const cashierOn = (staffId = 'staff-1', name = 'Ana'): ShiftFixture => ({
  staff: { staffId, name, role: 'cashier', branchId: 'branch-1', terminalId: 'term-1', organizationId: 'org-1' },
  activeShift: { id: 'shift-1', status: 'active' },
  isShiftActive: true,
});

const readyStatus = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  status: 200,
  data: {
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
      supports_issue: false,
      supports_reload: false,
      supports_redeem: true,
      supports_history: true,
      currency: 'EUR',
      ...overrides,
    },
  },
});

const lookupReply = (transactions: unknown[] = []) => () => ({
  success: true,
  status: 200,
  data: { success: true, card: CARD, transactions },
});

function availabilityOf(
  staffId: string,
  authority: GiftFundingAvailabilityAuthority,
  overrides: Partial<GiftFundingAvailability> = {},
): GiftFundingAvailability {
  return {
    staffId,
    authority,
    organizationId: 'org-1',
    branchId: 'branch-1',
    terminalId: 'term-1',
    configured: true,
    enabled: true,
    unavailable: false,
    currency: 'EUR',
    configurationRequired: null,
    fundingConfigured: true,
    modes: {
      cash_confirmed: { supported: true, ready: false, reason: 'CASH_FUNDING_DISABLED' },
      external_card_recorded: { supported: true, ready: true, reason: null },
      manager_grant:
        authority === 'manager'
          ? { supported: true, ready: true, reason: null }
          : { supported: true, ready: false, reason: 'MANAGER_REQUIRED' },
      verified_capture: { supported: false, ready: false, reason: 'NOT_SUPPORTED' },
    },
    operator: { ready: true, reason: null, returnPayments: false },
    verifiedCapture: false,
    fiscalReceipt: false,
    ...overrides,
  };
}

function attemptOf(overrides: Partial<GiftFundingAttemptView> = {}): GiftFundingAttemptView {
  return {
    attemptKey: 'att-1',
    organizationId: 'org-1',
    branchId: 'branch-1',
    terminalId: 'term-1',
    staffId: 'staff-1',
    operation: 'issue',
    mode: 'external_card_recorded',
    cardId: null,
    amountCents: 2500,
    currency: 'EUR',
    reason: 'Birthday',
    drawerId: null,
    shiftId: 'shift-1',
    state: 'prepared',
    intentId: null,
    unresolved: false,
    possiblySent: false,
    collectionPermitted: false,
    lastCode: null,
    result: null,
    verifiedCapture: false,
    fiscalReceipt: false,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

const collecting = (overrides: Partial<GiftFundingAttemptView> = {}) =>
  attemptOf({ state: 'collection_started', collectionPermitted: true, ...overrides });

const completedOf = (overrides: Partial<GiftFundingAttemptView> = {}, balanceCents = 2500) =>
  attemptOf({
    state: 'completed',
    result: {
      cardId: overrides.cardId ?? 'card-new',
      creditId: 'credit-1',
      acknowledgementId: 'ack-1',
      cardBalanceCents: balanceCents,
      cardNumberHash: 'hash-1',
      completedAt: '2026-09-30T10:05:00.000Z',
    },
    ...overrides,
  });

const OPENING: ShiftFinancialOpeningView = {
  openingKey: 'opening-1',
  shiftId: 'shift-1',
  drawerId: 'drawer-1',
  staffId: 'staff-1',
  organizationId: 'org-1',
  branchId: 'branch-1',
  terminalId: 'term-1',
  openingCents: 10000,
  currency: 'EUR',
  businessDate: '2026-09-30',
  checkedInAt: '2026-09-30T08:00:00.000Z',
  isDayStart: true,
  calculationVersion: 2,
  state: 'confirmed_usable',
  usable: true,
  hostedAuthorization: { state: 'required', expiresAt: null },
  lastPendingCode: null,
  drawer: null,
};

const ok = {
  availability: (availability: GiftFundingAvailability): Reply<'availability'> => ({ kind: 'ok', availability }),
  journal: (attempts: GiftFundingAttemptView[]): Reply<'journal'> => ({ kind: 'ok', attempts }),
  attempt: (attempt: GiftFundingAttemptView, cardNumber: string | null = null): Reply<'prepare'> => ({
    kind: 'ok',
    attempt,
    cardNumber,
  }),
  manager: (staffId: string): Reply<'authorizeManager'> => ({ kind: 'ok', staffId, expiresAt: FUTURE }),
  opening: (opening: ShiftFinancialOpeningView | null): Reply<'cashierOpening'> => ({ kind: 'ok', opening }),
  renewed: (opening: ShiftFinancialOpeningView): Reply<'renewCashier'> => ({ kind: 'ok', opening }),
};
const LOST = { kind: 'lost' } as const;

function routeBridge(routes: Record<string, RouteHandler>) {
  mocks.bridge.invoke.mockImplementation(async (_channel: string, path: string, options: SentOptions) => {
    const route = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    return route ? routes[route](options) : { success: false, status: 404, error: 'NOT_FOUND' };
  });
}

const callsTo = (action: string) =>
  mocks.bridge.invoke.mock.calls.filter(([, path]) => String(path).startsWith(`/api/pos/gift-cards/${action}`));

/** Hold the next reply of one client method until the test releases it. */
function hold(method: keyof typeof mocks.funding) {
  let release: (value: unknown) => void = () => undefined;
  mocks.funding[method].mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  return async (value: unknown) => {
    await act(async () => {
      release(value);
    });
  };
}

function emit(channel: string) {
  act(() => {
    mocks.listeners.get(channel)?.forEach((listener) => listener(undefined));
  });
}

async function enabledButton(name: string | RegExp) {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

async function renderReady(button: string) {
  const view = render(<GiftCardsPage />);
  return { view, button: await enabledButton(button) };
}

function fillIntent(amount = '25', reason = 'Birthday') {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: amount } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: reason } });
}

async function lookUpCard() {
  const lookupButton = await enabledButton('Look up');
  fireEvent.change(screen.getByLabelText('Card number'), { target: { value: 'GC1234567788' } });
  fireEvent.click(lookupButton);
  await screen.findByTestId('gift-card-masked-number');
}

async function recordCardPayment() {
  const form = await screen.findByRole('group', { name: /^Collect / });
  fireEvent.change(within(form).getByLabelText('Card provider'), { target: { value: REFS.provider } });
  fireEvent.change(within(form).getByLabelText('Merchant ID'), { target: { value: REFS.merchantId } });
  fireEvent.change(within(form).getByLabelText('Terminal reference'), { target: { value: REFS.terminalReference } });
  fireEvent.change(within(form).getByLabelText('Transaction reference'), {
    target: { value: REFS.transactionReference },
  });
  const record = within(form).getByRole('button', { name: 'Record card payment' });
  await waitFor(() => expect(record).toBeEnabled());
  fireEvent.click(record);
}

describe('GiftCardsPage', () => {
  beforeEach(() => {
    mocks.moduleEnabled = true;
    mocks.shift = cashierOn();
    mocks.listeners.clear();
    mocks.bridge.invoke.mockReset();
    mocks.bridge.sync.getNetworkStatus.mockResolvedValue({ isOnline: true });
    mocks.bridge.terminalConfig.getOrganizationId.mockResolvedValue('org-1');
    mocks.bridge.terminalConfig.getBranchId.mockResolvedValue('branch-1');
    mocks.bridge.terminalConfig.getTerminalId.mockResolvedValue('term-1');
    routeBridge({ '/api/pos/gift-cards/status': () => readyStatus() });
    Object.values(mocks.funding).forEach((method) => method.mockReset());
    mocks.funding.availability.mockImplementation(
      async (staffId: string, authority: GiftFundingAvailabilityAuthority) =>
        ok.availability(availabilityOf(staffId, authority)),
    );
    mocks.funding.journal.mockResolvedValue(ok.journal([]));
    mocks.funding.staffDirectory.mockResolvedValue(DIRECTORY);
  });

  afterEach(cleanup);

  it('fails closed without the gift_cards module and never calls the API or the funding client', async () => {
    mocks.moduleEnabled = false;
    render(<GiftCardsPage />);

    expect(screen.getByText('The Gift Cards module is not active for this business.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Look up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare funding' })).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.bridge.invoke).not.toHaveBeenCalled();
    expect(mocks.funding.availability).not.toHaveBeenCalled();
    expect(mocks.funding.journal).not.toHaveBeenCalled();
  });

  it('keeps lookup disabled while the server status is not ready', async () => {
    routeBridge({
      '/api/pos/gift-cards/status': () => readyStatus({ enabled: false, terminal_enabled: false }),
    });
    render(<GiftCardsPage />);

    expect(await screen.findByText('Gift cards are not enabled for this terminal.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Look up' })).toBeDisabled();
    await waitFor(() => expect(mocks.funding.journal).toHaveBeenCalled());
  });

  it('looks up a card and shows its masked number, balance, currency, status and history', async () => {
    routeBridge({
      '/api/pos/gift-cards/status': () => readyStatus(),
      '/api/pos/gift-cards/lookup': lookupReply([TRANSACTION]),
    });
    const { button: lookupButton } = await renderReady('Look up');

    fireEvent.change(screen.getByLabelText('Card number'), { target: { value: 'gc12 3456 7788' } });
    fireEvent.click(lookupButton);

    expect(await screen.findByTestId('gift-card-masked-number')).toHaveTextContent('****7788');
    expect(screen.getByTestId('gift-card-balance').textContent).toMatch(/25\.00/);
    expect(screen.getByTestId('gift-card-currency')).toHaveTextContent('EUR');
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Issued')).toBeInTheDocument();
    expect(callsTo('lookup')[0][2]).toEqual({ method: 'POST', body: { card_number: 'GC1234567788' } });
  });

  it('lets an ordinary cashier reach manager authorization while cash stays unavailable', async () => {
    await renderReady('Prepare funding');

    expect(screen.getByRole('radio', { name: 'Cash' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Manager grant' }));

    const dialog = await screen.findByRole('dialog', { name: 'Manager authorization' });
    expect(await within(dialog).findByRole('option', { name: 'Maria' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Manager PIN')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Authorize manager' })).toBeEnabled();
    expect(mocks.funding.availability).toHaveBeenCalledWith('staff-1', 'cashier');
    expect(mocks.funding.staffDirectory).toHaveBeenCalledWith('branch-1', { id: 'staff-1', name: 'Ana' });
    expect(mocks.funding.grant).not.toHaveBeenCalled();
  });

  it('completes a one-person manager grant only after separate authorization and explicit confirmation', async () => {
    await renderReady('Prepare funding');
    fillIntent('25', 'Loyalty');
    fireEvent.click(screen.getByRole('radio', { name: 'Manager grant' }));

    const dialog = await screen.findByRole('dialog', { name: 'Manager authorization' });
    await within(dialog).findByRole('option', { name: 'Ana' });
    fireEvent.change(within(dialog).getByLabelText('Manager'), { target: { value: 'staff-1' } });
    const pin = within(dialog).getByLabelText('Manager PIN') as HTMLInputElement;
    fireEvent.change(pin, { target: { value: '1234' } });
    mocks.funding.authorizeManager.mockResolvedValueOnce(ok.manager('staff-1'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Authorize manager' }));
    expect(pin.value).toBe('');

    const review = await enabledButton('Review grant');
    expect(mocks.funding.authorizeManager).toHaveBeenCalledWith('staff-1', '1234');
    expect(mocks.funding.availability).toHaveBeenCalledWith('staff-1', 'manager');
    fireEvent.click(review);
    expect(mocks.funding.grant).not.toHaveBeenCalled();

    mocks.funding.grant.mockResolvedValueOnce(
      ok.attempt(completedOf({ mode: 'manager_grant', reason: 'Loyalty' }), '6000111122223333'),
    );
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm grant' }));

    expect(await screen.findByTestId('gift-card-issued-number')).toHaveTextContent('6000 1111 2222 3333');
    expect(mocks.funding.grant).toHaveBeenCalledTimes(1);
    expect(mocks.funding.grant).toHaveBeenCalledWith({
      staffId: 'staff-1',
      operation: 'issue',
      amountCents: 2500,
      currency: 'EUR',
      reason: 'Loyalty',
    });
    expect(mocks.funding.prepare).not.toHaveBeenCalled();

    // Closing the manager step ends the authorization: a new grant needs a new one.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Manager grant' }));
    const reopened = await screen.findByRole('dialog', { name: 'Manager authorization' });
    expect(within(reopened).getByRole('button', { name: 'Authorize manager' })).toBeInTheDocument();
    expect(within(reopened).queryByRole('button', { name: 'Review grant' })).not.toBeInTheDocument();
  });

  it('exposes a completed grant for checking only after its manager reauthorizes', async () => {
    const completed = completedOf({ mode: 'manager_grant', staffId: 'mgr-2' });
    mocks.funding.journal.mockResolvedValue(ok.journal([
      completed,
      completedOf({ attemptKey: 'foreign-staff', staffId: 'staff-2' }),
      completedOf({ attemptKey: 'foreign-terminal', terminalId: 'term-2' }),
    ]));
    await renderReady('Prepare funding');
    expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Manager grant' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manager authorization' });
    await within(dialog).findByRole('option', { name: 'Maria' });
    fireEvent.change(within(dialog).getByLabelText('Manager'), { target: { value: 'mgr-2' } });
    fireEvent.change(within(dialog).getByLabelText('Manager PIN'), { target: { value: '1234' } });
    mocks.funding.authorizeManager.mockResolvedValueOnce(ok.manager('mgr-2'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Authorize manager' }));

    const check = await enabledButton('Check status');
    expect(screen.getAllByTestId('gift-funding-attempt')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Begin collection' })).not.toBeInTheDocument();
    mocks.funding.recover.mockResolvedValueOnce(ok.attempt(completed));
    fireEvent.click(check);
    expect(await screen.findByText(/Funding completed/)).toBeInTheDocument();
    expect(mocks.funding.recover).toHaveBeenCalledWith('att-1');
    expect(mocks.funding.grant).not.toHaveBeenCalled();
    expect(mocks.funding.begin).not.toHaveBeenCalled();
    expect(mocks.funding.complete).not.toHaveBeenCalled();
    expect(screen.queryByTestId('gift-card-issued-number')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument();
  });

  it('keeps same-shift cashier renewal reachable when the POS authorization expired', async () => {
    let renewed = false;
    mocks.funding.availability.mockImplementation(async (staffId: string, authority: GiftFundingAvailabilityAuthority) =>
      ok.availability(
        availabilityOf(
          staffId,
          authority,
          renewed ? {} : { operator: { ready: false, reason: 'CASHIER_AUTHORIZATION_EXPIRED', returnPayments: false } },
        ),
      ),
    );
    mocks.funding.cashierOpening.mockResolvedValueOnce(ok.opening(OPENING));
    mocks.funding.renewCashier.mockImplementationOnce(async () => {
      renewed = true;
      return ok.renewed(OPENING);
    });
    render(<GiftCardsPage />);

    const renew = await enabledButton('Renew authorization');
    expect(screen.getByRole('button', { name: 'Prepare funding' })).toBeDisabled();
    const pin = screen.getByLabelText('Your PIN') as HTMLInputElement;
    fireEvent.change(pin, { target: { value: '4321' } });
    fireEvent.click(renew);
    expect(pin.value).toBe('');

    expect(await screen.findByText('Authorization renewed.')).toBeInTheDocument();
    expect(mocks.funding.cashierOpening).toHaveBeenCalledWith(ACTOR, 'shift-1');
    expect(mocks.funding.renewCashier).toHaveBeenCalledTimes(1);
    expect(mocks.funding.renewCashier).toHaveBeenCalledWith(OPENING, '4321');
    await enabledButton('Prepare funding');
  });

  it('issues a card through prepare, a direct begin acknowledgement and recorded external-card evidence', async () => {
    const { button: prepare } = await renderReady('Prepare funding');
    fillIntent('25', 'Birthday');
    mocks.funding.prepare.mockResolvedValueOnce(ok.attempt(attemptOf()));
    fireEvent.click(prepare);

    const begin = await enabledButton('Begin collection');
    expect(mocks.funding.prepare).toHaveBeenCalledWith({
      staffId: 'staff-1',
      mode: 'external_card_recorded',
      operation: 'issue',
      amountCents: 2500,
      currency: 'EUR',
      reason: 'Birthday',
    });
    // The pending equivalent original blocks another prepare.
    expect(screen.getByRole('button', { name: 'Prepare funding' })).toBeDisabled();

    const started = collecting();
    mocks.funding.begin.mockResolvedValueOnce(ok.attempt(started));
    mocks.funding.complete.mockResolvedValueOnce(ok.attempt(completedOf(), '6000111122223333'));
    fireEvent.click(begin);
    await recordCardPayment();

    expect(await screen.findByTestId('gift-card-issued-number')).toHaveTextContent('6000 1111 2222 3333');
    expect(screen.getByText(/Funding completed/)).toBeInTheDocument();
    const evidence = buildFundingEvidence(started, REFS);
    expect(evidence).not.toBeNull();
    expect(JSON.stringify(evidence)).toContain('TX-42');
    expect(mocks.funding.begin).toHaveBeenCalledWith('att-1');
    expect(mocks.funding.complete).toHaveBeenCalledWith('att-1', evidence);
  });

  it('reloads the looked-up card by id and re-reads its balance after strict completion', async () => {
    routeBridge({
      '/api/pos/gift-cards/status': () => readyStatus(),
      '/api/pos/gift-cards/lookup': lookupReply(),
    });
    render(<GiftCardsPage />);
    await lookUpCard();
    await enabledButton('Prepare funding');

    fireEvent.click(screen.getByRole('radio', { name: 'Reload the selected card' }));
    fillIntent('10', 'Top up');
    const prepared = attemptOf({ operation: 'reload', cardId: 'card-1', amountCents: 1000, reason: 'Top up' });
    mocks.funding.prepare.mockResolvedValueOnce(ok.attempt(prepared));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare funding' }));

    const begin = await enabledButton('Begin collection');
    expect(mocks.funding.prepare).toHaveBeenCalledWith({
      staffId: 'staff-1',
      mode: 'external_card_recorded',
      operation: 'reload',
      cardId: 'card-1',
      amountCents: 1000,
      currency: 'EUR',
      reason: 'Top up',
    });

    const started: GiftFundingAttemptView = { ...prepared, state: 'collection_started', collectionPermitted: true };
    mocks.funding.begin.mockResolvedValueOnce(ok.attempt(started));
    mocks.funding.complete.mockResolvedValueOnce(
      ok.attempt(completedOf({ operation: 'reload', cardId: 'card-1', amountCents: 1000, reason: 'Top up' }, 3500)),
    );
    fireEvent.click(begin);
    await recordCardPayment();

    await waitFor(() => expect(callsTo('lookup')).toHaveLength(2));
    expect(mocks.funding.complete).toHaveBeenCalledWith('att-1', buildFundingEvidence(started, REFS));
    expect(screen.queryByTestId('gift-card-issued-number')).not.toBeInTheDocument();
  });

  it('sends one prepare for a rapid double tap', async () => {
    const { button: prepare } = await renderReady('Prepare funding');
    fillIntent();
    const release = hold('prepare');

    act(() => {
      fireEvent.click(prepare);
      fireEvent.click(prepare);
    });
    expect(mocks.funding.prepare).toHaveBeenCalledTimes(1);

    await release(ok.attempt(attemptOf()));
    await screen.findByRole('button', { name: 'Begin collection' });
    expect(mocks.funding.prepare).toHaveBeenCalledTimes(1);
  });

  it.each(['collection_started', 'completed'] as const)('keeps the same original when the journal is %s after a lost completion and remount, without collecting again', async (state) => {
    const started = collecting();
    const recorded: GiftFundingAttemptView = state === 'completed'
      ? completedOf()
      : { ...started, collectionPermitted: false, possiblySent: true, unresolved: true };
    mocks.funding.journal.mockResolvedValueOnce(ok.journal([attemptOf()])).mockResolvedValue(ok.journal([recorded]));
    mocks.funding.begin.mockResolvedValueOnce(ok.attempt(started));
    mocks.funding.complete.mockResolvedValueOnce(LOST);

    const { view, button: begin } = await renderReady('Begin collection');
    fireEvent.click(begin);
    await recordCardPayment();
    await screen.findByRole('button', { name: 'Check status' });

    view.unmount();
    render(<GiftCardsPage />);
    const check = await enabledButton('Check status');
    if (state === 'collection_started') {
      expect(screen.getByRole('button', { name: 'Record payment already collected' })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('button', { name: 'Record payment already collected' })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Begin collection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Collect / })).not.toBeInTheDocument();

    mocks.funding.recover.mockResolvedValueOnce(ok.attempt(completedOf()));
    fireEvent.click(check);

    expect(await screen.findByText(/Funding completed/)).toBeInTheDocument();
    expect(mocks.funding.recover).toHaveBeenCalledWith('att-1');
    expect(mocks.funding.begin).toHaveBeenCalledTimes(1);
    expect(mocks.funding.complete).toHaveBeenCalledTimes(1);
    expect(mocks.funding.prepare).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /^Collect / })).not.toBeInTheDocument();
    expect(screen.queryByTestId('gift-card-issued-number')).not.toBeInTheDocument();
  });

  it.each(['app:reset', 'terminal-config-updated'])(
    'drops a held begin acknowledgement after %s, so it never invites collection',
    async (event) => {
      mocks.funding.journal.mockResolvedValue(ok.journal([attemptOf()]));
      const release = hold('begin');
      const { button: begin } = await renderReady('Begin collection');
      fireEvent.click(begin);
      expect(mocks.funding.begin).toHaveBeenCalledWith('att-1');

      emit(event);
      await waitFor(() => expect(mocks.funding.journal).toHaveBeenCalledTimes(2));
      await release(ok.attempt(collecting()));

      expect(screen.queryByRole('group', { name: /^Collect / })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Card provider')).not.toBeInTheDocument();
    },
  );

  it('drops a held completion after the staff member changes and clears the page on logout', async () => {
    routeBridge({
      '/api/pos/gift-cards/status': () => readyStatus(),
      '/api/pos/gift-cards/lookup': lookupReply(),
    });
    mocks.funding.journal.mockResolvedValue(ok.journal([attemptOf()]));
    mocks.funding.begin.mockResolvedValueOnce(ok.attempt(collecting()));
    const release = hold('complete');
    const view = render(<GiftCardsPage />);
    await lookUpCard();
    fireEvent.click(await enabledButton('Begin collection'));
    await recordCardPayment();
    expect(mocks.funding.complete).toHaveBeenCalledTimes(1);

    mocks.shift = cashierOn('staff-2', 'Ben');
    view.rerender(<GiftCardsPage />);
    expect(screen.queryByTestId('gift-card-masked-number')).not.toBeInTheDocument();
    await release(ok.attempt(completedOf(), '6000111122223333'));

    await waitFor(() => expect(mocks.funding.availability).toHaveBeenCalledWith('staff-2', 'cashier'));
    await waitFor(() => expect(mocks.funding.journal).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('gift-card-issued-number')).not.toBeInTheDocument();
    expect(screen.queryByText(/Funding completed/)).not.toBeInTheDocument();
    // Another cashier does not see staff-1's original.
    expect(screen.queryByRole('button', { name: 'Begin collection' })).not.toBeInTheDocument();

    mocks.shift = LOGGED_OUT;
    view.rerender(<GiftCardsPage />);
    expect(screen.queryByRole('button', { name: 'Prepare funding' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument();
  });
});
