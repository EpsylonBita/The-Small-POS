import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Round 350 (Codex live QA, Greek/dark, refreshed debug POS): from Dashboard > New Order the Room card opens a
// modal-only room workflow (NOT the standalone Rooms page): a Room action chooser with three clear actions
// (Room Order / Check-in / Create Reservation), each routing to a compact in-modal picker
// (occupied-folio / reserved / available rooms) with calm localized empty states and floor chips, and the
// New Reservation form with a required guest name. These source-read guards lock that behaviour so it cannot
// regress. Tests only -- no production source changed.
const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8');
const modals = read('src/renderer/components/modals/RoomStayWorkflowModals.tsx');
const dash = read('src/renderer/components/OrderDashboard.tsx');
const loadLocale = (lng: string): Record<string, any> => JSON.parse(read(path.join('src', 'locales', `${lng}.json`)));

const GREEK = /[Ͱ-Ͽ]/;

// Slice the OrderDashboard Room Flow chooser modal region (open -> close).
const roomFlowModalRegion = (): string => {
  const start = dash.indexOf('isOpen={showRoomFlowModal}');
  assert.notEqual(start, -1, 'OrderDashboard Room Flow chooser modal must exist');
  const end = dash.indexOf('</LiquidGlassModal>', start);
  assert.notEqual(end, -1, 'Room Flow modal must close');
  return dash.slice(start, end);
};

