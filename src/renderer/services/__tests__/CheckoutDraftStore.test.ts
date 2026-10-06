// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../lib', () => ({ getBridge: () => ({}) }));
vi.mock('../terminal-credentials', () => ({ refreshTerminalCredentialCache: vi.fn() }));
import { CheckoutDraftStore, createCheckoutDraft, getCheckoutDraftStore } from '../CheckoutDraftStore';
import { refreshTerminalCredentialCache } from '../terminal-credentials';
import { buildOrderServiceTableMetadata } from '../../utils/tableOrderFlow';
const scope = { organizationId: 'org', branchId: 'branch', terminalId: 'terminal' };
const directories: string[] = [];
const connections: DatabaseSync[] = [];
afterEach(() => { connections.splice(0).forEach(db => db.close()); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function database(path: string) {
  const db = new DatabaseSync(path); connections.push(db);
  db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS draft(scope TEXT PRIMARY KEY,generation INTEGER NOT NULL,json TEXT)');
  const transport = async (command: string, input: any) => {
    const key = JSON.stringify([input.organizationId, input.branchId, input.terminalId]);
    const row = db.prepare('SELECT * FROM draft WHERE scope=?').get(key) as any;
    const generation = Number(row?.generation || 0);
    if (command !== 'checkout_draft_get') {
      if (input.expectedGeneration !== generation) throw new Error('CHECKOUT_DRAFT_VERSION_CHANGED');
      db.prepare('INSERT INTO draft VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET generation=excluded.generation,json=excluded.json')
        .run(key, generation + 1, command === 'checkout_draft_delete' ? null : JSON.stringify(input.draft));
    }
    const saved = db.prepare('SELECT * FROM draft WHERE scope=?').get(key) as any;
    return { success: true, scope, generation: Number(saved?.generation || 0), draft: saved?.json ? JSON.parse(saved.json) : null };
  };
  return { db, transport };
}
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'checkout-draft-')); directories.push(dir); return join(dir, 'checkout.sqlite'); }
const cart = () => ({ ...createCheckoutDraft(), cartItems: [{ id: 'item', quantity: 2, notes: 'no sugar', totalPrice: 8 }],
  context: { orderType: 'dine-in', selectedTable: { id: 'table-id', tableNumber: '1', tableSessionId: 'session-id' }, tableNumber: '1',
    selectedCustomer: { id: 'customer', name: 'Alex' }, editExpectedVersion: 8 },
  state: { manualDiscountMode: 'amount', manualDiscountValue: 2, notes: 'birthday' } });
