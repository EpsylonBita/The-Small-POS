import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression guards for Greek staff-flow QA findings: payment label wrapping,
// pending payment-method labels, split-payment strings, and Orders FAB
// order-type descriptions.
const root = process.cwd();
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const loadLocale = (lng: string): unknown => JSON.parse(read(`src/locales/${lng}.json`));
const get = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
const LOCALES = ['en', 'el', 'de', 'fr', 'it'];

const paymentSource = read('src/renderer/components/modals/PaymentModal.tsx');
const orderDetailsSource = read('src/renderer/components/modals/OrderDetailsModal.tsx');
const orderDashboardSource = read('src/renderer/components/OrderDashboard.tsx');
const splitPaymentSource = read('src/renderer/components/modals/SplitPaymentModal.tsx');
const zReportSource = read('src/renderer/components/modals/ZReportModal.tsx');

// Round 236: the Orders hub adds Rooms/Services tabs and a Room flow (Room Order / Check-in /
// Create Reservation). Every new user-facing string must exist (translated) in all five locales.
test('Round 236: hub tab + room flow keys exist and are translated in all five locales', () => {
  const keys = [
    'dashboard.tabs.rooms',
    'dashboard.tabs.services',
    'orderFlow.roomOrder',
    'orderFlow.roomDescription',
    'orderFlow.serviceOrder',
    'orderFlow.serviceDescription',
    'orderFlow.roomFlowTitle',
    'orderFlow.roomFlowOrder',
    'orderFlow.roomFlowOrderDesc',
    'orderFlow.roomFlowCheckin',
    'orderFlow.roomFlowCheckinDesc',
    'orderFlow.roomFlowReservation',
    'orderFlow.roomFlowReservationDesc',
    'orderFlow.roomOrderTitle',
    'orderFlow.roomOrderEmpty',
    'orderFlow.roomOrderNoFolio',
    'orderFlow.roomOrderSelectRoom',
    'orderFlow.roomGuestCustomer',
    'orderFlow.roomCustomer',
    // Round 342: the check-in selector empty-state helper (reservation-first guidance).
    'orderFlow.roomCheckinEmptyHint',
  ];
  for (const lng of LOCALES) {
    const data = loadLocale(lng);
    for (const key of keys) {
      const value = get(data, key);
      assert.equal(typeof value, 'string', `${lng} ${key} must be a string`);
      assert.ok((value as string).trim().length > 0, `${lng} ${key} must be non-empty`);
      assert.doesNotMatch(value as string, /NEEDS TRANSLATION/i, `${lng} ${key} must be translated`);
    }
  }
  // The interpolated room labels keep their {{room}} / {{guest}} placeholders in every locale.
  for (const lng of LOCALES) {
    assert.match(get(loadLocale(lng), 'orderFlow.roomGuestCustomer') as string, /\{\{room\}\}[\s\S]*\{\{guest\}\}/);
    assert.match(get(loadLocale(lng), 'orderFlow.roomCustomer') as string, /\{\{room\}\}/);
  }
  // Greek must actually differ from English for a representative key (not an English passthrough).
  assert.notEqual(
    get(loadLocale('el'), 'orderFlow.roomFlowOrder'),
    get(loadLocale('en'), 'orderFlow.roomFlowOrder'),
    'el roomFlowOrder must be translated',
  );
});

// Round 317 (live QA, Greek New Order -> Room): the room flow still exposed Latin-script "Check-in"
// inside otherwise-Greek modals -- the order-type card, the room action card title/description, the
// room-order empty hint, and the check-in selector empty state. Greek is now localized around guest
// arrival ("άφιξη" / "καταχώριση άφιξης"). German "Check-in"/"einchecken" (native term), French
// "Enregistrement" (already localized) and the Italian "check-in" loanword stay as accepted
// same-script hotel terminology, so only Greek changes. Copy/i18n only -- no behavior change.
test('Round 317: Greek New Order -> Room workflow strings contain no Latin "check-in"', () => {
  const orderFlow = (get(loadLocale('el'), 'orderFlow') ?? {}) as Record<string, unknown>;
  const CHECKIN = /check-?in/i;

  // The exact keys live QA flagged must be clean.
  for (const key of ['roomDescription', 'roomFlowCheckin', 'roomFlowCheckinDesc', 'roomOrderEmptyHint', 'roomCheckinEmpty']) {
    const value = orderFlow[key];
    assert.equal(typeof value, 'string', `el orderFlow.${key} must be a string`);
    assert.doesNotMatch(value as string, CHECKIN, `el orderFlow.${key} must not contain Latin "check-in"`);
  }

  // And so must every other rendered room-flow string (guards any future orderFlow.room* key too).
  for (const [key, value] of Object.entries(orderFlow)) {
    if (!/^room/i.test(key) || typeof value !== 'string') continue;
    assert.doesNotMatch(value, CHECKIN, `el orderFlow.${key} must not contain Latin "check-in"`);
  }

  // The localized arrival copy is real Greek (not the English passthrough) and uses the άφιξη root.
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const key of ['roomFlowCheckin', 'roomFlowCheckinDesc']) {
    assert.match(orderFlow[key] as string, GREEK, `el orderFlow.${key} should be Greek`);
    assert.match(orderFlow[key] as string, /φιξ/, `el orderFlow.${key} should use the άφιξη (arrival) wording`);
    assert.notEqual(orderFlow[key], get(loadLocale('en'), `orderFlow.${key}`), `el orderFlow.${key} must differ from English`);
  }
});

