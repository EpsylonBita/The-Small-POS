import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryIssue } from '../../../lib';

const { bridge, queue, toast } = vi.hoisted(() => ({
  bridge: {
    diagnostics: { getSystemHealth: vi.fn(), export: vi.fn() },
    sync: { getFailedFinancialItems: vi.fn(), validateFinancialIntegrity: vi.fn() },
    recovery: { listActionLog: vi.fn(), executeAction: vi.fn(), recordActionLog: vi.fn(), createPreActionSnapshot: vi.fn() },
  },
  queue: { listItems: vi.fn() },
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../lib', () => ({ getBridge: () => bridge }));
vi.mock('../../services/SyncQueueBridge', () => ({ getSyncQueueBridge: () => queue }));
vi.mock('react-hot-toast', () => ({ default: toast }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({
  runWithPrivilegedConfirmation: ({ action }: { action: () => Promise<unknown> }) => action(), confirmationModal: null,
}) }));
vi.mock('../ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
import { SyncRecoveryModal } from '../recovery/SyncRecoveryModal';
import { RecoveryCenterPanel } from '../recovery/RecoveryCenterPanel';

const health = { schemaVersion: 1, syncBacklog: {}, lastSyncTimes: {}, pendingOrders: 0,
  isOnline: true, dbSizeBytes: 0, printerStatus: { configured: true, recentJobs: [] },
  terminalContext: { organizationId: 'org-a', branchId: 'branch-a', terminalId: 'terminal-a' } } as any;
const issue: RecoveryIssue = {
  id: 'address-1', code: 'customer_address_default_conflict', severity: 'error', status: 'blocking',
  entityType: 'customer_address', entityId: 'address-1', titleKey: 'address.failed', summaryKey: 'address.impact', guidanceKey: 'address.next',
  actions: [ { id: 'retryParityItem', labelKey: 'retry.address', recommended: true, safetyLevel: 'safe', requiresOnline: false, requiresSnapshot: true, confirmationRequired: false, recipeId: 'address.retry', recipeVersion: 1 },
    { id: 'contactDev', labelKey: 'contact.support', safetyLevel: 'safe', requiresOnline: false, requiresSnapshot: false, confirmationRequired: false } ],
};
const row = { id:'q-a', tableName:'customer_addresses', moduleType:'customers', operation:'UPDATE', status:'failed', recordId:'address-a', organizationId:'org-a', data:'{"is_default":true}', errorMessage:'CUSTOMER_ADDRESS_DEFAULT_CONFLICT' };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes,no) => {resolve=yes; reject=no;}); return {promise,resolve,reject}; };

