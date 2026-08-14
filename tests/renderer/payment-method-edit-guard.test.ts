import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const dashboardSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
  'utf8',
);
const paymentsSource = readFileSync(
  path.join(projectRoot, 'src-tauri', 'src', 'payments.rs'),
  'utf8',
);
const paymentRoutingSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'utils', 'paymentEditRouting.ts'),
  'utf8',
);

test('payment-method edit exposes every completed payment row instead of blocking split orders', () => {
  assert.match(dashboardSource, /const handleEditPayment = async \(\) =>/);
  assert.match(
    dashboardSource,
    /await loadPaymentEditRoute\(bridge, editablePaymentOrder\)/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /completedPayments\.length > 1[\s\S]*?paymentMethodEditRequiresSingleCompletedPayment/,
    'split payments must be selectable one row at a time',
  );
  assert.match(
    dashboardSource,
    /payments:\s*route\.payments/,
  );
  assert.match(
    paymentRoutingSource,
    /await bridge\.payments\.getOrderPayments\(orderId\)/,
  );
  assert.match(
    dashboardSource,
    /route\.kind === "collect-missing"[\s\S]*?await loadPersistedSplitDismissal\([\s\S]*?setMissingPaymentRepairTarget/,
    'zero-row pending orders must collect a real payment instead of opening method edit',
  );
  assert.match(
    dashboardSource,
    /setMissingPaymentRepairTarget\(\{[\s\S]*?amount:\s*settlement\.outstandingAmount/,
    'the collection modal must display the authoritative remaining balance',
  );
  assert.match(
    dashboardSource,
    /nextMethod,\s*\n\s*paymentId/,
    'the selected payment identity must cross the bridge with the requested cash/card method',
  );
});

test('native payment edit remains ambiguity-safe while supporting an explicit payment target', () => {
  assert.match(
    paymentsSource,
    /PAYMENT_METHOD_EDIT_REQUIRES_SINGLE_COMPLETED_PAYMENT/,
  );
  assert.match(
    paymentsSource,
    /update_payment_method_for_payment\(/,
  );
  assert.match(
    paymentsSource,
    /target_payment_id/,
  );
  assert.match(
    dashboardSource,
    /toast\.error\(message,\s*\{\s*id:\s*"payment-method-edit-error"\s*\}\)/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /PAYMENT_METHOD_EDIT_REQUIRES_SINGLE_COMPLETED_PAYMENT[\s\S]*?paymentMethodEditRequiresSingleCompletedPayment/,
    'the renderer should no longer present the old hard block for split payments',
  );
  assert.doesNotMatch(
    dashboardSource,
    /toast\.error\(extractOrderDashboardErrorMessage\(error\)/,
  );
});

test('missing-payment repair reports one truthful payment outcome and treats refresh as best-effort', () => {
  const handlerStart = dashboardSource.indexOf('const handleMissingPaymentRepair');
  const handlerEnd = dashboardSource.indexOf('// Used when the operator changes order type', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'missing-payment repair handler must exist');
  const handler = dashboardSource.slice(handlerStart, handlerEnd);

  assert.match(handler, /recordPayment:\s*\(\) => repairMissingPayment\(bridge\.payments/);
  assert.match(handler, /reconcileOutstandingPaymentAttempt\(\{/);
  assert.match(handler, /settlement\.kind === ["']settled["']/);
  assert.match(handler, /settlement\.kind === ["']partial["']/);
  assert.match(handler, /settlement\.kind === ["']unpaid["']/);
  assert.doesNotMatch(handler, /toast\.error\([^)]*error/i, 'raw backend errors must not be rendered');
  assert.match(handler, /amount:\s*selection\.amount/);
  assert.match(handler, /cashReceived:\s*selection\.cashReceived/);
  assert.match(handler, /changeGiven:\s*selection\.change/);
  assert.match(handler, /transactionRef:\s*selection\.transactionId/);
  assert.match(handler, /idempotencyKey:\s*selection\.transactionId/);
  assert.doesNotMatch(handler, /idempotencyKey:\s*target\.orderId/);
  assert.match(handler, /snapshotOnly:\s*selection\.reconciliationOnly/);
  assert.match(
    handler,
    /paymentAttempt\.kind === ["']unknown["'][\s\S]*?return ["']reconciliation-pending["']/,
  );
  assert.match(
    handler,
    /paymentAttempt\.kind === ["']unknown["'][\s\S]*?if \(!selection\.reconciliationOnly\) \{[\s\S]*?toast\.error/,
  );
  assert.match(handler, /await loadOrders\(\)\.catch\(/);
  assert.doesNotMatch(handler, /toast\.success\(/, 'PaymentModal owns the single success toast');
  assert.match(handler, /return true/);
});

test('per-payment edit instructions exist in every POS locale', () => {
  const languages = ['en', 'el', 'de', 'fr', 'it'];
  const values = languages.map((language) => {
    const locale = JSON.parse(
      readFileSync(path.join(projectRoot, 'src', 'locales', `${language}.json`), 'utf8'),
    );
    const value = locale?.modals?.editPaymentMethod?.selectPayment;
    assert.equal(typeof value, 'string', `${language} must define the per-payment edit instruction`);
    assert.ok(value.trim().length > 0, `${language} per-payment edit instruction must not be empty`);
    return value;
  });

  assert.notEqual(values[1], values[0], 'Greek instructions must not fall back to English');
});