test('Round 317: orderFlow room-flow key set stays in parity across all five locales', () => {
  const roomKeys = (lng: string): string[] => {
    const of = (get(loadLocale(lng), 'orderFlow') ?? {}) as Record<string, unknown>;
    return Object.keys(of).filter((k) => /^room/i.test(k)).sort();
  };
  const reference = roomKeys('en');
  assert.ok(reference.length > 0, 'expected orderFlow.room* keys to exist');
  for (const lng of LOCALES) {
    assert.deepEqual(roomKeys(lng), reference, `${lng} orderFlow room-flow keys must match en`);
  }
});

// Finding 1: long uppercase Greek labels must not break per-letter.
test('PaymentModal method labels do not use break-words', () => {
  assert.doesNotMatch(
    paymentSource,
    /uppercase[^\n]*break-words/,
    'payment-method labels must not use break-words (causes per-syllable Greek breaks)',
  );
});

// Finding 2: a pending/placeholder payment method renders a localized label, not raw "pending".
test('OrderDetailsModal localizes a pending payment method instead of echoing the raw value', () => {
  assert.match(orderDetailsSource, /case 'pending':/);
  for (const lng of LOCALES) {
    assert.equal(typeof get(loadLocale(lng), 'modals.orderDetails.pending'), 'string', `${lng} pending label missing`);
  }
  assert.notEqual(
    get(loadLocale('el'), 'modals.orderDetails.pending'),
    get(loadLocale('en'), 'modals.orderDetails.pending'),
    'el pending label must be translated',
  );
});

// Finding 3: split-payment portion/footer labels are localized in every POS locale.
test('SplitPaymentModal portion/footer keys are localized in every POS locale', () => {
  const keys = [
    'splitPayment.payable',
    'splitPayment.discount',
    'splitPayment.outstanding',
    'splitPayment.alreadyPaid',
  ];
  for (const lng of LOCALES) {
    for (const key of keys) {
      const value = get(loadLocale(lng), key);
      assert.equal(typeof value, 'string', `${lng}.${key} missing`);
      assert.ok((value as string).length > 0, `${lng}.${key} empty`);
    }
  }
  const en = loadLocale('en');
  const el = loadLocale('el');
  for (const key of keys) {
    assert.notEqual(get(el, key), get(en, key), `${key} must be translated in el`);
  }
});

