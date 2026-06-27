import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveReservationStart,
  selectUpcomingTableReservations,
} from '../../src/renderer/utils/reservationFormWarnings.ts';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'ReservationForm.tsx'),
  'utf8',
);

const localesDir = path.join(process.cwd(), 'src', 'locales');
const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const flatten = (obj: Record<string, any>, prefix = ''): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      Object.assign(out, flatten(value, dotted));
    } else {
      out[dotted] = value as string;
    }
  }
  return out;
};

const POS_LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const;
// Greek and Coptic Unicode block (U+0370-U+03FF), built from escapes so this
// source file stays pure ASCII.
const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');

test('ReservationForm keeps customer name and phone as independent controlled state', () => {
  assert.match(source, /const \[customerName, setCustomerName\] = useState\(''\)/);
  assert.match(source, /const \[customerPhone, setCustomerPhone\] = useState\(''\)/);
  // Each input writes only its own state; no shared/mirrored handler.
  assert.match(
    source,
    /value=\{customerName\}\s*onChange=\{\(e\) => \{ setCustomerName\(e\.target\.value\); clearFieldError\('customerName'\); \}\}/,
  );
  assert.match(
    source,
    /value=\{customerPhone\}\s*onChange=\{\(e\) => \{ setCustomerPhone\(e\.target\.value\); clearFieldError\('customerPhone'\); \}\}/,
  );
});

