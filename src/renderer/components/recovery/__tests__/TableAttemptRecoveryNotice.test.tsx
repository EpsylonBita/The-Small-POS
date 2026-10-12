import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internalOrderReference } from '../../../../../../shared/utils/internal-order-reference';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), callbacks: new Map<string, Function>() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mocks.invoke,
  tableAttemptRecovery: { confirmOriginal: (input: { clientEventId: string }) =>
    mocks.invoke('table_attempt_recovery_confirm_original', input) } }),
  onEvent: (event: string, callback: Function) => mocks.callbacks.set(event, callback),
  offEvent: (event: string) => mocks.callbacks.delete(event) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { TableAttemptRecoveryNotice } from '../TableAttemptRecoveryNotice';
const attempt = { kind: 'whole_order_cancel', clientEventId: 'original', orderId: 'order-original', state: 'approval_required' };
const snapshotConflict = { ...attempt, state: 'conflict', errorCode: 'CANONICAL_SNAPSHOT_REVIEW_REQUIRED' };
beforeEach(() => { mocks.invoke.mockReset(); mocks.callbacks.clear(); });
afterEach(cleanup);
describe('visible table recovery state', () => {
  it('shows a compact recovery label without exposing an internal order UUID and reviews the exact original', async () => {
    const orderId = '30900e3d-ea23-497e-9ea1-3a496962397e';
    const review = vi.fn(async () => true);
    mocks.invoke.mockResolvedValue({ success: true, attempts: [{ ...snapshotConflict, kind: 'item_edit', orderId }] });
    render(<TableAttemptRecoveryNotice onReviewEdit={review} />);
    await screen.findByText(/checkoutRecovery.conflict/);
    expect(screen.queryByText(new RegExp(orderId))).toBeNull();
    expect(screen.getByText(new RegExp(` · ${internalOrderReference(orderId)}$`))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'modals.menu.draftRecover' }));
    await waitFor(() => expect(review).toHaveBeenCalledExactlyOnceWith('original'));
  });
  it('keeps a business order sequence useful in recovery without displaying its raw stored number', async () => {
    mocks.invoke.mockResolvedValue({ success: true, attempts: [{ ...attempt, orderId: 'ORD-20261011-0042' }] });
    render(<TableAttemptRecoveryNotice />);
    await screen.findByText(/checkoutRecovery.approval_required/);
    expect(screen.getByText(/ · ORD #0042$/)).toBeTruthy();
    expect(screen.queryByText(/ORD-20261011-0042/)).toBeNull();
  });
  it('reviews only the selected retained edit without dispatching a native mutation', async () => {
    const review = vi.fn(async () => true);
    mocks.invoke.mockResolvedValue({ success:true,attempts:[{...snapshotConflict,kind:'item_edit',clientEventId:'edit-original'}] });
    render(<TableAttemptRecoveryNotice onReviewEdit={review} />);
    fireEvent.click(await screen.findByRole('button', { name:'modals.menu.draftRecover' }));
    await waitFor(() => expect(review).toHaveBeenCalledExactlyOnceWith('edit-original'));
    expect(mocks.invoke.mock.calls.every(([command])=>command==='table_attempt_recovery_status')).toBe(true);
  });
  it('does not offer edit review while its original dispatch is processing', async () => {
    mocks.invoke.mockResolvedValue({ success:true,attempts:[{...snapshotConflict,kind:'item_edit',state:'processing'}] });
    render(<TableAttemptRecoveryNotice onReviewEdit={vi.fn(async()=>true)} />);
    await screen.findByText(/checkoutRecovery.processing/);
    expect(screen.queryByRole('button', { name:'modals.menu.draftRecover' })).toBeNull();
  });
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
  it('offers original-result confirmation only for the cancellation snapshot conflict', async () => {
    mocks.invoke.mockResolvedValue({ success: true, attempts: [snapshotConflict,
      { ...snapshotConflict, kind: 'item_edit', clientEventId: 'edit' },
      { ...snapshotConflict, errorCode: 'CANONICAL_RECEIPT_IDENTITY_CHANGED', clientEventId: 'foreign' },
      { ...snapshotConflict, state: 'processing', clientEventId: 'processing' }, attempt] });
    render(<TableAttemptRecoveryNotice />);
    expect(await screen.findAllByRole('button', { name: 'checkoutRecovery.confirmOriginalResult' })).toHaveLength(1);
    fireEvent.click(screen.getByText('checkoutRecovery.refresh'));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    expect(mocks.invoke.mock.calls.every(([command]) => command === 'table_attempt_recovery_status')).toBe(true);
  });
  it('confirms only the selected original, prevents duplicate clicks and waits for authoritative status', async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockImplementation((command: string) => command === 'table_attempt_recovery_status'
      ? Promise.resolve({ success: true, attempts: [snapshotConflict] })
      : new Promise(done => { resolve = done; }));
    render(<TableAttemptRecoveryNotice />);
    const button = await screen.findByRole('button', { name: 'checkoutRecovery.confirmOriginalResult' });
    fireEvent.click(button); fireEvent.click(button);
    expect(mocks.invoke).toHaveBeenCalledWith('table_attempt_recovery_confirm_original', { clientEventId: 'original' });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'table_attempt_recovery_confirm_original')).toHaveLength(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/order-original/)).toBeTruthy();
    mocks.invoke.mockImplementation(() => Promise.resolve({ success: true, attempts: [] }));
    await act(async () => resolve({ state: 'applied' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
  it('preserves an unresolved original and displays a useful error without exposing native details', async () => {
    mocks.invoke.mockImplementation((command: string) => command === 'table_attempt_recovery_status'
      ? Promise.resolve({ success: true, attempts: [snapshotConflict] })
      : Promise.reject(new Error('private native diagnostic')));
    render(<TableAttemptRecoveryNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'checkoutRecovery.confirmOriginalResult' }));
    await screen.findByText('checkoutRecovery.originalResultUnconfirmed');
    expect(screen.getByText(/order-original/)).toBeTruthy();
    expect(screen.queryByText('private native diagnostic')).toBeNull();
  });
  it('ignores an old binding confirmation after reset', async () => {
    let reject!: (error: Error) => void;
    mocks.invoke.mockImplementation((command: string) => command === 'table_attempt_recovery_status'
      ? Promise.resolve({ success: true, attempts: [snapshotConflict] })
      : new Promise((_done, fail) => { reject = fail; }));
    render(<TableAttemptRecoveryNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'checkoutRecovery.confirmOriginalResult' }));
    mocks.invoke.mockImplementation(() => Promise.resolve({ success: true, attempts: [] }));
    await act(async () => mocks.callbacks.get('terminal-config-updated')?.());
    await act(async () => reject(new Error('old binding unavailable')));
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'table_attempt_recovery_status')).toHaveLength(2);
  });
  it('clears only the resolved original warning while unrelated pending work remains', async () => {
    const other = { ...attempt, clientEventId: 'other', orderId: 'other-order', state: 'pending' };
    mocks.invoke.mockImplementation((command: string) => command === 'table_attempt_recovery_status'
      ? Promise.resolve({ success: true, attempts: [snapshotConflict, other] })
      : Promise.reject(new Error('original not confirmed')));
    render(<TableAttemptRecoveryNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'checkoutRecovery.confirmOriginalResult' }));
    await screen.findByText('checkoutRecovery.originalResultUnconfirmed');
    mocks.invoke.mockResolvedValue({ success: true, attempts: [other] });
    await act(async () => mocks.callbacks.get('table_attempt_recovery')?.());
    await waitFor(() => expect(screen.queryByText('checkoutRecovery.originalResultUnconfirmed')).toBeNull());
    expect(screen.getByText(/other-order/)).toBeTruthy();
  });
  it('failed and stale status reads retain the original warning', async () => {
    mocks.invoke.mockImplementation((command: string) => command === 'table_attempt_recovery_status'
      ? Promise.resolve({ success: true, attempts: [snapshotConflict] })
      : Promise.reject(new Error('original not confirmed')));
    render(<TableAttemptRecoveryNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'checkoutRecovery.confirmOriginalResult' }));
    await screen.findByText('checkoutRecovery.originalResultUnconfirmed');
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockRejectedValueOnce(new Error('current read failed'));
    await act(async () => mocks.callbacks.get('table_attempt_recovery')?.());
    await act(async () => mocks.callbacks.get('table_attempt_recovery')?.());
    await act(async () => resolve({ success: true, attempts: [] }));
    expect(screen.getByText('checkoutRecovery.originalResultUnconfirmed')).toBeTruthy();
    expect(screen.getByText(/order-original/)).toBeTruthy();
  });
});
