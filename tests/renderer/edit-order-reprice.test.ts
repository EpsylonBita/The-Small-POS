import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveIngredientTierPrice,
  sumCustomizationUnitPrice,
  resolveCartLineUnitPrice,
  reconcileHydratedUnitPrice,
} from '../../src/renderer/utils/edit-order-pricing.ts';
import { calculatePickupToDeliveryTotal } from '../../src/renderer/utils/pickup-to-delivery.ts';

const menuModalSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx'),
  'utf8',
);
const pickupToDeliverySource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'utils', 'pickup-to-delivery.ts'),
  'utf8',
);
const orderDashboardSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
  'utf8',
);

// --- Root cause (live report 2026-07-14): opening an existing order in the Edit Order
// modal flattened every customized line to the bare subcategory tier price. The
// edit-mode "reprice on order-type change" effect fired on EVERY edit open (the ref
// guard only prevented loops, never checked whether the type actually changed) and
// overwrote unitPrice with resolveMenuItemPrice() — which has no ingredient component.
// Fix: seed repricedForOrderTypeRef with the order's stored type at hydration, and
// when a genuine type change does fire the effect, reprice as tier base + sum of
// ingredient tier prices via resolveCartLineUnitPrice. ---

test('resolveIngredientTierPrice mirrors handleAddToCart tier fallbacks', () => {
  const ingredient = { price: 0.5, pickup_price: 0.5, delivery_price: 0.6, dine_in_price: 0.55 };
  assert.equal(resolveIngredientTierPrice(ingredient, 'pickup'), 0.5);
  assert.equal(resolveIngredientTierPrice(ingredient, 'delivery'), 0.6);
  assert.equal(resolveIngredientTierPrice(ingredient, 'dine-in'), 0.55);

  // dine-in falls back through pickup before base price.
  assert.equal(resolveIngredientTierPrice({ price: 1, pickup_price: 0.8 }, 'dine-in'), 0.8);
  assert.equal(resolveIngredientTierPrice({ price: 1 }, 'dine-in'), 1);
  // Missing tier falls back to base; missing everything is 0, never NaN.
  assert.equal(resolveIngredientTierPrice({ price: 0.7 }, 'delivery'), 0.7);
  assert.equal(resolveIngredientTierPrice({}, 'pickup'), 0);
  assert.equal(resolveIngredientTierPrice(null, 'pickup'), 0);
  // A genuine 0 tier price is respected (free ingredient), not skipped.
  assert.equal(resolveIngredientTierPrice({ price: 0.9, delivery_price: 0 }, 'delivery'), 0);
});

test('sumCustomizationUnitPrice handles the POS SelectedIngredient array shape', () => {
  const customizations = [
    { ingredient: { price: 0.5, delivery_price: 0.6 }, quantity: 2 },
    { ingredient: { price: 0.3 }, quantity: 1 },
    // "without" entries never contribute to price.
    { ingredient: { price: 9.99 }, quantity: 1, isWithout: true },
  ];
  assert.equal(sumCustomizationUnitPrice(customizations, 'pickup'), 0.5 * 2 + 0.3);
  assert.equal(sumCustomizationUnitPrice(customizations, 'delivery'), 0.6 * 2 + 0.3);
});

test('sumCustomizationUnitPrice handles the synced object-map shape (keyed by ingredient id)', () => {
  const customizations = {
    'uuid-1': { ingredient: { price: 0.5 }, quantity: 1 },
    'uuid-2': { ingredient: { price: 0.25 }, quantity: 2 },
  };
  assert.equal(sumCustomizationUnitPrice(customizations, 'pickup'), 0.5 + 0.25 * 2);
});

