import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryIssue } from '../../../lib';

const { bridge, queue, toast } = vi.hoisted(() => ({
  bridge: {
    invoke: vi.fn(),
    diagnostics: { getSystemHealth: vi.fn(), export: vi.fn(), sendRemoteIncident: vi.fn() },
    sync: { getStatus: vi.fn().mockResolvedValue({isOnline:true}), getFailedFinancialItems: vi.fn(), validateFinancialIntegrity: vi.fn() },
    recovery: { listActionLog: vi.fn(), executeAction: vi.fn(), recordActionLog: vi.fn(), createPreActionSnapshot: vi.fn() },
  },
  queue: { listItems: vi.fn() },
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../lib', () => ({ getBridge: () => bridge, onEvent: vi.fn(), offEvent: vi.fn(), emitCompatEvent: vi.fn() }));
vi.mock('../../contexts/shift-context', () => ({ useShift: () => ({ isShiftActive: true, staff: null }) }));
vi.mock('../../hooks/useFeatures', () => ({ useFeatures: () => ({ isMobileWaiter: false }) }));
vi.mock('../../hooks/useEndOfDayStatus', () => ({ useEndOfDayStatus: () => ({ endOfDayStatus: { status: 'idle' } }) }));
vi.mock('../recovery/RecoveryPanel', () => ({ RecoveryPanel: () => null }));
vi.mock('../support/SupportDetailsPanel', () => ({ SupportDetailsPanel: () => null }));
vi.mock('../../services/SyncQueueBridge', () => ({ getSyncQueueBridge: () => queue }));
vi.mock('react-hot-toast', () => ({ default: toast }));
// The modal formats blocker money through `renderer/utils/format`, which
// pulls in the real i18n bootstrap; the mock has to carry its plugin too.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({
  runWithPrivilegedConfirmation: ({ action }: { action: () => Promise<unknown> }) => action(), confirmationModal: null,
}) }));
vi.mock('../ui/ConfirmDialog', () => ({ ConfirmDialog: ({ isOpen, onConfirm }: { isOpen: boolean; onConfirm(): void }) =>
  isOpen ? <button type="button" onClick={onConfirm}>Confirm selected change</button> : null }));

import { SyncStatusIndicator } from '../SyncStatusIndicator';
import { openTillHealth } from '../recovery/till-health-model';
import { TillHealthActionHarness } from '../recovery/__tests__/TillHealthActionHarness';
import { buildSyncRecoveryIssues } from '../recovery/sync-recovery-issues';

const health = { schemaVersion: 1, syncBacklog: {}, lastSyncTimes: {}, pendingOrders: 0,
  isOnline: true, dbSizeBytes: 0, printerStatus: { configured: true, recentJobs: [] },
  terminalContext: { organizationId: 'org-a', branchId: 'branch-a', terminalId: 'terminal-a' } } as any;
const issue: RecoveryIssue = {
  id: 'address-1', code: 'customer_address_default_conflict', severity: 'error', status: 'blocking',
  entityType: 'customer_address', entityId: 'address-1', params: { sampleItemId: 'q-a' }, titleKey: 'address.failed', summaryKey: 'address.impact', guidanceKey: 'address.next',
  actions: [ { id: 'retryParityItem', labelKey: 'recovery.actions.retryCustomerAddressDefault.label', recommended: true, safetyLevel: 'safe', requiresOnline: false, requiresSnapshot: true, confirmationRequired: false, recipeId: 'address.retry', recipeVersion: 1 },
    { id: 'contactDev', labelKey: 'contact.support', safetyLevel: 'safe', requiresOnline: false, requiresSnapshot: false, confirmationRequired: false } ],
};
const row = { id:'q-a', tableName:'customer_addresses', moduleType:'customers', operation:'UPDATE', status:'failed', recordId:'address-a', organizationId:'org-a', data:'{"is_default":true}', errorMessage:'CUSTOMER_ADDRESS_DEFAULT_CONFLICT' };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes,no) => {resolve=yes; reject=no;}); return {promise,resolve,reject}; };

beforeEach(() => {
  vi.clearAllMocks();
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === 'table_attempt_recovery_status') return { success: true, attempts: [] };
    throw new Error(`Unexpected bridge command: ${command}`);
  });
  bridge.diagnostics.getSystemHealth.mockResolvedValue(health);
  bridge.sync.getFailedFinancialItems.mockResolvedValue([]);
  bridge.sync.validateFinancialIntegrity.mockResolvedValue({ valid:true, issues:[] });
  bridge.recovery.listActionLog.mockResolvedValue([]);
  bridge.recovery.recordActionLog.mockImplementation(async entry => entry);
  bridge.recovery.createPreActionSnapshot.mockResolvedValue({id:'snapshot-1'});
  queue.listItems.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(cleanup);

