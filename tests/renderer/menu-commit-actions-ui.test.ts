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

test('Round 250: MenuItemModal Update commit button is green, centered, touch-safe', () => {
  // Commit button uses the green success glass for BOTH add + update; the amber warning is gone.
  assert.match(
    itemModalSource,
    /isEditMode\s*\?\s*'liquid-glass-modal-success'\s*:\s*'liquid-glass-modal-success shadow-\[0_0_24px_rgba\(34,197,94,0\.24\)\]'/,
  );
  assert.doesNotMatch(itemModalSource, /liquid-glass-modal-warning/);
  // Centered + touch-safe (full-width, tall) + active press feedback on the commit button.
  assert.match(
    itemModalSource,
    /liquid-glass-modal-button w-full py-3 rounded-xl font-bold text-base shadow-lg transition-all duration-200 transform active:scale-98 flex items-center justify-center/,
  );
  // Commit handler + update/add labels unchanged (no behaviour change).
  assert.match(itemModalSource, /onClick=\{handleAddToCart\}/);
  assert.match(itemModalSource, /t\('menu\.itemModal\.updateItem'/);
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
