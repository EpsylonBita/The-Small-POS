import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Explicit .ts so this leaf-util import resolves under both the esbuild parity suite and a
// focused standalone `node --test` run (Node ESM does not auto-resolve extensionless paths).
import { resolveOrderCompletionOutcome } from '../../src/renderer/utils/orderCompletionOutcome.ts';

// Regression contract for the checkout failure path (2026-06-10 review):
// handleOrderComplete used to be typed `any → Promise<void>` and resolved
// undefined on every path, while MenuModal/PaymentModal treat anything other
// than literal `false` as success. A failed create therefore cleared the cart,
// closed the modal, and fired the payment success toast next to the failure
// toast — losing the whole keyed-in order.

const rendererSource = (...segments: string[]): string =>
  readFileSync(path.join(process.cwd(), 'src', 'renderer', ...segments), 'utf8');

const sliceBetween = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found after start: ${endMarker}`);
  return source.slice(start, end);
};

test('a successful completion finalizes the order UI, with or without a returned orderId', () => {
  assert.deepEqual(
    resolveOrderCompletionOutcome({ succeeded: true, orderPersisted: true }),
    { completionResult: true, resetOrderUiState: true },
  );
  // createOrder can report success without echoing an orderId (offline
  // saveForRetry); the cart must still clear so the queued order is not re-keyed.
  assert.deepEqual(
    resolveOrderCompletionOutcome({ succeeded: true, orderPersisted: false }),
    { completionResult: true, resetOrderUiState: true },
  );
});

test('a failed, unpersisted create keeps the cart: failure result, no UI reset', () => {
  // Covers createOrder returning success:false — the 15s ORDER_CREATE_TIMEOUT
  // and the offline saveForRetry fallback also failing both land here — and
  // pre-create validation failures such as a missing delivery address.
  assert.deepEqual(
    resolveOrderCompletionOutcome({ succeeded: false, orderPersisted: false }),
    { completionResult: false, resetOrderUiState: false },
  );
});

test('a failure after the order persisted still finalizes (duplicate protection)', () => {
  // e.g. the table-session follow-up threw after createOrder succeeded. The
  // order exists, so retrying from a stale cart would create it twice — the
  // cart must clear exactly as on success, even though an error was toasted.
  assert.deepEqual(
    resolveOrderCompletionOutcome({ succeeded: false, orderPersisted: true }),
    { completionResult: true, resetOrderUiState: true },
  );
});

// Item E (30/09/2026): a card charged at checkout whose order the till could
// not save is held for "Save payment again". The checkout must end (a retry
// from the same cart is a new checkout and a second charge), never as a
// success, and every surface tells the cashier "charged, not saved".
test('a card charged at checkout and not saved ends the checkout, never as a success', () => {
  assert.deepEqual(
    resolveOrderCompletionOutcome({
      succeeded: false,
      orderPersisted: false,
      chargedNotSaved: true,
    }),
    { completionResult: false, resetOrderUiState: true },
  );

  const dashboard = sliceBetween(
    rendererSource('components', 'OrderDashboard.tsx'),
    'const handleOrderComplete = async (',
    'const resetEditOrderState',
  );
  assert.match(
    dashboard,
    /else if \(result\.paymentNotSaved\) \{[\s\S]*?notifyPaymentNotSaved\(result, t\);[\s\S]*?announceUnsavedCheckoutChanged\(\);[\s\S]*?return finishOrderCompletion\(false, true\);/,
  );

  const flow = sliceBetween(
    rendererSource('components', 'OrderFlow.tsx'),
    'const handleOrderComplete = useCallback(',
    '\n  return (',
  );
  assert.match(
    flow,
    /else if \(result\.paymentNotSaved\) \{[\s\S]*?notifyPaymentNotSaved\(result, t\);[\s\S]*?announceUnsavedCheckoutChanged\(\);[\s\S]*?chargedNotSaved: true/,
  );

  const page = rendererSource('pages', 'NewOrderPage.tsx');
  assert.match(
    page,
    /if \(!result\.success && result\.paymentNotSaved\) \{[\s\S]*?notifyPaymentNotSaved\(result, t\);[\s\S]*?announceUnsavedCheckoutChanged\(\);[\s\S]*?setShowMenuModal\(false\);[\s\S]*?return false;/,
  );
});

// Item H (30/09/2026, the same decision as Android): a read error of the
// store's tax rate is not "missing". Checkout pauses with a message and "Try
// again"; nothing is priced or its tax split on an assumed 24%. The canonical
// editor delegates tax to the server and applies its complete financial snapshot.
test('new checkout requires readable tax settings and canonical edits preserve server fiscal totals', () => {
  for (const segments of [
    ['components', 'OrderFlow.tsx'],
    ['pages', 'NewOrderPage.tsx'],
  ]) {
    const source = rendererSource(...segments);
    assert.doesNotMatch(source, /setTaxRatePercentage\(24\)/, segments.join('/'));
    assert.doesNotMatch(source, /'tax_rate_percentage', 24\)/, segments.join('/'));
    assert.match(
      source,
      /resolveCheckoutTaxRate\(\{ loaded: terminalSettingsLoaded, getSetting \}\)/,
      segments.join('/'),
    );
    const handler = sliceBetween(
      source,
      'const handleOrderComplete = useCallback(',
      'setIsProcessingOrder(true);',
    );
    assert.match(
      handler,
      /if \(taxRatePercentage === null\) \{\s*notifyMoneySettingsUnavailable\(t, reloadTerminalSettings\);\s*return false;\s*\}/,
      segments.join('/'),
    );
  }

  const dashboard = rendererSource('components', 'OrderDashboard.tsx');
  assert.doesNotMatch(dashboard, /'tax_rate_percentage', 24\)/);
  const edit = sliceBetween(
    dashboard,
    'const handleEditMenuComplete = async',
    'const handleEditMenuClose',
  );
  assert.doesNotMatch(edit, /resolveCheckoutTaxRate|tax_amount\s*:|tax_rate\s*:/,
    'the canonical editor must not calculate or send an assumed client tax');
  assert.match(edit, /await previewMenuOrderEdit\(bridge\.orders, data, bridge\.sync\)/);
  assert.match(edit, /if \(preflight\.kind !== 'settlement'\)[\s\S]*?await bridge\.orders\.updateItems\(data\.orderId, data\.items,/);
  assert.match(edit, /clientEventId: data\.client_event_id, expectedVersion: data\.expected_version/);
  assert.match(edit, /expectedLocalVersion: data\.renderer_local_version/);
  assert.match(edit, /await commitMenuOrderEdit\(bridge\.orders, data,/,
    'paid corrections use the journaled settlement path, including exact recovery');
  assert.match(edit, /if \(result\?\.success === false\) throw new Error/,
    'unconfirmed canonical edits must retain the frozen draft');

  const editService = rendererSource('services', 'MenuOrderEdit.ts');
  assert.match(editService, /if \(!scoped\.quotedFinancials\?\.quote[\s\S]*?throw new Error\('EDIT_CANONICAL_QUOTE_REQUIRED'\)/,
    'paid corrections require the complete authoritative quote before confirmation');
  assert.match(editService, /financials: scoped\.quotedFinancials/);
  const commit = editService.slice(editService.indexOf('export async function commitMenuOrderEdit('));
  assert.match(commit, /await lifecycle\.beforeCommit\([\s\S]*?await orders\.applyEditSettlement\(request\)/,
    'the exact quoted action is frozen before financial dispatch');
  assert.match(commit, /if \(response\?\.success !== true\)[\s\S]*?throw new Error/,
    'a fulfilled IPC without committed success cannot clear the correction');

  const api = readFileSync(path.join(process.cwd(), '..', 'admin-dashboard', 'src', 'services', 'pos', 'pos-orders-api-service.ts'), 'utf8');
  assert.match(api, /const branchComplianceSettings = await this\.getBranchComplianceSettings\(terminal\.branch_id\)\s+const computed = this\.computeOrderTotals\(/);
  for (const [field, result] of [
    ['subtotal', 'computedSubtotal'], ['tax_amount', 'taxAmount'],
    ['discount_amount', 'discountAmount'], ['total_amount', 'computedTotal'],
    ['fiscal_totals', 'fiscalTotals'], ['fiscal_line_snapshot', 'fiscalLineSnapshot'],
  ]) {
    assert.ok(api.includes(`updateData.${field} = computed.${result}`), `${field} is server-calculated`);
  }
  assert.match(api, /rpc\('edit_pos_order_atomic',[\s\S]*?p_header: \{ \.\.\.encryptedUpdateData,[\s\S]*?_pos_edit_settlement: data\.settlement_context[\s\S]*?p_items: replacementItems/,
    'the atomic edit keeps encrypted server-computed fiscal fields together with its exact settlement and items');

  const native = readFileSync(path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'orders.rs'), 'utf8');
  const remoteEdit = sliceBetween(native, 'if let Some(request) = remote_edit_request {', '\n    let actual_order_id = {');
  assert.match(remoteEdit, /confirm_foreground_item\([\s\S]*?\.await\?;[\s\S]*?return Ok\(/,
    'success requires the full canonical financial mirror, rather than a local total-only update');
  const recovery = readFileSync(path.join(process.cwd(), 'src-tauri', 'src', 'table_attempt_recovery.rs'), 'utf8');
  const apply = sliceBetween(recovery, 'fn apply_foreground_item_snapshot(', 'pub(crate) async fn confirm_foreground_item(');
  assert.match(apply, /apply_lan_canonical_response\(&tx,[\s\S]*?foreground_applied\(&tx,[\s\S]*?tx\.commit\(\)/,
    'the full snapshot and the applied receipt must commit together');
});

test('OrderDashboard.handleOrderComplete resolves an explicit boolean and success-gates the UI reset', () => {
  const source = rendererSource('components', 'OrderDashboard.tsx');
  const handler = sliceBetween(
    source,
    'const handleOrderComplete = async (',
    'const resetEditOrderState',
  );

  assert.match(
    handler,
    /^const handleOrderComplete = async \(\s*orderData: any,?\s*\): Promise<boolean> =>/,
    'handleOrderComplete must be explicitly typed to return Promise<boolean>',
  );

  // The modal-close/state-clear must route through the outcome helper instead
  // of running unconditionally in a finally block.
  assert.match(handler, /resolveOrderCompletionOutcome\(/);
  assert.match(handler, /if \(outcome\.resetOrderUiState\)/);
  assert.match(handler, /orderPersisted = true;/);
  assert.doesNotMatch(
    handler,
    /finally\s*\{[\s\S]{0,600}?setShowMenuModal\(false\)/,
    'closing MenuModal in a finally block loses the keyed-in cart on failure',
  );

  // A bare `return;` resolves to undefined, which MenuModal reads as success.
  // Only the fire-and-forget print-error callback may stay void.
  const bareReturns = handler.match(/return;/g) ?? [];
  assert.ok(
    bareReturns.length <= 1,
    `every handler path must resolve an explicit boolean; found ${bareReturns.length} bare \`return;\` statements`,
  );

  assert.match(handler, /return finishOrderCompletion\(true\);/);
  assert.match(handler, /return finishOrderCompletion\(false\);/);
});

