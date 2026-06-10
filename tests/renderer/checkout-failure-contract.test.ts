import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveOrderCompletionOutcome } from '../../src/renderer/utils/orderCompletionOutcome';

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
    /if \(completionResult === false\) \{\s*setIsLocalProcessing\(false\);\s*return false;\s*\}/,
    'a false completion must abort before the cart-clearing success path',
  );
  const guardIndex = paymentHandler.indexOf('if (completionResult === false)');
  const clearCartIndex = paymentHandler.indexOf('setCartItems([])');
  assert.ok(guardIndex !== -1 && clearCartIndex !== -1 && guardIndex < clearCartIndex,
    'the false-guard must run before setCartItems([]) clears the keyed-in order');

  // The split flow must also abort instead of treating undefined as success.
  assert.match(source, /if \(completionResult === false\) \{\s*return;\s*\}/);
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
