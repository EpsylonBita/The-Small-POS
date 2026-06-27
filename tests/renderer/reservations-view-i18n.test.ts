import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const viewSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'verticals', 'restaurant', 'ReservationsView.tsx'),
  'utf8',
);

const locale = (language: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${language}.json`), 'utf8'));

const hookSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'hooks', 'useReservations.ts'),
  'utf8',
);

test('Round 369: ReservationsView renders the standard visible page title above its tabs', () => {
  assert.match(
    viewSource,
    /<h1 className=\{`truncate text-3xl font-bold tracking-tight \$\{isDark \? 'text-white' : 'text-gray-900'\}`\}>\s*\{t\('navigation\.menu\.reservations', \{ defaultValue: 'Reservations' \}\)\}\s*<\/h1>/,
  );
  assert.match(
    viewSource,
    /data-vertical-hero="reservations"[\s\S]*rounded-3xl border p-4 backdrop-blur-xl[\s\S]*navigation\.menu\.reservations[\s\S]*availableReservationTabs\.length > 1[\s\S]*reservationsView\.stats\.total/,
    'Reservations title, module tabs and stats should live in the same rounded glass hero',
  );
  assert.ok(
    viewSource.indexOf('navigation.menu.reservations') < viewSource.indexOf('availableReservationTabs.length > 1'),
    'Reservations page title must render before the tab row',
  );
});

test('ReservationsView single-module headers use dedicated keys, not the short tab labels', () => {
  // The tab buttons and the single-module section title both used reservationsView.tabs.*,
  // which collapses to one value once translated. Headers now use their own keys.
  assert.match(viewSource, /reservationsView\.headers\.tables', \{ defaultValue: 'Table Reservations' \}/);
  assert.match(viewSource, /reservationsView\.headers\.rooms', \{ defaultValue: 'Room Reservations' \}/);
  assert.match(viewSource, /reservationsView\.headers\.services', \{ defaultValue: 'Service Reservations' \}/);
  // The create button's accessible name reuses createTitle so "Create Reservation" survives translation.
  assert.match(viewSource, /reservationsView\.createTitle', \{ defaultValue: 'Create Reservation' \}/);
});

// Round 191 (touch-first, live QA): the top Create + Refresh controls carried native DOM `title=`
// tooltips, which surfaced as "… Description: …" hover text in the accessibility tree on the
// touchscreen POS. They must expose their accessible names via aria-label instead — no native
// title tooltips and no hover utilities anywhere in the view.
test('ReservationsView top Create/Refresh controls use aria-labels, not native title tooltips', () => {
  // No native browser tooltip and no hover utilities anywhere in the view.
  assert.doesNotMatch(viewSource, /\btitle=/);
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /dark:hover:/);
  assert.doesNotMatch(viewSource, /group-hover:/);

  // Create keeps the SAME 3-way branching accessible name the old title used
  // (service-disabled reason → service booking → generic create) via aria-label.
  assert.match(
    viewSource,
    /aria-label=\{activeTab === 'services' && !hasServiceReservations\s*\?\s*t\('reservationsView\.createServiceInAppointments'[\s\S]*?:\s*activeTab === 'services'\s*\?\s*t\('reservationsView\.createServiceTitle'[\s\S]*?:\s*t\('reservationsView\.createTitle'/,
  );
  // Create disabled logic + visible icon/label are preserved.
  assert.match(viewSource, /disabled=\{activeTab === 'services' && !hasServiceReservations\}/);
  assert.match(viewSource, /<Plus className="w-4 h-4 shrink-0" \/>\s*\{t\('reservationsView\.create'/);

  // Refresh keeps its localized aria-label, the tab-aware refetch handlers, and the
  // spin-on-loading RefreshCw icon.
  assert.match(viewSource, /aria-label=\{t\('reservationsView\.refresh', \{ defaultValue: 'Refresh' \}\)\}/);
  assert.match(
    viewSource,
    /onClick=\{\(\) => \{\s*if \(activeTab === 'services'\) \{\s*void refetchAppointments\(\);\s*\} else \{\s*void refetch\(\);\s*\}\s*\}\}/,
  );
  assert.match(viewSource, /<RefreshCw className=\{`w-5 h-5 shrink-0 \$\{isActiveLoading \? 'animate-spin' : ''\}`\} \/>/);
});

// Round 193 (icon consistency, live QA): the Tables tab + single-module Tables header used the lucide
// UtensilsCrossed (fork/utensils) glyph, which read as a food/menu mark rather than a table. They must
// use the user-approved shared TableOrderIcon -- the same table/chair artwork the order-type chooser
// uses. Rooms (BedDouble) and Services (Scissors) are unchanged.
test('ReservationsView uses the shared TableOrderIcon for the tables tab + header, not UtensilsCrossed', () => {
  // Shared chooser icon is imported from the canonical icons module.
  assert.match(viewSource, /import TableOrderIcon from '\.\.\/\.\.\/\.\.\/components\/icons\/TableOrderIcon';/);

  // Tab loop: the tables fall-through icon is TableOrderIcon (rooms -> BedDouble, services -> Scissors).
  assert.match(
    viewSource,
    /const Icon = tab === 'rooms' \? BedDouble : tab === 'services' \? Scissors : TableOrderIcon;/,
  );
  // Single-module header for the tables tab renders the shared TableOrderIcon.
  assert.match(
    viewSource,
    /<TableOrderIcon className=\{`w-6 h-6 shrink-0 \$\{isDark \? 'text-yellow-400' : 'text-yellow-600'\}`\} \/>/,
  );

  // UtensilsCrossed is fully gone from this view (no leftover import or render).
  assert.doesNotMatch(viewSource, /UtensilsCrossed/);

  // Rooms (BedDouble) + Services (Scissors) are unchanged in both the tab loop and the header.
  assert.match(viewSource, /\bBedDouble\b/);
  assert.match(viewSource, /\bScissors\b/);
  assert.match(
    viewSource,
    /<BedDouble className=\{`w-6 h-6 shrink-0 \$\{isDark \? 'text-yellow-400' : 'text-yellow-600'\}`\} \/>/,
  );
  assert.match(
    viewSource,
    /<Scissors className=\{`w-6 h-6 shrink-0 \$\{isDark \? 'text-yellow-400' : 'text-yellow-600'\}`\} \/>/,
  );

  // No native title tooltip / hover utilities introduced by the icon swap.
  assert.doesNotMatch(viewSource, /\btitle=/);
  assert.doesNotMatch(viewSource, /hover:/);
});

test('Round 431: ReservationsView quick actions and close buttons keep smooth touch radii', () => {
  assert.match(
    viewSource,
    /className=\{`inline-flex items-center justify-center text-center px-2 py-1 rounded-2xl text-xs font-medium transition-transform active:scale-95 \$\{/,
  );
  const roundedCloseButtons =
    viewSource.match(
      /className=\{`inline-flex items-center justify-center shrink-0 p-1\.5 rounded-full transition-transform active:scale-95/g,
    ) || [];
  assert.ok(roundedCloseButtons.length >= 3, `expected at least 3 rounded modal/detail close buttons, found ${roundedCloseButtons.length}`);
  assert.doesNotMatch(viewSource, /rounded-lg/);
});

test('ReservationsView translation keys are present in every locale', () => {
  const flatKeys = [
    'create',
    'createTitle',
    'refresh',
    'noReservationsHint',
    'detailTitle',
    'customer',
    'when',
    'quickActions',
    'assignTable',
    'walkInCustomer',
  ];
  const formKeys = [
    'customerName',
    'customerPhone',
    'customerEmail',
    'tableId',
    'specialRequests',
    'notes',
  ];
  const tabKeys = ['tables', 'rooms', 'services'];

  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const view = locale(language).reservationsView;
    assert.ok(view, `${language} is missing reservationsView`);
    for (const key of flatKeys) {
      assert.equal(typeof view[key], 'string', `${language}.reservationsView.${key} should be a string`);
      assert.ok(view[key].length > 0, `${language}.reservationsView.${key} should be non-empty`);
    }
    for (const key of formKeys) {
      assert.equal(typeof view.form?.[key], 'string', `${language}.reservationsView.form.${key} missing`);
    }
    for (const key of tabKeys) {
      assert.equal(typeof view.tabs?.[key], 'string', `${language}.reservationsView.tabs.${key} missing`);
      assert.equal(typeof view.headers?.[key], 'string', `${language}.reservationsView.headers.${key} missing`);
    }
    assert.equal(typeof view.status?.completed, 'string', `${language} missing status.completed`);
    assert.equal(typeof view.stats?.guests, 'string', `${language} missing stats.guests`);
    assert.equal(typeof view.actions?.confirm, 'string', `${language} missing actions.confirm`);
    assert.equal(typeof view.validation?.customerRequired, 'string', `${language} missing validation.customerRequired`);
  }
});

test('ReservationsView never renders a raw table UUID or uuid fragment', () => {
  // The list/timeline previously fell back to res.tableId.slice(-4), leaking a
  // uuid fragment ("#9bf5"). No table surface may slice the raw id anymore.
  assert.doesNotMatch(viewSource, /tableId\.slice/);
  // List + timeline resolve the visible label through the shared resolver instead.
  assert.ok(
    (viewSource.match(/resolveTableLabel\(res\.tableId, res\.tableNumber\)/g) || []).length >= 2,
    'list and timeline should both use resolveTableLabel',
  );
});

test('ReservationsView resolves table labels from the shared table cache + display helper', () => {
  assert.match(viewSource, /import \{ useTables \} from '\.\.\/\.\.\/\.\.\/hooks\/useTables';/);
  assert.match(viewSource, /import \{ formatTableDisplayNumber \} from '\.\.\/\.\.\/\.\.\/utils\/table-display';/);
  assert.match(viewSource, /useTables\(\{/);
  assert.match(viewSource, /const tablesById = useMemo\(/);
  assert.match(viewSource, /const resolveTableLabel = useCallback\(/);
  // The resolver formats via the same helper the POS grid uses and never returns the id.
  assert.match(viewSource, /formatTableDisplayNumber\(number\)/);
});

test('ReservationsView assign + create table controls are selectors bound to the id, not raw-UUID text inputs', () => {
  // Both the detail "Assign Table" control and the create-form table field must be
  // <select>s: the option value is the internal table id, the visible text is the label.
  const selects = viewSource.match(/<select\b/g) || [];
  assert.ok(selects.length >= 2, `expected at least 2 <select> controls, found ${selects.length}`);
  assert.match(viewSource, /value=\{tableAssignmentId\}/);
  assert.match(viewSource, /value=\{createForm\.tableId\}/);
  // Options carry the id internally and show the formatted label to staff.
  assert.match(viewSource, /<option key=\{table\.id\} value=\{table\.id\}>/);
  assert.match(viewSource, /\{formatTableDisplayNumber\(table\.tableNumber\)\}/);
  // The old raw "Table ID" text-field placeholder is gone from the UI.
  assert.doesNotMatch(viewSource, /reservationsView\.form\.tableId'/);
  // No visible text input is bound directly to the raw id/UUID state anymore.
  assert.doesNotMatch(viewSource, /<input[^>]*value=\{tableAssignmentId\}/);
  assert.doesNotMatch(viewSource, /<input[^>]*value=\{createForm\.tableId\}/);
});

test('ReservationsView table-selector locale keys exist in every locale and Greek is translated', () => {
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const view = locale(language).reservationsView;
    assert.equal(typeof view.selectTable, 'string', `${language} missing reservationsView.selectTable`);
    assert.ok(view.selectTable.length > 0, `${language} empty reservationsView.selectTable`);
    assert.equal(typeof view.form?.tableOptional, 'string', `${language} missing reservationsView.form.tableOptional`);
    assert.ok(view.form.tableOptional.length > 0, `${language} empty reservationsView.form.tableOptional`);
  }
  const en = locale('en').reservationsView;
  const el = locale('el').reservationsView;
  assert.notEqual(el.selectTable, en.selectTable, 'Greek selectTable must not equal English');
  assert.notEqual(el.form.tableOptional, en.form.tableOptional, 'Greek form.tableOptional must not equal English');
});

test('create-reservation modal renders visible field labels, not placeholder-only controls', () => {
  // A shared label class drives a visible <span> label above each control.
  assert.match(viewSource, /const fieldLabelClass = /);
  const labeledFields = [
    'customerName', 'customerPhone', 'customerEmail', 'partySize',
    'reservationDate', 'reservationTime', 'duration', 'tableOptional',
    'specialRequests', 'notes',
  ];
  for (const field of labeledFields) {
    assert.match(
      viewSource,
      new RegExp(`<span className=\\{fieldLabelClass\\}>\\{t\\('reservationsView\\.form\\.${field}'`),
      `create modal must render a visible label for form.${field}`,
    );
  }
});

test('create-reservation duration is labeled with units, not just a raw prefilled number', () => {
  // The prefilled "90" must sit under a visible "Duration (minutes)" label inside a <label>.
  assert.match(
    viewSource,
    /<label className="flex flex-col gap-1">\s*<span className=\{fieldLabelClass\}>\{t\('reservationsView\.form\.duration'[\s\S]*?value=\{createForm\.durationMinutes\}/,
    'duration input must be wrapped in a <label> with a visible units label',
  );
  // The duration label text carries the unit hint in every locale.
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const value = locale(language).reservationsView.form.duration;
    assert.equal(typeof value, 'string', `${language} missing reservationsView.form.duration`);
    assert.ok(value.length > 0, `${language} empty reservationsView.form.duration`);
  }
});

test('create-reservation date/time labels exist in every locale and Greek is translated', () => {
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const form = locale(language).reservationsView.form;
    assert.equal(typeof form.reservationDate, 'string', `${language} missing form.reservationDate`);
    assert.ok(form.reservationDate.length > 0, `${language} empty form.reservationDate`);
    assert.equal(typeof form.reservationTime, 'string', `${language} missing form.reservationTime`);
    assert.ok(form.reservationTime.length > 0, `${language} empty form.reservationTime`);
  }
  const enForm = locale('en').reservationsView.form;
  const elForm = locale('el').reservationsView.form;
  assert.notEqual(elForm.reservationDate, enForm.reservationDate, 'Greek form.reservationDate must differ from English');
  assert.notEqual(elForm.reservationTime, enForm.reservationTime, 'Greek form.reservationTime must differ from English');
});

// Regression contract for the hidden early-reservation timeline (2026-06-21 review):
// timeSlots was hardcoded to 11–22 and grouping dropped any reservation outside it,
// so a 09:00 booking visible in list view vanished from the timeline.
test('Reservations timeline range is dynamic, not a hardcoded 11-22 window', () => {
  // The hardcoded 12-slot 11–22 array is gone.
  assert.doesNotMatch(viewSource, /Array\.from\(\{ length: 12 \}, \(_, i\) => 11 \+ i\)/);

  // timeSlots come from the dynamic helper over the filtered reservation hours.
  assert.match(
    viewSource,
    /import \{ buildReservationTimelineSlots \} from '\.\.\/\.\.\/\.\.\/utils\/reservationTimeline';/,
  );
  assert.match(
    viewSource,
    /buildReservationTimelineSlots\(\s*filteredReservations\.map\(\(res\) => new Date\(res\.reservationDatetime\)\.getHours\(\)\),?\s*\)/,
  );
});

test('Reservations timeline grouping creates hour buckets on demand and never drops reservations', () => {
  // Buckets are created on demand so an out-of-default-window hour is never dropped.
  assert.match(viewSource, /if \(!grouped\[hour\]\) \{\s*grouped\[hour\] = \[\];\s*\}/);
  // The old drop-if-missing guard is gone.
  assert.doesNotMatch(viewSource, /if \(grouped\[hour\]\) \{\s*grouped\[hour\]\.push/);
});

// Regression contract for the details Date & Time mismatch (2026-06-21 review): the
// details panel rendered raw reservationDate + reservationTime (UTC/service values),
// so the same reservation showed a different time (19:00:00) than list/timeline (21:00).
test('Reservations details Date & Time uses the normalized reservationDatetime, not raw fields', () => {
  // Details formats the same normalized datetime list/timeline use.
  assert.match(
    viewSource,
    /\{formatDate\(selectedReservation\.reservationDatetime\)\} \{formatTime\(selectedReservation\.reservationDatetime, \{ hour: '2-digit', minute: '2-digit' \}\)\}/,
  );
  // The raw reservationDate + reservationTime concatenation is gone.
  assert.doesNotMatch(
    viewSource,
    /formatDate\(selectedReservation\.reservationDate\)\} \{selectedReservation\.reservationTime\}/,
  );
});

test('Reservations list, timeline, and details share the same datetime formatting source', () => {
  // List and timeline format the time from reservationDatetime.
  assert.ok(
    (viewSource.match(/formatTime\(res\.reservationDatetime, \{ hour: '2-digit', minute: '2-digit' \}\)/g) || []).length >= 1,
    'list/timeline must format time from reservationDatetime',
  );
  // Details uses the same reservationDatetime field (not the raw reservationTime string).
  assert.match(viewSource, /formatTime\(selectedReservation\.reservationDatetime, \{ hour: '2-digit', minute: '2-digit' \}\)/);
});

test('useReservations routes all toasts through i18n (no hardcoded English / raw status enum)', () => {
  assert.match(hookSource, /import \{ useTranslation \} from 'react-i18next';/);
  assert.match(hookSource, /const \{ t \} = useTranslation\(\);/);
  // Success + error toasts use keys.
  assert.match(hookSource, /t\('reservationsView\.toasts\.created'/);
  assert.match(hookSource, /t\('reservationsView\.toasts\.createFailed'/);
  assert.match(hookSource, /t\('reservationsView\.toasts\.updateStatusFailed'/);
  assert.match(hookSource, /t\('reservationsView\.toasts\.tableAssigned'/);
  assert.match(hookSource, /t\('reservationsView\.toasts\.assignTableFailed'/);
  // Status uses explicit per-status keys, never raw enum concatenation.
  assert.match(hookSource, /t\(`reservationsView\.toasts\.status\.\$\{status\}`/);

  // The previously hardcoded English literals and raw-status toast are gone.
  assert.doesNotMatch(hookSource, /toast\.success\('Reservation created successfully'\)/);
  assert.doesNotMatch(hookSource, /toast\.success\('Table assigned'\)/);
  assert.doesNotMatch(hookSource, /toast\.success\(`Reservation \$\{status\}`\)/);
});

test('reservation toast keys (incl. all status enums) exist in every locale, Greek is translated', () => {
  const FLAT = ['created', 'createFailed', 'updateStatusFailed', 'tableAssigned', 'assignTableFailed'];
  const STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled'];
  const GREEK = new RegExp('[\\u0370-\\u03FF]');

  for (const lang of ['en', 'el', 'de', 'fr', 'it']) {
    const toasts = locale(lang).reservationsView?.toasts;
    assert.ok(toasts, `${lang} missing reservationsView.toasts`);
    for (const k of FLAT) {
      assert.equal(typeof toasts[k], 'string', `${lang}.reservationsView.toasts.${k} missing`);
    }
    for (const s of STATUSES) {
      assert.equal(typeof toasts.status?.[s], 'string', `${lang}.reservationsView.toasts.status.${s} missing`);
    }
  }

  const el = locale('el').reservationsView.toasts;
  const en = locale('en').reservationsView.toasts;
  assert.match(el.created, GREEK);
  assert.notEqual(el.created, en.created);
  for (const s of STATUSES) {
    assert.match(el.status[s], GREEK, `el reservation status.${s} should be Greek`);
    assert.notEqual(el.status[s], en.status[s], `el reservation status.${s} must differ from English`);
  }
});

// Feature contract for service reservations (2026-06-21 live QA): the Υπηρεσίες tab
// showed a permanently-disabled Create gated behind a "create from Appointments" tooltip.
// Eligible orgs (appointments + service_catalog) must be able to create service bookings
// from the Reservations screen itself.
test('Reservations service tab Create is enabled for eligible orgs (disabled tooltip no longer blocks them)', () => {
  assert.match(viewSource, /const hasServiceReservations = hasAppointmentsModule && hasServiceCatalogModule;/);
  // Create is only disabled on services when the org lacks service reservations.
  assert.match(viewSource, /disabled=\{activeTab === 'services' && !hasServiceReservations\}/);
  // The old unconditional services-disabled is gone.
  assert.doesNotMatch(viewSource, /disabled=\{activeTab === 'services'\}/);
  // The "create from Appointments" accessible name only appears when truly disabled; eligible
  // orgs get the service-booking name instead. This branching label is exposed via aria-label
  // (round 191: native title= tooltip removed for the touchscreen/no-hover rule).
  assert.match(
    viewSource,
    /aria-label=\{activeTab === 'services' && !hasServiceReservations\s*\?\s*t\('reservationsView\.createServiceInAppointments'[\s\S]*?:\s*activeTab === 'services'\s*\?\s*t\('reservationsView\.createServiceTitle'[\s\S]*?:\s*t\('reservationsView\.createTitle'/,
  );
});

test('Reservations Create on the services tab opens the app-level service booking modal (portal + blur + dialog)', () => {
  // The Create button branches to the service modal on the services tab.
  assert.match(
    viewSource,
    /onClick=\{\(\) => \{\s*if \(activeTab === 'services'\) \{\s*openServiceModal\(\);\s*return;\s*\}/,
  );
  assert.match(viewSource, /const openServiceModal = useCallback\(\(\) => \{[\s\S]*?setShowServiceModal\(true\);/);
  // App-level portal with a full-screen blurred backdrop, same contract as table/room.
  assert.match(viewSource, /\{showServiceModal && renderModalPortal\(/);
  assert.match(viewSource, /const modalScrimClass = `absolute inset-0 backdrop-blur-xl/);
  assert.match(viewSource, /<div className=\{modalScrimClass\} onClick=\{closeServiceModal\}/);
  assert.match(viewSource, /className=\{modalPanelClass\}/);
  // Labelled dialog semantics on the panel, wired to the visible service-booking title.
  assert.match(viewSource, /ref=\{serviceDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{serviceTitleId\}/);
  assert.match(viewSource, /<h3 id=\{serviceTitleId\}[^>]*>\s*\{t\('reservationsView\.createServiceTitle'/);
});

test('Service modal creates an appointment via useAppointments.createAppointment (validated), not a reservation', () => {
  // The appointment creator is wired in from the hook.
  assert.match(viewSource, /createAppointment,\s*\} = useAppointments\(/);
  // Validate service + staff + date + time before submit.
  assert.match(viewSource, /if \(!serviceForm\.serviceId \|\| !serviceForm\.staffId \|\| !serviceForm\.date \|\| !serviceForm\.time\) \{/);
  assert.match(viewSource, /t\('reservationsView\.validation\.serviceRequired'/);
  // Build start/end from the LOCAL calendar date (no UTC drift) and call createAppointment.
  assert.match(viewSource, /const base = parseLocalDateString\(serviceForm\.date\);/);
  assert.match(
    viewSource,
    /const created = await createAppointment\(\{[\s\S]*?staffId: serviceForm\.staffId,[\s\S]*?serviceId: serviceForm\.serviceId,[\s\S]*?startTime,[\s\S]*?endTime,[\s\S]*?\}\);/,
  );
  // After success it refreshes the services (appointments) list.
  assert.match(viewSource, /await refetchAppointments\(\);/);

  // Table/room create still uses the reservation modal + createReservation, and the
  // table-label UUID hiding is intact.
  assert.match(viewSource, /const created = await createReservation\(payload\);/);
  assert.match(viewSource, /\{showCreateModal && renderModalPortal\(/);
  assert.ok(
    (viewSource.match(/resolveTableLabel\(res\.tableId, res\.tableNumber\)/g) || []).length >= 2,
    'table-label UUID hiding (resolveTableLabel) must remain in list + timeline',
  );
});

test('Service modal Escape closes only the modal via the close-only path, never submits', () => {
  assert.match(viewSource, /const closeServiceModal = useCallback\(\(\) => \{\s*setShowServiceModal\(false\);\s*\}, \[\]\);/);
  // Escape effect: gated on showServiceModal, topmost-[role="dialog"] gated, routed to close-only.
  assert.match(viewSource, /if \(!showServiceModal\) \{\s*return;\s*\}/);
  assert.match(viewSource, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== serviceDialogRef\.current/);
  assert.match(viewSource, /event\.preventDefault\(\);\s*closeServiceModal\(\);/);
  // Escape never routes to the create submit.
  assert.doesNotMatch(viewSource, /event\.preventDefault\(\);\s*(void )?handleCreateServiceBooking/);
  // Backdrop + X + Cancel all route through the close-only path.
  assert.ok(
    (viewSource.match(/onClick=\{closeServiceModal\}/g) || []).length >= 3,
    'backdrop, X and Cancel should all use closeServiceModal',
  );
});

test('service booking locale keys exist in every locale and Greek is translated', () => {
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const view = locale(language).reservationsView;
    assert.equal(typeof view.createServiceTitle, 'string', `${language} missing reservationsView.createServiceTitle`);
    assert.ok(view.createServiceTitle.length > 0, `${language} empty reservationsView.createServiceTitle`);
    assert.equal(typeof view.validation?.serviceRequired, 'string', `${language} missing validation.serviceRequired`);
    for (const key of ['service', 'staff', 'selectService', 'selectStaff']) {
      assert.equal(typeof view.form?.[key], 'string', `${language} missing reservationsView.form.${key}`);
      assert.ok(view.form[key].length > 0, `${language} empty reservationsView.form.${key}`);
    }
  }
  const en = locale('en').reservationsView;
  const el = locale('el').reservationsView;
  assert.notEqual(el.createServiceTitle, en.createServiceTitle, 'el createServiceTitle must be translated');
  assert.notEqual(el.validation.serviceRequired, en.validation.serviceRequired, 'el serviceRequired must be translated');
  assert.match(el.createServiceTitle, GREEK_LETTER, 'el createServiceTitle should be Greek');
  assert.match(el.form.service, GREEK_LETTER, 'el form.service should be Greek');
});

// Feature contract for room reservations (2026-06-21 live QA): the Δωμάτια create form
// used a raw "Room ID" text input, forcing staff to know an internal room id. It must offer
// a room selector populated from real room inventory, with staff-facing labels (never UUIDs),
// while still sending the selected room.id as roomId.
test('Reservations room create uses a room selector populated from room inventory, not a raw room-id input', () => {
  // Room inventory comes from the shared useRooms hook (same source as the Rooms grid),
  // gated on the rooms module so non-rooms orgs do not fetch it.
  assert.match(viewSource, /import \{ useRooms \} from '\.\.\/\.\.\/\.\.\/hooks\/useRooms';/);
  assert.match(viewSource, /const \{ rooms \} = useRooms\(\{[\s\S]*?branchId: hasRoomsModule \? branchId \|\| '' : '',/);

  // The room field is a <select> bound to createForm.roomId; options carry the internal
  // room id as the value and a staff-facing label as the visible text.
  assert.match(viewSource, /<span className=\{fieldLabelClass\}>\{t\('reservationsView\.form\.room'/);
  assert.match(
    viewSource,
    /<select\s+value=\{createForm\.roomId\}[\s\S]*?aria-label=\{t\('reservationsView\.form\.room'/,
  );
  assert.match(viewSource, /<option value="">\{t\('reservationsView\.form\.selectRoom'/);
  assert.match(viewSource, /\{rooms\.map\(\(room\) => \(\s*<option key=\{room\.id\} value=\{room\.id\}>\s*\{roomOptionLabel\(room\)\}/);

  // The staff-facing label uses room number + (locale-aware) rate, never the raw id/UUID.
  assert.match(viewSource, /const roomOptionLabel = useCallback\(/);
  assert.match(viewSource, /formatCurrency\(Number\(room\.ratePerNight\) \|\| 0\)/);
  assert.doesNotMatch(viewSource, /roomOptionLabel[\s\S]{0,200}room\.id/);

  // The old raw "Room ID" text input + its label are gone.
  assert.doesNotMatch(viewSource, /reservationsView\.form\.roomId'/);
  assert.doesNotMatch(viewSource, /<input[^>]*value=\{createForm\.roomId\}/);

  // Validation still requires the selected room + check-in/out, and the payload sends roomId.
  assert.match(
    viewSource,
    /activeTab === 'rooms' && \(!createForm\.roomId\.trim\(\) \|\| !createForm\.checkInDate \|\| !createForm\.checkOutDate\)/,
  );
  assert.match(viewSource, /roomId: activeTab === 'rooms' \? createForm\.roomId\.trim\(\) \|\| undefined : undefined/);

  // Table create still uses its own table selector (unchanged).
  assert.match(viewSource, /value=\{createForm\.tableId\}/);
  assert.match(viewSource, /<option key=\{table\.id\} value=\{table\.id\}>/);
});

test('Reservations room selector locale keys exist in every locale and Greek is translated', () => {
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const form = locale(language).reservationsView.form;
    for (const key of ['room', 'selectRoom']) {
      assert.equal(typeof form?.[key], 'string', `${language} missing reservationsView.form.${key}`);
      assert.ok(form[key].length > 0, `${language} empty reservationsView.form.${key}`);
    }
  }
  const enForm = locale('en').reservationsView.form;
  const elForm = locale('el').reservationsView.form;
  assert.notEqual(elForm.room, enForm.room, 'el form.room must be translated');
  assert.notEqual(elForm.selectRoom, enForm.selectRoom, 'el form.selectRoom must be translated');
  assert.match(elForm.room, GREEK_LETTER, 'el form.room should be Greek');
  assert.match(elForm.selectRoom, GREEK_LETTER, 'el form.selectRoom should be Greek');
});

// Regression contract for the create-modal Escape gap (2026-06-21 live QA): the service
// create modal closed on Escape but the table/room create modal did not. Both must share the
// same topmost-[role="dialog"] close-only Escape behavior, without submitting or cancelling.
test('Reservations table/room create modal closes on Escape via the topmost-dialog close-only path', () => {
  // The create panel is a labelled dialog so it joins the [role="dialog"] stack the gate scans.
  assert.match(viewSource, /const createDialogRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(
    viewSource,
    /ref=\{createDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{createTitleId\}/,
  );
  assert.match(viewSource, /<h3 id=\{createTitleId\}[^>]*>\s*\{t\('reservationsView\.createTitle'/);

  // Close-only callback: only hides the modal, never createReservation.
  assert.match(viewSource, /const closeCreateModal = useCallback\(\(\) => \{\s*setShowCreateModal\(false\);\s*\}, \[\]\);/);

  // Escape effect: gated on showCreateModal, topmost-gated against the create panel, routed
  // to the close-only path.
  assert.match(viewSource, /if \(!showCreateModal\) \{\s*return;\s*\}/);
  assert.match(viewSource, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== createDialogRef\.current/);
  assert.match(viewSource, /event\.preventDefault\(\);\s*closeCreateModal\(\);/);

  // Escape never submits the reservation (no create/cancel side effect).
  assert.doesNotMatch(viewSource, /event\.preventDefault\(\);\s*(void )?handleCreateReservation/);
  assert.doesNotMatch(viewSource, /event\.preventDefault\(\);\s*(void )?createReservation/);

  // Portal/blur intact: still portaled with the high-z blurred backdrop, and the existing
  // backdrop close handler is preserved.
  assert.match(viewSource, /\{showCreateModal && renderModalPortal\(/);
  assert.match(viewSource, /<div className=\{modalScrimClass\} onClick=\{\(\) => setShowCreateModal\(false\)\}/);

  // The service modal Escape path is unchanged (no regression).
  assert.match(viewSource, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== serviceDialogRef\.current/);
  assert.match(viewSource, /event\.preventDefault\(\);\s*closeServiceModal\(\);/);

  // All four reservation selectors remain intact (table, room, service, staff).
  assert.match(viewSource, /value=\{createForm\.tableId\}/);
  assert.match(viewSource, /value=\{createForm\.roomId\}/);
  assert.match(viewSource, /value=\{serviceForm\.serviceId\}/);
  assert.match(viewSource, /value=\{serviceForm\.staffId\}/);
});

test('Reservations create modal uses light glass and disables Create until required fields are ready', () => {
  assert.match(viewSource, /const modalPanelClass = `relative z-10[\s\S]*?bg-gray-950\/55[\s\S]*?bg-white\/28/);
  assert.match(viewSource, /const modalScrimClass = `absolute inset-0 backdrop-blur-xl \$\{isDark \? 'bg-black\/55' : 'bg-black\/30'\}`/);
  assert.match(viewSource, /const isCreateReservationReady =[\s\S]*?Boolean\(createForm\.customerName\.trim\(\)\)[\s\S]*?Boolean\(createForm\.customerPhone\.trim\(\)\)/);
  assert.match(viewSource, /Number\.isFinite\(createPartySize\)[\s\S]*?createPartySize > 0/);
  assert.match(viewSource, /activeTab !== 'rooms' \|\|[\s\S]*?Boolean\(createForm\.roomId\.trim\(\)\)[\s\S]*?Boolean\(createForm\.checkInDate\)[\s\S]*?Boolean\(createForm\.checkOutDate\)/);

  const createButton = viewSource.slice(
    viewSource.indexOf('onClick={() => void handleCreateReservation()}'),
    viewSource.indexOf('</button>', viewSource.indexOf('onClick={() => void handleCreateReservation()}')),
  );
  assert.match(createButton, /disabled=\{isCreating \|\| !isCreateReservationReady\}/);
  assert.match(createButton, /disabled:cursor-not-allowed/);
  assert.match(createButton, /disabled:bg-gray-200\/70/);
  assert.match(createButton, /disabled:text-gray-500/);
});