test('OrderDashboard queues table-session open after any saved table-order session failure', () => {
  const source = rendererSource('components', 'OrderDashboard.tsx');
  const tableSessionFallback = sliceBetween(
    source,
    '[OrderDashboard] Table session open failed, falling back to table status assignment:',
    'await updateTableStatus(selectedTable.id, "occupied", {',
  );

  assert.match(tableSessionFallback, /await enqueueTableSessionOpen\(/);
  assert.doesNotMatch(
    tableSessionFallback,
    /if \(isRetryableTableServiceError\(sessionError\)\) \{/,
    'after the order is already saved locally, table-session open should be queued for retry instead of dropping unclassified API errors',
  );
});

test('OrderFlow.handleOrderComplete resolves an explicit boolean on every checkout path', () => {
  const source = rendererSource('components', 'OrderFlow.tsx');
  const handler = sliceBetween(
    source,
    'const handleOrderComplete = useCallback(',
    '\n  return (',
  );

  assert.match(
    handler,
    /^const handleOrderComplete = useCallback\(\s*async \(orderData: any\): Promise<boolean> =>/,
    'handleOrderComplete must be explicitly typed to return Promise<boolean>',
  );

  assert.match(handler, /resolveOrderCompletionOutcome\(/);
  assert.match(handler, /orderPersisted = true;/);
  // Success paths must report success explicitly.
  assert.match(handler, /resetFlow\(\);\s*return true;/);

  // Only the fire-and-forget print-error callback may stay void.
  const bareReturns = handler.match(/return;/g) ?? [];
  assert.ok(
    bareReturns.length <= 1,
    `every handler path must resolve an explicit boolean; found ${bareReturns.length} bare \`return;\` statements`,
  );
});

test('MenuModal keeps the cart and reports failure when onOrderComplete resolves false', () => {
  const source = rendererSource('components', 'modals', 'MenuModal.tsx');

  // Tightened prop contract: suppliers must hand back a boolean, so a future
  // void-returning handler fails the type-check instead of faking success.
  assert.match(
    source,
    /\}\) => Promise<boolean> \| boolean;/,
    'onOrderComplete must require a boolean result',
  );

  const paymentHandler = sliceBetween(
    source,
    'const handlePaymentComplete = async',
    'const handleSplitPayment',
  );
  assert.match(
    paymentHandler,
    /if \(completionResult === false\) \{\s*setIsLocalProcessing\(false\);\s*setCheckoutPhase\('payment'\);\s*return false;\s*\}/,
    'a false completion must abort before the cart-clearing success path',
  );
  const guardIndex = paymentHandler.indexOf('if (completionResult === false)');
  const clearCartIndex = paymentHandler.indexOf('setCartItems([])');
  assert.ok(guardIndex !== -1 && clearCartIndex !== -1 && guardIndex < clearCartIndex,
    'the false-guard must run before setCartItems([]) clears the keyed-in order');

  // The split flow must also abort instead of treating undefined as success.
  assert.match(
    source,
    /if \(completionResult === false\) \{\s*setCheckoutPhase\('payment'\);\s*return;\s*\}/,
  );
});

test('PaymentModal fires the success toast only after a non-false completion result', () => {
  const source = rendererSource('components', 'modals', 'PaymentModal.tsx');
  const handler = sliceBetween(
    source,
    'const handleSimplePayment = async',
    'const handleCashPaymentComplete',
  );

  assert.match(
    handler,
    /if \(completionResult === false\) \{\s*return;\s*\}/,
    'PaymentModal must abort on a false completion result',
  );
  const guardIndex = handler.indexOf('if (completionResult === false)');
  const successToastIndex = handler.indexOf('toast.success');
  assert.ok(guardIndex !== -1 && successToastIndex !== -1 && guardIndex < successToastIndex,
    'the false-guard must run before the payment success toast');
  assert.doesNotMatch(
    handler.slice(successToastIndex),
    /\bonClose\(\)/,
    'the owning checkout flow already tears down a successful checkout; a second stale close can reopen MenuModal and trigger its dirty-cart guard',
  );
});

test('ProductCatalogModal keeps the cart and reports failure when onOrderComplete resolves false', () => {
  const source = rendererSource('components', 'modals', 'ProductCatalogModal.tsx');

  // Tightened prop contract: suppliers must hand back a boolean, so a future
  // void-returning handler fails the type-check instead of faking success.
  assert.match(
    source,
    /\}\) => Promise<boolean> \| boolean;/,
    'onOrderComplete must require a boolean result',
  );

  const paymentHandler = sliceBetween(
    source,
    'const handlePaymentComplete = async',
    'if (!isOpen) return null;',
  );
  assert.match(
    paymentHandler,
    /const completionResult = await onOrderComplete\?\.\(/,
    'handlePaymentComplete must await the completion result instead of firing and forgetting',
  );
  assert.match(
    paymentHandler,
    /if \(completionResult === false\) \{\s*return false;\s*\}/,
    'a false completion must abort and propagate failure to PaymentModal',
  );
  const guardIndex = paymentHandler.indexOf('if (completionResult === false)');
  const clearCartIndex = paymentHandler.indexOf('setCartItems([])');
  assert.ok(guardIndex !== -1 && clearCartIndex !== -1 && guardIndex < clearCartIndex,
    'the false-guard must run before setCartItems([]) clears the keyed-in retail order');

  // The retail quick-catalog flow wires OrderFlow.handleOrderComplete — which
  // resolves false on a failed create — into this prop.
  assert.match(
    rendererSource('components', 'OrderFlow.tsx'),
    /<ProductCatalogModal[\s\S]{0,500}?onOrderComplete=\{handleOrderComplete\}/,
    'OrderFlow must wire its boolean-resolving handleOrderComplete into ProductCatalogModal',
  );
});

// Regression contract for the unpaid-completion blocker (2026-06-21 review):
// `no_persisted_payment` zero-payment blockers fell through to a raw English
// payload toast (leaking the internal ORD-* id), and the caller emitted a second
// duplicate toast. They must instead route to the localized by-amount repair UI.
test('OrderDashboard routes no_persisted_payment to the by-amount repair UI, not a raw payload toast', () => {
  const source = rendererSource('components', 'OrderDashboard.tsx');
  const handler = sliceBetween(
    source,
    'const handlePaymentIntegrityBlocker = useCallback(',
    'const retryBlockedStatusTransition = useCallback(',
  );

  // no_persisted_payment is handled with the split/by-amount repair (staff choose
  // cash/card per portion), alongside split_payment_incomplete.
  assert.match(
    handler,
    /blocker\.reasonCode === "split_payment_incomplete" \|\|\s*blocker\.reasonCode === "no_persisted_payment" \|\|\s*blocker\.paymentMethod === "split"/,
  );
  assert.match(handler, /setSplitPaymentData\(\s*buildStatusBlockerSplitPaymentData\(order, targetStatus, blocker\),?\s*\)/);

  // The raw backend payload (English + ORD-* id) is never toasted; the handler
  // falls back to a localized message instead.
  assert.doesNotMatch(handler, /payload\.error \|\|\s*payload\.message/);
  assert.match(handler, /t\("orderDashboard\.collectPaymentFailed"/);

  // The single-payment repair shows the visible compact order label, not ORD-*.
  assert.match(
    handler,
    /orderNumber: formatCompactOrderNumberForDisplay\(getVisibleOrderNumber\(order\)\)/,
  );
});

test('OrderDashboard never emits a second toast when a payment-integrity blocker is handled', () => {
  const source = rendererSource('components', 'OrderDashboard.tsx');

  // The status-completion callers must return right after delegating to the blocker
  // handler (which owns the messaging), instead of `&&`-ing on its return value and
  // then falling through to a second toast.error.
  const handledReturns =
    source.match(
      /if \(result\.paymentIntegrityPayload\) \{\s*handlePaymentIntegrityBlocker\([\s\S]*?\);\s*return;\s*\}/g,
    ) ?? [];
  assert.ok(
    handledReturns.length >= 2,
    `both bulk status paths must return after handling the blocker; found ${handledReturns.length}`,
  );

  // The old fall-through shape (`payload && handler() ` guarding the early return)
  // that produced the duplicate raw toast is gone.
  assert.doesNotMatch(
    source,
    /result\.paymentIntegrityPayload &&\s*handlePaymentIntegrityBlocker\(/,
  );

  // collectPaymentFailed is a real localized key in every POS locale.
  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
    const value = JSON.parse(
      readFileSync(path.join(process.cwd(), 'src', 'locales', `${lng}.json`), 'utf8'),
    ).orderDashboard.collectPaymentFailed;
    assert.equal(typeof value, 'string', `${lng} missing orderDashboard.collectPaymentFailed`);
    assert.ok(value.length > 0, `${lng} empty orderDashboard.collectPaymentFailed`);
  }
  const en = JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', 'en.json'), 'utf8'));
  const el = JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', 'el.json'), 'utf8'));
  assert.notEqual(
    el.orderDashboard.collectPaymentFailed,
    en.orderDashboard.collectPaymentFailed,
    'Greek collectPaymentFailed must be a real translation',
  );
});

// Fix review 30/09/2026 (double charge on a slow card terminal): every press of
// Pay for the same cart carries the same checkout id (the till deduplicates the
// order and the card approval by it and refuses a second press while the first
// still waits), the id is dropped only when the order exists or the checkout
// ends, and a checkout without an answer keeps the cart instead of failing.
test('every checkout surface pays the same cart with the same checkout id', () => {
  const surfaces: Array<[string, string]> = [
    ['components/OrderFlow.tsx', 'const clientRequestId = takeCheckoutRequestId(orderData.clientRequestId);'],
    ['pages/NewOrderPage.tsx', 'const clientRequestId = takeCheckoutRequestId(orderData.clientRequestId);'],
    ['components/OrderDashboard.tsx', 'clientRequestId: takeCheckoutRequestId(orderData.clientRequestId),'],
  ];
  for (const [file, take] of surfaces) {
    const source = rendererSource(...file.split('/'));
    assert.ok(source.includes('useCheckoutRequestId()'), `${file} holds one checkout id per cart`);
    assert.ok(source.includes(take), `${file} reuses the checkout id on every press`);
    assert.match(source,
      /restoreCheckoutRequestId\(context\.checkoutRequestId, \{ phase: context\.checkoutPhase,[^}]*renewedFrom: renewal\?\.previousCheckoutRequestId \}\)/,
      `${file} restores the original id with its durable phase and live-only renewal proof`);
    if (!file.startsWith('pages/')) {
      assert.match(source, /restoreCheckoutRequestId\(context\.checkoutRequestId, \{[^}]*editMode: context\.editMode/,
        `${file} keeps an existing-order edit separate from the next create identity`);
    }
    assert.doesNotMatch(
      source,
      /const clientRequestId =\s*globalThis\.crypto\?\.randomUUID/,
      `${file} must not draw a new checkout id per press`,
    );
    assert.match(
      source,
      /isCheckoutOutcomeUnknown\(result\)\)?\s*\{[\s\S]{0,300}?notifyCheckoutOutcomeUnknown\(result, t\);/,
      `${file} keeps the cart when the payment has no answer yet`,
    );
    assert.ok(
      source.includes('resetCheckoutRequestId();'),
      `${file} starts a new checkout id once the order exists`,
    );
  }

  const requestId = rendererSource('hooks', 'useCheckoutRequestId.ts');
  assert.match(requestId, /if \(idRef\.current && idRef\.current !== persistedId\) throw new Error\('CHECKOUT_REQUEST_ID_CHANGED'\)/,
    'restored intent must not replace the active cart identity');
  assert.match(requestId, /idRef\.current = persistedId;/,
    'a restored checkout reuses its durable original id');

  const store = rendererSource('hooks', 'useOrderStore.ts');
  assert.match(store, /const CHECKOUT_WITH_PAYMENT_TIMEOUT_MS = 180_000;/);
  assert.match(
    store,
    /carriesPayment \? CHECKOUT_WITH_PAYMENT_TIMEOUT_MS : TIMING\.ORDER_CREATE_TIMEOUT/,
  );

  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
    const payment = JSON.parse(
      readFileSync(path.join(process.cwd(), 'src', 'locales', `${lng}.json`), 'utf8'),
    ).payment;
    assert.equal(typeof payment.checkoutOutcomeUnknown, 'string', `${lng} checkoutOutcomeUnknown`);
    assert.equal(typeof payment.checkoutInProgress, 'string', `${lng} checkoutInProgress`);
  }
});
