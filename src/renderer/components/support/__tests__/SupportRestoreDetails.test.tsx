import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportDetailsPanel } from '../SupportDetailsPanel';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), authorize: vi.fn(), critical: false, canConnect: true }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mocks.invoke }) }));
vi.mock('../../../hooks/useSupportSession', () => ({ useSupportSession: () => ({ snapshot: { can_connect: mocks.canConnect, critical_op_active: mocks.critical } }) }));
vi.mock('../../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({ runWithPrivilegedConfirmation: mocks.authorize, confirmationModal: null }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const snapshots = [
  { snapshot_id: 'your-older', taken_at: '2026-10-30T10:00:00Z', reason: 'pre_quarantine', integrity_ok: true, restorable: true, changed_since: [] },
  { snapshot_id: 'your-newest', taken_at: '2026-10-31T10:00:00Z', reason: 'pre_breakglass_sql', integrity_ok: true, restorable: true,
    changed_since: [{ table: 'catalog_cache', count: 3, resynced_from_server: true }, { table: 'sync_queue', count: 2, resynced_from_server: false }] },
];
const groups = [{ group_id: 'your-group', created_at: '2026-10-30T12:00:00Z', tables: ['orders', 'order_items'], row_counts: { orders: 1, order_items: 2 }, restore_state: 'quarantined', restorable: true }];
async function ipc(command: string) {
  if (command === 'support_list_snapshots') { return { snapshots }; }
  if (command === 'support_list_quarantine') { return { groups }; }
  if (command === 'support_undo_device_apply') { return { applies: [] }; }
  return { success: true };
}
beforeEach(() => {
  mocks.canConnect = true; mocks.critical = false; mocks.invoke.mockImplementation(ipc);
  mocks.authorize.mockImplementation(({ action }: { action(): Promise<unknown> }) => action());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
async function open() {
  const view = render(<SupportDetailsPanel />);
  await screen.findByTestId('support-snapshot-your-newest'); return view;
}
function choose(kind: 'snapshot' | 'quarantine' = 'snapshot') {
  fireEvent.click(within(screen.getByTestId(kind === 'snapshot' ? 'support-snapshot-your-newest' : 'support-quarantine-your-group')).getByText('support.restore.action'));
  return within(screen.getByRole('group', { name: 'support.restore.confirm' }));
}
describe.each(['light', 'dark'])('support restore details in %s', theme => {
  it('shows newest-only restore with times, changes, counts and per-table re-sync flags', async () => {
    document.documentElement.className = theme; await open();
    expect(within(screen.getByTestId('support-snapshot-your-older')).queryByRole('button')).toBeNull();
    const newest = within(screen.getByTestId('support-snapshot-your-newest'));
    expect(newest.getByText('catalog_cache: 3 · support.restore.resynced')).toBeVisible(); expect(newest.getByText('sync_queue: 2')).toBeVisible();
    expect(newest.getByText('2026-10-31T10:00:00Z')).toBeVisible(); expect(newest.getByText(/support.restore.reasons.pre_breakglass_sql/)).toBeVisible();
    expect(screen.getByText('orders: 1')).toBeVisible(); expect(screen.getByText('order_items: 2')).toBeVisible();
    const confirmation = choose(); expect(confirmation.getByText('support.restore.preparing')).toBeVisible();
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(confirmation.getByText('support.restore.action').className).toContain('--pos-s-sel-bg');
  });
  it.each(['snapshot', 'quarantine'] as const)('uses manual authorization before %s restore IPC and blocks repeated taps', async kind => {
    await open(); const confirmation = choose(kind);
    let finish: ((value: { success: boolean }) => void) | undefined;
    mocks.invoke.mockImplementation(command => command.startsWith('support_restore_') ? new Promise(resolve => { finish = resolve; }) : ipc(command));
    const restore = confirmation.getByText('support.restore.action'); fireEvent.click(restore); fireEvent.click(restore);
    expect(mocks.authorize).toHaveBeenCalledOnce(); expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ scope: 'system_control', subtitle: 'support.onsite.storePinNotice' }));
    expect(mocks.invoke).toHaveBeenCalledWith(kind === 'snapshot' ? 'support_restore_snapshot' : 'support_restore_quarantine', kind === 'snapshot' ? { snapshot_id: 'your-newest' } : { group_id: 'your-group' });
    await act(async () => finish?.({ success: true })); expect(screen.queryByRole('group')).toBeNull();
  });
  it.each(['snapshot', 'quarantine'] as const)('refuses %s restore for staff with only support-connect', async kind => {
    mocks.authorize.mockRejectedValue(new Error('FORBIDDEN')); await open(); fireEvent.click(choose(kind).getByText('support.restore.action'));
    await screen.findByRole('alert'); expect(mocks.invoke.mock.calls.filter(([command]) => command.startsWith('support_restore_'))).toHaveLength(0);
  });
  it('leaves data unchanged when confirmation is declined and disables restore during checkout', async () => {
    const view = await open(); fireEvent.click(choose().getByText('support.onsite.decline')); expect(mocks.authorize).not.toHaveBeenCalled();
    mocks.critical = true; view.rerender(<SupportDetailsPanel />);
    for (const button of screen.getAllByText('support.restore.action')) { expect(button).toBeDisabled(); }
  });
  it('keeps explicit native refusal visible and does not refresh as successful', async () => {
    await open(); mocks.invoke.mockImplementation(command => command === 'support_restore_snapshot' ? Promise.resolve({ success: false }) : ipc(command));
    fireEvent.click(choose().getByText('support.restore.action')); await screen.findByRole('alert');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'support_list_snapshots')).toHaveLength(1);
  });
});
it('does not offer a restore if the newest snapshot is ineligible, even when an older one says restorable', async () => {
  mocks.invoke.mockImplementation(command => command === 'support_list_snapshots' ? Promise.resolve({ snapshots: snapshots.map((row, index) => ({ ...row, restorable: index === 0 })) }) : ipc(command));
  await open(); expect(within(screen.getByTestId('support-snapshot-your-newest')).queryByRole('button')).toBeNull();
  expect(within(screen.getByTestId('support-snapshot-your-older')).queryByRole('button')).toBeNull();
});
it('accepts native RFC3339 timestamps with UTC offsets and orders them by time', async () => {
  mocks.invoke.mockImplementation(command => {
    if (command === 'support_list_snapshots') { return Promise.resolve({ snapshots: snapshots.map(row => ({ ...row, taken_at: row.taken_at.replace('Z', '+00:00') })) }); }
    if (command === 'support_list_quarantine') { return Promise.resolve({ groups: groups.map(row => ({ ...row, created_at: row.created_at.replace('Z', '+00:00') })) }); }
    return ipc(command);
  });
  await open(); expect(screen.getByText('2026-10-31T10:00:00+00:00')).toBeVisible();
  expect(within(screen.getByTestId('support-snapshot-your-newest')).getByText('support.restore.action')).toBeEnabled();
});
it('does not offer details to staff without support-connect', () => {
  mocks.canConnect = false; render(<SupportDetailsPanel />); expect(screen.queryByTestId('support-details-panel')).toBeNull(); expect(mocks.invoke).not.toHaveBeenCalled();
});
it('rejects malformed list data rather than presenting unknown counts as zero', async () => {
  mocks.invoke.mockImplementation(command => command === 'support_list_quarantine' ? Promise.resolve({ groups: [{ ...groups[0], row_counts: {} }] }) : ipc(command));
  render(<SupportDetailsPanel />); await screen.findByRole('alert');
  expect(screen.queryByText('support.restore.action')).toBeNull();
});
it('retains a recovery-list failure when an independent device list succeeds later', async () => {
  let finish: ((value: { applies: never[] }) => void) | undefined;
  mocks.invoke.mockImplementation(command => {
    if (command === 'support_undo_device_apply') { return new Promise(resolve => { finish = resolve; }); }
    if (command === 'support_list_snapshots') { return Promise.reject(new Error('IPC failed')); }
    return ipc(command);
  });
  render(<SupportDetailsPanel />); await screen.findByRole('alert');
  await act(async () => finish?.({ applies: [] })); expect(screen.getByRole('alert')).toBeVisible(); expect(screen.queryByText('support.restore.action')).toBeNull();
});
it('rechecks the critical state after the store authorization wait before invoking restore', async () => {
  let action: (() => Promise<unknown>) | undefined;
  let authorize: ((value: { success: boolean }) => void) | undefined;
  mocks.authorize.mockImplementation((options: { action(): Promise<unknown> }) => { action = options.action; return new Promise(resolve => { authorize = resolve; }); });
  const view = await open(); fireEvent.click(choose().getByText('support.restore.action'));
  mocks.critical = true; view.rerender(<SupportDetailsPanel />);
  expect(() => action?.()).toThrow('Restore no longer authorized');
  await act(async () => authorize?.({ success: false })); await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  expect(mocks.invoke.mock.calls.filter(([command]) => command.startsWith('support_restore_'))).toHaveLength(0);
});
