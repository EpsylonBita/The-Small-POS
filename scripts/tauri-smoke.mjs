#!/usr/bin/env node
/**
 * The Small POS (Tauri) — Smoke Test Checklist Runner
 *
 * This is a manual-assist test runner. It prints each parity gate with
 * step-by-step instructions and lets the tester mark pass/fail.
 *
 * Usage:
 *   node scripts/tauri-smoke.mjs          # Interactive mode
 *   node scripts/tauri-smoke.mjs --list   # Just list gates
 *
 * Prerequisites:
 *   - Rust toolchain installed (rustup)
 *   - `cargo tauri dev` running in another terminal
 *   - Terminal configured with admin URL + API key (for online gates)
 */

import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const GATES = [
  {
    id: 'G1',
    name: 'Offline Order Creation + Restart Persistence',
    steps: [
      'Disconnect from network',
      'Open POS app (cargo tauri dev)',
      'Create 3 orders (dine-in, takeaway, delivery) via DevTools console',
      'Verify each returns { success: true, syncStatus: "pending" }',
      'Close app completely (Ctrl+C)',
      'Re-launch app',
      'Call order_get_all — must return all 3 orders',
      'Verify sync_queue has 3 pending entries',
    ],
    critical: true,
  },
  {
    id: 'G2',
    name: 'Sync Idempotency (No Duplicates)',
    steps: [
      'Reconnect to network',
      'Create 1 order',
      'Call sync_force',
      'Verify order syncStatus is "synced"',
      'Call sync_force again — should sync 0 items',
      'Check admin dashboard — only 1 copy exists',
    ],
    critical: true,
  },
  {
    id: 'G3',
    name: 'Menu Cache Stability',
    steps: [
      'Connect to admin, call terminal_config_refresh',
      'Verify menu_get_categories returns non-empty array',
      'Close and re-launch app',
      'Verify categories still present from cache',
      'Disconnect network, verify cache still works',
    ],
    critical: true,
  },
  {
    id: 'G4',
    name: 'Auth Lockout',
    steps: [
      'Set up staff PIN via auth_setup_pin',
      'Attempt login with wrong PIN 5 times',
      'Verify 6th attempt returns lockout error',
      'Wait for lockout to expire (or test with adjusted timeout)',
      'Verify correct PIN works after lockout',
    ],
    critical: true,
  },
  {
    id: 'G5',
    name: 'Shift Lifecycle',
    steps: [
      'Open cashier shift with opening_cash: 100',
      'Verify shift returned with status: "active"',
      'Call shift_get_active — returns the shift',
      'Call shift_get_active_by_terminal — returns the shift',
      'Create 2 orders linked to the shift',
      'Close shift with closing_cash: 150',
      'Verify variance calculation',
      'Verify shift status is "closed" in DB',
    ],
    critical: true,
  },
  {
    id: 'G6',
    name: 'Shift Offline Persistence + Sync Exactly-Once',
    steps: [
      'Disconnect from network',
      'Open cashier shift with opening_cash: 200',
      'Record expense: { amount: 15, expenseType: "supplies", description: "Napkins" }',
      'Verify shift_get_expenses returns 1 expense',
      'Close shift with closing_cash: 250',
      'Close and re-launch app',
      'Verify shift_get_active returns null (shift is closed)',
      'Verify shift_get_summary shows expense total = 15',
      'Verify sync_queue has 3 pending entries (open, expense, close)',
      'Reconnect to network',
      'Call sync_force',
      'Verify all 3 sync_queue entries are "synced"',
      'Call sync_force again — should sync 0 items',
    ],
    critical: true,
  },
  {
    id: 'G8',
    name: 'Payment Offline Persistence + Exactly-Once Sync',
    steps: [
      'Disconnect from network',
      'Open cashier shift',
      'Create order via POS flow (pickup, 2+ items)',
      'Complete cash payment — amount 25.00, received 30.00',
      'Verify order_payments has 1 row (sync_status: pending, method: cash)',
      'Verify orders row has payment_status: paid, payment_method: cash',
      'Verify sync_queue has entries for both order and payment entity types',
      'Close app completely, re-launch',
      'Verify order_payments row survives restart',
      'Reconnect network, call sync:force',
      'Order syncs first (gets supabase_id), payment defers if order not synced yet',
      'Call sync:force again — payment syncs to /api/pos/payments',
      'Verify order_payments.sync_status = synced',
      'Call sync:force — should be no-op (0 items)',
      'Select order in OrderDashboard, bulk action "receipt" — verify HTML preview renders',
    ],
    critical: true,
  },
  {
    id: 'G9',
    name: 'Order-Payment Reconciliation (deferred payment auto-sync)',
    steps: [
      'Disconnect from network',
      'Open cashier shift',
      'Create order (pickup, amount 30.00)',
      'Record cash payment: amount 30.00, received 50.00, change 20.00',
      'Verify order_payments.sync_state = "waiting_parent"',
      'Verify sync_queue payment entry has status = "deferred"',
      'Close app completely, re-launch',
      'Verify order_payments row survives restart with sync_state = "waiting_parent"',
      'Reconnect network, call sync_force — order syncs (gets supabase_id)',
      'Verify payment auto-promoted: sync_state should be "pending" or "applied"',
      'Call sync_force again — payment syncs to /api/pos/payments',
      'Verify order_payments.sync_state = "applied", sync_status = "synced"',
      'Call sync_force a third time — should be no-op (0 items)',
      'On admin dashboard: order shows payment_status "paid" once only',
      'Replay same idempotency key — server returns 200 "Payment already recorded"',
    ],
    critical: true,
  },
  {
    id: 'G10',
    name: 'Print Pipeline Offline Safety + Idempotency',
    steps: [
      'Create an order and record a payment',
      'Click "Print Receipt" — verify print_list_jobs returns 1 pending job',
      'Click "Print Receipt" again — verify no duplicate (same jobId, duplicate: true)',
      'Wait 5 seconds for print worker — verify job status is "printed"',
      'Verify outputPath points to a valid .html file on disk',
      'Read the file — verify it contains order number, items, totals',
      'Close app, re-launch — verify printed job persists',
      'Create new order, click "Print Receipt", close app within 5s',
      'Re-launch — verify pending print job survives restart',
      'Wait for worker — verify it transitions to "printed"',
      'Call print_get_receipt_file(orderId) — verify valid file path returned',
    ],
    critical: true,
  },
  {
    id: 'G11',
    name: 'Hardware Printing Resilience',
    steps: [
      'Call printer_list_system_printers — verify returns installed printers',
      'Create printer profile with INVALID name: { name: "Bad", printerName: "NONEXISTENT" }',
      'Set it as default via printer_set_default_profile(profileId)',
      'Create order + payment, click Print Receipt',
      'Wait 5s for worker — verify job status is "failed"',
      'Verify order payment_status is still "paid" (checkout NOT rolled back)',
      'Verify receipt .html file was generated on disk',
      'Update profile with valid printer: printer_update_profile({ id, printerName: "Microsoft Print to PDF" })',
      'Call print_reprint_job(jobId) — verify job reset to pending',
      'Wait 5s — verify job transitions to "printed"',
      'Call print_reprint_job(jobId) again — should error (not in failed state)',
      'Delete printer profile — verify default is cleared',
      'New print job without profile — succeeds in file-only mode',
    ],
    critical: true,
  },
  {
    id: 'G12',
    name: 'Cash Drawer Resilience',
    steps: [
      'Create printer profile with drawer disabled (default): { name: "No Drawer", printerName: "Test" }',
      'Set as default, call drawer_open — returns { success: false, message: "disabled" }',
      'Update profile: openCashDrawer: true (drawer_mode still "none")',
      'Call drawer_open — returns { success: false, message: "...none..." }',
      'Update profile: drawerMode: "escpos_tcp", drawerHost: "192.0.2.1", drawerPort: 9100',
      'Call drawer_open — returns error (TCP connect fails to unreachable host)',
      'Verify order payment_status still "paid" — checkout NOT rolled back',
      'Verify any print job for order has status "printed" — printing independent of drawer',
      'Call drawer_open immediately again — returns rate-limit error',
      'Wait 2 seconds, call drawer_open — attempts TCP again (rate limit clears)',
      'Create order + payment, enqueue print job with this profile',
      'Wait for worker — verify job is "printed" despite drawer kick failure',
      'Check logs — drawer kick error is WARN, not blocking ERROR',
      '(Optional) Start local TCP server on 9100, update drawerHost to 127.0.0.1',
      '(Optional) Call drawer_open — returns { success: true }, server receives ESC/POS bytes',
      'Delete printer profile — verify cleanup',
    ],
    critical: true,
  },
  {
    id: 'G13',
    name: 'Void/Refund Offline Persistence + Exactly-Once Sync',
    steps: [
      'Disconnect from network',
      'Open cashier shift, create order (total 50.00), record cash payment (50.00)',
      'Call refund_payment({ paymentId, amount: 15.00, reason: "Item returned" })',
      'Verify payment_adjustments has 1 row: type=refund, amount=15, sync_state=waiting_parent',
      'Verify sync_queue has adjustment entry with status=deferred',
      'Call refund_get_payment_balance(paymentId) — balance=35, totalRefunds=15',
      'Call refund_void_payment({ paymentId, reason: "Cancel" }) — payment voided',
      'Verify payment_adjustments has 2 rows (1 refund + 1 void)',
      'Call refund_get_payment_balance(paymentId) — balance=0, status=voided',
      'Call payment_get_receipt_preview(orderId) — HTML contains REFUND and VOID lines',
      'Record new payment (30.00), try refund(35.00) — rejected "exceeds remaining balance"',
      'Close app, re-launch — verify adjustments survive restart',
      'Call refund_list_order_adjustments(orderId) — both adjustments present',
      'Reconnect network, call sync_force multiple times until adjustments sync',
      'Verify payment_adjustments rows have sync_state=applied',
      'Call sync_force — should be no-op (0 items)',
    ],
    critical: true,
  },
  {
    id: 'G14',
    name: 'End-of-Day Close + Z-Report Offline',
    steps: [
      'Disconnect from network',
      'Open cashier shift (opening cash: 200.00)',
      'Create 3 orders (totals: 25.00, 35.00, 40.00)',
      'Record cash payments for orders 1+2 (60.00 total)',
      'Record card payment for order 3 (40.00)',
      'Partial refund on order 1: 10.00 (reason: "wrong item")',
      'Record expense: 15.00 (type: supplies)',
      'Close shift (closing cash: 235.00, expected: 235.00, variance: 0)',
      'Call zreport_generate({ shiftId }) — verify totals: gross=100, net=90, cash=60, card=40',
      'Verify z_reports table has 1 row with sync_state: pending',
      'Verify sync_queue has z_report entry with status: pending',
      'Call zreport_print({ zReportId }) — verify print job enqueued',
      'Verify print_jobs has z_report entry with status: pending',
      'Close app completely, re-launch',
      'Verify z_reports row survives restart with totals intact',
      'Reconnect to network, call sync_force — z_report syncs',
      'Verify z_reports.sync_state = applied',
      'Call sync_force again — should be no-op (0 items)',
      'Call zreport_generate({ shiftId }) again — returns existing report (idempotent)',
    ],
    critical: true,
  },
];