test('sumCustomizationUnitPrice handles the kiosk {added:[...]} shape with flat prices', () => {
  const customizations = {
    added: [
      { id: 'uuid-1', name: 'Ham', price: 0.5, quantity: 2 },
      { id: 'uuid-2', name: 'Cheese', price: 0.4 },
    ],
    removed: ['uuid-3'],
  };
  assert.equal(sumCustomizationUnitPrice(customizations, 'pickup'), 0.5 * 2 + 0.4);
});

test('sumCustomizationUnitPrice tolerates JSON strings, junk, and empty inputs', () => {
  assert.equal(
    sumCustomizationUnitPrice(JSON.stringify([{ ingredient: { price: 0.5 }, quantity: 1 }]), 'pickup'),
    0.5,
  );
  assert.equal(sumCustomizationUnitPrice(null, 'pickup'), 0);
  assert.equal(sumCustomizationUnitPrice(undefined, 'pickup'), 0);
  assert.equal(sumCustomizationUnitPrice('not json', 'pickup'), 0);
  assert.equal(sumCustomizationUnitPrice([], 'pickup'), 0);
  assert.equal(sumCustomizationUnitPrice(['Extra sauce'], 'pickup'), 0);
});

test('resolveCartLineUnitPrice = tier base + ingredient tier prices (the corrected reprice math)', () => {
  const menuItem = { price: 6.6, pickup_price: 6.6, delivery_price: 7.0, dine_in_price: 6.8 };
  const customizations = [
    { ingredient: { price: 0.5, delivery_price: 0.6 }, quantity: 2 },
    { ingredient: { price: 0.3 }, quantity: 1, isWithout: true },
  ];

  const pickup = resolveCartLineUnitPrice(menuItem, customizations, 'pickup');
  assert.equal(pickup.basePrice, 6.6);
  assert.equal(pickup.unitPrice, 7.6); // 6.6 + 0.5*2

  const delivery = resolveCartLineUnitPrice(menuItem, customizations, 'delivery');
  assert.equal(delivery.basePrice, 7.0);
  assert.equal(delivery.unitPrice, 8.2); // 7.0 + 0.6*2

  // No customizations -> unitPrice equals the bare tier price (uncustomized lines
  // must be untouched by the reprice, exactly as before).
  const plain = resolveCartLineUnitPrice(menuItem, [], 'pickup');
  assert.equal(plain.unitPrice, 6.6);
});

test('reconcileHydratedUnitPrice reconstructs kiosk base-only unit prices from the line total', () => {
  // Kiosk rows store unit_price = base only while total_price includes ingredients:
  // 2 x (6.60 base + 1.00 ingredients) -> unit_price 6.60, total_price 15.20.
  assert.equal(reconcileHydratedUnitPrice(6.6, 15.2, 2), 7.6);
  // POS rows store the combined unit price; unit*qty == total -> unchanged.
  assert.equal(reconcileHydratedUnitPrice(7.6, 15.2, 2), 7.6);
  // Discounted lines (total below unit*qty) are never rewritten upward or downward.
  assert.equal(reconcileHydratedUnitPrice(7.6, 14.0, 2), 7.6);
  // Degenerate inputs never divide by zero or fabricate prices.
  assert.equal(reconcileHydratedUnitPrice(7.6, 0, 2), 7.6);
  assert.equal(reconcileHydratedUnitPrice(7.6, 15.2, 0), 7.6);
  assert.equal(reconcileHydratedUnitPrice(7.6, Number.NaN, 2), 7.6);
  // Sub-cent noise is not "reconstruction".
  assert.equal(reconcileHydratedUnitPrice(7.6, 15.204, 2), 7.6);
});

test('MenuModal edit hydration seeds the reprice ref with the stored order type', () => {
  // The hydration path must capture the order's stored type...
  assert.match(menuModalSource, /editSourceOrderTypeRef/);
  // ...and pre-arm the reprice guard so a plain edit (type unchanged or unknown)
  // never reprices, while a genuine type change still does.
  assert.match(
    menuModalSource,
    /repricedForOrderTypeRef\.current =\s*sourceOrderType && sourceOrderType !== orderType \? null : orderType/,
  );
});

