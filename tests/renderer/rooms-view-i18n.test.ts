import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const viewSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'verticals', 'hotel', 'RoomsView.tsx'),
  'utf8',
);

const locale = (language: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${language}.json`), 'utf8'));

const hookSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'hooks', 'useRooms.ts'),
  'utf8',
);

const serviceSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'services', 'RoomsService.ts'),
  'utf8',
);

// Round 236: RoomsView can be embedded in the Orders hub and driven by a check-in / reservation
// preset (a room tap routes straight into that flow), with the internal FAB hidden in the hub.
test('RoomsView supports embedded hub presets (Round 236)', () => {
  assert.match(viewSource, /interface RoomsViewProps/);
  assert.match(viewSource, /embedded\?: boolean/);
  assert.match(viewSource, /hubPreset\?: 'checkin' \| 'reservation' \| null/);
  assert.match(viewSource, /hubPresetSignal\?: number/);
  assert.match(viewSource, /const \[hubMode, setHubMode\] = useState<'checkin' \| 'reservation' \| null>\(null\)/);

  // The preset effect shows the relevant rooms first and arms hubMode.
  assert.match(viewSource, /if \(!hubPresetSignal \|\| !hubPreset\) return;/);
  assert.match(viewSource, /setStatusFilter\(hubPreset === 'checkin' \? 'reserved' : 'available'\)/);

  // A room tap in a preset routes straight to the matching existing flow.
  assert.match(viewSource, /if \(hubMode === 'checkin'\) \{[\s\S]*?openCheckinModal\(room\);/);
  assert.match(viewSource, /if \(hubMode === 'reservation'\) \{[\s\S]*?openReservationModal\(room\);/);

  // The internal FAB is hidden when embedded (the hub owns New Order).
  assert.match(viewSource, /\{!embedded && \(\s*<FloatingActionButton/);
});

// Round 236 follow-up (live QA): the embedded rooms grid must hide the native scrollbar without
// disabling scroll, and the hub preset must be one-shot (cleared after a room tap consumes it and
// when staff manually change the status filter).
test('RoomsView hub preset is one-shot and the embedded grid hides the native scrollbar (Round 236 follow-up)', () => {
  // Scroll is preserved (overflow-y-auto) but the native scrollbar is hidden when embedded.
  assert.match(
    viewSource,
    /className=\{`flex-1 overflow-y-auto space-y-4 pb-20 \$\{embedded \? 'scrollbar-hide' : ''\}`\}/,
  );

  // Consuming a preset disarms hubMode (one-shot) in both routes, before opening the flow.
  assert.match(viewSource, /if \(hubMode === 'checkin'\) \{\s*setHubMode\(null\);\s*openCheckinModal\(room\);/);
  assert.match(viewSource, /if \(hubMode === 'reservation'\) \{\s*setHubMode\(null\);\s*openReservationModal\(room\);/);

  // A manual status-filter change clears the armed preset, and both filter button groups use it.
  assert.match(
    viewSource,
    /const handleManualStatusFilterChange = \(next: RoomStatus \| 'all'\) => \{\s*setHubMode\(null\);\s*setStatusFilter\(next\);/,
  );
  assert.match(viewSource, /<StatusFilterButtons statusFilter=\{statusFilter\} setStatusFilter=\{handleManualStatusFilterChange\}/);
  assert.doesNotMatch(viewSource, /<StatusFilterButtons statusFilter=\{statusFilter\} setStatusFilter=\{setStatusFilter\}/);

  // The preset effect still sets statusFilter directly, so it does NOT self-clear hubMode.
  assert.match(viewSource, /setStatusFilter\(hubPreset === 'checkin' \? 'reserved' : 'available'\)/);
});

test('RoomsView routes its app-owned strings through i18n', () => {
  // Representative strings that were hardcoded English are now translated.
  assert.match(viewSource, /t\('roomsView\.stats\.total', \{ defaultValue: 'Total' \}\)/);
  assert.match(viewSource, /t\('roomsView\.searchPlaceholder', \{ defaultValue: 'Search room or guest\.\.\.' \}\)/);
  assert.match(viewSource, /t\('roomsView\.newCheckin', \{ defaultValue: 'New Check-in' \}\)/);
  assert.match(viewSource, /t\('roomsView\.newReservation', \{ defaultValue: 'New Reservation' \}\)/);
  assert.match(viewSource, /t\('roomsView\.completeCheckin'/);
  assert.match(viewSource, /t\('roomsView\.createReservation'/);
  assert.match(viewSource, /t\('roomsView\.actions\.checkin'/);
  assert.match(viewSource, /t\('roomsView\.toasts\.checkinSuccess'/);
  assert.match(viewSource, /roomsView\.paymentMethods\.\$\{method\}/);
  assert.match(viewSource, /roomsView\.chargeTypes\.\$\{type\}/);

  // No leftover hardcoded literals for the high-visibility controls.
  assert.doesNotMatch(viewSource, /label="Total"/);
  assert.doesNotMatch(viewSource, /placeholder="Search room or guest\.\.\."/);
  assert.doesNotMatch(viewSource, /title="New Check-in"/);
  assert.doesNotMatch(viewSource, /title="New Reservation"/);
  assert.doesNotMatch(viewSource, /label="Payment Amount"/);
  assert.doesNotMatch(viewSource, /toast(?:\.(?:error|success))?\(\s*['"]/);
});

test('roomsView translation keys are present in every locale', () => {
  const flatKeys = [
    'loading',
    'searchPlaceholder',
    'filters',
    'allFloors',
    'noRooms',
    'noRoomsHint',
    'newCheckin',
    'newReservation',
    'selectRoom',
    'chooseRoom',
    'completeCheckin',
    'createReservation',
    'numberOfNights',
    'checkInDate',
    'checkOutDate',
  ];
  const groups: Record<string, string[]> = {
    stats: ['total', 'available', 'occupied', 'cleaning', 'occupancy'],
    fields: ['status', 'type', 'capacity', 'ratePerNight', 'guest', 'folioBalance', 'guestsCount'],
    actions: ['checkin', 'reserve', 'checkout', 'addCharge'],
    paymentMethods: ['cash', 'card', 'transfer', 'bank_transfer', 'other'],
    chargeTypes: ['other', 'room', 'food', 'beverage', 'service', 'tax'],
    roomTypes: ['standard', 'deluxe', 'suite', 'penthouse', 'accessible'],
    toasts: [
      'checkinSuccess',
      'reservationCreated',
      'paymentPosted',
      'chargeAdded',
      'checkinFailed',
      'folioSkipped',
      'checkoutAlreadyCompleted',
      'checkoutCompleted',
      'statusUpdated',
      'statusUpdateFailed',
    ],
  };

  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const view = locale(language).roomsView;
    assert.ok(view, `${language} missing roomsView`);
    for (const key of flatKeys) {
      assert.equal(typeof view[key], 'string', `${language}.roomsView.${key} missing`);
      assert.ok(view[key].length > 0, `${language}.roomsView.${key} empty`);
    }
    for (const [group, keys] of Object.entries(groups)) {
      for (const key of keys) {
        assert.equal(typeof view[group]?.[key], 'string', `${language}.roomsView.${group}.${key} missing`);
      }
    }
    // Interpolated keys must keep their placeholders in every locale.
    assert.match(view.floor, /\{\{floor\}\}/, `${language}.roomsView.floor must keep {{floor}}`);
    assert.match(view.roomTitle, /\{\{number\}\}/, `${language}.roomsView.roomTitle must keep {{number}}`);
    assert.match(view.fields.guestsCount, /\{\{count\}\}/, `${language}.roomsView.fields.guestsCount must keep {{count}}`);
  }
});

const flattenStrings = (obj: Record<string, any>, prefix = ''): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      Object.assign(out, flattenStrings(value, dotted));
    } else if (typeof value === 'string') {
      out[dotted] = value;
    }
  }
  return out;
};

test('non-English roomsView copy never leaks raw English "check-out"/"checkout"', () => {
  const CHECKOUT_EN = /check-?out|checkout/i;
  // English keeps "Checkout"; every other locale must use native wording.
  for (const language of ['el', 'de', 'fr', 'it']) {
    const flat = flattenStrings(locale(language).roomsView ?? {});
    for (const [key, value] of Object.entries(flat)) {
      assert.ok(
        !CHECKOUT_EN.test(value),
        `${language}.roomsView.${key} still contains raw English checkout: "${value}"`,
      );
    }
  }
});

test('roomsView checkout action/CTA/toasts are real translations, not the English source', () => {
  const en = locale('en').roomsView;
  // Greek uses the natural departure wording for the primary action.
  assert.equal(locale('el').roomsView.actions.checkout, 'Αναχώρηση');

  const checkoutKeys: string[] = [
    'actions.checkout',
    'postPaymentCheckout',
    'toasts.folioCheckoutOffline',
    'toasts.checkoutQueued',
    'toasts.checkoutHousekeepingFailed',
    'toasts.folioSkipped',
    'toasts.checkoutAlreadyCompleted',
    'toasts.checkoutCompleted',
    'toasts.checkoutFailed',
  ];
  const enFlat = flattenStrings(en);
  for (const language of ['el', 'de', 'fr', 'it']) {
    const flat = flattenStrings(locale(language).roomsView);
    for (const key of checkoutKeys) {
      assert.equal(typeof flat[key], 'string', `${language}.roomsView.${key} missing`);
      assert.notEqual(
        flat[key],
        enFlat[key],
        `${language}.roomsView.${key} still equals the English source`,
      );
    }
  }
});

test('RoomsView floating action no longer hard-wires check-in while using the check-in-or-reservation label', () => {
  // The FAB previously always opened the check-in modal even though its label
  // promised a check-in OR reservation choice. It must branch on hasReservations.
  assert.doesNotMatch(viewSource, /onClick=\{\(\) => setModalType\('checkin'\)\}/);
  assert.match(viewSource, /onClick=\{\(\) => setModalType\(hasReservations \? 'chooseCreate' : 'checkin'\)\}/);
  // Label matches behaviour: choice label only when reservations are available,
  // plain check-in label otherwise.
  assert.match(viewSource, /hasReservations\s*\?\s*t\('roomsView\.newCheckinOrReservation'/);
});

test('RoomsView create-choice modal is portaled (blur/high-z) with separate check-in and reservation actions', () => {
  const chooseBlock = viewSource.match(/modalType === 'chooseCreate'[\s\S]*?<\/Modal>/);
  assert.ok(chooseBlock, 'chooseCreate modal block not found');
  // Only reachable when reservations are enabled.
  assert.match(chooseBlock[0], /modalType === 'chooseCreate' && hasReservations/);
  // Rendered through the shared Modal (which portals) with both opener actions.
  assert.match(chooseBlock[0], /<Modal\b/);
  assert.match(chooseBlock[0], /openCheckinModal\(\)/);
  assert.match(chooseBlock[0], /openReservationModal\(\)/);

  // The shared Modal still mounts via the app-level portal with backdrop blur and
  // a high z-index, so the choice overlay never renders inside the page container.
  assert.match(viewSource, /return renderModalPortal\(/);
  assert.match(viewSource, /fixed inset-0 z-\[1200\]/);
  assert.match(viewSource, /bg-black\/50 backdrop-blur-sm/);

  // newCheckinOrReservation is now also a modal title, so it must exist everywhere.
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const value = locale(language).roomsView?.newCheckinOrReservation;
    assert.equal(typeof value, 'string', `${language} missing roomsView.newCheckinOrReservation`);
    assert.ok(value.length > 0, `${language} empty roomsView.newCheckinOrReservation`);
  }
});

test('RoomsView room-option labels show formatted money, not the raw ratePerNight', () => {
  // The room picker showed "(145/night)" instead of formatted money like the rest
  // of the Rooms UI. The rate must pass through formatMoney before interpolation.
  assert.doesNotMatch(viewSource, /rate: room\.ratePerNight\b/);
  const formatted = viewSource.match(/rate: formatMoney\(room\.ratePerNight \|\| 0\)/g) || [];
  assert.ok(formatted.length >= 2, `both room-option lists must format the rate (found ${formatted.length})`);
});

test('RoomsView money uses the locale-aware currency helper, not hardcoded "$"', () => {
  // formatMoney must delegate to the shared POS currency formatter (Greek "145,00 €"),
  // not build a hardcoded "$" + toFixed string.
  assert.match(viewSource, /import \{ formatCurrency, formatDate \} from '\.\.\/\.\.\/\.\.\/utils\/format';/);
  assert.match(viewSource, /const formatMoney = \(amount: number\): string => formatCurrency\(Number\(amount\) \|\| 0\);/);
  assert.doesNotMatch(viewSource, /\$\{amount\.toFixed\(2\)\}/);
  // The previously hardcoded "$" rate and check-in total are gone.
  assert.doesNotMatch(viewSource, /\$\{actionRoom\.ratePerNight\}/);
  assert.doesNotMatch(viewSource, /\$\{checkinData\.totalAmount\.toFixed/);
  assert.match(viewSource, /\{formatMoney\(actionRoom\.ratePerNight\)\}/);
  assert.match(viewSource, /\{formatMoney\(checkinData\.totalAmount\)\}/);
});

test('RoomsView localizes room-type slugs through translateRoomType (cards, detail, selectors)', () => {
  // A shared helper resolves known slugs via roomsView.roomTypes.* and preserves
  // genuinely custom names when no mapping exists.
  assert.match(viewSource, /const translateRoomType = \(t: RoomTranslateFn, roomType\?: string \| null\): string =>/);
  assert.match(viewSource, /t\(`roomsView\.roomTypes\.\$\{raw\.toLowerCase\(\)\}`, \{ defaultValue: '' \}\)/);
  // Custom names are preserved (returns raw when no localized value is found).
  assert.match(viewSource, /return typeof localized === 'string' && localized \? localized : raw;/);

  // Every room-type render goes through the helper: card, detail modal, both selectors.
  const localized = viewSource.match(/translateRoomType\(t, /g) || [];
  assert.ok(localized.length >= 4, `expected >=4 translateRoomType usages, found ${localized.length}`);
  // No raw room-type renders survive.
  assert.doesNotMatch(viewSource, /\{room\.roomType\}/);
  assert.doesNotMatch(viewSource, /\{actionRoom\.roomType\}/);
  assert.doesNotMatch(viewSource, /type: room\.roomType\b/);
});

test('room-type labels are real Greek translations, not the raw English slugs', () => {
  const el = locale('el').roomsView.roomTypes;
  const en = locale('en').roomsView.roomTypes;
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');
  for (const slug of ['standard', 'deluxe', 'suite', 'penthouse', 'accessible']) {
    assert.equal(typeof el[slug], 'string', `el roomTypes.${slug} missing`);
    assert.match(el[slug], GREEK_LETTER, `el roomTypes.${slug} should be Greek: "${el[slug]}"`);
    assert.notEqual(el[slug], en[slug], `el roomTypes.${slug} must differ from the English label`);
    assert.notEqual(el[slug].toLowerCase(), slug, `el roomTypes.${slug} must not be the raw slug`);
  }
  // English keeps the canonical labels.
  assert.equal(en.standard, 'Standard');
  assert.equal(en.penthouse, 'Penthouse');
});

// Regression contract for the room status-change bug (2026-06-21 live QA): the toast was
// hardcoded English and updateStatus returned only a boolean, so the open modal summary
// and the grid/stats could disagree until a manual refresh.
test('useRooms localizes the status-change toast and aligns effectiveStatus on success', () => {
  // Toast text comes from i18n, not a hardcoded English template.
  assert.match(hookSource, /import \{ useTranslation \} from 'react-i18next';/);
  assert.match(hookSource, /const \{ t \} = useTranslation\(\);/);
  assert.match(hookSource, /const statusLabel = t\(`roomsView\.status\.\$\{status\}`/);
  assert.match(
    hookSource,
    /t\('roomsView\.toasts\.statusUpdated', \{[\s\S]*?status: statusLabel[\s\S]*?\}\)/,
  );
  assert.match(hookSource, /t\('roomsView\.toasts\.statusUpdateFailed'/);
  // The old hardcoded English toast is gone.
  assert.doesNotMatch(hookSource, /Room status updated to \$\{status\}/);

  // An explicit status change aligns effectiveStatus to the chosen status so the stats
  // (room.status) and the cards/modal (effectiveStatus || status) agree without a refetch.
  assert.match(hookSource, /const normalized: Room = \{ \.\.\.updated, status, effectiveStatus: status \};/);
  assert.match(hookSource, /prev\.map\(\(r\) => \(r\.id === roomId \? normalized : r\)\)/);

  // updateStatus returns the normalized room (not a bare boolean) so callers can sync.
  assert.match(
    hookSource,
    /updateStatus = useCallback\(async \(roomId: string, status: RoomStatus\): Promise<Room \| null>/,
  );
  assert.match(hookSource, /return normalized;/);
  assert.match(hookSource, /return null;/);
  assert.match(
    hookSource,
    /updateStatus: \(roomId: string, status: RoomStatus\) => Promise<Room \| null>;/,
  );
});

test('RoomsView status change updates the open modal summary status AND effectiveStatus on success', () => {
  // handleStatusChange consumes the returned room and syncs both fields, so the modal
  // summary (getRoomEffectiveStatus(actionRoom)) reflects the new status immediately.
  assert.match(viewSource, /const updated = await updateStatus\(roomId, newStatus\);/);
  assert.match(
    viewSource,
    /if \(updated && actionRoom\?\.id === roomId\) \{[\s\S]*?setActionRoom\(prev =>[\s\S]*?\{ \.\.\.prev, status: updated\.status, effectiveStatus: updated\.effectiveStatus \}/,
  );
  // The stale single-field update (status only, leaving effectiveStatus old) is gone.
  assert.doesNotMatch(viewSource, /setActionRoom\(prev => prev \? \{ \.\.\.prev, status: newStatus \} : null\)/);

  // The shared Modal still portals with backdrop blur (portal/blur behavior intact).
  assert.match(viewSource, /return renderModalPortal\(/);
  assert.match(viewSource, /bg-black\/50 backdrop-blur-sm/);
});

test('roomsView status-update toasts exist in every locale with {{status}} kept and Greek translated', () => {
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const toasts = locale(language).roomsView?.toasts;
    assert.equal(typeof toasts?.statusUpdated, 'string', `${language} missing roomsView.toasts.statusUpdated`);
    assert.equal(typeof toasts?.statusUpdateFailed, 'string', `${language} missing roomsView.toasts.statusUpdateFailed`);
    assert.match(toasts.statusUpdated, /\{\{status\}\}/, `${language} statusUpdated must keep {{status}}`);
  }
  const en = locale('en').roomsView.toasts;
  const el = locale('el').roomsView.toasts;
  assert.notEqual(el.statusUpdated, en.statusUpdated, 'el statusUpdated must be translated');
  assert.notEqual(el.statusUpdateFailed, en.statusUpdateFailed, 'el statusUpdateFailed must be translated');
  assert.match(el.statusUpdated, GREEK, 'el statusUpdated should be Greek');
  assert.match(el.statusUpdateFailed, GREEK, 'el statusUpdateFailed should be Greek');
});

// Regression contract for the inconsistent Rooms grid (2026-06-21 live QA): the cards used
// effectiveStatus || status, but the status filter (useRooms) and the dashboard stats
// (RoomsService.calculateStats) counted by raw room.status — so the Reserved filter showed
// rooms that rendered Available, and the Available stat disagreed with the visible cards.
// All three must share one getRoomEffectiveStatus helper.
test('RoomsService exposes a shared getRoomEffectiveStatus and stats count by it, not raw status', () => {
  // The shared helper is effectiveStatus || status.
  assert.match(
    serviceSource,
    /export const getRoomEffectiveStatus = \(\s*room: \{ status: RoomStatus; effectiveStatus: RoomStatus \| null \},?\s*\): RoomStatus => room\.effectiveStatus \|\| room\.status;/,
  );

  // calculateStats counts by the effective status (one resolve per room), not raw r.status.
  assert.match(serviceSource, /const status = getRoomEffectiveStatus\(r\);/);
  for (const s of ['available', 'occupied', 'cleaning', 'maintenance', 'reserved']) {
    assert.match(serviceSource, new RegExp(`if \\(status === '${s}'\\) stats\\.`), `stats must count ${s} by effective status`);
  }
  // The old raw-status counting is gone.
  assert.doesNotMatch(serviceSource, /if \(r\.status === 'available'\) stats\./);
  assert.doesNotMatch(serviceSource, /if \(r\.status === 'reserved'\) stats\./);
});

test('useRooms status filter counts by effective status (matches the grid cards), not raw status', () => {
  // The hook imports the shared helper from RoomsService.
  assert.match(hookSource, /import \{[\s\S]*?getRoomEffectiveStatus[\s\S]*?\} from '\.\.\/services\/RoomsService';/);
  // The status filter selects rooms by effective status.
  assert.match(hookSource, /filtered = filtered\.filter\(r => getRoomEffectiveStatus\(r\) === statusFilter\)/);
  // The old raw-status filter is gone.
  assert.doesNotMatch(hookSource, /filtered = filtered\.filter\(r => r\.status === statusFilter\)/);

  // The manual-update normalization is preserved: an explicit status change aligns
  // effectiveStatus to the chosen status, so effective-status filtering/stats stay correct.
  assert.match(hookSource, /const normalized: Room = \{ \.\.\.updated, status, effectiveStatus: status \};/);
});

test('RoomsView cards/actions use the shared getRoomEffectiveStatus (single source, no local copy)', () => {
  // RoomsView imports the shared helper and no longer defines its own copy.
  assert.match(viewSource, /import \{ getRoomEffectiveStatus \} from '\.\.\/\.\.\/\.\.\/services\/RoomsService';/);
  assert.doesNotMatch(viewSource, /const getRoomEffectiveStatus = /);
  // It still renders cards/actions through the helper (so the grid and filter/stats agree).
  assert.match(viewSource, /getRoomEffectiveStatus\(/);
});

// Regression contract for the detail-modal mismatch (2026-06-21 retest): the summary +
// available/reserved action gates used getRoomEffectiveStatus(actionRoom), but the occupied
// action gate and the quick status buttons (active/disabled styling) still read raw
// actionRoom.status — so room 201's summary said Διαθέσιμο while the quick grid highlighted
// Κρατημένο. Every detail surface must compare against the effective status.
test('RoomsView detail quick-status buttons compare against getRoomEffectiveStatus(actionRoom), not raw status', () => {
  // No detail surface reads raw actionRoom.status anymore.
  assert.doesNotMatch(viewSource, /actionRoom\.status/);

  // The quick status button disabled + active styling both compare effective status === status.
  assert.match(viewSource, /disabled=\{getRoomEffectiveStatus\(actionRoom\) === status\}/);
  assert.match(
    viewSource,
    /className=\{`py-2 px-2 rounded-2xl text-xs font-medium transition-transform active:scale-95 \$\{\s*getRoomEffectiveStatus\(actionRoom\) === status/,
  );
  // The old raw-status quick-status comparisons are gone.
  assert.doesNotMatch(viewSource, /disabled=\{actionRoom\.status === status\}/);
  assert.doesNotMatch(viewSource, /\{actionRoom\.status === status/);
});

