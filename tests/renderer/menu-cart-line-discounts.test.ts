import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyDiscountToCartLines,
  clearDiscountFromCartLines,
  type DiscountableCartLine,
} from '../../src/renderer/utils/cart-line-discounts.ts';

const projectRoot = process.cwd();
const menuCartPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'MenuCart.tsx');
const menuModalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx');
const source = (filePath: string) => readFileSync(filePath, 'utf8');

test('applyDiscountToCartLines discounts only the selected cart lines', () => {
  const items: DiscountableCartLine[] = [
    { id: 'special', name: 'Special', quantity: 2, price: 5, unitPrice: 5, totalPrice: 10 },
    { id: 'plain', name: 'Plain', quantity: 1, price: 7, unitPrice: 7, totalPrice: 7 },
  ];

  const discounted = applyDiscountToCartLines(items, ['special'], 'percentage', 20);

  assert.equal(discounted[0].unitPrice, 4);
  assert.equal(discounted[0].price, 4);
  assert.equal(discounted[0].totalPrice, 8);
  assert.equal(discounted[0].originalUnitPrice, 5);
  assert.equal(discounted[0].isPriceOverridden, true);
  assert.equal(discounted[0].discountAmount, 2);
  assert.deepEqual(discounted[1], items[1]);
});

test('applyDiscountToCartLines distributes fixed discounts proportionally', () => {
  const items: DiscountableCartLine[] = [
    { id: 'large', name: 'Large', quantity: 1, price: 10, unitPrice: 10, totalPrice: 10 },
    { id: 'small', name: 'Small', quantity: 1, price: 5, unitPrice: 5, totalPrice: 5 },
    { id: 'other', name: 'Other', quantity: 1, price: 4, unitPrice: 4, totalPrice: 4 },
  ];

  const discounted = applyDiscountToCartLines(items, ['large', 'small'], 'fixed', 3);

  assert.equal(discounted[0].discountAmount, 2);
  assert.equal(discounted[0].totalPrice, 8);
  assert.equal(discounted[1].discountAmount, 1);
  assert.equal(discounted[1].totalPrice, 4);
  assert.equal(discounted[2].totalPrice, 4);
});

test('clearDiscountFromCartLines restores the discount base price', () => {
  const items: DiscountableCartLine[] = [
    {
      id: 'special',
      name: 'Special',
      quantity: 1,
      price: 6,
      unitPrice: 6,
      totalPrice: 6,
      originalUnitPrice: 10,
      discountBaseUnitPrice: 8,
      discountAmount: 2,
      isPriceOverridden: true,
    },
  ];

  const cleared = clearDiscountFromCartLines(items, ['special']);

  assert.equal(cleared[0].unitPrice, 8);
  assert.equal(cleared[0].price, 8);
  assert.equal(cleared[0].totalPrice, 8);
  assert.equal(cleared[0].discountAmount, 0);
  assert.equal(cleared[0].isPriceOverridden, true);
});

test('applyDiscountToCartLines replaces an existing selected line discount', () => {
  const items: DiscountableCartLine[] = [
    { id: 'special', name: 'Special', quantity: 1, price: 6, unitPrice: 6, totalPrice: 6 },
  ];

  const tenPercent = applyDiscountToCartLines(items, ['special'], 'percentage', 10);
  const twentyPercent = applyDiscountToCartLines(tenPercent, ['special'], 'percentage', 20);

  assert.equal(twentyPercent[0].totalPrice, 4.8);
  assert.equal(twentyPercent[0].unitPrice, 4.8);
  assert.equal(twentyPercent[0].discountAmount, 1.2);
  assert.equal(twentyPercent[0].discountBaseUnitPrice, 6);
  assert.equal(twentyPercent[0].discountBaseTotalPrice, 6);
});

