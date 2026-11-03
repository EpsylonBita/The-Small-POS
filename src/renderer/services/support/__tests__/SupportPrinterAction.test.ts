import { expect, it, vi } from 'vitest';
import { executeHealthRecoveryAction } from '../SupportRemedyRunner';
import type { RecoveryActionDescriptor, RecoveryActionRequest } from '../../../../lib';

const native = vi.hoisted(() => ({ execute: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ recovery: { executeAction: native.execute, createPreActionSnapshot: native.snapshot } }) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
const action: RecoveryActionDescriptor = { id: 'restoreLastKnownPrinterBrand', recipeId: 'printer.restore_last_known_brand', recipeVersion: 1,
  labelKey: 'label', requiresSnapshot: true, safetyLevel: 'safe', requiresOnline: false, confirmationRequired: false };
const request: RecoveryActionRequest = { actionId: action.id, issueId: 'your-issue', issueCode: 'printer.brand_probe_unanswered',
  entityType: 'printer', entityId: 'your-printer', recipeId: action.recipeId, recipeVersion: 1,
  queueId: null, orderId: null, orderNumber: null, paymentId: null, adjustmentId: null, zReportId: null, shiftId: null, reportDate: null };

it('uses the native snapshot and fence without invoking a PIN or renderer snapshot', async () => {
  native.execute.mockResolvedValue({ success: true, snapshotPointId: 'your-native-snapshot', verification: { status: 'passed' } });
  const authorize = vi.fn(), onSnapshot = vi.fn(), beforeExecute = vi.fn();
  const result = await executeHealthRecoveryAction({ action, request, stale: () => false, t: key => key, authorize, onSnapshot, beforeExecute });
  expect(beforeExecute).toHaveBeenCalledOnce();
  expect(authorize).not.toHaveBeenCalled();
  expect(native.snapshot).not.toHaveBeenCalled();
  expect(native.execute).toHaveBeenCalledWith(request);
  expect(onSnapshot).toHaveBeenCalledWith('your-native-snapshot');
  expect(result.verification?.status).toBe('passed');
});