async function runInteractive() {
  console.log('\n=== The Small POS (Tauri) — Smoke Test Runner ===\n');
  console.log(`Total gates: ${GATES.length}\n`);

  const results = [];

  for (const gate of GATES) {
    console.log(`\n--- ${gate.id}: ${gate.name} ${gate.critical ? '(CRITICAL)' : ''} ---`);
    console.log('Steps:');
    gate.steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));

    const answer = await ask('\nResult? [p]ass / [f]ail / [s]kip: ');
    const result = answer.toLowerCase().startsWith('p')
      ? 'PASS'
      : answer.toLowerCase().startsWith('f')
        ? 'FAIL'
        : 'SKIP';

    results.push({ id: gate.id, name: gate.name, result, critical: gate.critical });
    console.log(`  => ${result}`);
  }

  // Summary
  console.log('\n\n=== RESULTS ===\n');
  const passed = results.filter((r) => r.result === 'PASS').length;
  const failed = results.filter((r) => r.result === 'FAIL').length;
  const skipped = results.filter((r) => r.result === 'SKIP').length;
  const criticalFails = results.filter((r) => r.result === 'FAIL' && r.critical);

  for (const r of results) {
    const icon = r.result === 'PASS' ? '[OK]' : r.result === 'FAIL' ? '[FAIL]' : '[SKIP]';
    console.log(`  ${icon} ${r.id}: ${r.name}`);
  }

  console.log(`\nPassed: ${passed}  Failed: ${failed}  Skipped: ${skipped}`);

  if (criticalFails.length > 0) {
    console.log('\n** CRITICAL FAILURES — DO NOT SHIP **');
    criticalFails.forEach((r) => console.log(`  - ${r.id}: ${r.name}`));
    process.exit(1);
  }

  if (failed > 0) {
    console.log('\nSome gates failed. Review before shipping.');
    process.exit(1);
  }

  console.log('\nAll gates passed!');
  rl.close();
}

function listGates() {
  console.log('Parity Gates:');
  for (const gate of GATES) {
    console.log(`  ${gate.id}: ${gate.name} ${gate.critical ? '(CRITICAL)' : ''}`);
  }
}

// Entry
if (process.argv.includes('--list')) {
  listGates();
} else {
  runInteractive();
}