beforeEach(() => {
  vi.clearAllMocks();
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

describe('Recovery action truth', () => {
  it('prioritizes a known remedy over an equally severe generic warning without hiding either issue', () => {
    const known = {...issue,knownSolution:{recipeId:'address.retry',version:1,labelKey:'known.address',explanationKey:'known.why',requiresSnapshot:true}};
    const unknown = {...issue,id:'unknown',titleKey:'unknown.problem',actions:[issue.actions[1]]};
    const view=render(<RecoveryCenterPanel issues={[unknown,known]} recentActions={[]} onRefresh={vi.fn()} />);
    expect(screen.getAllByRole('heading')[0]).toHaveTextContent('address.failed');
    expect(screen.getByText('unknown.problem')).toBeInTheDocument();
    view.rerender(<RecoveryCenterPanel issues={[{...unknown,severity:'critical'},known]} recentActions={[]} onRefresh={vi.fn()} />);
    expect(screen.getAllByRole('heading')[0]).toHaveTextContent('unknown.problem');
  });
  it('never runs a mutating action when the pre-action snapshot was not confirmed', async () => {
    bridge.recovery.createPreActionSnapshot.mockResolvedValue({success:false});
    render(<RecoveryCenterPanel issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getAllByText('retry.address')[0]);
    await waitFor(()=>expect(toast.error).toHaveBeenCalled());
    expect(bridge.recovery.executeAction).not.toHaveBeenCalled();
  });
  it.each([undefined, {status:'pending'}, {status:'unknown'}])('keeps an acknowledged issue pending until fresh diagnostics: %j', async verification => {
    bridge.recovery.executeAction.mockResolvedValue({ success:true, verification });
    const refresh = deferred<void>();
    const view = render(<RecoveryCenterPanel issues={[issue]} recentActions={[]} onRefresh={() => refresh.promise} />);
    fireEvent.click(screen.getAllByText('retry.address')[0]);
    await waitFor(() => expect(bridge.recovery.recordActionLog).toHaveBeenCalled());
    expect(screen.getAllByText('address.failed').length).toBeGreaterThan(0);
    expect(toast.success).not.toHaveBeenCalled();
    expect(bridge.recovery.recordActionLog.mock.calls[0][0]).toMatchObject({success:false, outcome:'pending', recipeId:'address.retry', recipeVersion:1, snapshotPointId:'snapshot-1'});
    await act(async () => refresh.resolve());
    expect(screen.getAllByText('address.failed').length).toBeGreaterThan(0);
    view.rerender(<RecoveryCenterPanel issues={[]} recentActions={[]} onRefresh={vi.fn()} />);
    expect(screen.queryByText('address.failed')).not.toBeInTheDocument();
    expect(screen.getByText('recovery.center.noVisibleBlockerTitle')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('recovery.center.outcomes.resolved');
  });
  it('records explicit verification passed without hiding the old observation before refresh', async () => {
    bridge.recovery.executeAction.mockResolvedValue({success:true, verification:{status:'passed'}});
    render(<RecoveryCenterPanel issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getAllByText('retry.address')[0]);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.getAllByText('address.failed').length).toBeGreaterThan(0);
    expect(bridge.recovery.recordActionLog.mock.calls[0][0]).toMatchObject({success:true,outcome:'resolved'});
  });
  it.each([undefined, {success:false}, {success:true, verification:{status:'failed'}}])('never navigates or claims success after rejected action %j', async result => {
    bridge.recovery.executeAction.mockResolvedValue(result);
    const onNavigate = vi.fn();
    const routeIssue = {...issue, actions:[{...issue.actions[0], routeTarget:{screen:'connectionSettings' as const}}]};
    render(<RecoveryCenterPanel issues={[routeIssue]} recentActions={[]} onRefresh={vi.fn()} onNavigate={onNavigate} />);
    fireEvent.click(screen.getAllByText('retry.address')[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onNavigate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('allows one action at a time and blocks actions on stale diagnostics', async () => {
    const running = deferred<any>(); bridge.recovery.executeAction.mockReturnValue(running.promise);
    const view = render(<RecoveryCenterPanel issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getAllByText('retry.address')[0]);
    fireEvent.click(screen.getAllByText('retry.address')[0]);
    await waitFor(() => expect(bridge.recovery.executeAction).toHaveBeenCalledTimes(1));
    await act(async () => running.resolve({success:true}));
    view.rerender(<RecoveryCenterPanel issues={[issue]} recentActions={[]} onRefresh={vi.fn()} diagnosticsStale />);
    fireEvent.click(screen.getAllByText('retry.address')[0]);
    expect(bridge.recovery.executeAction).toHaveBeenCalledTimes(1);
  });
});

describe('Recovery observation lifecycle', () => {
  it('shows loading even with initial core context, then unavailable on queue failure', async () => {
    const load=deferred<any>(); queue.listItems.mockReturnValue(load.promise);
    render(<SyncRecoveryModal isOpen onClose={vi.fn()} initialContext={{systemHealth:health}} />);
    expect(screen.getByText('sync.healthModal.loading.message')).toBeInTheDocument();
    expect(screen.queryByText('recovery.center.noVisibleBlockerTitle')).not.toBeInTheDocument();
    await act(async () => load.reject(new Error('queue unavailable')));
    expect(screen.getByText('sync.recoveryCenter.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText('recovery.center.noVisibleBlockerTitle')).not.toBeInTheDocument();
  });
  it('retains issues after a failed refresh and clears them across close/reopen in a different organization', async () => {
    queue.listItems.mockResolvedValue([row]);
    const onClose=vi.fn(); const context={systemHealth:health};
    const view=render(<SyncRecoveryModal isOpen onClose={onClose} initialContext={context} />);
    await screen.findAllByText('recovery.issues.customerAddressDefaultConflict.title');
    queue.listItems.mockRejectedValue(new Error('no queue'));
    fireEvent.click(screen.getByRole('button',{name:'common.actions.refresh'}));
    await screen.findByText('sync.recoveryCenter.staleData');
    expect(screen.getAllByText('recovery.issues.customerAddressDefaultConflict.title').length).toBeGreaterThan(0);
    view.rerender(<SyncRecoveryModal isOpen={false} onClose={onClose} initialContext={context} />);
    const contextB={systemHealth:{...health,terminalContext:{...health.terminalContext,organizationId:'org-b'}}};
    view.rerender(<SyncRecoveryModal isOpen onClose={onClose} initialContext={contextB} />);
    expect(screen.queryByText('recovery.issues.customerAddressDefaultConflict.title')).not.toBeInTheDocument();
    await screen.findByText('sync.recoveryCenter.loadFailed');
    expect(screen.queryByText('recovery.center.noVisibleBlockerTitle')).not.toBeInTheDocument();
  });
  it('discards responses from a closed observation', async () => {
    const oldLoad=deferred<any>(); queue.listItems.mockReturnValueOnce(oldLoad.promise);
    const onClose=vi.fn(); const view=render(<SyncRecoveryModal isOpen onClose={onClose} />);
    view.rerender(<SyncRecoveryModal isOpen={false} onClose={onClose} />);
    view.rerender(<SyncRecoveryModal isOpen onClose={onClose} />);
    await screen.findByText('recovery.center.noVisibleBlockerTitle');
    await act(async () => oldLoad.resolve([row]));
    expect(screen.queryByText('recovery.issues.customerAddressDefaultConflict.title')).not.toBeInTheDocument();
  });
  it('contains keyboard focus, closes on Escape and returns focus to its launcher', async () => {
    vi.spyOn(HTMLElement.prototype,'offsetParent','get').mockImplementation(function(){ return this.parentElement; });
    function Harness(){ const [open,setOpen]=React.useState(false); return <><button onClick={()=>setOpen(true)}>Open recovery</button><SyncRecoveryModal isOpen={open} onClose={()=>setOpen(false)} /></>; }
    render(<Harness/>);
    const launcher=screen.getByRole('button',{name:'Open recovery'}); launcher.focus(); fireEvent.click(launcher);
    const close=await screen.findByRole('button',{name:'common.actions.close'});
    await waitFor(()=>expect(close).toHaveFocus());
    close.focus(); fireEvent.keyDown(document,{key:'Tab',shiftKey:true});
    expect(screen.getByRole('button',{name:'common.actions.refresh'})).toHaveFocus();
    fireEvent.keyDown(document,{key:'Tab'}); expect(close).toHaveFocus();
    fireEvent.keyDown(document,{key:'Escape'});
    await waitFor(()=>expect(launcher).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
