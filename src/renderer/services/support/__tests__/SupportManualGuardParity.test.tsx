import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryActionDescriptor, RecoveryIssue } from '../../../../lib';
import { TillHealthActionHarness } from '../../../components/recovery/__tests__/TillHealthActionHarness';
import { acquireRecoveryAction } from '../SupportRemedyRunner';
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), execute: vi.fn(), log: vi.fn(), authorize: vi.fn() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ recovery: { createPreActionSnapshot: mocks.snapshot, executeAction: mocks.execute, recordActionLog: mocks.log } }) }));
vi.mock('../../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({ runWithPrivilegedConfirmation: mocks.authorize, confirmationModal: null }) }));
vi.mock('../../../components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../../../components/recovery/RecoveryPanel', () => ({ RecoveryPanel: () => null }));
vi.mock('../../../components/support/SupportDetailsPanel', () => ({ SupportDetailsPanel: () => null }));
vi.mock('../../../components/recovery/TableAttemptRecoveryNotice', () => ({ TableAttemptRecoveryNotice: () => null }));
vi.mock('react-i18next', () => ({ initReactI18next: {type:'3rdParty', init: () => {}}, useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
const action: RecoveryActionDescriptor = { id: 'repairPaymentTotalConflict', labelKey: 'your.action', safetyLevel: 'safe', requiresOnline: true, requiresSnapshot: true, confirmationRequired: false };
const issue: RecoveryIssue = { id: 'your-issue', code: 'payment_total_conflict', entityType: 'order', entityId: 'your-order', severity: 'warning', status: 'blocking',
  titleKey: 'your.title', summaryKey: 'your.summary', guidanceKey: 'your.guidance', actions: [action] };
beforeEach(() => {
  mocks.snapshot.mockResolvedValue({ id: 'your-snapshot' }); mocks.execute.mockResolvedValue({ success: true, verification: { status: 'pending' } });
  mocks.log.mockImplementation(async value => value); mocks.authorize.mockImplementation(({ action: execute }: { action(): Promise<unknown> }) => execute());
});
function actionButton() {
  for (const detail of document.querySelectorAll<HTMLDetailsElement>('.till-health-support details')) detail.open = true;
  return screen.getByRole('button', { name: 'your.action' });
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('manual Health and remote support share guards', () => {
  it('keeps the real manual snapshot, privileged-action dialog and pending outcome after bridge extraction', async () => {
    render(<TillHealthActionHarness issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(actionButton());
    await waitFor(() => expect(mocks.log).toHaveBeenCalled());
    expect(mocks.snapshot).toHaveBeenCalledOnce(); expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ scope: 'cash_drawer_control' }));
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ actionId: action.id, entityId: issue.entityId }));
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ success: false, outcome: 'pending', snapshotPointId: 'your-snapshot' }));
  });
  it.each([
    [{code:'AUTH_SESSION_REQUIRED',reason:'private detail'}, 'AUTH_SESSION_REQUIRED', 'signIn'],
    [{code:'AUTH_SHIFT_REQUIRED',reason:'private detail'}, 'AUTH_SHIFT_REQUIRED', 'shift'],
    [new Error('SNAPSHOT_FAILED: private detail'), 'SNAPSHOT_FAILED', 'failed'],
    [new Error('private detail'), 'UNCLASSIFIED_REFUSAL', 'failed'],
    [new Error('PREEMPTED_BY_CRITICAL_OPERATION: private detail'), 'PREEMPTED_BY_CRITICAL_OPERATION', 'busy'],
  ])('records a closed code for Health without displaying refusal details', async (error, code, feedback) => {
    mocks.authorize.mockRejectedValue(error);
    const correction = {...issue, code: 'customer_correction_refused', params: { queueId: 'parked-row' },
      actions: [{...action, id: 'keepServerOrderCustomerDetails'}]};
    const view = render(<TillHealthActionHarness issues={[correction]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(actionButton());
    await waitFor(() => expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({
      noticeQueueId: 'parked-row', success: false, outcome: 'failed', errorMessage: code,
    })));
    expect(screen.getByTestId('till-health-card')).toHaveTextContent('tillHealth.phase.' + feedback);
    expect(view.container.textContent).not.toContain('private detail');
  });
  it('confirms the existing details after the keep action', async () => {
    mocks.execute.mockResolvedValue({ success: true, verification: { status: 'passed' }, changedIds: ['parked-row'] });
    const correction = {...issue, code: 'customer_correction_refused', params: { queueId: 'parked-row' },
      actions: [{...action, id: 'keepServerOrderCustomerDetails'}]};
    render(<TillHealthActionHarness issues={[correction]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(actionButton());
    await screen.findByText('tillHealth.phase.solved');
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'resolved', success: true }));
  });
  it('blocks a manual run while the shared remote lock is held', async () => {
    const release = acquireRecoveryAction();
    try {
      render(<TillHealthActionHarness issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
      fireEvent.click(actionButton()); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.snapshot).not.toHaveBeenCalled();
    } finally { release?.(); }
  });
  it('blocks manual stale diagnostics before snapshot or authorization', () => {
    render(<TillHealthActionHarness issues={[issue]} recentActions={[]} onRefresh={vi.fn()} diagnosticsStale />);
    expect(actionButton()).toBeDisabled();
    fireEvent.click(actionButton()); expect(mocks.snapshot).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
