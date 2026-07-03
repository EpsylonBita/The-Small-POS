import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression contracts for the retail checkout money/order-item seam
// (THE-324 review, 2026-07-02):
// 1. ProductCatalogModal used to pass a fee-INCLUSIVE total to onOrderComplete
//    while OrderFlow.handleOrderComplete adds deliveryFee again — retail
//    delivery orders persisted total_amount one fee too high and extracted VAT
//    from the wrong base. The prop contract is MenuModal's: `total` is the
//    fee-exclusive discounted subtotal.
// 2. Catalog-offer reward lines carried their synthetic 'offer-reward-*' id
//    into menu_item_id, failing hasValidSyncedPosMenuItemId's UUID gate and
//    blocking the ENTIRE checkout whenever a free-item offer fired.
// 3. The offers/validate payload inflated fractional (measured-goods)
//    quantities with Math.max(1, …) — the server's int() schema 400'd the
//    whole evaluation and sub-1 lines discounted from the wrong base.
// 4. Scale-scanned lines reused product.id as the cart line id, so plain adds
//    merged into price-overridden lines and duplicate scans shared React
//    keys. Cart identity now lives in a dedicated lineId.

const rendererSource = (...segments: string[]): string =>
  readFileSync(path.join(process.cwd(), 'src', 'renderer', ...segments), 'utf8');

