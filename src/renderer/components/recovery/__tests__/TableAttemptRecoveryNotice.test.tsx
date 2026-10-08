import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), callbacks: new Map<string, Function>() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mocks.invoke }),
  onEvent: (event: string, callback: Function) => mocks.callbacks.set(event, callback),
  offEvent: (event: string) => mocks.callbacks.delete(event) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { TableAttemptRecoveryNotice } from '../TableAttemptRecoveryNotice';
const attempt = { kind: 'whole_order_cancel', clientEventId: 'original', orderId: 'order-original', state: 'approval_required' };
beforeEach(() => { mocks.invoke.mockReset(); mocks.callbacks.clear(); });
afterEach(cleanup);
describe('visible table recovery state', () => {
  it('shows approval-required original operation and never dispatches a mutation', async () => {
    mocks.invoke.mockResolvedValue({ success: true, attempts: [attempt] }); render(<TableAttemptRecoveryNotice />);
    expect(await screen.findByText(/checkoutRecovery.approval_required/)).toBeTruthy();
    expect(screen.getByText(/order-original/)).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('table_attempt_recovery_status');
  });
  it('failed refresh preserves pending work and exposes read failure', async () => {
    mocks.invoke.mockResolvedValueOnce({ success: true, attempts: [attempt] }).mockRejectedValue(new Error('read error'));
    render(<TableAttemptRecoveryNotice />); await screen.findByText(/approval_required/);
    fireEvent.click(screen.getByText('checkoutRecovery.refresh'));
    await screen.findByText('checkoutRecovery.unavailable'); expect(screen.getByText(/approval_required/)).toBeTruthy();
  });
  // 06/10/2026: a store without tables saw the notice at intervals, each time
  // one status read failed after readings with nothing pending.
  it('a failed read after a valid reading with nothing pending stays quiet', async () => {
    mocks.invoke.mockResolvedValueOnce({ success: true, attempts: [] }).mockRejectedValue(new Error('REPAIR_SCOPE_TRANSITION_PENDING'));
    render(<TableAttemptRecoveryNotice />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    await act(async () => mocks.callbacks.get('table_attempt_recovery')?.());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('shows the status as unavailable while the binding has never been read', async () => {
    mocks.invoke.mockRejectedValue(new Error('REPAIR_SCOPE_TRANSITION_PENDING'));
    render(<TableAttemptRecoveryNotice />);
    await screen.findByText('checkoutRecovery.unavailable');
  });
  it('removes resolved work only after a successful authoritative status read', async () => {
    mocks.invoke.mockResolvedValueOnce({ success: true, attempts: [attempt] }).mockResolvedValue({ success: true, attempts: [] });
    render(<TableAttemptRecoveryNotice />); await screen.findByText(/approval_required/);
    await act(async () => mocks.callbacks.get('table_attempt_recovery')?.());
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
  it('a late older status cannot replace a newer canonical read', async () => {
    let resolve!: Function;
    mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue({ success: true, attempts: [] });
    render(<TableAttemptRecoveryNotice />);
    await act(async () => mocks.callbacks.get('table_attempt_recovery')?.());
    await act(async () => resolve({ success: true, attempts: [attempt] }));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('reset clears old-scope projections before loading the new binding', async () => {
    mocks.invoke.mockResolvedValueOnce({ success: true, attempts: [attempt] }).mockRejectedValue(new Error('new binding unavailable'));
    render(<TableAttemptRecoveryNotice />); await screen.findByText(/order-original/);
    await act(async () => mocks.callbacks.get('app:reset')?.());
    expect(screen.queryByText(/order-original/)).toBeNull(); await screen.findByText('checkoutRecovery.unavailable');
  });
});
