// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { menuEditRefundAction } from '../../services/MenuOrderEdit';
import { shouldAutomaticallyRestoreCheckoutDraft } from '../../utils/checkoutDraftRestoration';
import { createCheckoutDraft } from '../../services/CheckoutDraftStore';
import * as editFinancials from '../../utils/editSettlementFinancials';
import { editRefusalMessageKey } from '../../utils/editRefusalMessage';
import { paymentRefusalMessage } from '../../utils/paymentRefusalMessage';

function callback(file: string, name: string, next: string, bindings: Record<string, any>) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = source.indexOf('const ' + name + ' =');
  const end = source.indexOf('const ' + next + ' =', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const entries = Object.entries(bindings).filter(([key]) => key !== name);
  return new Function(...entries.map(([key]) => key), code + '\nreturn ' + name)(...entries.map(([, value]) => value));
}
const preview = { completedPayments: [{ id: 'original-payment', method: 'card', remainingRefundable: 10 }] };
const request = { orderId: 'order-19', items: [{ id: 'line' }] };
function fixture() {
  const applyEditSettlement = vi.fn(async (..._args: any[]) => ({ success: true }));
  const commitMenuOrderEdit = vi.fn(async (..._args: any[]) => undefined);
  return { useCallback: (fn: any) => fn, bridge: { orders: { applyEditSettlement } }, commitMenuOrderEdit, menuEditRefundAction, editRefusalMessageKey, paymentRefusalMessage,
    activeShift: { id: 'last-driver-shift', staff_id: 'driver' }, staff: { staffId: 'driver', databaseStaffId: 'driver-db' },
    resolveAdjustmentAttribution: vi.fn(() => ({ staffId: 'driver', staffShiftId: 'last-driver-shift' })),
    collectionScope: {}, claimOrdinaryCollectionOwner: () => ({ claimed: true, owner: {} }),
    runOrdinaryCollection: async (_owner: any, _input: any, send: any) => { await send(); return { status: 'completed' }; },
    noteOrdinaryWriteFacts: vi.fn(), readOrdinaryWriteReply: vi.fn(), releaseOrdinaryOwnerBeforeSend: vi.fn(),
    classifyOrdinaryWrite: vi.fn(), ordinaryRefusalText: vi.fn(), toast: { success: vi.fn(), error: vi.fn() },
    loadOrders: vi.fn(async () => undefined), silentRefresh: vi.fn(async () => undefined), refetchTables: vi.fn(),
    t: (key: string, options?: any) => options?.defaultValue || key,
    setPendingEditRefundSettlement: vi.fn(), pendingEditRefundSettlement: { request },
    setEditSettlementDeltaPrompt: vi.fn(), editSettlementDeltaPrompt: null as any };
}
function assertDrawerAction(action: any, mode: string) {
  expect(action.type).toBe(mode);
  const rows = mode === 'collect' ? action.payments : action.refunds;
  expect(rows).toHaveLength(1);
  for (const row of rows) {
    expect(row).not.toHaveProperty('staffId');
    expect(row).not.toHaveProperty('staffShiftId');
    if (mode === 'collect') expect(row.collectedBy).toBe('cashier_drawer');
  }
}
describe('native owns edit money even with a driver on screen', () => {
  it('explains a refused edit collection with the native refusal guidance', async () => {
    const f: any = fixture();
    f.editSettlementDeltaPrompt = { mode: 'collect', amount: 1.9, preview, request };
    f.runOrdinaryCollection = async () => ({ status: 'refused', code: 'EDIT_LOCAL_STORAGE_BUSY' });
    await expect(callback('../OrderDashboard.tsx', 'handleEditSettlementDeltaConfirm', 'handleEditSettlementDeltaCancel', f)('card'))
      .rejects.toThrow('EDIT_LOCAL_STORAGE_BUSY');
    expect(f.toast.error).toHaveBeenCalledWith('modals.menu.editStorageBusy');
  });
  it('dashboard refusal mappings explain the missing drawer owner', () => {
    const f = { ...fixture(), extractOrderDashboardErrorMessage: (error: any) => error instanceof Error ? error.message : error };
    const error = new Error('EDIT_NO_DRAWER_OWNER_ON_SHIFT');
    expect(callback('../OrderDashboard.tsx', 'localizePaymentMethodEditError', 'handleEditPayment', f)(error))
      .toBe('modals.menu.editNoDrawerOwnerOnShift');
    expect(callback('../OrderDashboard.tsx', 'ordinaryRefusalText', 'judgeOrdinaryAttempt', f)(error.message))
      .toBe('modals.menu.editNoDrawerOwnerOnShift');
  });
  it.each(['collect', 'refund'])('menu commit %s leaves collector identity to native', async mode => {
    const f = fixture();
    f.editSettlementDeltaPrompt = { mode, amount: 1.9, preview, request,
      menuCommit: { data: request, lifecycle: {}, resolve: vi.fn(), reject: vi.fn() } };
    const confirm = callback('../OrderDashboard.tsx', 'handleEditSettlementDeltaConfirm', 'handleEditSettlementDeltaCancel', f);
    await confirm('card');
    expect(f.commitMenuOrderEdit).toHaveBeenCalledOnce();
    assertDrawerAction(f.commitMenuOrderEdit.mock.calls[0][2], mode);
    expect(f.resolveAdjustmentAttribution).not.toHaveBeenCalled();
  });
  it.each(['collect', 'refund'])('dashboard %s leaves collector identity to native', async mode => {
    const f = fixture();
    f.editSettlementDeltaPrompt = { mode, amount: 1.9, preview, request };
    await callback('../OrderDashboard.tsx', 'handleEditSettlementDeltaConfirm', 'handleEditSettlementDeltaCancel', f)('card');
    assertDrawerAction(f.bridge.orders.applyEditSettlement.mock.calls[0][0].action, mode);
    expect(f.resolveAdjustmentAttribution).not.toHaveBeenCalled();
  });
  it('the legacy refund confirmation strips screen identity even from supplied refunds', async () => {
    const f = fixture();
    await callback('../OrderDashboard.tsx', 'handleEditRefundSettlementConfirm', 'handleEditSettlementDeltaConfirm', f)([
      { paymentId: 'original-payment', amount: 1.9, staffId: 'driver', staffShiftId: 'last-driver-shift' },
    ]);
    assertDrawerAction(f.bridge.orders.applyEditSettlement.mock.calls[0][0].action, 'refund');
  });
  it.each(['collect', 'refund'])('OrderFlow %s leaves collector identity to native', async mode => {
    const f = fixture();
    const extra = { recoveredEditPrompt: { data: request, lifecycle: {}, preview: { ...preview, requiredAction: mode },
      amount: 1.9, resolve: vi.fn(), reject: vi.fn() }, setRecoveredEditPrompt: vi.fn() };
    await callback('../OrderFlow.tsx', 'confirmRecoveredEdit', 'handleStartNewOrder', { ...f, ...extra })('card');
    expect(f.commitMenuOrderEdit).toHaveBeenCalledOnce();
    assertDrawerAction(f.commitMenuOrderEdit.mock.calls[0][2], mode);
  });
});
describe('only the matching explicit edit may restore an edit draft', () => {
  it.each(['editing', 'checkout_pending'] as const)('never automatically restores a %s edit', phase => {
    const draft = { ...createCheckoutDraft(), phase, cartItems: [{ id: 'line' }], context: { editMode: true } };
    expect(shouldAutomaticallyRestoreCheckoutDraft(draft)).toBe(false);
    expect(shouldAutomaticallyRestoreCheckoutDraft({ ...draft, context: { editMode: false } })).toBe(true);
  });
});