test('MenuCart keeps manual item entry available while editing an order', () => {
  const menuCart = source(menuCartPath);
  const manualButtonMatch = menuCart.match(
    /\{(?<condition>[^\n{}]+)\s*&&\s*\(\s*<button[\s\S]*?aria-label=\{t\('menu\.cart\.addManualItem'/,
  );

  assert.ok(manualButtonMatch?.groups?.condition, 'manual item button condition should be present');
  assert.doesNotMatch(
    manualButtonMatch.groups.condition,
    /!editMode/,
    'edit mode must not hide the manual item add button',
  );
  assert.match(
    manualButtonMatch.groups.condition,
    /!isSelectionMode/,
    'selection mode should still hide the manual item add button',
  );
});

test('MenuModal passes manual item entry into the cart while editing an order', () => {
  const menuModal = source(menuModalPath);
  const menuCartMatch = menuModal.match(/<MenuCart[\s\S]*?\/>/);

  assert.ok(menuCartMatch, 'MenuModal should render MenuCart');
  assert.doesNotMatch(
    menuCartMatch[0],
    /onAddManualItem=\{editMode\s*\?\s*undefined\s*:\s*handleAddManualItem\}/,
    'edit mode must not strip the manual item handler before MenuCart renders',
  );
  assert.match(
    menuCartMatch[0],
    /onAddManualItem=\{handleAddManualItem\}/,
    'MenuCart should receive the manual item handler in create and edit modes',
  );
});

// --- Discount modal i18n (pickup/cart discount picker) ---------------------
// Regression: menu.cart.manualDiscount / removeDiscount / applyDiscount were
// absent from every locale (only their hardcoded English t() defaults rendered),
// so the Greek discount modal leaked "Manual discount" / "Remove discount" /
// "Apply discount". discountAmount already existed and must stay localized.

const localesDir = path.join(projectRoot, 'src', 'locales');
const getKey = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
const loadLocale = (lng: string): unknown =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const DISCOUNT_MODAL_KEYS = ['manualDiscount', 'removeDiscount', 'applyDiscount', 'discountAmount'] as const;

test('discount modal menu.cart.* labels exist and never leak the raw key in any POS locale', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const json = loadLocale(lng);
    for (const key of DISCOUNT_MODAL_KEYS) {
      const dotted = `menu.cart.${key}`;
      const value = getKey(json, dotted);
      assert.equal(typeof value, 'string', `${lng} missing ${dotted}`);
      assert.ok((value as string).length > 0, `${lng} empty ${dotted}`);
      assert.notEqual(value, dotted, `${lng} ${dotted} leaks the dotted i18n key`);
      assert.notEqual(value, key, `${lng} ${dotted} leaks the bare key name`);
    }
  }
});

test('Greek discount modal labels do not fall back to English', () => {
  const en = loadLocale('en');
  const el = loadLocale('el');
  const greek = new RegExp('[\\u0370-\\u03FF]');

  for (const key of DISCOUNT_MODAL_KEYS) {
    const dotted = `menu.cart.${key}`;
    assert.notEqual(
      getKey(el, dotted),
      getKey(en, dotted),
      `el ${dotted} must be a Greek translation, not the English fallback`,
    );
  }
  // The three previously-missing labels must actually contain Greek script.
  for (const key of ['manualDiscount', 'removeDiscount', 'applyDiscount']) {
    assert.match(getKey(el, `menu.cart.${key}`) as string, greek, `el menu.cart.${key} should be Greek`);
  }
});

test('MenuCart discount picker stays an app-level fixed overlay with a blurred backdrop', () => {
  const menuCart = source(menuCartPath);

  // The discount modal wiring references all four labels.
  for (const key of DISCOUNT_MODAL_KEYS) {
    assert.match(menuCart, new RegExp(`t\\('menu\\.cart\\.${key}'`), `MenuCart should use menu.cart.${key}`);
  }

  // The cart discount picker (anchored on its title) must keep the fixed,
  // high-z, blurred-backdrop shell — i.e. app-level, outside the POS container.
  const idx = menuCart.indexOf("menu.cart.discountPickerTitle");
  assert.ok(idx > 0, 'discount picker modal should exist');
  const shell = menuCart.slice(Math.max(0, idx - 700), idx);
  assert.match(shell, /fixed inset-0 z-\[\d{4}\]/, 'discount modal must be an app-level fixed overlay');
  assert.match(shell, /backdrop-blur/, 'discount modal must keep a blurred backdrop');
});

// --- Manual item submit button i18n ---------------------------------------
// Regression: the manual-item form's submit button used t('common.add', 'Add'),
// a key absent from every locale, so it leaked English "Add" in Greek.

test('MenuCart manual item submit button routes through a localized menu.cart key', () => {
  const menuCart = source(menuCartPath);
  assert.match(menuCart, /t\('menu\.cart\.manualItemSubmit', 'Add'\)/);
  // The English-leaking common.add fallback is gone from MenuCart.
  assert.doesNotMatch(menuCart, /t\('common\.add'/);
});

test('menu.cart.manualItemSubmit exists and is localized (Greek not "Add") in every POS locale', () => {
  const greek = new RegExp('[\\u0370-\\u03FF]');
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const value = getKey(loadLocale(lng), 'menu.cart.manualItemSubmit');
    assert.equal(typeof value, 'string', `${lng} missing menu.cart.manualItemSubmit`);
    assert.ok((value as string).length > 0, `${lng} empty menu.cart.manualItemSubmit`);
  }
  const en = getKey(loadLocale('en'), 'menu.cart.manualItemSubmit');
  const el = getKey(loadLocale('el'), 'menu.cart.manualItemSubmit');
  assert.notEqual(el, en, 'el manualItemSubmit must not equal the English source');
  assert.notEqual(el, 'Add', 'el manualItemSubmit must not be the raw "Add" leak');
  assert.match(el as string, greek, `el manualItemSubmit should be Greek: "${el}"`);
});

test('MenuCart manual item submit button fits localized labels without clipping', () => {
  const menuCart = source(menuCartPath);

  // The submit button must keep its full label width (no flex-shrink) and never
  // wrap/clip — the Greek "Προσθήκη" was truncated to "Προ..." when it could shrink.
  const submitIdx = menuCart.indexOf("t('menu.cart.manualItemSubmit'");
  assert.ok(submitIdx > 0, 'manual item submit button should exist');
  const buttonBlock = menuCart.slice(Math.max(0, submitIdx - 400), submitIdx);
  assert.match(buttonBlock, /shrink-0/, 'submit button must not shrink below its label width');
  assert.match(buttonBlock, /whitespace-nowrap/, 'submit button label must not wrap/clip');

  // The price input sharing the row must be able to shrink (min-w-0) so the
  // button has room without forcing horizontal overflow in the cart column.
  assert.match(
    menuCart,
    /manualPricePlaceholder[\s\S]{0,220}?flex-1 min-w-0/,
    'price input in the submit row must allow shrinking (flex-1 min-w-0)',
  );
});

test('nested MenuCart overlays mark role="dialog" so Escape closes only the topmost (parent stays open)', () => {
  const menuCart = source(menuCartPath);

  // LiquidGlassModal.isTopMostDialog() selects the LAST [role="dialog"] in the DOM.
  // A nested cart overlay must declare role="dialog" to become topmost — otherwise the
  // parent MenuModal stays "topmost" and ALSO closes on Escape, dropping the draft cart.
  // All four fixed overlays (line-price editor, coupon, line-discount, discount) opt in.
  for (const z of ['z-\\[1190\\]', 'z-\\[1195\\]', 'z-\\[1198\\]', 'z-\\[1200\\]']) {
    const re = new RegExp(
      `<div className="fixed inset-0 ${z} flex items-center justify-center p-4" role="dialog"`,
    );
    assert.match(menuCart, re, `overlay ${z} must declare role="dialog" to join the topmost-dialog stack`);
  }

  // The coupon/discount/line-discount overlays already close themselves on Escape.
  assert.match(
    menuCart,
    /event\.key === 'Escape'[\s\S]*?setIsCouponModalOpen\(false\)/,
    'coupon/discount/line-discount overlays must close on Escape',
  );
});
