import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriBridge } from '../../../../lib/ipc-adapter';
import type { DriverCashForNotice } from '../../../../lib/ipc-contracts';
import greek from '../../../../locales/overlays/el.platforms.json';
import * as store from '../../../services/platformCancellationNoticeStore';
import { formatCurrency } from '../../../utils/format';
import { CancellationNoticeManager } from '../CancellationNoticeManager';

const mocks = vi.hoisted(() => ({
  getBridge: vi.fn(),
  invoke: vi.fn(),
  fetchNotices: vi.fn(),
  playSound: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  getResolvedTerminalIdentity: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../../../lib', async (original) => ({
  ...(await original<typeof import('../../../../lib')>()),
  getBridge: mocks.getBridge,
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}));
vi.mock('../../../services/terminal-credentials', async (original) => ({
  ...(await original<typeof import('../../../services/terminal-credentials')>()),
  getResolvedTerminalIdentity: mocks.getResolvedTerminalIdentity,
}));
vi.mock('../../../services/platformCancellationNoticesApi', () => ({
  fetchAllCancellationNotices: mocks.fetchNotices,
}));
vi.mock('../../../services/platformNotificationSound', () => ({
  playSelectedPlatformSound: mocks.playSound,
}));
vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const identity = { organizationId: 'org', branchId: 'branch', terminalId: 'till' };
const notice = (id: string, number: string): store.PlatformCancellationNotice => ({
  id, order_number: number, platform: 'efood', external_order_id: null, cancelled_at: '2026-11-19T10:00:00Z',
});
const noticeA = notice('a', '#101');
const noticeB = notice('b', '#102');
const cash = (collectorName: string | null): DriverCashForNotice =>
  ({ state: 'driver_cash', amountCents: 1250, currency: 'CHF', collectorName });