test('Round 350: New Order Room card opens a 3-action Room chooser modal (not the standalone Rooms page)', () => {
  const region = roomFlowModalRegion();

  // It is a glass modal titled by the room-flow key (a chooser, not a navigation to the Rooms page).
  assert.match(region, /title=\{t\("orderFlow\.roomFlowTitle"/);

  // Exactly the three actions, each a touch-first <button> with its semantic color + handler.
  // 1. Room Order -- amber/orange.
  assert.match(region, /onClick=\{handleRoomFlowOrder\}/);
  assert.match(region, /border-amber-400\/30[\s\S]*?from-amber-500\/10/);
  assert.match(region, /text-amber-400[\s\S]*?orderFlow\.roomFlowOrder/);
  // 2. Check-in -- green.
  assert.match(region, /onClick=\{handleRoomFlowCheckin\}/);
  assert.match(region, /border-green-400\/30[\s\S]*?from-green-500\/10/);
  assert.match(region, /text-green-400[\s\S]*?orderFlow\.roomFlowCheckin/);
  // 3. Create Reservation -- purple.
  assert.match(region, /onClick=\{handleRoomFlowReservation\}/);
  assert.match(region, /border-purple-400\/30[\s\S]*?from-purple-500\/10/);
  assert.match(region, /text-\[#a855f7\][\s\S]*?orderFlow\.roomFlowReservation/);

  // Touch-first: the chooser actions are real buttons with active-press only (no hover-era styling).
  assert.ok((region.match(/type="button"/g) ?? []).length >= 3, 'all three room actions must be type=button');
  assert.match(region, /active:scale-95/);
  assert.doesNotMatch(region, /hover:/);
  assert.doesNotMatch(region, /group-hover/);
});

test('Round 350: the New Order room actions use focused modal modules, never RoomsView/hubPreset', () => {
  // The dashboard imports the focused, purpose-built modal modules for the room actions.
  assert.match(
    dash,
    /import \{[\s\S]*?RoomStaySelectorModal,[\s\S]*?RoomCheckinModal,[\s\S]*?RoomReservationModal,[\s\S]*?\} from "\.\/modals\/RoomStayWorkflowModals";/,
  );
  // Check-in selects RESERVED rooms; Create Reservation selects AVAILABLE rooms -- via the selector variants.
  assert.match(dash, /<RoomStaySelectorModal[\s\S]*?variant="checkin"/);
  assert.match(dash, /<RoomStaySelectorModal[\s\S]*?variant="reservation"/);

  // The rejected approach (an embedded RoomsView armed with a hubPreset inside the workflow modal) stays gone:
  // no hubPreset on any RoomsView, and the ONLY RoomsView render is the browse-only Rooms hub tab.
  assert.doesNotMatch(dash, /<RoomsView\b[^>]*hubPreset/);
  assert.doesNotMatch(dash, /hubPresetSignal=\{/);
  const roomsViewUsages = dash.match(/<RoomsView\b[^/]*\/>/g) ?? [];
  assert.deepEqual(roomsViewUsages, ['<RoomsView embedded />'], 'RoomsView may only appear as the browse-only Rooms tab');
});

test('Round 350: RoomFloorChips resets to all-floors on open, hides below 2 floors, no native scrollbar', () => {
  // The selector resets the floor filter to "all" each time it (re)opens, so a stale floor cannot hide rooms.
  assert.match(modals, /useEffect\(\(\) => \{\s*if \(isOpen\) setFloorFilter\('all'\);\s*\}, \[isOpen\]\)/);

  // RoomFloorChips renders only when there are 2+ floors, with a calm "All Floors" + per-floor chip set.
  assert.match(modals, /export const RoomFloorChips/);
  assert.match(modals, /if \(floors\.length < 2\) return null;/);
  assert.match(modals, /t\('roomsView\.allFloors'/);
  assert.match(modals, /t\('roomsView\.floor', \{ floor/);
  // The chip rail and the room grid both hide the native scrollbar (touch POS).
  assert.match(modals, /overflow-x-auto scrollbar-hide[^"]*" role="group"/);
  assert.match(modals, /<RoomFloorChips floors=\{floors\}/);
  assert.match(modals, /grid[\s\S]*?overflow-y-auto scrollbar-hide/);
});

test('Round 350: room-order + check-in empty states have localized helper copy (Greek, not the dotted key)', () => {
  // Check-in selector (modals): primary empty + a reservation-first helper.
  assert.match(modals, /orderFlow\.roomCheckinEmpty'/);
  assert.match(modals, /orderFlow\.roomCheckinEmptyHint'/);
  // Room Order picker (OrderDashboard): primary empty + an open-folio-first helper.
  assert.match(dash, /orderFlow\.roomOrderEmpty"/);
  assert.match(dash, /orderFlow\.roomOrderEmptyHint"/);

  // All four empty/helper keys exist, are non-empty, and are real Greek translations (el != en).
  const en = loadLocale('en').orderFlow;
  const el = loadLocale('el').orderFlow;
  for (const key of ['roomOrderEmpty', 'roomOrderEmptyHint', 'roomCheckinEmpty', 'roomCheckinEmptyHint']) {
    assert.equal(typeof el[key], 'string', `el orderFlow.${key} must exist`);
    assert.ok(el[key].length > 0, `el orderFlow.${key} must be non-empty`);
    assert.match(el[key], GREEK, `el orderFlow.${key} must be Greek`);
    assert.notEqual(el[key], en[key], `el orderFlow.${key} must differ from English`);
  }
});

test('Round 350: selector room cards use formatted currency and a translated room type', () => {
  assert.match(modals, /import \{ formatCurrency \} from '\.\.\/\.\.\/utils\/format';/);
  // Room type is localized via the shared helper, and the available-room rate is shown via formatCurrency.
  assert.match(modals, /const typeLabel = translateRoomType\(t, room\.roomType\)/);
  assert.match(modals, /formatCurrency\(room\.ratePerNight \|\| 0\)/);
});

test('Round 350: New Reservation form has selected-room chip, required guest name, red cancel, disabled green create', () => {
  const start = modals.indexOf('export const RoomReservationModal');
  assert.notEqual(start, -1, 'RoomReservationModal must exist');
  const form = modals.slice(start);

  // Selected room chip + the New Reservation heading.
  assert.match(form, /title=\{t\('roomsView\.newReservation'/);
  assert.match(form, /<RoomChip room=\{room\}/);

  // Guest name is required; other fields (phone, dates, notes) are present but optional.
  assert.match(form, /label=\{t\('roomsView\.guestName'[\s\S]*?\n\s*required/);

  // Cancel = red destructive glass; Create = emerald, DISABLED until a name is entered (no submit on empty).
  assert.match(form, /border border-red-400\/40 bg-red-500\/15[\s\S]*?text-red-300/);
  assert.match(form, /disabled=\{!name\.trim\(\) \|\| submitting\}\s*\n\s*className="flex-1 rounded-xl border border-emerald-500 bg-emerald-600/);
  assert.match(form, /t\('roomsView\.createReservation'/);
  // The submit handler also fails closed on an empty name.
  assert.match(form, /if \(!name\.trim\(\) \|\| submitting\) return;/);
});

test('Round 350: New Check-in form mirrors the required-name + red-cancel/green-create contract', () => {
  const start = modals.indexOf('export const RoomCheckinModal');
  assert.notEqual(start, -1, 'RoomCheckinModal must exist');
  const end = modals.indexOf('export const RoomReservationModal', start);
  const form = modals.slice(start, end);

  assert.match(form, /title=\{t\('roomsView\.newCheckin'/);
  assert.match(form, /<RoomChip room=\{room\}/);
  assert.match(form, /label=\{t\('roomsView\.guestName'[\s\S]*?\n\s*required/);
  assert.match(form, /border border-red-400\/40 bg-red-500\/15[\s\S]*?text-red-300/);
  assert.match(form, /disabled=\{!name\.trim\(\) \|\| submitting\}\s*\n\s*className="flex-1 rounded-xl border border-emerald-500 bg-emerald-600/);
  assert.match(form, /t\('roomsView\.completeCheckin'/);
});

test('Round 350: room workflow modals are touch-first (no hover/group-hover/native title tooltips)', () => {
  assert.doesNotMatch(modals, /hover:/, 'room workflow modals must not use hover utilities');
  assert.doesNotMatch(modals, /group-hover/, 'room workflow modals must not use group-hover utilities');
  // The only title= props are the three LiquidGlassModal headings (title={title} / newCheckin / newReservation);
  // any other native title= tooltip is forbidden. (subtitle= is unaffected -- no \b before its "title".)
  assert.doesNotMatch(
    modals,
    /\btitle=\{(?!title\}|t\('roomsView\.new)/,
    'no native title= tooltip allowed (only LiquidGlassModal heading props)',
  );
});