describe('CheckoutDraftStore durable identity', () => {
  it('closes a new cart before its first autosave and fences a late save', async () => {
    const { transport } = database(fixture());
    const owner = new CheckoutDraftStore(scope, transport);
    const unsaved = cart();
    await owner.load();
    await owner.clear(unsaved.draftId);
    await expect(owner.save(unsaved)).rejects.toThrow('CHECKOUT_DRAFT_CHANGED');
    expect(await new CheckoutDraftStore(scope, transport).load()).toBeNull();
  });
  it('restores the complete actual cart and table binding after closing and reopening storage', async () => {
    const file = fixture(); const first = database(file); const saved = cart();
    await new CheckoutDraftStore(scope, first.transport).save(saved);
    connections.splice(connections.indexOf(first.db), 1); first.db.close();
    const next = database(file); const restored = await new CheckoutDraftStore(scope, next.transport).load();
    expect(restored).toEqual(saved);
    const tableContext = buildOrderServiceTableMetadata({ orderType: 'dine-in', tableId: restored!.context.selectedTable.id,
      tableNumber: restored!.context.tableNumber, tableSessionId: restored!.context.selectedTable.tableSessionId });
    expect(tableContext).toMatchObject({ table_id: 'table-id', table_session_id: 'session-id' });
  });
  it('orders autosaves and tombstones accepted cart; a late old save cannot resurrect it', async () => {
    const { transport } = database(fixture()); const owner = new CheckoutDraftStore(scope, transport); const original = cart();
    const save = owner.save(original); const clear = owner.clear(original.draftId); const late = owner.save(original);
    await save; await clear; await expect(late).rejects.toThrow('CHECKOUT_DRAFT_CHANGED');
    expect(await new CheckoutDraftStore(scope, transport).load()).toBeNull();
    const next = cart(); await owner.save(next); expect(await owner.load()).toEqual(next);
  });
  it('a second renderer owner cannot overwrite a draft loaded before acceptance', async () => {
    const { transport } = database(fixture()); const first = new CheckoutDraftStore(scope, transport); const stale = new CheckoutDraftStore(scope, transport);
    const original = cart(); await first.save(original); await stale.load(); await first.clear(original.draftId);
    await expect(stale.save(original)).rejects.toThrow('CHECKOUT_DRAFT_VERSION_CHANGED');
  });
  it('freezes financial preimage across restart, refuses editing/discard, clears only exact acceptance', async () => {
    const { transport } = database(fixture()); const pending = { ...cart(), phase: 'checkout_pending' as const, submission: { method: 'card', amount: 8 } };
    const owner = new CheckoutDraftStore(scope, transport); await owner.save(pending);
    const restored = new CheckoutDraftStore(scope, transport); expect(await restored.load()).toEqual(pending);
    await expect(restored.save({ ...pending, cartItems: [] })).rejects.toThrow('AWAITING_RECONCILIATION');
    await expect(restored.clear(pending.draftId)).rejects.toThrow('AWAITING_RECONCILIATION');
    await expect(restored.clear('another-cart', true)).rejects.toThrow('CHECKOUT_DRAFT_CHANGED');
    await restored.clear(pending.draftId, true); expect(await restored.load()).toBeNull();
  });
  it('failed native reads cannot be interpreted as an empty cart or overwritten', async () => {
    const native = vi.fn().mockRejectedValue(new Error('disk read failed')); const owner = new CheckoutDraftStore(scope, native);
    await expect(owner.load()).rejects.toThrow('disk read failed'); await expect(owner.save(cart())).rejects.toThrow('disk read failed');
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('rejects a cross-tenant response and never admits its cart', async () => {
    const native = vi.fn(async () => ({ success: true, scope: { ...scope, organizationId: 'other' }, generation: 1, draft: cart() }));
    await expect(new CheckoutDraftStore(scope, native).load()).rejects.toThrow('STORAGE_UNAVAILABLE');
  });
  it('inspection uses original editor identity and cannot authorize another collection', async () => {
    const draft = { ...cart(), context: { editMode: true, editOrderId: 'order', editExpectedVersion: 9 },
      phase: 'checkout_pending' as const, submission: { client_event_id: 'event' } };
    const native = vi.fn(async (command: string) => command === 'checkout_draft_get' ?
      { success: true, scope, generation: 2, draft } : { success: true, outcome: 'not_found', canCollect: false });
    const owner = new CheckoutDraftStore(scope, native); expect(await owner.inspect(draft.checkoutRequestId)).toMatchObject({ outcome: 'not_found', canCollect: false });
    expect(native).toHaveBeenLastCalledWith('checkout_draft_inspect', { ...scope, clientRequestId: draft.checkoutRequestId, editOrderId: 'order', clientEventId: 'event' });
    await expect(owner.inspect('new-id')).rejects.toThrow('CHANGED');
  });
  it('paid edit admission includes its original order within the current terminal scope', async () => {
    const native = vi.fn(async (command: string) => command === 'checkout_draft_get'
      ? { success: true, scope, generation: 0, draft: null }
      : { success: true, currency: 'EUR' });
    await new CheckoutDraftStore(scope, native).checkAdmission({ orderId: 'paid-original' });
    expect(native).toHaveBeenCalledWith('checkout_draft_check_admission', { ...scope, orderId: 'paid-original' });
  });
  it('factory requires fresh full scope and never keeps a stale owner across reset/rebinding', async () => {
    vi.mocked(refreshTerminalCredentialCache).mockResolvedValue({ ...scope, apiKey: '' });
    expect(await getCheckoutDraftStore()).not.toBe(await getCheckoutDraftStore());
    vi.mocked(refreshTerminalCredentialCache).mockResolvedValue({ ...scope, branchId: '', apiKey: '' });
    await expect(getCheckoutDraftStore()).rejects.toThrow('SCOPE_UNAVAILABLE');
  });
  it('explicit refusal resume preserves the cart, sends original CAS and fences a queued old autosave', async () => {
    const pending = { ...cart(), phase: 'checkout_pending' as const,
      submission: { clientRequestId: 'original', paymentData: { method: 'card', amount: 8 } } };
    pending.checkoutRequestId = 'original';
    const { submission: _submission, ...editable } = pending;
    const resumed = { ...editable, phase: 'editing' as const, checkoutRequestId: 'renewed',
      context: { ...pending.context, checkoutRequestId: 'renewed' } };
    const native = vi.fn(async (command: string) => ({ success: true, scope,
      generation: command === 'checkout_draft_get' ? 4 : 5, draft: command === 'checkout_draft_get' ? pending : resumed }));
    const owner = new CheckoutDraftStore(scope, native);
    await owner.load();
    const resume = owner.resumeDeclined('original');
    const late = owner.save(pending);
    expect(await resume).toEqual(resumed);
    await expect(late).rejects.toThrow('CHECKOUT_REQUEST_ID_CHANGED');
    expect(native.mock.calls).toEqual([
      ['checkout_draft_get', scope],
      ['checkout_draft_resume_declined', { ...scope, expectedGeneration: 4, draftId: pending.draftId, clientRequestId: 'original' }],
    ]);
    expect(await owner.load()).toEqual(resumed);
  });
  it('failed or contradictory refusal proof retains the original frozen identity', async () => {
    const pending = { ...cart(), phase: 'checkout_pending' as const };
    const native = vi.fn(async (command: string) => {
      if (command === 'checkout_draft_get') return { success: true, scope, generation: 3, draft: pending };
      throw new Error('CHECKOUT_DRAFT_DECLINE_NOT_PROVEN');
    });
    const owner = new CheckoutDraftStore(scope, native);
    await expect(owner.resumeDeclined(pending.checkoutRequestId)).rejects.toThrow('DECLINE_NOT_PROVEN');
    expect(await owner.load()).toEqual(pending);
    await expect(owner.clear(pending.draftId)).rejects.toThrow('AWAITING_RECONCILIATION');
  });
});
