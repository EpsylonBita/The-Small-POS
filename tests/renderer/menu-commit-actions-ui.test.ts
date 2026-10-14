import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const cartPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'MenuCart.tsx');
const itemModalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'MenuItemModal.tsx');

const cartSource = readFileSync(cartPath, 'utf8');
const itemModalSource = readFileSync(itemModalPath, 'utf8');

// --- Round 250 (live QA, Greek/dark): commit/save/update actions must read as semantic GREEN.
// The edit-order cart footer "Save Changes" button and the item-customization "Update Product"
// button were amber/orange; they are now green (yellow/black stays for the normal complete-order
// action and selected/attention states). Touch rule: these components carry no native title=
// tooltips and add no hover-only effects on the controls touched; aria-label / visible text /
// sr-only provide the accessible name, with active: press feedback. ---

test('Round 250: MenuCart edit-mode save action is green, not amber/orange', () => {
  // editMode footer primary action → semantic green (with active press feedback).
  assert.match(
    cartSource,
    /editMode\s*\?\s*'bg-green-600 text-white active:bg-green-700 active:scale-\[1\.02\]'/,
  );
  // The amber/orange edit-mode save treatment is gone from that branch.
  assert.doesNotMatch(
    cartSource,
    /'bg-amber-600 text-white active:bg-amber-700 active:scale-\[1\.02\]'/,
  );
  // The normal (non-edit) complete-order action stays intentional yellow/black.
  assert.match(
    cartSource,
    /:\s*'bg-yellow-400 text-black active:bg-yellow-300 active:scale-\[1\.02\]'/,
  );
  // Disabled state stays neutral (not green), and the save handler/logic is unchanged.
  assert.match(
    cartSource,
    /isCheckoutBlocked\s*\?\s*'bg-black\/10 dark:bg-white\/10 text-black\/30 dark:text-white\/30 cursor-not-allowed'/,
  );
  assert.match(cartSource, /onClick=\{onCheckout\}\s*disabled=\{isCheckoutBlocked\}/);
});

test('Round 250: MenuCart touch controls drop native title= tooltips, keep/gain aria-labels', () => {
  // No DOM native title= attribute remains on any cart touch control.
  assert.doesNotMatch(cartSource, /title=["{]/);
  // Icon-only controls expose a localized accessible name via aria-label (converted from title).
  assert.match(cartSource, /aria-label=\{t\('common\.actions\.delete'\)\}/);
  assert.match(cartSource, /aria-label=\{t\('menu\.cart\.exitSelection', 'Exit selection'\)\}/);
  assert.match(cartSource, /aria-label=\{t\('menu\.cart\.addManualItem', 'Manual Item'\)\}/);
  assert.match(
    cartSource,
    /aria-label=\{t\('menu\.cart\.removeLoyaltyRedemption', 'Remove loyalty redemption'\)\}/,
  );
  // Select-all keeps its dynamic accessible name.
  assert.match(cartSource, /aria-label=\{\s*allSelectableSelected/);
  // Coupon / loyalty / discount icon buttons keep their pre-existing aria-labels (only title removed).
  assert.match(cartSource, /aria-label=\{loyaltyActionTitle\}/);
  assert.match(cartSource, /aria-label=\{discountActionTitle\}/);
  // Touch terminal: no hover-only utilities anywhere in the cart.
  assert.doesNotMatch(cartSource, /hover:/);
});

// 04/10/2026, founder-requested POS UI pass (docs/reviews/pos-ui-ux-audit-2026-10-02.md, step 6):
// the item customizer's commit button (Add to Cart and Update Item) became the solid yellow cart
// CTA with dark text, replacing Round 250's green success glass there. The Round 250 touch rules
// still hold: full width, centered, tall, press feedback, no hover, no amber warning.
test('MenuItemModal commit button is the solid yellow cart CTA: centered, touch-safe, opaque', () => {
  const ctaCss = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'menu-item-cart-action.css'),
    'utf8',
  );
  assert.match(itemModalSource, /import '\.\/menu-item-cart-action\.css';/);
  assert.match(itemModalSource, /onClick=\{handleAddToCart\}\s*className="menu-item-cart-action"/);
  assert.doesNotMatch(itemModalSource, /liquid-glass-modal-warning/);

  const rule = ctaCss.match(/\.menu-item-customizer-modal \.menu-item-cart-action \{([^}]*)\}/)?.[1] ?? '';
  for (const declaration of [
    'display: flex;',
    'width: 100%;',
    'min-height: 48px;',
    'align-items: center;',
    'justify-content: center;',
    'background: #facc15;',
    'color: #18181b;',
    'backdrop-filter: none;',
  ]) {
    assert.ok(rule.includes(declaration), `cart CTA must keep "${declaration}"`);
  }
  assert.doesNotMatch(rule, /opacity|rgba\(/, 'the cart CTA is a solid, opaque surface');
  assert.match(ctaCss, /\.menu-item-cart-action:active \{ background: #eab308; border-color: #eab308; \}/);
  assert.match(ctaCss, /\.menu-item-cart-action:focus-visible \{ outline: 2px solid #ca8a04;/);
  assert.doesNotMatch(ctaCss, /:hover/);

  // Commit handler + update/add labels unchanged; Update keeps its own icon.
  assert.match(itemModalSource, /<Check className="w-5 h-5" aria-hidden="true" \/>\s*\{t\('menu\.itemModal\.updateItem'/);
  assert.match(itemModalSource, /t\('menu\.itemModal\.addToCart'/);
});

test('Round 250: MenuItemModal quantity/ingredient controls drop native title=, keep aria-labels', () => {
  // No DOM native title= attribute remains on any quantity/ingredient touch control.
  assert.doesNotMatch(itemModalSource, /title=["{]/);
  // Item-quantity +/- keep their localized aria-labels.
  assert.match(
    itemModalSource,
    /aria-label=\{t\('common\.actions\.decrease', \{ defaultValue: 'Decrease quantity' \}\)\}/,
  );
  assert.match(
    itemModalSource,
    /aria-label=\{t\('common\.actions\.increase', \{ defaultValue: 'Increase quantity' \}\)\}/,
  );
  // Ingredient quantity +/- and add/remove keep their aria-labels.
  assert.match(itemModalSource, /aria-label=\{t\('common\.actions\.decrease'\)\}/);
  assert.match(itemModalSource, /aria-label=\{t\('common\.actions\.increase'\)\}/);
  assert.match(itemModalSource, /aria-label=\{t\('common\.actions\.remove'\)\}/);
  assert.match(itemModalSource, /aria-label=\{t\('common\.actions\.add'\)\}/);
  // Touch terminal: no hover-only utilities anywhere in the item modal.
  assert.doesNotMatch(itemModalSource, /hover:/);
});