const sliceBetween = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found after start: ${endMarker}`);
  return source.slice(start, end);
};

test('ProductCatalogModal hands OrderFlow the fee-exclusive discounted subtotal', () => {
  const source = rendererSource('components', 'modals', 'ProductCatalogModal.tsx');
  const paymentHandler = sliceBetween(
    source,
    'const handlePaymentComplete = async',
    'if (!isOpen) return null;',
  );

  // The payload total must be the DELIVERY-fee-exclusive discounted subtotal
  // (OrderFlow re-adds orderData.deliveryFee itself). Deposits are a
  // post-discount pass-through and DO ride in this total.
  assert.match(
    paymentHandler,
    /total: subtotalAfterDiscount \+ depositTotal,/,
    'onOrderComplete payload must pass the delivery-fee-exclusive subtotal (+ deposits) as total',
  );
  assert.doesNotMatch(
    paymentHandler,
    /^\s*total: subtotalAfterDiscount \+ deliveryFee/m,
    'the payload total must not include the delivery fee (OrderFlow adds it once)',
  );

  // The fee still travels separately so OrderFlow can add it exactly once.
  assert.match(paymentHandler, /deliveryFee,/);
});

test('OrderFlow adds the delivery fee to the payload total exactly once', () => {
  const source = rendererSource('components', 'OrderFlow.tsx');
  const handler = sliceBetween(
    source,
    'const handleOrderComplete = useCallback(',
    '\n  return (',
  );

  // The other side of the contract: orderData.total is treated as the
  // fee-exclusive discounted subtotal and the fee is added here.
  assert.match(handler, /const subtotalAfterDiscount = orderData\.total;/);
  assert.match(handler, /const total_amount = subtotalAfterDiscount \+ deliveryFee;/);
});

test('MenuModal and ProductCatalogModal share the same fee-exclusive total contract', () => {
  const menuSource = rendererSource('components', 'modals', 'MenuModal.tsx');
  assert.match(
    menuSource,
    /total: discountedSubtotal,/,
    'MenuModal is the reference implementation for the onOrderComplete total contract',
  );
});

test('returnable-container deposits ride as itemised manual lines, post-discount', () => {
  const source = rendererSource('components', 'modals', 'ProductCatalogModal.tsx');

  // Deposits are summed from cart lines, excluding reward lines.
  assert.match(
    source,
    /const depositTotal = cartItems\.reduce\(/,
    'deposit total must be derived from cart lines',
  );

  const paymentHandler = sliceBetween(
    source,
    'const handlePaymentComplete = async',
    'if (!isOpen) return null;',
  );

  // Deposit lines are manual (is_manual + null menu_item_id) so they pass the
  // synced-item gate and the server sanitizer, and are appended to the items.
  assert.match(paymentHandler, /const depositLines = cartItems/);
  assert.match(paymentHandler, /is_manual: true/);
  assert.match(paymentHandler, /menu_item_id: null/);
  assert.match(paymentHandler, /items: \[\.\.\.productLines, \.\.\.depositLines\]/);

  // Deposits are added to the fee-exclusive total post-discount (a pass-through
  // charge, never discounted), so the customer is charged for them.
  assert.match(paymentHandler, /total: subtotalAfterDiscount \+ depositTotal,/);
});

test('offer-reward cart lines reach checkout under the granted product UUID', () => {
  const source = rendererSource('components', 'modals', 'ProductCatalogModal.tsx');

  // Reward lines are created with a synthetic non-UUID id...
  assert.match(source, /id: `offer-reward-\$\{signature\}`/);

  // ...so the checkout mapper must swap in the granted product's real UUID
  // (reward_item_id) before it lands in menu_item_id, or the UUID gate in
  // hasValidSyncedPosMenuItemId rejects the whole order.
  const paymentHandler = sliceBetween(
    source,
    'const handlePaymentComplete = async',
    'if (!isOpen) return null;',
  );
  assert.match(
    paymentHandler,
    /item\.is_offer_reward && item\.reward_item_id \? item\.reward_item_id : item\.id/,
    'reward lines must resolve to reward_item_id before menu_item_id assignment',
  );
  assert.match(paymentHandler, /menu_item_id: itemId,/);
  assert.match(paymentHandler, /product_id: itemId,/);
  assert.doesNotMatch(
    paymentHandler,
    /menu_item_id: item\.id,/,
    'mapping menu_item_id straight from item.id sends offer-reward-* ids into the UUID gate',
  );

  // The UUID gate this protects against: non-UUID, non-manual ids reject the order.
  const gateSource = readFileSync(
    path.join(process.cwd(), 'src', 'shared', 'utils', 'pos-order-items.ts'),
    'utf8',
  );
  assert.match(gateSource, /POS_ORDER_ITEM_UUID_REGEX\.test\(candidate\)/);
});

test('fractional-quantity (measured) lines are excluded from the catalog-offer payload', () => {
  const source = rendererSource('components', 'modals', 'ProductCatalogModal.tsx');
  const builder = sliceBetween(
    source,
    'const offerValidationItems = useMemo',
    'const offerValidationSignature',
  );

  // The server schema (admin-dashboard pos/offers/_shared.ts) requires
  // z.number().int().min(1): a single fractional line 400s the WHOLE
  // evaluation (the catch clears every offer), and rounding a sub-1 quantity
  // up computes the discount from the wrong base. Measured lines must be
  // dropped from the payload, not coerced into it.
  assert.match(
    builder,
    /Number\.isInteger\(quantity\)/,
    'fractional quantities must be filtered out of the offer-evaluation payload',
  );
  assert.match(builder, /quantity < 1/);
  assert.doesNotMatch(
    builder,
    /Math\.max\(1,/,
    'quantities must not be inflated to satisfy the int schema',
  );
});

test('cart lines carry a dedicated lineId while the order payload keeps the product UUID', () => {
  const source = rendererSource('components', 'modals', 'ProductCatalogModal.tsx');

  // Cart-side identity: merge lookup, quantity edits, removal, and React keys
  // all run on the per-line lineId, so two scale scans of one product stay
  // distinct lines and a plain add never merges into a scanned or
  // price-overridden line.
  assert.match(source, /lineId: string;/, 'CartItem must declare a dedicated lineId');
  assert.match(source, /key=\{item\.lineId\}/, 'cart rows must key on lineId, not product.id');
  assert.match(source, /removeFromCart\(item\.lineId\)/);
  assert.match(source, /updateCartQuantity\(item\.lineId, -1\)/);
  assert.match(source, /updateCartQuantity\(item\.lineId, 1\)/);
  assert.match(
    source,
    /item\.scaleScanned !== true/,
    'plain adds must never merge into a scale-scanned line',
  );
  assert.match(
    source,
    /item\.originalUnitPrice === undefined/,
    'plain adds must never merge into a price-overridden line',
  );

  // Order-side identity: the checkout mapper still resolves ids from item.id
  // (or reward_item_id) — real product UUIDs — and lineId never leaks into
  // the payload handed to onOrderComplete.
  const paymentHandler = sliceBetween(
    source,
    'const handlePaymentComplete = async',
    'if (!isOpen) return null;',
  );
  assert.match(
    paymentHandler,
    /item\.is_offer_reward && item\.reward_item_id \? item\.reward_item_id : item\.id/,
    'order-item ids must come from the product UUID fields, untouched by lineId',
  );
  assert.doesNotMatch(
    paymentHandler,
    /\.lineId/,
    'the order payload must not reference the cart-local lineId',
  );
});