const command = (id: string) => ['order_driver_cash_for_notice', { orderId: id }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const i18n = i18next.createInstance();
let online = false;
const manager = () => (
  <I18nextProvider i18n={i18n}>
    <CancellationNoticeManager enabled />
  </I18nextProvider>
);
const ack = () => screen.getByRole('button', { name: 'Το διάβασα' });
const readText = (text: string) => screen.findByText(text);
const pollResult = (scope: string, notices: store.PlatformCancellationNotice[]) =>
  ({ ok: true, scope, notices, incomplete: false, resumeCursor: null });

beforeAll(async () => {
  await i18n.init({
    lng: 'el', resources: { el: { translation: greek } }, interpolation: { escapeValue: false },
  });
});

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  online = false;
  vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
  mocks.getBridge.mockReturnValue(new TauriBridge());
  mocks.getResolvedTerminalIdentity.mockResolvedValue(identity);
  mocks.playSound.mockReturnValue(vi.fn());
  mocks.invoke.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('Cancellation notice payment wording', () => {
  it.each([
    { label: 'driver cash with name and answer currency', answer: cash('  Μαρία  '),
      expected: () => i18n.t('cancellationNotice.driverCash', { amount: formatCurrency(12.5, 'CHF'), name: '  Μαρία  ' }) },
    { label: 'driver cash without a name', answer: cash(null),
      expected: () => i18n.t('cancellationNotice.driverCashNoName', { amount: formatCurrency(12.5, 'CHF') }) },
    { label: 'driver cash with an empty name', answer: cash(''),
      expected: () => i18n.t('cancellationNotice.driverCashNoName', { amount: formatCurrency(12.5, 'CHF') }) },
    { label: 'driver cash with a whitespace name', answer: cash('  '),
      expected: () => i18n.t('cancellationNotice.driverCashNoName', { amount: formatCurrency(12.5, 'CHF') }) },
    { label: 'review', answer: { state: 'review' }, expected: () => i18n.t('cancellationNotice.paymentInReview') },
    { label: 'check', answer: { state: 'check' }, expected: () => i18n.t('cancellationNotice.checkPayments') },
  ])('shows $label under the order details', async ({ answer, expected }) => {
    await store.mergeIncomingNotices(identity, 'scope-a', [noticeA]);
    mocks.invoke.mockResolvedValueOnce(answer);
    render(manager());
    const line = await screen.findByText(expected(), { normalizer: text => text });
    expect(line.previousElementSibling?.tagName).toBe('DL');
    expect(line.textContent).toBe(expected());
    expect(mocks.invoke.mock.calls).toStrictEqual([command('a')]);
    expect(ack()).toBeEnabled();
  });

  it.each(['null', 'rejected', 'pending'] as const)('keeps the original notice and acknowledges immediately when the read is %s', async (outcome) => {
    await store.mergeIncomingNotices(identity, 'scope-a', [noticeA]);
    const acknowledge = vi.spyOn(store, 'acknowledgeNotice');
    const read = deferred<DriverCashForNotice | null>();
    mocks.invoke.mockReturnValueOnce(read.promise);
    render(manager());
    await readText('#101');
    const dialog = screen.getByRole('dialog');
    const original = dialog.textContent;
    expect(dialog.querySelector('dl')?.nextElementSibling).toBe(ack());
    expect(mocks.playSound).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.invoke.mock.calls).toStrictEqual([command('a')]));

    await act(async () => {
      if (outcome === 'null') read.resolve(null);
      if (outcome === 'rejected') read.reject(new Error('read failed'));
    });
    expect(dialog.textContent).toBe(original);
    expect(ack()).toBeEnabled();
    fireEvent.click(ack());
    await waitFor(() => expect(screen.queryByTestId('cancellation-notice-dialog')).toBeNull());

    expect(acknowledge.mock.calls).toStrictEqual([[identity, 'scope-a', 'a']]);
    expect(mocks.invoke.mock.calls).toStrictEqual([command('a')]);
  });

  it('reads each queued notice when current and drops A’s late reply after acknowledgement', async () => {
    await store.mergeIncomingNotices(identity, 'scope-a', [noticeA, noticeB]);
    const first = deferred<DriverCashForNotice>();
    mocks.invoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ state: 'review' });
    render(manager());
    await readText('#101');
    await waitFor(() => expect(mocks.invoke.mock.calls).toStrictEqual([command('a')]));
    fireEvent.click(ack());
    await readText('#102');
    await readText(i18n.t('cancellationNotice.paymentInReview'));
    await act(async () => first.resolve(cash('Μαρία')));
    expect(screen.queryByText(/Μαρία/)).toBeNull();
    expect(mocks.invoke.mock.calls).toStrictEqual([command('a'), command('b')]);
  });

  it('drops the old scope’s reply when a new scope replaces the current notice', async () => {
    await store.mergeIncomingNotices(identity, 'scope-a', [noticeA]);
    const first = deferred<DriverCashForNotice>();
    mocks.invoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ state: 'check' });
    mocks.fetchNotices.mockResolvedValueOnce(pollResult('scope-b', [noticeB]));
    render(manager());
    await readText('#101');
    await waitFor(() => expect(mocks.invoke.mock.calls).toStrictEqual([command('a')]));
    online = true;
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await readText('#102');
    await readText(i18n.t('cancellationNotice.checkPayments'));
    await act(async () => first.resolve(cash('Μαρία')));
    expect(screen.queryByText(/Μαρία/)).toBeNull();
    expect(mocks.invoke.mock.calls).toStrictEqual([command('a'), command('b')]);
  });

  it('reads again and drops the old reply when a new scope shows the same order ID', async () => {
    await store.mergeIncomingNotices(identity, 'scope-a', [noticeA]);
    const first = deferred<DriverCashForNotice>();
    mocks.invoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ state: 'check' });
    mocks.fetchNotices.mockResolvedValueOnce(pollResult('scope-b', [notice('a', '#301')]));
    render(manager());
    await readText('#101');
    await waitFor(() => expect(mocks.invoke.mock.calls).toStrictEqual([command('a')]));
    online = true;
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await readText('#301');
    await readText(i18n.t('cancellationNotice.checkPayments'));
    await act(async () => first.resolve(cash('Μαρία')));
    expect(screen.queryByText(/Μαρία/)).toBeNull();
    expect(mocks.invoke.mock.calls).toStrictEqual([command('a'), command('a')]);
  });

  it('drops the previous terminal’s reply when the order ID is reused', async () => {
    await store.mergeIncomingNotices(identity, 'scope-a', [noticeA]);
    const nextIdentity = { ...identity, terminalId: 'next' };
    await store.mergeIncomingNotices(nextIdentity, 'scope-b', [notice('a', '#201')]);
    const first = deferred<DriverCashForNotice>();
    mocks.invoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ state: 'check' });
    render(manager());
    await readText('#101');
    await waitFor(() => expect(mocks.invoke.mock.calls).toStrictEqual([command('a')]));

    mocks.getResolvedTerminalIdentity.mockResolvedValue(nextIdentity);
    await act(async () => {
      for (const [event, listener] of mocks.onEvent.mock.calls) {
        if (event === 'terminal-credentials-updated') listener();
      }
    });
    await readText('#201');
    await readText(i18n.t('cancellationNotice.checkPayments'));
    await act(async () => first.resolve(cash('Μαρία')));
    expect(screen.queryByText(/Μαρία/)).toBeNull();
    expect(mocks.invoke.mock.calls).toStrictEqual([command('a'), command('a')]);
  });

  it('reads the restored current notice again after a restart', async () => {
    await store.mergeIncomingNotices(identity, 'scope-a', [noticeA]);
    const first = render(manager());
    await readText('#101');
    await waitFor(() => expect(mocks.invoke.mock.calls).toStrictEqual([command('a')]));
    first.unmount();

    mocks.invoke.mockResolvedValueOnce({ state: 'review' });
    render(manager());
    await readText(i18n.t('cancellationNotice.paymentInReview'));
    expect(mocks.invoke.mock.calls).toStrictEqual([command('a'), command('a')]);
  });

  it('keeps one read while polling the same current notice in the same scope', async () => {
    await store.mergeIncomingNotices(identity, 'scope-a', [noticeA]);
    mocks.invoke.mockResolvedValueOnce({ state: 'review' });
    mocks.fetchNotices.mockResolvedValueOnce(pollResult('scope-a', [notice('a', '#201')]));
    render(manager());
    await readText('#101');
    await readText(i18n.t('cancellationNotice.paymentInReview'));

    online = true;
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await readText('#201');
    expect(screen.getByText(i18n.t('cancellationNotice.paymentInReview'))).toBeInTheDocument();
    expect(mocks.invoke.mock.calls).toStrictEqual([command('a')]);
  });
});