// Finding 3 (comprehensive): every splitPayment.* key SplitPaymentModal references must
// exist in the splitPayment namespace of every POS locale, so card/error/loading paths
// never silently fall back to the English defaultValue.
test('every splitPayment.* key used by SplitPaymentModal exists in all POS locales', () => {
  const used = new Set<string>();
  const re = /t\(\s*['"]splitPayment\.([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(splitPaymentSource)) !== null) {
    used.add(match[1]);
  }
  assert.ok(used.size > 0, 'expected SplitPaymentModal to reference splitPayment.* keys');

  for (const lng of LOCALES) {
    const namespace = (get(loadLocale(lng), 'splitPayment') ?? {}) as Record<string, unknown>;
    for (const key of used) {
      const flat = namespace[key];
      const hasFlat = typeof flat === 'string' && flat.length > 0;
      // i18next plural keys: a key used with { count } resolves to key_one/key_other,
      // so the flat base key may legitimately be absent.
      const pluralOne = namespace[`${key}_one`];
      const pluralOther = namespace[`${key}_other`];
      const hasPlural =
        typeof pluralOne === 'string' && pluralOne.length > 0 &&
        typeof pluralOther === 'string' && pluralOther.length > 0;
      assert.ok(
        hasFlat || hasPlural,
        `${lng}.splitPayment.${key} is missing (SplitPaymentModal uses it)`,
      );
    }
  }
});

// Finding 4: Orders FAB order-type descriptions use existing localized keys.
test('OrderDashboard order-type descriptions resolve to localized keys', () => {
  assert.match(orderDashboardSource, /modals\.orderTypeSelection\.pickupDescription/);
  assert.match(orderDashboardSource, /modals\.orderTypeSelection\.deliveryDescription/);
  assert.doesNotMatch(orderDashboardSource, /t\("orderFlow\.pickupDescription"/);
  assert.doesNotMatch(orderDashboardSource, /t\("orderFlow\.deliveryDescription"/);
  for (const lng of LOCALES) {
    assert.equal(
      typeof get(loadLocale(lng), 'modals.orderTypeSelection.pickupDescription'),
      'string',
      `${lng} pickup description missing`,
    );
    assert.equal(
      typeof get(loadLocale(lng), 'modals.orderTypeSelection.deliveryDescription'),
      'string',
      `${lng} delivery description missing`,
    );
  }
});

// Round 200: the order-type chooser cards showed the title twice in Greek (Παράδοση / Παράδοση,
// Παραλαβή / Παραλαβή) and the a11y tree built duplicate button names ("button Παράδοση Παράδοση").
// Every locale must give the three cards a real, kid-clear description that differs from the title,
// and the chooser buttons must expose explicit, non-duplicating aria-labels.
test('Round 200: order-type card descriptions are non-empty and differ from their titles in every locale', () => {
  const cards = [
    { title: 'orderFlow.pickupOrder', desc: 'modals.orderTypeSelection.pickupDescription' },
    { title: 'orderFlow.deliveryOrder', desc: 'modals.orderTypeSelection.deliveryDescription' },
    { title: 'orderFlow.tableOrder', desc: 'orderFlow.tableDescription' },
  ];
  for (const lng of LOCALES) {
    const json = loadLocale(lng);
    for (const { title, desc } of cards) {
      const descValue = get(json, desc);
      const titleValue = get(json, title);
      assert.equal(typeof descValue, 'string', `${lng}.${desc} must be a string`);
      assert.ok((descValue as string).trim().length > 0, `${lng}.${desc} must be non-empty`);
      assert.notEqual(
        (descValue as string).trim().toLowerCase(),
        String(titleValue ?? '').trim().toLowerCase(),
        `${lng}.${desc} must not just repeat ${title}`,
      );
    }
  }
});

test('Round 200: Greek pickup/delivery descriptions differ from their orderFlow titles', () => {
  const el = loadLocale('el');
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  const pickupDesc = get(el, 'modals.orderTypeSelection.pickupDescription') as string;
  const deliveryDesc = get(el, 'modals.orderTypeSelection.deliveryDescription') as string;
  assert.notEqual(pickupDesc, get(el, 'orderFlow.pickupOrder'), 'el pickup description must differ from title');
  assert.notEqual(deliveryDesc, get(el, 'orderFlow.deliveryOrder'), 'el delivery description must differ from title');
  assert.match(pickupDesc, GREEK, `el pickup description should be Greek: "${pickupDesc}"`);
  assert.match(deliveryDesc, GREEK, `el delivery description should be Greek: "${deliveryDesc}"`);
});

test('Round 200: OrderDashboard chooser buttons expose explicit aria-labels via the dedupe helper', () => {
  // A helper collapses title+description to a single accessible name (no "X X" when they are equal).
  assert.match(
    orderDashboardSource,
    /const composeOrderTypeAriaLabel = \(title: string, description: string\): string =>/,
  );
  assert.match(orderDashboardSource, /cleanDescription\.toLowerCase\(\) === cleanTitle\.toLowerCase\(\)/);

  // All three chooser buttons carry an explicit aria-label built from the helper + are real buttons.
  const ariaLabels =
    orderDashboardSource.match(/aria-label=\{composeOrderTypeAriaLabel\(/g) || [];
  assert.ok(ariaLabels.length >= 3, `expected >=3 chooser aria-labels, found ${ariaLabels.length}`);
  for (const which of ['delivery', 'pickup', 'dine-in']) {
    assert.match(
      orderDashboardSource,
      new RegExp(`type="button"[\\s\\S]*?onClick=\\{\\(\\) => handleOrderTypeSelect\\("${which}"\\)\\}[\\s\\S]*?aria-label=\\{composeOrderTypeAriaLabel\\(`),
      `${which} chooser button must be type="button" with a compose-helper aria-label`,
    );
  }

  // The leftover hover-only "group" wrapper class is gone from the three chooser buttons, and no
  // hover utilities remain (touchscreen-first; active:scale tap feedback stays).
  assert.doesNotMatch(
    orderDashboardSource,
    /className="group relative p-6 rounded-2xl border-2/,
    'chooser buttons must not keep the leftover "group" class',
  );
  for (const accent of ['border-[#facc15]/45', 'border-[#34d399]/45', 'border-[#60a5fa]/45']) {
    assert.match(orderDashboardSource, new RegExp(`active:scale-95`));
    assert.match(orderDashboardSource, new RegExp(accent.replace(/[\/\[\]#]/g, '\\$&')));
  }
});

// Finding 5 (2026-06-21 live QA): the Z-report Orders audit rows printed raw backend
// tokens in the Greek UI ("dine-in · card", "pickup · pending", "room_service · card").
// The audit row must localize order type + payment/method/status via display helpers,
// while the filter state keeps the raw values for matching.
test('ZReportModal order audit row localizes order type and payment label, not raw tokens', () => {
  // The raw echo of order.orderType / order.paymentMethod in the audit row is gone.
  assert.doesNotMatch(
    zReportSource,
    /\{order\.orderType \|\| '—'\} · \{order\.paymentMethod \|\| '—'\}/,
    'audit row must not echo the raw orderType/paymentMethod slugs',
  );
  // The row renders through the localizing display helpers instead.
  assert.match(
    zReportSource,
    /\{localizeZReportOrderType\(order\.orderType, t\)\} · \{localizeZReportPaymentLabel\(order\.paymentMethod, t\)\}/,
  );

  // Both helpers exist and resolve via the dedicated localized namespaces.
  assert.match(zReportSource, /function localizeZReportOrderType\(/);
  assert.match(zReportSource, /function localizeZReportPaymentLabel\(/);
  assert.match(zReportSource, /modals\.zReport\.orderTypes\./);
  assert.match(zReportSource, /modals\.zReport\.paymentLabels\./);

  // Raw separator variants (dine-in/dine_in, room_service/room-service, etc.) collapse to
  // one canonical key, so both forms localize to the same label.
  assert.match(zReportSource, /function normalizeZReportSlug\([\s\S]*?replace\(\/\[\\s_-\]\+\/g, '_'\)/);

  // The filter matching still uses the raw values (display localization must not change it).
  assert.match(zReportSource, /o\.orderType === orderTypeFilter/);
  assert.match(zReportSource, /o\.paymentMethod === paymentMethodFilter/);
});

test('Z-report order-type + payment audit labels exist in every POS locale (Greek translated)', () => {
  const orderTypeKeys = ['delivery', 'dineIn', 'pickup', 'takeaway', 'driveThrough', 'roomService', 'unknown'];
  const paymentKeys = ['cash', 'card', 'split', 'roomCharge', 'pending', 'unpaid', 'unknown'];

  for (const lng of LOCALES) {
    for (const key of orderTypeKeys) {
      const value = get(loadLocale(lng), `modals.zReport.orderTypes.${key}`);
      assert.equal(typeof value, 'string', `${lng}.modals.zReport.orderTypes.${key} missing`);
      assert.ok((value as string).length > 0, `${lng}.modals.zReport.orderTypes.${key} empty`);
    }
    for (const key of paymentKeys) {
      const value = get(loadLocale(lng), `modals.zReport.paymentLabels.${key}`);
      assert.equal(typeof value, 'string', `${lng}.modals.zReport.paymentLabels.${key} missing`);
      assert.ok((value as string).length > 0, `${lng}.modals.zReport.paymentLabels.${key} empty`);
    }
  }

  // The explicitly-required Greek labels must be real translations, not the raw slug/English.
  const en = loadLocale('en');
  const el = loadLocale('el');
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const key of ['orderTypes.dineIn', 'orderTypes.roomService', 'paymentLabels.pending']) {
    const elValue = get(el, `modals.zReport.${key}`) as string;
    assert.notEqual(elValue, get(en, `modals.zReport.${key}`), `el modals.zReport.${key} must differ from English`);
    assert.match(elValue, GREEK, `el modals.zReport.${key} should be Greek: "${elValue}"`);
  }
  // And specifically: pending must not render the literal word "pending" in Greek.
  assert.doesNotMatch(get(el, 'modals.zReport.paymentLabels.pending') as string, /pending/i);
});