test('ReservationForm clears a field validation error as soon as it is edited', () => {
  assert.match(
    source,
    /const clearFieldError = useCallback\(\(field: keyof ReservationFormErrors\) => \{[\s\S]*?prev\[field\] \? \{ \.\.\.prev, \[field\]: undefined \} : prev/,
    'editing a field should drop only that field error so required validation does not linger',
  );
  // All required fields wire the clear-on-change.
  assert.match(source, /clearFieldError\('reservationDate'\)/);
  assert.match(source, /clearFieldError\('reservationTime'\)/);
  assert.ok(
    (source.match(/clearFieldError\('partySize'\)/g) || []).length >= 3,
    'party size direct input and +/- buttons should clear party-size validation errors',
  );
});

test('ReservationForm renders through an app-level portal above the sidebar and FAB', () => {
  // The form previously rendered inline at z-50, leaving the sidebar/FAB visible
  // and the footer clipped. It must portal to document.body on the app-modal
  // layer with a full-screen backdrop/blur, and a constrained, scrollable body.
  assert.match(source, /import \{ renderModalPortal \} from '\.\.\/\.\.\/utils\/render-modal-portal';/);
  assert.match(source, /return renderModalPortal\(\s*<div/);
  assert.match(source, /className="fixed inset-0 z-\[1200\] flex items-center justify-center"/);
  assert.match(source, /bg-black\/50 backdrop-blur-sm/);
  // The old inline z-50 overlay (clipped by the dashboard container) is gone.
  assert.doesNotMatch(source, /fixed inset-0 z-50/);
  // Body is height-constrained and scrolls so header/footer never clip.
  assert.match(source, /max-h-\[90vh\]/);
  assert.match(source, /flex-1 min-h-0 overflow-y-auto/);
  assert.match(source, /border-t flex-shrink-0/);
});

test('ReservationForm passes count for guest pluralization (no flat "guests" label)', () => {
  assert.match(source, /t\('reservationForm\.guests', \{ count: partySize \}\)/);
  assert.match(source, /t\('reservationForm\.guests', \{ count: tableCapacity \}\)/);
  assert.match(source, /t\('reservationForm\.guestCount', \{ count: res\.partySize \}\)/);
  // The non-pluralizable flat fallback must be gone so singular cannot regress.
  assert.doesNotMatch(source, /reservationForm\.guests', \{ defaultValue: 'guests' \}/);
  assert.doesNotMatch(source, /Capacity: \{\{capacity\}\} guests/);
});

test('ReservationForm reservation lists use i18n format keys, not hardcoded English', () => {
  // The "<date> at <time> - <name> (N guests)" formatting must be localized.
  assert.match(source, /reservationForm\.existingReservationItem/);
  assert.match(source, /reservationForm\.conflictItem/);
  assert.match(source, /reservationForm\.andMore/);
  // Customer name stays a raw interpolation value (never translated).
  assert.match(source, /customer: res\.customerName/);
  // No leftover hardcoded English connectives / units / "... and N more".
  assert.doesNotMatch(source, / at \{res\.reservationTime\}/);
  assert.doesNotMatch(source, /\(\{res\.partySize\} guests\)/);
  assert.doesNotMatch(source, /\.\.\. and \{existingReservations\.length/);
});

test('reservationForm locale keys exist across en/el/de/fr/it with matching structure', () => {
  const enKeys = Object.keys(flatten(loadLocale('en').reservationForm ?? {})).sort();
  assert.ok(enKeys.length >= 25, `expected the full reservationForm namespace, got ${enKeys.length} keys`);

  for (const lng of POS_LOCALES) {
    const ns = loadLocale(lng).reservationForm;
    assert.ok(ns, `${lng} is missing the reservationForm namespace`);
    const keys = Object.keys(flatten(ns)).sort();
    assert.deepEqual(keys, enKeys, `${lng} reservationForm keys diverge from en`);
    for (const [key, value] of Object.entries(flatten(ns))) {
      assert.equal(typeof value, 'string', `${lng}.reservationForm.${key} must be a string`);
      assert.ok((value as string).length > 0, `${lng}.reservationForm.${key} is empty`);
    }
  }
});

test('Greek reservationForm values are real translations, not English fallbacks', () => {
  const en = flatten(loadLocale('en').reservationForm);
  const el = flatten(loadLocale('el').reservationForm);

  // Representative human-readable keys must be genuine Greek, not the English source.
  const textKeys = [
    'title', 'editTitle', 'customerName', 'customerNamePlaceholder', 'phone',
    'date', 'time', 'partySize', 'decreaseGuests', 'increaseGuests',
    'guests_one', 'guests_other', 'specialRequests',
    'specialRequestsPlaceholder', 'existingReservations', 'conflictWarning',
    'conflictDescription', 'conflictAction', 'cancel', 'save', 'create',
    'saving', 'creating', 'checking',
    'errors.nameRequired', 'errors.phoneRequired', 'errors.phoneInvalid',
    'errors.dateRequired', 'errors.timeRequired', 'errors.partySizeMin',
    'errors.partySizeExceedsCapacity',
  ];
  for (const key of textKeys) {
    assert.notEqual(el[key], en[key], `el.reservationForm.${key} still equals the English source`);
    assert.match(el[key], GREEK_LETTER, `el.reservationForm.${key} has no Greek letters: "${el[key]}"`);
  }

  // None of the reported English leak strings may appear anywhere in the Greek namespace.
  const englishLeaks = [
    'Edit Reservation', 'Customer Name', 'Phone Number', 'Number of Guests',
    'Special Requests', 'Save Changes', 'This table has existing reservations',
    'Any special requests', ' guests', ' at ',
  ];
  const elBlob = Object.values(el).join('\n');
  for (const phrase of englishLeaks) {
    assert.ok(!elBlob.includes(phrase), `Greek reservationForm leaks English: "${phrase}"`);
  }
});

test('reservationForm interpolation tokens are preserved across locales', () => {
  for (const lng of POS_LOCALES) {
    const ns = flatten(loadLocale(lng).reservationForm);
    assert.match(ns.subtitle, /\{\{tableNumber\}\}/, `${lng} subtitle lost {{tableNumber}}`);
    assert.match(ns.subtitle, /\{\{capacity\}\}/, `${lng} subtitle lost {{capacity}}`);
    assert.match(ns.subtitle, /\{\{guests\}\}/, `${lng} subtitle lost {{guests}}`);
    assert.match(ns.existingReservationItem, /\{\{date\}\}.*\{\{time\}\}.*\{\{customer\}\}.*\{\{guests\}\}/, `${lng} existingReservationItem lost tokens`);
    assert.match(ns.conflictItem, /\{\{time\}\}.*\{\{customer\}\}.*\{\{guests\}\}/, `${lng} conflictItem lost tokens`);
    assert.match(ns.guestCount_other, /\{\{count\}\}/, `${lng} guestCount_other lost {{count}}`);
    assert.match(ns['errors.partySizeExceedsCapacity'], /\{\{capacity\}\}/, `${lng} partySizeExceedsCapacity lost {{capacity}}`);
  }
});

test('ReservationForm subtitle uses the shared table display label, not a raw number with a hardcoded #', () => {
  // The subtitle showed "#P01" (raw number) while the dashboard/TableActionModal
  // showed "#TP01". It must run the number through the same shared helper.
  assert.match(source, /import \{ formatTableDisplayNumber \} from '\.\.\/\.\.\/utils\/table-display';/);
  assert.match(source, /tableNumber: formatTableDisplayNumber\(tableNumber\)/);
  // The raw `tableNumber,` interpolation is gone from the subtitle.
  assert.doesNotMatch(source, /reservationForm\.subtitle', \{\s*tableNumber,/);
  // The prop type accepts the real (string-capable) table number value.
  assert.match(source, /tableNumber: string \| number;/);

  // The formatted value already carries the "#", so the locale strings must not
  // add their own (which would produce a double "#"), while keeping the token.
  for (const lng of POS_LOCALES) {
    const subtitle = loadLocale(lng).reservationForm.subtitle;
    assert.match(subtitle, /\{\{tableNumber\}\}/, `${lng} subtitle must keep the {{tableNumber}} token`);
    assert.doesNotMatch(subtitle, /#\{\{tableNumber\}\}/, `${lng} subtitle must not hardcode a leading '#'`);
  }
});

// --- Behavioral: upcoming-only existing-reservations selection -------------
// The live defect warned about stale past reservations (2026-06-19 / 2026-06-20
// when creating a reservation on 2026-06-21). selectUpcomingTableReservations is
// the pure selector the form now derives the warning from.

const PAST_RESERVATIONS = [
  {
    id: 'r1',
    reservationDate: '2026-06-19',
    reservationTime: '19:00:00',
    reservationDatetime: '2026-06-19T19:00:00',
    customerName: 'Test Guest',
    partySize: 2,
    status: 'confirmed',
  },
  {
    id: 'r2',
    reservationDate: '2026-06-20',
    reservationTime: '19:00:00',
    reservationDatetime: '2026-06-20T19:00:00',
    customerName: 'QA Reservation',
    partySize: 4,
    status: 'pending',
  },
];

test('selectUpcomingTableReservations drops the stale past reservations from the live repro', () => {
  const now = new Date('2026-06-21T10:00:00');
  // Both rows are before today -> the warning must be empty (panel hidden).
  assert.deepEqual(selectUpcomingTableReservations(PAST_RESERVATIONS, { now }), []);
});

test('selectUpcomingTableReservations keeps today/future rows, sorted, excluding the edited one', () => {
  const now = new Date('2026-06-21T10:00:00');
  const rows = [
    ...PAST_RESERVATIONS,
    { id: 'future', reservationDate: '2026-06-22', reservationTime: '12:00:00', reservationDatetime: '2026-06-22T12:00:00' },
    { id: 'today', reservationDate: '2026-06-21', reservationTime: '20:00:00', reservationDatetime: '2026-06-21T20:00:00' },
  ];

  // Past dropped; today + future kept and sorted ascending by start.
  assert.deepEqual(
    selectUpcomingTableReservations(rows, { now }).map((r) => r.id),
    ['today', 'future'],
  );
  // The reservation currently being edited is excluded from its own warning.
  assert.deepEqual(
    selectUpcomingTableReservations(rows, { now, excludeId: 'today' }).map((r) => r.id),
    ['future'],
  );
});

test('selectUpcomingTableReservations treats a date-only row today as upcoming', () => {
  const now = new Date('2026-06-21T23:00:00');
  // No time -> start of day; still "today", so it stays relevant.
  assert.deepEqual(
    selectUpcomingTableReservations([{ id: 'today', reservationDate: '2026-06-21' }], { now }).map((r) => r.id),
    ['today'],
  );
  // The same date a day earlier is past and dropped.
  assert.deepEqual(
    selectUpcomingTableReservations([{ id: 'yesterday', reservationDate: '2026-06-20' }], { now }),
    [],
  );
});

test('resolveReservationStart prefers reservationDatetime, falls back to date+time', () => {
  // Full datetime wins even when date/time fields disagree.
  assert.equal(
    resolveReservationStart({
      reservationDatetime: '2026-06-21T20:30:00',
      reservationDate: '2020-01-01',
      reservationTime: '00:00:00',
    })?.getTime(),
    new Date('2026-06-21T20:30:00').getTime(),
  );
  // Falls back to date + time (HH:mm accepted) when datetime is absent.
  assert.equal(
    resolveReservationStart({ reservationDate: '2026-06-21', reservationTime: '20:00' })?.getTime(),
    new Date('2026-06-21T20:00:00').getTime(),
  );
  // Missing time defaults to start of day.
  assert.equal(
    resolveReservationStart({ reservationDate: '2026-06-21' })?.getTime(),
    new Date('2026-06-21T00:00:00').getTime(),
  );
  // Nothing parseable -> null (excluded from the warning).
  assert.equal(resolveReservationStart({}), null);
});

test('ReservationForm derives the warning from upcoming reservations, not the raw fetch', () => {
  assert.match(source, /selectUpcomingTableReservations\(existingReservations, \{/);
  assert.match(source, /excludeId: initialReservation\?\.id/);
  // The warning renders the derived upcoming list (gate, slice, "and more").
  assert.match(source, /\{upcomingReservations\.length > 0 && \(/);
  assert.match(source, /upcomingReservations\.slice\(0, 3\)/);
  assert.match(source, /upcomingReservations\.length > 3/);
});

test('ReservationForm renders reservation date/time through localized formatters', () => {
  assert.match(source, /import \{ formatDate, formatTime \} from '\.\.\/\.\.\/utils\/format';/);
  // Existing + conflict items format a resolved start instead of the raw fields.
  assert.match(source, /date: start \? formatDate\(start\) : res\.reservationDate/);
  assert.match(source, /formatTime\(start, \{ hour: '2-digit', minute: '2-digit' \}\)/);
  // The raw YYYY-MM-DD / HH:mm:ss fields are no longer fed straight to the UI.
  assert.doesNotMatch(source, /date: res\.reservationDate,/);
  assert.doesNotMatch(source, /time: res\.reservationTime,/);
});

test('ReservationForm exposes dialog semantics so it joins the topmost-modal behavior', () => {
  // The form was a plain group/heading; it must declare role="dialog" + aria-modal and a
  // labelled title so accessibility and the shared topmost-dialog logic do not drift.
  assert.match(source, /ref=\{dialogRef\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby="reservation-form-title"/);
  assert.match(source, /<h2 id="reservation-form-title"/);
});

test('ReservationForm closes on Escape only while open and only when it is the topmost dialog', () => {
  // isOpen-gated Escape effect (the `if (!isOpen) { return; }` immediately followed by
  // the handler is unique to this effect).
  assert.match(source, /if \(!isOpen\) \{\s*return;\s*\}\s*const handleEscape = \(event: KeyboardEvent\) => \{/);
  assert.match(source, /if \(event\.key !== 'Escape'\) \{\s*return;\s*\}/);
  // Topmost-dialog gate (mirrors TableActionModal), so a dialog above the form closes
  // first and an underlying modal is never dismissed instead.
  assert.match(source, /const dialogs = Array\.from\(document\.querySelectorAll\('\[role="dialog"\]'\)\);/);
  assert.match(source, /if \(dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== dialogRef\.current\) \{/);
  // Dismisses via handleCancel (reset + onCancel), and registers/cleans up the listener.
  assert.match(source, /handleCancel\(\);/);
  assert.match(source, /document\.addEventListener\('keydown', handleEscape\);/);
  assert.match(source, /document\.removeEventListener\('keydown', handleEscape\)/);
  assert.match(source, /\}, \[isOpen, handleCancel\]\);/);
});

test('ReservationForm Escape dismissal cancels and never submits/creates a reservation', () => {
  // Escape routes through handleCancel, which only resets the form and calls onCancel -
  // it must not invoke the create/submit path.
  const handleCancel = source.match(/const handleCancel = useCallback\(\(\) => \{[\s\S]*?\}, \[resetForm, onCancel\]\);/);
  assert.ok(handleCancel, 'handleCancel not found');
  assert.match(handleCancel[0], /resetForm\(\)/);
  assert.match(handleCancel[0], /onCancel\(\)/);
  assert.doesNotMatch(handleCancel[0], /createReservation|handleSubmit|reservationsService\./);
});

// Round 226 (live QA, glass consistency): ReservationForm still opened as an opaque white/dark panel with
// purple focus/save styling, hover effects, and a mojibake bullet, breaking the otherwise-glass reservation
// flow. It now adopts the SHARED liquid-glass tokens (shell/header/title/close/content/input/text/border)
// while keeping the renderModalPortal scaffolding, z-[1200], Escape, dialog semantics, and behaviour
// (all asserted above).
test('ReservationForm adopts the shared liquid-glass tokens (premium glass, not an opaque panel)', () => {
  // Dialog shell uses the shared glass surface class + a stable marker.
  assert.match(source, /role="dialog"[\s\S]*?className="liquid-glass-modal-shell/);
  assert.match(source, /data-reservation-form/);

  // Shared header / title / close / content / input tokens.
  assert.match(source, /className="liquid-glass-modal-header"/);
  assert.match(source, /<h2 id="reservation-form-title" className="liquid-glass-modal-title">/);
  assert.match(source, /className="liquid-glass-modal-close active:scale-95"/);
  assert.match(source, /liquid-glass-modal-content scrollbar-hide/);
  assert.match(source, /liquid-glass-modal-input/);
  assert.match(source, /liquid-glass-modal-text\b/);
  assert.match(source, /liquid-glass-modal-border/);

  // The old opaque shell + ad-hoc inputs are gone.
  assert.doesNotMatch(source, /bg-gray-900 border border-white\/10/);
  assert.doesNotMatch(source, /'bg-white'/);
});

test('ReservationForm is touch-first: no hover utilities, no native title tooltip, active tap feedback', () => {
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /\btitle=\{/);
  assert.match(source, /active:scale/);
  // The close button has a localized accessible label.
  assert.match(source, /aria-label=\{t\('common\.actions\.close'/);
});

test('ReservationForm uses semantic action colours (cancel red, create green) and no purple control styling', () => {
  // The old purple focus/save styling is gone entirely.
  assert.doesNotMatch(source, /purple/);
  // Cancel button is red; submit/create button is green.
  assert.match(source, /flex-1 inline-flex min-h-\[44px\][^"]*border-red-500\/50 bg-red-500\/10[^"]*text-red-600/);
  assert.match(source, /type="submit"[\s\S]*?bg-green-600 active:bg-green-700/);
});

test('ReservationForm guest steppers are centered 44px touch targets with active feedback + lucide icons', () => {
  const stepperHits = source.match(/inline-flex h-11 w-11 items-center justify-center rounded-xl[^"]*active:scale-95/g) || [];
  assert.ok(stepperHits.length >= 2, `guest steppers must be h-11 w-11 active-scale touch targets (found ${stepperHits.length})`);
  assert.match(source, /<Minus className="h-4 w-4" \/>/);
  assert.match(source, /<Plus className="h-4 w-4" \/>/);
  // Each icon-only stepper carries a localized accessible label via the reservationForm.* keys
  // (real translations in all five locales, not a defaultValue-only fallback).
  assert.match(source, /aria-label=\{t\('reservationForm\.decreaseGuests'/);
  assert.match(source, /aria-label=\{t\('reservationForm\.increaseGuests'/);
});

test('ReservationForm has no non-ASCII mojibake bullet and uses ASCII-safe list markers (i18n text preserved)', () => {
  // No non-ASCII anywhere in the component source -- the old U+2022 bullet glyph is gone.
  assert.doesNotMatch(source, new RegExp('[^\\x00-\\x7F]'));
  // Warning lists render their markers via CSS list-disc, not a literal bullet character.
  assert.match(source, /list-disc/);
  // Warning copy stays i18n-driven.
  assert.match(source, /t\('reservationForm\.existingReservationItem'/);
  assert.match(source, /t\('reservationForm\.conflictItem'/);
});