test('MenuModal reprice effect preserves ingredient prices via resolveCartLineUnitPrice', () => {
  assert.match(
    menuModalSource,
    /import \{[^}]*resolveCartLineUnitPrice[^}]*\} from '\.\.\/\.\.\/utils\/edit-order-pricing';/,
  );
  assert.match(menuModalSource, /resolveCartLineUnitPrice\(menuItem, item\.customizations, orderType\)/);
  // The old flattening write (basePrice set to the bare tier unit price wholesale)
  // is gone: basePrice must now come from the resolved base, not newUnitPrice.
  assert.doesNotMatch(menuModalSource, /basePrice: newUnitPrice/);
  // The bare-tier-only comparison is gone from the reprice loop.
  assert.doesNotMatch(
    menuModalSource,
    /const newUnitPrice = resolveMenuItemPrice\(menuItem, orderType\);/,
  );
});

test('MenuModal edit hydration reconciles base-only unit prices from the stored line total', () => {
  assert.match(menuModalSource, /reconcileHydratedUnitPrice\(/);
  // Both hydration branches (initialCartItems and fetched items) go through the
  // reconciled unit price rather than trusting stored unit_price alone.
  const occurrences = menuModalSource.match(/reconcileHydratedUnitPrice\(/g) || [];
  assert.ok(
    occurrences.length >= 2,
    `expected both hydration branches to reconcile unit prices, found ${occurrences.length} call(s)`,
  );
});

test('pickup-to-delivery items total keeps ingredient prices when retiering to delivery', () => {
  assert.match(
    pickupToDeliverySource,
    /import \{[^}]*resolveCartLineUnitPrice[^}]*\} from '\.\/edit-order-pricing';/,
  );
  assert.match(pickupToDeliverySource, /resolveCartLineUnitPrice\(/);
  // Rename-proof: the bare-tier flattening cannot come back under any
  // spelling because the util is no longer imported at all.
  assert.doesNotMatch(pickupToDeliverySource, /resolveMenuItemPrice/);
});

// --- Adversarial-review round: regression tests for the confirmed findings. ---

test('reconcileHydratedUnitPrice never fires on fractional (weighed) quantities', () => {
  // 0.1 kg at 7.97/kg stores cent-rounded total 0.80; 0.80/0.1 = 8.00 must
  // NOT be mistaken for an ingredient contribution.
  assert.equal(reconcileHydratedUnitPrice(7.97, 0.8, 0.1), 7.97);
  assert.equal(reconcileHydratedUnitPrice(9.99, 1.0, 0.1), 9.99);
  assert.equal(reconcileHydratedUnitPrice(12.99, 4.55, 0.35), 12.99);
});

test('MenuModal hydration never fabricates a price override from the normalizer echo of original_unit_price', () => {
  // When the stored original merely echoes the (base-only) unit_price, the
  // reconciled unit price becomes the original too — otherwise every
  // untouched kiosk line would persist is_price_overridden=true on save.
  const occurrences =
    menuModalSource.match(/Math\.abs\(storedOriginalUnitPrice - storedUnitPrice\) > 0\.0001/g) || [];
  assert.ok(
    occurrences.length >= 2,
    `expected both hydration branches to guard originalUnitPrice, found ${occurrences.length}`,
  );
});

test('MenuModal reprice loop never reprices offer-reward lines', () => {
  assert.match(menuModalSource, /if \(isOfferRewardLine\(item\)\) continue;/);
});

test('MenuModal edit hydration honors the caller-supplied source order type (conversion flow)', () => {
  // The pickup->delivery conversion stamps order_type before the modal
  // reopens; only the caller knows the tier the line prices reflect.
  assert.match(
    menuModalSource,
    /const sourceOrderType = editSourceOrderType \?\? editSourceOrderTypeRef\.current;/,
  );
  // OrderDashboard threads the pre-conversion type through the prop.
  assert.match(orderDashboardSource, /editSourceOrderType=\{currentEditSourceOrderType\}/);
  assert.match(orderDashboardSource, /setCurrentEditSourceOrderType\(currentType\);/);
});

test('MenuModal edit hydration bails on stale runs when switching orders mid-open', () => {
  const bails = menuModalSource.match(/if \(lastEditOrderIdRef\.current !== editOrderId\) return;/g) || [];
  assert.ok(bails.length >= 2, `expected stale-run guards after each await, found ${bails.length}`);
});

test('MenuModal initialCartItems branch pre-arms the reprice guard', () => {
  assert.match(
    menuModalSource,
    /pre-arm the reprice guard[\s\S]{0,300}?repricedForOrderTypeRef\.current = orderType;/,
  );
});

test('MenuModal no longer imports the bare-tier pricing util (rename-proof flatten guard)', () => {
  assert.doesNotMatch(menuModalSource, /from '\.\.\/\.\.\/utils\/order-type-pricing'/);
});

test('calculatePickupToDeliveryTotal recovers kiosk ingredient value via the line total', () => {
  // Kiosk shape: unit_price base-only 6.60, total 15.20 for qty 2 (1.00/unit
  // of ingredients), no tier fields on the item.
  const order: any = {
    totalAmount: 15.2,
    items: [
      {
        quantity: 2,
        unit_price: 6.6,
        total_price: 15.2,
        customizations: { added: [{ id: 'u1', name: 'Ham', price: 1.0, quantity: 1 }] },
      },
    ],
  };
  // 15.20 of items (reconciled 7.60 x 2) + 2.00 fee — the 2.00 of
  // ingredients must not evaporate on conversion.
  assert.equal(calculatePickupToDeliveryTotal(order, 2), 17.2);
});

test('calculatePickupToDeliveryTotal retiers POS lines to delivery including ingredient tiers', () => {
  const order: any = {
    totalAmount: 15.2,
    items: [
      {
        quantity: 2,
        price: 7.6,
        unit_price: 7.6,
        total_price: 15.2,
        basePrice: 6.6,
        base_price: 6.6,
        pickup_price: 6.6,
        delivery_price: 7.0,
        customizations: [{ ingredient: { price: 0.5, delivery_price: 0.6 }, quantity: 2 }],
      },
    ],
  };
  // Delivery tier: base 7.00 + 2 x 0.60 = 8.20/unit -> 16.40 + 2.00 fee.
  assert.equal(calculatePickupToDeliveryTotal(order, 2), 18.4);
});

test('calculatePickupToDeliveryTotal keeps offer-reward lines free and overridden lines as set', () => {
  const rewardOrder: any = {
    totalAmount: 15.2,
    items: [
      {
        quantity: 2,
        price: 7.6,
        unit_price: 7.6,
        total_price: 15.2,
        basePrice: 6.6,
        base_price: 6.6,
        pickup_price: 6.6,
        delivery_price: 7.0,
        customizations: [{ ingredient: { price: 0.5, delivery_price: 0.6 }, quantity: 2 }],
      },
      // Free reward crepe worth 7.00: must stay free across the retier.
      {
        quantity: 1,
        unit_price: 0,
        total_price: 0,
        basePrice: 7.0,
        base_price: 7.0,
        is_offer_reward: true,
      },
    ],
  };
  assert.equal(calculatePickupToDeliveryTotal(rewardOrder, 2), 18.4);

  const overriddenOrder: any = {
    totalAmount: 5,
    items: [
      {
        quantity: 1,
        unit_price: 5,
        total_price: 5,
        is_price_overridden: true,
        delivery_price: 7.0,
      },
    ],
  };
  // Operator set 5.00; conversion must not re-inflate to the 7.00 tier.
  assert.equal(calculatePickupToDeliveryTotal(overriddenOrder, 2), 7);
});
