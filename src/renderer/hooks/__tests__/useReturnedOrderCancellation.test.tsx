import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), cancelWithApproval: vi.fn(), updateStatus: vi.fn(), onCancelled: vi.fn(),
  getSetting: vi.fn(),
}));
vi.mock('../../../lib', () => ({ getBridge: () => ({ invoke: mocks.invoke,
  orders: { cancelWithApproval: mocks.cancelWithApproval, updateStatus: mocks.updateStatus } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../useTerminalSettings', () => ({
  useTerminalSettings: () => ({ getSetting: mocks.getSetting, error: null }),
}));
vi.mock('../usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({
  runWithPrivilegedConfirmation: ({ action }: any) => action('approved-pin'), confirmationModal: null,
}) }));
vi.mock('../../components/modals/OrderCancellationModal', () => ({
  default: ({ isOpen, manualReturn, onConfirmCancel, platformOrder }: any) => isOpen ? <div role="dialog" data-platform={platformOrder}>
    <span>{manualReturn ? manualReturn.amountCents : 'reason-only'}</span>
    <button onClick={() => void onConfirmCancel('Returned order', manualReturn ? 'bank' : undefined)}>Confirm cancel</button>
  </div> : null,
}));
import { useReturnedOrderCancellation } from '../useReturnedOrderCancellation';
function Harness({ order }: { order?: unknown }) {
  const { requestCancellation, modal } = useReturnedOrderCancellation(mocks.onCancelled, order);
  return <><button onClick={() => void requestCancellation('order').then(value => {
    document.body.dataset.providerFallback = String(!value);
  })}>Return</button>{modal}</>;
}
const plan = { success: true, orderId: 'order', requiresReturn: false, requiresHandback: false,
  amountCents: 0, currency: null, generation: 'ledger', requestId: 'event' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.invoke.mockResolvedValue(plan);
  mocks.cancelWithApproval.mockResolvedValue({ success: true });
  mocks.updateStatus.mockResolvedValue({ success: true });
  delete document.body.dataset.providerFallback;
});
afterEach(cleanup);

describe('history returned-order cancellation host', () => {
  it('asks for the reason then cancels an already returned order without any refund command', async () => {
    render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByText('Return')); });
    expect(screen.getByText('reason-only')).toBeTruthy();
    expect(mocks.updateStatus).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByText('Confirm cancel')); });
    expect(mocks.updateStatus).toHaveBeenCalledExactlyOnceWith('order', 'cancelled', { cancellationReason: 'Returned order' });
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['order_prepare_manual_cancel']);
    expect(mocks.onCancelled).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps a closed table cancellation plain when no money remains', async () => {
    mocks.invoke.mockResolvedValue({ ...plan, tableSessionId: 'closed-check' });
    render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByText('Return')); });
    await act(async () => { fireEvent.click(screen.getByText('Confirm cancel')); });
    expect(mocks.cancelWithApproval).toHaveBeenCalledExactlyOnceWith({ orderId: 'order', reason: 'Returned order',
      tableSessionId: 'closed-check', clientEventId: 'event', managerPin: 'approved-pin' });
    expect(mocks.updateStatus).not.toHaveBeenCalled();
  });
  it('leaves the remaining manual return to the atomic cancellation command', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...plan, requiresReturn: true, amountCents: 400, currency: 'EUR' })
      .mockResolvedValueOnce({ success: true });
    render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByText('Return')); });
    expect(screen.getByText('400')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Confirm cancel')); });
    expect(mocks.invoke.mock.calls[1]).toEqual(['order_cancel_manual_refund', { orderId: 'order',
      generation: 'ledger', requestId: 'event', reason: 'Returned order', returnChannel: 'bank' }]);
  });
  it.each([false, true])('uses the platform cancellation dialog only with the switch on (%s)', async enabled => {
    mocks.getSetting.mockReturnValue(JSON.stringify({ platform_driver_cash_auto: enabled }));
    mocks.invoke.mockResolvedValue({ ...plan, requiresReturn: true, amountCents: 400, currency: 'EUR' });
    render(<Harness order={{ plugin: 'efood' }} />);
    await act(async () => { fireEvent.click(screen.getByText('Return')); });
    expect(mocks.getSetting).toHaveBeenCalledWith('terminal', 'enabled_features');
    expect(screen.getByRole('dialog').getAttribute('data-platform')).toBe(String(enabled));
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['order_prepare_manual_cancel']);
  });
  it('authorizes existing refund behavior only for original provider returns', async () => {
    mocks.invoke.mockRejectedValue(new Error('ORIGINAL_PROVIDER_RETURN_REQUIRED'));
    render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByText('Return')); });
    expect(document.body.dataset.providerFallback).toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
