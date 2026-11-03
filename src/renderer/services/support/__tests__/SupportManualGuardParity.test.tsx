import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryActionDescriptor, RecoveryIssue } from '../../../../lib';
import { RecoveryCenterPanel } from '../../../components/recovery/RecoveryCenterPanel';
import { acquireRecoveryAction } from '../SupportRemedyRunner';
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), execute: vi.fn(), log: vi.fn(), authorize: vi.fn() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ recovery: { createPreActionSnapshot: mocks.snapshot, executeAction: mocks.execute, recordActionLog: mocks.log } }) }));
vi.mock('../../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({ runWithPrivilegedConfirmation: mocks.authorize, confirmationModal: null }) }));
vi.mock('../../../components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../../../components/recovery/TableAttemptRecoveryNotice', () => ({ TableAttemptRecoveryNotice: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
const action: RecoveryActionDescriptor = { id: 'repairPaymentTotalConflict', labelKey: 'your.action', safetyLevel: 'safe', requiresOnline: true, requiresSnapshot: true, confirmationRequired: false };
const issue: RecoveryIssue = { id: 'your-issue', code: 'payment_total_conflict', entityType: 'order', entityId: 'your-order', severity: 'warning', status: 'blocking',
  titleKey: 'your.title', summaryKey: 'your.summary', guidanceKey: 'your.guidance', actions: [action] };
beforeEach(() => {
  mocks.snapshot.mockResolvedValue({ id: 'your-snapshot' }); mocks.execute.mockResolvedValue({ success: true, verification: { status: 'pending' } });
  mocks.log.mockImplementation(async value => value); mocks.authorize.mockImplementation(({ action: execute }: { action(): Promise<unknown> }) => execute());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('manual Health and remote support share guards', () => {
  it('keeps the real manual snapshot, privileged-action dialog and pending outcome after bridge extraction', async () => {
    render(<RecoveryCenterPanel issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'your.action' })[0]);
    await waitFor(() => expect(mocks.log).toHaveBeenCalled());
    expect(mocks.snapshot).toHaveBeenCalledOnce(); expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ scope: 'cash_drawer_control' }));
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ actionId: action.id, entityId: issue.entityId }));
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ success: false, outcome: 'pending', snapshotPointId: 'your-snapshot' }));
  });
  it('blocks a manual run while the shared remote lock is held', async () => {
    const release = acquireRecoveryAction();
    try {
      render(<RecoveryCenterPanel issues={[issue]} recentActions={[]} onRefresh={vi.fn()} />);
      fireEvent.click(screen.getAllByRole('button', { name: 'your.action' })[0]); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.snapshot).not.toHaveBeenCalled();
    } finally { release?.(); }
  });
  it('blocks manual stale diagnostics before snapshot or authorization', () => {
    render(<RecoveryCenterPanel issues={[issue]} recentActions={[]} onRefresh={vi.fn()} diagnosticsStale />);
    expect(screen.getAllByRole('button', { name: 'your.action' })[0]).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'your.action' })[0]); expect(mocks.snapshot).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