test('Round 429: Rooms reservation controls stay on the yellow/amber system with smoother touch controls', () => {
  assert.match(viewSource, /reserved: \{ color: 'text-yellow-500', bgClass: 'bg-yellow-500\/10 border-yellow-500\/30'/);
  assert.match(viewSource, /label=\{t\('roomsView\.newReservation'[\s\S]*?color="amber"/);
  assert.match(viewSource, /label=\{t\('roomsView\.actions\.reserve'[\s\S]*?color="amber"/);
  assert.match(viewSource, /className="flex-1 py-3 rounded-2xl font-medium bg-emerald-500 text-white active:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"/);
  assert.match(viewSource, /className=\{`px-3 py-1\.5 rounded-2xl text-xs sm:text-sm font-medium transition-transform active:scale-95/);
  assert.match(viewSource, /className=\{`px-3 py-1\.5 rounded-2xl text-xs sm:text-sm \$\{/);
  assert.match(viewSource, /className=\{`h-9 w-9 rounded-full inline-flex items-center justify-center transition-transform active:scale-95/);
  assert.match(viewSource, /className=\{`flex items-center justify-center gap-2 py-3 px-4 rounded-2xl font-medium transition-transform active:scale-95/);
  assert.doesNotMatch(viewSource, /purple-/);
  assert.doesNotMatch(viewSource, /color="purple"/);
  assert.doesNotMatch(viewSource, /rounded-lg/);
});

test('RoomsView occupied detail action gate (checkout/add-charge) uses effective status, not raw status', () => {
  // The occupied action block (checkout + add-charge) is gated by effective status, matching
  // the summary and the available/reserved gates.
  assert.match(viewSource, /\{getRoomEffectiveStatus\(actionRoom\) === 'occupied' && \(/);
  assert.doesNotMatch(viewSource, /\{actionRoom\.status === 'occupied' && \(/);

  // The available/reserved gates and the summary already use the effective status (unchanged).
  assert.match(viewSource, /\{getRoomEffectiveStatus\(actionRoom\) === 'available' && \(/);
  assert.match(viewSource, /\{getRoomEffectiveStatus\(actionRoom\) === 'reserved' && \(/);
  assert.match(viewSource, /statusConfig\[getRoomEffectiveStatus\(actionRoom\)\]\.color/);

  // Checkout/add-charge wiring itself is untouched (only the visibility gate changed).
  assert.match(viewSource, /label=\{t\('roomsView\.actions\.checkout'[\s\S]*?onClick=\{handleCheckout\}/);
  assert.match(viewSource, /onClick=\{\(\) => openFolioChargeModal\(actionRoom\)\}/);
});

// Regression contract for filter-constrained action selectors (2026-06-21 live QA): the
// create/check-in/reservation room selectors derived from the grid-filtered `rooms`, so a
// staff search for one occupied room (e.g. 204) hid every selectable room. Action surfaces
// must use the full unfiltered branch set (allRooms); only the visible grid stays filtered.
test('useRooms exposes both the filtered grid rooms and the unfiltered allRooms set', () => {
  // The hook contract returns allRooms (the private unfiltered set) alongside rooms.
  assert.match(hookSource, /allRooms: Room\[\];/, 'UseRoomsReturn must declare allRooms');
  assert.match(hookSource, /return \{\s*rooms,\s*allRooms,/, 'the hook must return allRooms next to rooms');
  // rooms is still the client-filtered grid list (unchanged), so the grid keeps filtering.
  assert.match(hookSource, /const rooms = useMemo\(/);
  assert.match(hookSource, /filtered = filtered\.filter\(r => getRoomEffectiveStatus\(r\) === statusFilter\)/);
});

test('RoomsView action room selectors + submit lookups use the unfiltered allRooms, not the filtered grid rooms', () => {
  // The view destructures allRooms from the hook.
  assert.match(viewSource, /const \{ rooms, allRooms,[^}]*\} = useRooms\(/);

  // The selector option source is derived from allRooms (filtered only by effective status).
  assert.match(viewSource, /const availableRooms = allRooms\.filter\(r => getRoomEffectiveStatus\(r\) === 'available'\);/);
  assert.doesNotMatch(viewSource, /const availableRooms = rooms\.filter\(/);
  // The check-in and reservation modals render options from availableRooms.
  assert.ok(
    (viewSource.match(/\{availableRooms\.map\(room =>/g) || []).length >= 2,
    'both the check-in and reservation selectors should list availableRooms',
  );

  // Selected-room submit lookups (check-in + reservation) resolve from allRooms.
  assert.match(viewSource, /const selectedRoom = allRooms\.find\(\(room\) => room\.id === checkinData\.roomId\);/);
  assert.match(viewSource, /const selectedRoom = allRooms\.find\(r => r\.id === reservationData\.roomId\);/);
  // The check-in total rate lookup also resolves from allRooms (filter can't zero the total).
  assert.match(viewSource, /const room = allRooms\.find\(r => r\.id === roomId\);/);
  // No action-path lookup falls back to the filtered grid rooms anymore.
  assert.doesNotMatch(viewSource, /const selectedRoom = rooms\.find\(/);

  // The visible grid grouping STILL uses the filtered rooms (grid stays filtered).
  assert.match(viewSource, /const floorRooms = rooms\.filter\(r => r\.floor === floor\);/);
});

// Round 254 (live QA, 1282x802, Greek/dark, Orders hub -> Rooms tab): the search placeholder was
// clipped ("Αναζήτηση δωμα...") because the search field shared one desktop row with the status chips,
// floor select, and refresh. The search now sits on its own full-width row (data-rooms-search / w-full),
// and the status/floor/refresh controls wrap on a separate row below (data-rooms-filter-controls) — so
// long localized placeholders are never squeezed. Filtering wiring + touch rules are unchanged.
test('Round 254: Rooms search is its own full-width row, not squeezed by the desktop status/floor/refresh controls', () => {
  // The search & filter bar stacks vertically (no sm:flex-row), so search never shares a row with the controls.
  assert.match(
    viewSource,
    /\{\/\* Search & Filter Bar \*\/\}\s*<motion\.div variants=\{pageMotionItem\} data-rooms-filter-bar className="flex flex-col gap-2 sm:gap-3 mb-3 sm:mb-4">/,
  );
  // The old single-row (sm:flex-row) search bar that squeezed the field is gone.
  assert.doesNotMatch(
    viewSource,
    /Search & Filter Bar \*\/\}\s*<motion\.div variants=\{pageMotionItem\} className="flex flex-col sm:flex-row/,
  );

  // The search field is a full-width row (w-full), not a squeezable flex-1, and keeps its i18n placeholder.
  assert.match(
    viewSource,
    /<div data-rooms-search className=\{`relative w-full \$\{isDark \? 'text-white' : 'text-gray-900'\}`\}>/,
  );
  assert.doesNotMatch(viewSource, /<div className=\{`relative flex-1 \$\{isDark \? 'text-white' : 'text-gray-900'\}`\}>/);
  assert.match(
    viewSource,
    /data-rooms-search[\s\S]*?placeholder=\{t\('roomsView\.searchPlaceholder', \{ defaultValue: 'Search room or guest\.\.\.' \}\)\}/,
  );

  // The status filters + floor selector + refresh live in a separate wrapping controls row, after the search.
  assert.match(viewSource, /<div data-rooms-filter-controls className="flex flex-wrap items-center gap-2">/);
  assert.ok(
    viewSource.indexOf('data-rooms-search') < viewSource.indexOf('data-rooms-filter-controls'),
    'the search row must come before the controls row',
  );
  const controlsRegion = viewSource.slice(
    viewSource.indexOf('data-rooms-filter-controls'),
    viewSource.indexOf('{/* Mobile Filters'),
  );
  assert.match(
    controlsRegion,
    /<StatusFilterButtons statusFilter=\{statusFilter\} setStatusFilter=\{handleManualStatusFilterChange\}/,
  );
  assert.match(controlsRegion, /<FloorSelect floorFilter=\{floorFilter\}/);
  assert.match(controlsRegion, /onClick=\{\(\) => refetch\(\)\}/);
  // The desktop filters wrap so many translated status chips never force a horizontal squeeze.
  assert.match(controlsRegion, /<div className="hidden sm:flex flex-wrap gap-2">/);

  // Touch rules preserved on the relocated bar: active feedback, no hover-only utilities, no native title.
  const barRegion = viewSource.slice(
    viewSource.indexOf('data-rooms-filter-bar'),
    viewSource.indexOf('{/* Mobile Filters'),
  );
  assert.match(barRegion, /active:bg-gray-700/);
  assert.doesNotMatch(barRegion, /hover:/);
  assert.doesNotMatch(barRegion, /\stitle=/);
});