describe('ordinary collection uses general payment guidance', () => {
  it.each([
    ['../OrderDashboard.tsx', 'judgeOrdinaryAttempt'],
    ['../OrderFlow.tsx', 'ordinaryLandedRef'],
  ])('%s explains the native collector refusal outside edits', (file, next) => {
    const text = callback(file, 'ordinaryRefusalText', next, fixture());
    expect(text('PAYMENT_COLLECTOR_NOT_DRAWER_OWNER')).toBe('modals.payment.refusals.collectorNotDrawerOwner');
    expect(text('GIFT_CARD_TERMINAL_SCOPE_REQUIRED')).toBe('giftCardCheckout.refusal.scope');
  });
});

describe('edit collection prompts and payloads use cents', () => {
  it.each([
    [undefined, 1.9], [190, 1.9], [180, 1.8], [0, 0],
  ])('uses native cents %s (or the older-reply fallback)', async (requiredCollectCents, expected) => {
    const nextPreview = { ...preview, requiredAction: 'collect', nextTotal: 11.1, paidTotal: 9.2, requiredCollectCents };
    for (const entry of ['dashboard', 'menu', 'recovered']) {
      const f = { ...fixture(), ...editFinancials,
        previewMenuOrderEdit: vi.fn(async () => ({ preflight: { kind: 'settlement' }, preview: nextPreview })),
        tableEditScope: () => null, currentEditOrderNumber: '19', restoredEditContext: null,
        setRecoveredEditPrompt: vi.fn(), recoveredEditPrompt: null as any };
      let completion: Promise<void> | undefined;
      if (entry === 'dashboard') {
        callback('../OrderDashboard.tsx', 'openEditSettlementCollectionPrompt', 'applySettlementAwareOrderEdit', f)(nextPreview, request);
      } else if (entry === 'menu') {
        completion = callback('../OrderDashboard.tsx', 'handleEditMenuComplete', 'handleEditMenuClose', f)(request, {});
      } else {
        completion = callback('../OrderFlow.tsx', 'completeRecoveredEdit', 'confirmRecoveredEdit', f)(request, {});
      }
      // The async menu entries stop at the picker until its confirmation resolves.
      await vi.waitFor(() => expect(entry === 'recovered' ? f.setRecoveredEditPrompt : f.setEditSettlementDeltaPrompt).toHaveBeenCalledOnce());
      const prompt = (entry === 'recovered' ? f.setRecoveredEditPrompt : f.setEditSettlementDeltaPrompt).mock.calls[0][0];
      expect(prompt.amount).toBe(expected);
      expect(String(prompt.amount)).toBe(String(expected));
      // This same state value is rendered as the delta modal's amount prop.
      const source = readFileSync(new URL(entry === 'recovered' ? '../OrderFlow.tsx' : '../OrderDashboard.tsx', import.meta.url), 'utf8');
      expect(source).toContain(entry === 'recovered' ? 'amount={recoveredEditPrompt?.amount ?? 0}' : 'amount={editSettlementDeltaPrompt?.amount ?? 0}');
      if (entry === 'recovered') {
        f.recoveredEditPrompt = prompt;
        await callback('../OrderFlow.tsx', 'confirmRecoveredEdit', 'handleStartNewOrder', f)('card');
      } else {
        f.editSettlementDeltaPrompt = prompt;
        await callback('../OrderDashboard.tsx', 'handleEditSettlementDeltaConfirm', 'handleEditSettlementDeltaCancel', f)('card');
      }
      const action = entry === 'dashboard'
        ? f.bridge.orders.applyEditSettlement.mock.calls[0][0].action
        : f.commitMenuOrderEdit.mock.calls[0][2];
      expect(action.payments[0].amount).toBe(expected);
      await completion;
    }
  });
});