function openIssueControls() {
  for (const detail of document.querySelectorAll<HTMLDetailsElement>('.till-health-support details')) detail.open = true;
}

describe('Recovery action truth', () => {
  it('prioritizes a known remedy over an equally severe generic warning without hiding either issue', () => {
    const known = {...issue,knownSolution:{recipeId:'address.retry',version:1,labelKey:'known.address',explanationKey:'known.why',requiresSnapshot:true}};
    const unknown = {...issue,id:'unknown',titleKey:'unknown.problem',actions:[issue.actions[1]]};
    const view=render(<TillHealthActionHarness issues={[unknown,known]} recentActions={[]} onRefresh={vi.fn()} />);
    expect(screen.getAllByTestId('till-health-card')[0]).toHaveTextContent('tillHealth.families.address.title');
    expect(screen.getAllByTestId('till-health-card')).toHaveLength(2);
    view.rerender(<TillHealthActionHarness issues={[{...unknown,severity:'critical'},known]} recentActions={[]} onRefresh={vi.fn()} />);
    expect(screen.getAllByTestId('till-health-card')[0]).toHaveTextContent('tillHealth.families.address.title');
  });
  it('never runs a mutating action when the pre-action snapshot was not confirmed', async () => {
    bridge.recovery.createPreActionSnapshot.mockResolvedValue({success:false});
    render(<TillHealthActionHarness issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getAllByText('tillHealth.action.saveAddress')[0]);
    await waitFor(()=>expect(bridge.recovery.recordActionLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' })));
    expect(bridge.recovery.executeAction).not.toHaveBeenCalled();
  });
  it.each([undefined, {status:'pending'}, {status:'unknown'}])('keeps an acknowledged issue pending until fresh diagnostics: %j', async verification => {
    bridge.recovery.executeAction.mockResolvedValue({ success:true, verification });
    const refresh = deferred<void>();
    const view = render(<TillHealthActionHarness issues={[issue]} recentActions={[]} onRefresh={() => refresh.promise} />);
    fireEvent.click(screen.getAllByText('tillHealth.action.saveAddress')[0]);
    await waitFor(() => expect(bridge.recovery.recordActionLog).toHaveBeenCalled());
    expect(screen.getByTestId('till-health-card')).toHaveTextContent('tillHealth.families.address.title');
    expect(toast.success).not.toHaveBeenCalled();
    expect(bridge.recovery.recordActionLog.mock.calls[0][0]).toMatchObject({success:false, outcome:'pending', recipeId:'address.retry', recipeVersion:1, snapshotPointId:'snapshot-1'});
    await act(async () => refresh.resolve());
    expect(screen.getByTestId('till-health-card')).toHaveTextContent('tillHealth.families.address.title');
    view.rerender(<TillHealthActionHarness issues={[]} recentActions={[]} onRefresh={vi.fn()} />);
    expect(screen.getByTestId('till-health-card')).toHaveTextContent('tillHealth.phase.pending');
    expect(screen.queryByText('tillHealth.phase.solved')).not.toBeInTheDocument();
    expect(bridge.recovery.recordActionLog.mock.calls.every(([entry]) => !entry.success)).toBe(true);
  });
  it('records explicit verification passed without hiding the old observation before refresh', async () => {
    bridge.recovery.executeAction.mockResolvedValue({success:true, verification:{status:'passed'}, changedIds:['q-a']});
    render(<TillHealthActionHarness issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getAllByText('tillHealth.action.saveAddress')[0]);
    await screen.findByText('tillHealth.phase.solved');
    expect(screen.getByTestId('till-health-card')).toHaveTextContent('tillHealth.families.address.title');
    expect(bridge.recovery.recordActionLog.mock.calls[0][0]).toMatchObject({success:true,outcome:'resolved'});
  });
  it.each([undefined, {success:false}, {success:true, verification:{status:'failed'}}])('never navigates or claims success after rejected action %j', async result => {
    bridge.recovery.executeAction.mockResolvedValue(result);
    const onNavigate = vi.fn();
    const routeIssue = {...issue, actions:[{...issue.actions[0], routeTarget:{screen:'connectionSettings' as const}}]};
    render(<TillHealthActionHarness issues={[routeIssue]} recentActions={[]} onRefresh={vi.fn()} onNavigate={onNavigate} />);
    fireEvent.click(screen.getAllByText('tillHealth.action.saveAddress')[0]);
    await waitFor(() => expect(bridge.recovery.recordActionLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' })));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('renders separate same-order blockers and sends the exact owner and row from the employee action', async () => {
    const base = {
      entityId: 'one-order', entityType: 'orders', operation: 'UPDATE', queue: 'parity_sync_queue' as const,
    };
    const systemHealth = { ...health, syncBlockerDetails: [
      { ...base, queueItemId: 'failed-a', queueStatus: 'failed', blockerReason: 'PAYLOAD_REFUSED' },
      { ...base, queueItemId: 'parked-b', queueStatus: 'conflict', blockerReason: 'UNKNOWN_CONFLICT_REVIEW' },
      { ...base, entityType: 'order', queue: 'sync_queue', queueId: 57, queueStatus: 'failed', blockerReason: 'LEGACY_REFUSED' },
    ] };
    const { issues } = buildSyncRecoveryIssues({ systemHealth });
    expect(issues.map(item => item.businessEventKey)).toEqual([
      'parity_sync_queue:failed-a', 'parity_sync_queue:parked-b', 'sync_queue:57',
    ]);
    expect(issues[1].actions.map(action => action.id)).toEqual(['contactDev']);
    bridge.recovery.executeAction.mockResolvedValue({ success: true, verification: { status: 'passed' }, changedIds: ['parked-b'] });
    render(<TillHealthActionHarness issues={issues} recentActions={[]} onRefresh={vi.fn()} />);
    openIssueControls();
    fireEvent.click(screen.getAllByText('recovery.actionStatus.sendRecord')[0]);
    await waitFor(() => expect(bridge.recovery.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'retryParityItem', queueId: null, snapshotPointId: 'snapshot-1',
      params: expect.objectContaining({ queueOwner: 'parity_sync_queue', sampleItemId: 'failed-a' }),
    })));
    await waitFor(() => expect(bridge.recovery.recordActionLog).toHaveBeenCalledWith(expect.objectContaining({
      success: false, outcome: 'pending',
    })));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('removes only the invalid sending records in the visible preview', async () => {
    const systemHealth = { ...health, invalidOrders: { count: 2, details: [
      { order_id: 'order-a', queue_id: 15, invalid_menu_items: [], reason: 'Order not found' },
      { order_id: 'order-b', queue_id: 42, invalid_menu_items: [], reason: 'Order not found' },
    ] } };
    const { issues } = buildSyncRecoveryIssues({ systemHealth });
    bridge.recovery.executeAction.mockResolvedValue({ success: true, verification: { status: 'passed' }, changedIds: ['15', '42'] });
    render(<TillHealthActionHarness issues={issues} recentActions={[]} onRefresh={vi.fn()} />);
    openIssueControls();
    fireEvent.click(screen.getByText('recovery.actionStatus.removeLabel'));
    expect(bridge.recovery.executeAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm selected change' }));
    await waitFor(() => expect(bridge.recovery.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'removeInvalidOrders', snapshotPointId: 'snapshot-1',
      params: expect.objectContaining({ invalidRows: [[15, 'order-a'], [42, 'order-b']] }),
    })));
    expect(bridge.recovery.createPreActionSnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(bridge.recovery.executeAction.mock.invocationCallOrder[0]);
  });

  it('keeps the platform money action in place until both changes are verified', async () => {
    const systemHealth = { ...health, checkoutPaymentBlockers: { count: 1, details: [{
      orderId: 'platform-order', orderNumber: '15', orderStatus: 'delivered', platformHeld: true,
      reasonCode: 'platform_settlement_mismatch', reasonVariant: 'platform_holds', totalAmount: 14.5, settledAmount: 14.5,
      paymentStatus: 'paid', paymentMethod: 'cash', reasonText: '', suggestedFix: '', severity: 'blocking',
    }] } };
    const { issues } = buildSyncRecoveryIssues({ systemHealth });
    const navigate = vi.fn();
    bridge.recovery.executeAction
      .mockResolvedValueOnce({ success: true, verification: { status: 'pending' }, changedIds: ['drawer-payment'] })
      .mockResolvedValueOnce({ success: true, verification: { status: 'passed' }, changedIds: ['drawer-payment', 'settlement-payment'] });
    render(<TillHealthActionHarness issues={issues} recentActions={[]} onRefresh={vi.fn()} onNavigate={navigate} />);
    openIssueControls();
    const press = () => {
      fireEvent.click(screen.getAllByText('recovery.actions.repairPlatformSettlementMismatch.label')[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Confirm selected change' }));
    };
    press();
    await waitFor(() => expect(bridge.recovery.recordActionLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending' })));
    expect(navigate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByText('recovery.actions.repairPlatformSettlementMismatch.label')[0]).not.toBeDisabled());
    press();
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(bridge.recovery.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'repairPlatformSettlementMismatch', orderId: 'platform-order', snapshotPointId: 'snapshot-1',
    }));
  });

  it.each([
    [null, 'reportFailed'],
    [{ success: false, localPrepared: true, bundleStored: false, path: 'C:/copy.zip' }, 'reportPrepared'],
    [{ success: true, bundleStored: true, alertSent: true }, 'reportFailed'],
    [{ success: true, bundleStored: true, incidentId: 'inc-verified', alertStatus: 'failed' }, 'reportStored'],
    [{ success: true, bundleStored: true, incidentId: 'inc-verified', alertSent: true }, 'reportNotified'],
  ])('reports delivery and notification only with a verified receipt (%j)', async (report, key) => {
    const systemHealth = { ...health, syncBlockerDetails: [{
      queue: 'parity_sync_queue', queueItemId: 'parked-row', entityId: 'retained-order',
      entityType: 'orders', operation: 'UPDATE', queueStatus: 'conflict', blockerReason: 'UNKNOWN_CONFLICT_REVIEW',
    }] };
    const { issues } = buildSyncRecoveryIssues({ systemHealth });
    if (report) bridge.diagnostics.sendRemoteIncident.mockResolvedValueOnce(report);
    else bridge.diagnostics.sendRemoteIncident.mockRejectedValueOnce(new Error('export failed'));
    render(<TillHealthActionHarness issues={issues} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'tillHealth.support.reportTopic' }), { target: { value: issues[0].id } });
    fireEvent.click(screen.getByRole('button', { name: 'tillHealth.report.new' }));
    const reportLine = key === 'reportFailed' ? 'failed' : key === 'reportPrepared' ? 'local' : 'sent';
    expect(await screen.findByText('tillHealth.report.' + reportLine)).toBeInTheDocument();
    if (key === 'reportStored') expect(screen.getByText('recovery.actionStatus.reportStored')).toBeInTheDocument();
    await waitFor(() => expect(bridge.recovery.recordActionLog).toHaveBeenCalledWith(expect.objectContaining({
      success: key === 'reportStored' || key === 'reportNotified',
    })));
    expect(bridge.diagnostics.sendRemoteIncident).toHaveBeenCalledWith(expect.objectContaining({
      healthView: { selectedIssue: expect.objectContaining({ code: 'UNKNOWN_CONFLICT_REVIEW', queueId: 'parked-row' }) },
    }));
    expect(bridge.diagnostics.export).not.toHaveBeenCalled();
    expect(bridge.recovery.executeAction).not.toHaveBeenCalled();
  });
  it('allows one action at a time and blocks actions on stale diagnostics', async () => {
    const running = deferred<any>(); bridge.recovery.executeAction.mockReturnValue(running.promise);
    const view = render(<TillHealthActionHarness issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getAllByText('tillHealth.action.saveAddress')[0]);
    expect(screen.queryByRole('button', { name: 'tillHealth.action.saveAddress' })).toBeNull();
    await waitFor(() => expect(bridge.recovery.executeAction).toHaveBeenCalledTimes(1));
    await act(async () => running.resolve({success:true}));
    view.rerender(<TillHealthActionHarness issues={[issue]} recentActions={[]} onRefresh={vi.fn()} diagnosticsStale />);
    openIssueControls();
    const disabled = screen.getByText('recovery.actions.retryCustomerAddressDefault.label');
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(bridge.recovery.executeAction).toHaveBeenCalledTimes(1);
  });
});

describe('Recovery observation lifecycle', () => {
  it('keeps general recovery available when the optional order observer is unavailable', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({ ...health, orderNotices: null,
      observerFailures: ['orderNotices', 'orderIssueEvidence'] });
    queue.listItems.mockResolvedValue([row]);
    render(<SyncStatusIndicator showDetails />);
    await screen.findAllByText('tillHealth.families.address.title');
    expect(screen.queryByText('tillHealth.states.unavailable.detail')).not.toBeInTheDocument();
    expect(screen.queryByText('tillHealth.states.stale.detail')).not.toBeInTheDocument();
  });
  it('shows loading even with initial core context, then unavailable on queue failure', async () => {
    const load=deferred<any>(); queue.listItems.mockReturnValue(load.promise);
    render(<SyncStatusIndicator showDetails />);
    expect(screen.getByText('tillHealth.states.loading.detail')).toBeInTheDocument();
    expect(screen.queryByText('tillHealth.states.ok.title')).not.toBeInTheDocument();
    await act(async () => load.reject(new Error('queue unavailable')));
    expect(screen.getByText('tillHealth.states.unavailable.detail')).toBeInTheDocument();
    expect(screen.queryByText('tillHealth.states.ok.title')).not.toBeInTheDocument();
  });
  it.each(['financial', 'integrity', 'parity'] as const)('keeps last known issues when the %s read fails on refresh', async source => {
    queue.listItems.mockResolvedValue([row]);
    render(<SyncStatusIndicator showDetails />);
    await screen.findAllByText('tillHealth.families.address.title');
    const reader = {
      financial: bridge.sync.getFailedFinancialItems,
      integrity: bridge.sync.validateFinancialIntegrity,
      parity: queue.listItems,
    }[source];
    reader.mockRejectedValueOnce(new Error('reader offline'));
    fireEvent.click(screen.getByRole('button', { name: 'tillHealth.action.recheck' }));
    await screen.findByText('tillHealth.states.stale.detail');
    expect(screen.getAllByText('tillHealth.families.address.title').length).toBeGreaterThan(0);
    expect(screen.queryByText('tillHealth.states.ok.title')).not.toBeInTheDocument();
  });

  it('retains issues after a failed refresh and clears them across close/reopen in a different organization', async () => {
    queue.listItems.mockResolvedValue([row]);
    render(<SyncStatusIndicator showDetails />);
    await screen.findAllByText('tillHealth.families.address.title');
    queue.listItems.mockRejectedValue(new Error('no queue'));
    fireEvent.click(screen.getByRole('button',{name:'tillHealth.action.recheck'}));
    await screen.findByText('tillHealth.states.stale.detail');
    expect(screen.getAllByText('tillHealth.families.address.title').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button',{name:'common.actions.close'}));
    bridge.diagnostics.getSystemHealth.mockResolvedValue({ ...health, terminalContext: { ...health.terminalContext, organizationId: 'org-b' } });
    act(() => openTillHealth());
    await screen.findByText('tillHealth.states.unavailable.detail');
    expect(screen.queryByText('tillHealth.families.address.title')).not.toBeInTheDocument();
    await screen.findByText('tillHealth.states.unavailable.detail');
    expect(screen.queryByText('tillHealth.states.ok.title')).not.toBeInTheDocument();
  });
  it('discards responses from a closed observation', async () => {
    const oldLoad=deferred<any>(); queue.listItems.mockReturnValueOnce(oldLoad.promise);
    render(<SyncStatusIndicator showDetails />);
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    queue.listItems.mockResolvedValue([]);
    act(() => openTillHealth());
    await screen.findByText('tillHealth.states.ok.title');
    await act(async () => oldLoad.resolve([row]));
    expect(screen.queryByText('tillHealth.families.address.title')).not.toBeInTheDocument();
  });
  it('contains keyboard focus, closes on Escape and returns focus to its launcher', async () => {
    vi.spyOn(HTMLElement.prototype,'offsetParent','get').mockImplementation(function(){ return this.parentElement; });
    render(<SyncStatusIndicator />);
    const launcher=screen.getByRole('button',{name:/tillHealth.title/}); launcher.focus(); fireEvent.click(launcher);
    const close=await screen.findByRole('button',{name:'common.actions.close'});
    const dialog=screen.getByRole('dialog',{name:'tillHealth.title'});
    await waitFor(()=>expect(dialog).toHaveFocus());
    close.focus(); fireEvent.keyDown(document,{key:'Tab',shiftKey:true});
    expect(screen.getByRole('button',{name:/tillHealth.support.title/})).toHaveFocus();
    fireEvent.keyDown(document,{key:'Tab'}); expect(close).toHaveFocus();
    fireEvent.keyDown(document,{key:'Escape'});
    await waitFor(()=>expect(launcher).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
