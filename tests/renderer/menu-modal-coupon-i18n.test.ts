import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';

// couponErrors is a leaf util (no imports), so the explicit .ts extension keeps
// this file runnable under a direct `node --test` as well as the esbuild suite.
import {
  resolveCouponErrorKey,
  COUPON_ERROR_FALLBACKS,
} from '../../src/renderer/utils/couponErrors.ts';

const LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const;
const NEW_KEYS = [
  'couponNotFound',
  'couponInactive',
  'couponExpired',
  'couponUsageLimit',
  'couponNotAvailable',
  'couponMinOrder',
] as const;

const loadLocale = (locale: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${locale}.json`), 'utf8'));

const menuModalSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx'),
  'utf8',
);

// A t() bound to the full main locale, where menu.cart.* lives.
const createMenuT = async (locale: string) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: 'en',
    resources: {
      en: { translation: loadLocale('en') },
      el: { translation: loadLocale('el') },
    },
    interpolation: { escapeValue: false },
  });
  return instance.getFixedT(locale);
};

// --- Mapping: both backend shapes resolve to the right locale key ----------

test('resolveCouponErrorKey maps desktop English sentences (Tauri bridge) to keys', () => {
  assert.equal(resolveCouponErrorKey('Coupon not found'), 'menu.cart.couponNotFound');
  assert.equal(resolveCouponErrorKey('Coupon is inactive'), 'menu.cart.couponInactive');
  assert.equal(resolveCouponErrorKey('Coupon has expired'), 'menu.cart.couponExpired');
  assert.equal(resolveCouponErrorKey('Coupon usage limit has been reached'), 'menu.cart.couponUsageLimit');
  assert.equal(resolveCouponErrorKey('Minimum order amount is 20.00'), 'menu.cart.couponMinOrder');
});

test('resolveCouponErrorKey maps browser machine codes (admin API) to keys', () => {
  assert.equal(resolveCouponErrorKey('COUPON_NOT_FOUND'), 'menu.cart.couponNotFound');
  assert.equal(resolveCouponErrorKey('COUPON_INACTIVE'), 'menu.cart.couponInactive');
  assert.equal(resolveCouponErrorKey('COUPON_EXPIRED'), 'menu.cart.couponExpired');
  assert.equal(resolveCouponErrorKey('COUPON_USAGE_LIMIT_REACHED'), 'menu.cart.couponUsageLimit');
  assert.equal(resolveCouponErrorKey('COUPON_NOT_AVAILABLE_FOR_BRANCH'), 'menu.cart.couponNotAvailable');
  assert.equal(resolveCouponErrorKey('COUPON_MIN_ORDER_NOT_MET'), 'menu.cart.couponMinOrder');
});

test('resolveCouponErrorKey falls back to the generic invalid key for empty/unknown signals', () => {
  assert.equal(resolveCouponErrorKey(''), 'menu.cart.couponInvalid');
  assert.equal(resolveCouponErrorKey(null), 'menu.cart.couponInvalid');
  assert.equal(resolveCouponErrorKey(undefined), 'menu.cart.couponInvalid');
  assert.equal(resolveCouponErrorKey('some unexpected server text'), 'menu.cart.couponInvalid');
});

// --- Behavioral: the invalid-coupon message is Greek in Greek UI -----------

test('invalid coupon ("Coupon not found") renders in Greek, not raw English', async () => {
  const el = await createMenuT('el');
  const en = await createMenuT('en');

  const key = resolveCouponErrorKey('Coupon not found'); // the live desktop repro signal
  const elMessage = el(key, COUPON_ERROR_FALLBACKS[key]);
  const enMessage = en(key, COUPON_ERROR_FALLBACKS[key]);

  assert.equal(elMessage, 'Το κουπόνι δεν βρέθηκε');
  assert.equal(enMessage, 'Coupon not found');
  // The live defect: raw English in the Greek UI must not happen.
  assert.notEqual(elMessage, 'Coupon not found');
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');
  assert.match(elMessage, GREEK_LETTER, `el not-found message should be Greek: "${elMessage}"`);

  // The browser machine code must never surface to the user either.
  const codeKey = resolveCouponErrorKey('COUPON_NOT_FOUND');
  assert.equal(el(codeKey, COUPON_ERROR_FALLBACKS[codeKey]), 'Το κουπόνι δεν βρέθηκε');
});

// --- Locale completeness ---------------------------------------------------

test('all new coupon error keys exist in every POS locale and are translated (el != en)', () => {
  for (const locale of LOCALES) {
    const cart = loadLocale(locale).menu?.cart ?? {};
    for (const k of NEW_KEYS) {
      assert.equal(typeof cart[k], 'string', `${locale}.menu.cart.${k} missing`);
      assert.ok((cart[k] as string).length > 0, `${locale}.menu.cart.${k} empty`);
    }
  }
  const en = loadLocale('en').menu.cart;
  const el = loadLocale('el').menu.cart;
  for (const k of NEW_KEYS) {
    assert.notEqual(el[k], en[k], `el.menu.cart.${k} must be translated, not an English echo`);
  }
});

test('COUPON_ERROR_FALLBACKS stay in lock-step with the en.json values', () => {
  const enCart = loadLocale('en').menu.cart;
  for (const fullKey of Object.keys(COUPON_ERROR_FALLBACKS)) {
    const cartKey = fullKey.replace('menu.cart.', '');
    assert.equal(
      COUPON_ERROR_FALLBACKS[fullKey as keyof typeof COUPON_ERROR_FALLBACKS],
      enCart[cartKey],
      `fallback for ${fullKey} must match en.json menu.cart.${cartKey}`,
    );
  }
});

// --- Source wiring: MenuModal localizes at the source ----------------------

test('MenuModal localizes the coupon validation reason via resolveCouponErrorKey', () => {
  assert.match(
    menuModalSource,
    /import \{ resolveCouponErrorKey, COUPON_ERROR_FALLBACKS \} from '\.\.\/\.\.\/utils\/couponErrors';/,
  );
  assert.match(menuModalSource, /const reasonKey = resolveCouponErrorKey\(couponPayload\?\.error\)/);
  assert.match(menuModalSource, /setCouponError\(t\(reasonKey, COUPON_ERROR_FALLBACKS\[reasonKey\]\)\)/);

  // The raw server error / machine code must no longer be echoed straight to the UI.
  assert.doesNotMatch(menuModalSource, /setCouponError\(couponPayload\?\.error \|\|/);
  assert.doesNotMatch(menuModalSource, /setCouponError\(result\.error \|\|/);
});
