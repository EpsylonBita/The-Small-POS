import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// --- Live report 2026-07-14: editing an order never reprinted the updated
// receipt. Fix: a new `after_edit` receipt action (default ON) enqueues the
// same auto-print entity types as order creation from the post-commit tail of
// orders_apply_edit_settlement. Receipt documents render at DISPATCH time, so
// the reprint carries the edited items AND the full payment breakdown — an
// order paid in cash whose edit delta was settled by card prints both as
// separate payment lines (Cash X / Card Y), refunds as adjustment lines. ---

const printRs = readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'print.rs'),
  'utf8',
);
const ordersRs = readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'orders.rs'),
  'utf8',
);
const printerSettingsSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'PrinterSettingsModal.tsx'),
  'utf8',
);

const LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const;

test('after_edit receipt action defaults ON in the Rust action registry', () => {
  // The default-true match arm must include after_edit.
  const matchArm = printRs.match(/None => matches!\(\s*key,([\s\S]*?)\),/);
  assert.ok(matchArm, 'default-true match arm not found');
  assert.match(matchArm![1], /"after_edit"/);
});

test('after-edit reprint helper exists and mirrors creation auto-print', () => {
  assert.match(printRs, /pub fn enqueue_after_edit_auto_print\(/);
  const helper = printRs.slice(printRs.indexOf('pub fn enqueue_after_edit_auto_print'));
  const body = helper.slice(0, helper.indexOf('\n}\n'));
  // Ghost orders never print; the action gate is consulted; entity types
  // come from the same per-order-type table as order creation.
  assert.match(body, /if is_ghost/);
  assert.match(body, /is_print_action_enabled\(db, "after_edit"\)/);
  assert.match(body, /auto_print_entity_types_for_order_type\(order_type\)/);
});

test('orders_apply_edit_settlement enqueues the reprint post-commit', () => {
  const fnStart = ordersRs.indexOf('pub async fn orders_apply_edit_settlement(');
  assert.ok(fnStart >= 0, 'orders_apply_edit_settlement not found');
  const nextFn = ordersRs.indexOf('#[tauri::command]', fnStart);
  const fnBody = ordersRs.slice(fnStart, nextFn);
  // The hook fires after COMMIT (the delta payment/refund rows land in the
  // same transaction, so the reprinted receipt shows the full breakdown).
  const commitIdx = fnBody.indexOf('execute_batch("COMMIT")');
  const hookIdx = fnBody.indexOf('enqueue_after_edit_auto_print(&db, &actual_order_id');
  assert.ok(commitIdx >= 0, 'commit not found in edit settlement');
  assert.ok(hookIdx > commitIdx, 'reprint hook must run after the commit');
});

test('printer settings expose the after_edit toggle (default on)', () => {
  assert.match(printerSettingsSource, /'after_order', 'after_edit',/);
  assert.match(printerSettingsSource, /after_edit: true,/);
  assert.match(printerSettingsSource, /case 'after_edit':/);
  // The default-true grid grew to 8 entries; the "new triggers" grid follows.
  assert.match(printerSettingsSource, /RECEIPT_ACTION_KEYS\.slice\(0, 8\)/);
  assert.match(printerSettingsSource, /RECEIPT_ACTION_KEYS\.slice\(8\)/);
});

test('every POS locale carries the afterEdit receipt-action label', () => {
  for (const locale of LOCALES) {
    const json = JSON.parse(
      readFileSync(path.join(process.cwd(), 'src', 'locales', `${locale}.json`), 'utf8'),
    );
    const label = json?.settings?.printer?.receiptActions?.afterEdit;
    assert.ok(
      typeof label === 'string' && label.trim().length > 0,
      `locale ${locale} is missing settings.printer.receiptActions.afterEdit`,
    );
  }
});
