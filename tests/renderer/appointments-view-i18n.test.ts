import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const viewSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'verticals', 'salon', 'AppointmentsView.tsx'),
  'utf8',
);

const locale = (language: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${language}.json`), 'utf8'));

const hookSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'hooks', 'useAppointments.ts'),
  'utf8',
);

// Round 236: the Orders hub opens Create Appointment by bumping openCreateSignal; the existing
// staff/service/day/time availability check inside handleCreateAppointment is untouched.
test('AppointmentsView opens Create from the hub via openCreateSignal (Round 236)', () => {
  assert.match(viewSource, /interface AppointmentsViewProps/);
  assert.match(viewSource, /embedded\?: boolean/);
  assert.match(viewSource, /openCreateSignal\?: number/);
  assert.match(viewSource, /if \(openCreateSignal && openCreateSignal > 0\) \{\s*setShowCreateModal\(true\);/);
  // The availability-validated creation path is preserved (not bypassed/duplicated).
  assert.match(viewSource, /const handleCreateAppointment = async \(\) => \{/);
  assert.match(viewSource, /availabilityResult/);
});

test('Round 369: AppointmentsView renders the standard visible page title above its controls', () => {
  assert.match(
    viewSource,
    /<h1 className="truncate text-3xl font-bold tracking-tight">\s*\{t\('navigation\.menu\.appointments', \{ defaultValue: 'Appointments' \}\)\}\s*<\/h1>/,
  );
  assert.match(
    viewSource,
    /data-vertical-hero="appointments"[\s\S]*rounded-3xl border p-4 backdrop-blur-xl[\s\S]*navigation\.menu\.appointments[\s\S]*appointments\.stats\.total/,
    'Appointments title and stats should live in the same rounded glass hero',
  );
  assert.ok(
    viewSource.indexOf("navigation.menu.appointments") < viewSource.indexOf("appointments.stats.total"),
    'Appointments page title must render before the stats/control row',
  );
});

test('Round 392: Appointments page rows use static status classes, smooth controls, and safe separators', () => {
  const pageRegion = viewSource.slice(0, viewSource.indexOf('const CreateAppointmentModalContent'));
  assert.ok(pageRegion.length > 0, 'page region (AppointmentsView body) must be found');

  // Tailwind cannot reliably build arbitrary interpolated colour utilities. Appointment
  // status styling must stay as static, on-palette classes instead.
  assert.match(viewSource, /border: 'border-l-amber-400'/);
  assert.match(viewSource, /border: 'border-l-emerald-500'/);
  assert.match(viewSource, /chip: 'border border-yellow-500\/30 bg-yellow-500\/10 text-yellow-500'/);
  assert.match(pageRegion, /statusConfig\[apt\.status\]\.border/);
  assert.match(pageRegion, /statusConfig\[apt\.status\]\.chip/);
  assert.doesNotMatch(pageRegion, /statusConfig\[apt\.status\]\.color/);
  assert.doesNotMatch(pageRegion, /border-\$\{statusConfig\[apt\.status\]\.color\}-500/);
  assert.doesNotMatch(pageRegion, /bg-\$\{statusConfig\[apt\.status\]\.color\}-500\/10/);

  // The appointment page should not reintroduce the older small-radius controls/cards.
  assert.doesNotMatch(viewSource, /rounded-lg/);
  assert.match(pageRegion, /rounded-2xl border-l-4 \$\{statusConfig\[apt\.status\]\.border\}/);
  assert.match(pageRegion, /rounded-xl text-sm font-medium flex items-center gap-1/);

  // No mojibake or raw bullet characters in source; JSX uses an entity for row separators,
  // and the modal summary uses an ASCII hyphen separator.
  assert.doesNotMatch(viewSource, /[Ââ•]/);
  assert.match(viewSource, /&middot;/);
  assert.match(viewSource, /\`\$\{formatDate\(selectedDay\)\} - \$\{formData\.startTime\}\`/);
});

test('AppointmentsView routes its remaining app-owned strings through i18n', () => {
  assert.match(viewSource, /t\(`appointments\.status\.\$\{apt\.status\}`/);
  assert.match(viewSource, /t\('appointments\.walkIn', \{ defaultValue: 'Walk-in' \}\)/);
  assert.match(viewSource, /t\('appointments\.staff', \{ defaultValue: 'Staff' \}\)/);
  assert.match(viewSource, /t\('appointments\.service', \{ defaultValue: 'Service' \}\)/);
  assert.match(viewSource, /t\('appointments\.noAppointments'/);
  assert.match(viewSource, /t\('appointments\.newAppointment'/);
  assert.match(viewSource, /t\('appointments\.selectStaffService'/);
  assert.match(viewSource, /t\('appointments\.validation\.availabilityFailed'/);

  // No leftover hardcoded literals for the high-visibility strings.
  assert.doesNotMatch(viewSource, /\|\| 'Walk-in'/);
  assert.doesNotMatch(viewSource, /\|\| 'Staff'/);
  assert.doesNotMatch(viewSource, /\|\| 'Service'/);
  assert.doesNotMatch(viewSource, />No appointments found</);
  assert.doesNotMatch(viewSource, /aria-label="New Appointment"/);
  assert.doesNotMatch(viewSource, /toast\.error\('Please select staff and service'\)/);
});

test('Appointment modal renders above the floating action button and hides native scrollbars', () => {
  // FloatingActionButton is portal-mounted to document.body, so Appointments
  // must remove it while the create/customer modal stack is open.
  // Round 236: the FAB is additionally gated on !embedded (the Orders hub owns New Order).
  assert.match(viewSource, /!\s*embedded && !\s*showCreateModal && !\s*showCustomerSearch && \(\s*<FloatingActionButton/);
  const fabBlock = viewSource.slice(
    viewSource.indexOf('{/* Floating Action Button'),
    viewSource.indexOf('{/* Create Appointment Modal */}'),
  );
  assert.ok(fabBlock.includes('<FloatingActionButton'), 'appointments FAB render block should exist');
  assert.ok(fabBlock.includes('!embedded && !showCreateModal && !showCustomerSearch'), 'FAB should be hidden while embedded or modal stack is open');
  // Keep the modal layer high for non-portal content as well.
  assert.match(viewSource, /className=\{`fixed inset-0 z-\[1000\] flex items-center justify-center backdrop-blur-xl/);
  assert.match(viewSource, /max-h-\[calc\(100%-1\.5rem\)\] sm:max-h-\[calc\(100%-3rem\)\]/);
  assert.doesNotMatch(viewSource, /className="fixed inset-0 z-50 flex items-center justify-center/);
  // Native white scrollbars are hidden while preserving scroll behavior.
  assert.match(viewSource, /h-full overflow-y-auto scrollbar-hide/);
  // Round 240: the scroll body also carries min-h-0 so it can shrink and scroll (footer reserved).
  assert.match(viewSource, /p-4 sm:p-6 overflow-y-auto flex-1 min-h-0 scrollbar-hide/);
  assert.match(viewSource, /max-h-56 overflow-y-auto pr-1 scrollbar-hide/);
  const hiddenScrollers = viewSource.match(/overflow-y-auto[^"']*scrollbar-hide/g) || [];
  assert.ok(hiddenScrollers.length >= 4, 'timeline, list, modal body and slot grid should hide native scrollbars');
});

// Regression contract for the hidden default time (2026-06-21 live QA): opening New
// Appointment from the floating + left selectedDay null, so the Morning/Afternoon/Evening
// time-slot grid + summary never rendered, yet the parent's default startTime '09:00' kept
// Create enabled — letting staff create at a hidden today-09:00 while the header still said
// "Search Customer by Phone". The modal must seed its visible date state from formData.date
// so the grid and the default selected slot are visible before creation.
test('Appointment create modal seeds visible date/time state from formData.date (no hidden default time)', () => {
  // Local-calendar parse (no UTC drift) is imported and used to seed the modal date.
  assert.match(viewSource, /import \{ parseLocalDateString \} from '\.\.\/\.\.\/\.\.\/utils\/date';/);
  assert.match(
    viewSource,
    /const resolveInitialModalDate = \(\): Date => \{\s*const parsed = parseLocalDateString\(formData\.date\);\s*return Number\.isNaN\(parsed\.getTime\(\)\) \? new Date\(\) : parsed;\s*\};/,
    'the modal must resolve its initial date from formData.date via the local-calendar parser',
  );

  // selectedDay + calendarDate are seeded from formData.date so the time-slot grid (gated on
  // selectedDay) and the summary render on open with the default slot visible.
  assert.match(viewSource, /const \[calendarDate, setCalendarDate\] = useState<Date>\(resolveInitialModalDate\);/);
  assert.match(viewSource, /const \[selectedDay, setSelectedDay\] = useState<Date \| null>\(resolveInitialModalDate\);/);

  // The hidden-default-time source (selectedDay starting null) must not return.
  assert.doesNotMatch(viewSource, /const \[selectedDay, setSelectedDay\] = useState<Date \| null>\(null\);/);
  // And the seed must not regress to a UTC-drifting raw Date parse of the YYYY-MM-DD string.
  assert.doesNotMatch(viewSource, /useState<Date \| null>\(new Date\(formData\.date\)\)/);

  // The real time-slot grid stays gated on selectedDay (now seeded) and Create still requires a chosen
  // time — so the enabling state is the visible slot, not a hidden default. Round 307 nests that selectedDay
  // gate inside the staff+service branch (`) : selectedDay ? (`), so the grid still needs a seeded day.
  assert.match(viewSource, /\) : selectedDay \? \(/);
  assert.match(
    viewSource,
    /disabled=\{isSubmitting \|\| !formData\.staffId \|\| !formData\.serviceId \|\| !formData\.startTime\}/,
  );

  // Round 285 follow-up (live QA): the create form starts with NO pre-selected time (startTime: ''),
  // so no slot reads as chosen/yellow before staff + service are picked. The seeded selectedDay/calendar
  // (above) stays visible; only the default time is removed.
  assert.match(viewSource, /startTime: '',/);
  assert.doesNotMatch(viewSource, /startTime: '09:00'/);
});

// Regression contract for the non-dismissable New Appointment modal (2026-06-21 live QA):
// the modal closed on X but not on Escape. It must close on Escape via the same
// topmost-[role="dialog"] close-only pattern as the Reservations/Rooms modals.
test('Appointment create modal closes on Escape via the topmost-dialog close-only path', () => {
  // The modal is a labelled dialog so it joins the [role="dialog"] stack the gate scans.
  assert.match(viewSource, /import React, \{[^}]*\buseId\b[^}]*\} from 'react';/);
  assert.match(viewSource, /import React, \{[^}]*\buseRef\b[^}]*\} from 'react';/);
  assert.match(viewSource, /const dialogRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(viewSource, /const titleId = useId\(\);/);
  assert.match(
    viewSource,
    /ref=\{dialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{titleId\}/,
    'the appointment modal panel must declare a labelled dialog',
  );
  assert.match(viewSource, /<h2 id=\{titleId\}[^>]*>\s*\{t\('appointments\.modal\.title', 'New Appointment'\)\}/);

  // Escape effect: topmost-[role="dialog"] gated against the modal panel, routed to onClose
  // (close-only — the parent's onClose hides + resets the form, never creates).
  assert.match(viewSource, /const dialogs = Array\.from\(document\.querySelectorAll\('\[role="dialog"\]'\)\);/);
  assert.match(viewSource, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== dialogRef\.current/);
  assert.match(viewSource, /event\.preventDefault\(\);\s*onClose\(\);/);
  assert.match(viewSource, /document\.addEventListener\('keydown', handleEscape\)/);
  assert.match(viewSource, /document\.removeEventListener\('keydown', handleEscape\)/);

  // Escape never submits/creates the appointment.
  assert.doesNotMatch(viewSource, /event\.preventDefault\(\);\s*(void )?handleCreateAppointment/);

  // Portal/blur preserved: still portaled to body with the full-screen blurred backdrop,
  // and the X close button still calls onClose.
  assert.match(viewSource, /return renderModalPortal\(/);
  assert.match(viewSource, /fixed inset-0 z-\[1000\][^`]*backdrop-blur-xl/);
  assert.match(viewSource, /isDark \? 'bg-black\/55' : 'bg-black\/22'/);
  assert.match(viewSource, /onClick=\{onClose\}/);

  // Staff + service selection paths remain intact (selection behavior unchanged).
  assert.match(viewSource, /value=\{formData\.staffId\}/);
  assert.match(viewSource, /value=\{formData\.serviceId\}/);
});

test('Appointments calendar weekday labels are locale-aware, not hardcoded English initials', () => {
  // The English S/M/T/W/T/F/S literal array is gone and cannot return.
  assert.doesNotMatch(viewSource, /\[\s*'S',\s*'M',\s*'T',\s*'W',\s*'T',\s*'F',\s*'S'\s*\]/);

  // Weekdays come from the shared locale-aware date formatter (narrow weekday),
  // Sunday-first to match the date grid, recomputed when the locale changes.
  assert.match(viewSource, /const \{ t, i18n \} = useTranslation\(\);/);
  assert.match(viewSource, /Array\.from\(\{ length: 7 \}/);
  assert.match(viewSource, /formatDate\(new Date\(2023, 0, 1 \+ index\), \{ weekday: 'narrow' \}\)/);
  assert.match(viewSource, /\[i18n\.language\]/);
});

test('Greek calendar weekday initials are localized, never the English S/M/T/W/T/F/S row', () => {
  // Mirror the component's mechanism (narrow weekday via the same Intl path, Sunday-first).
  const greekDays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat('el', { weekday: 'narrow' }).format(new Date(2023, 0, 1 + index)),
  );
  const englishDays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  assert.notDeepEqual(greekDays, englishDays, 'Greek weekday initials must differ from English');
  // Every Greek initial is in the Greek/Coptic block, so no Latin S/M/T/W/F leaks.
  const greekLetter = new RegExp('[\\u0370-\\u03FF]');
  for (const day of greekDays) {
    assert.match(day, greekLetter, `expected a Greek weekday initial, got "${day}"`);
  }
});

test('appointments translation keys are present in every locale', () => {
  const statusKeys = ['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'];
  const topKeys = ['walkIn', 'service', 'staff', 'noAppointments', 'noAppointmentsHint', 'newAppointment', 'selectStaffService'];
  const modalKeys = ['customer', 'bannedCustomer', 'clearCustomer', 'searchCustomer', 'walkInName', 'walkInPhone'];

  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const a = locale(language).appointments;
    assert.ok(a, `${language} missing appointments`);
    for (const key of statusKeys) {
      assert.equal(typeof a.status?.[key], 'string', `${language}.appointments.status.${key} missing`);
    }
    for (const key of topKeys) {
      assert.equal(typeof a[key], 'string', `${language}.appointments.${key} missing`);
      assert.ok(a[key].length > 0, `${language}.appointments.${key} empty`);
    }
    for (const key of modalKeys) {
      assert.equal(typeof a.modal?.[key], 'string', `${language}.appointments.modal.${key} missing`);
    }
    assert.equal(typeof a.validation?.availabilityFailed, 'string', `${language} missing validation.availabilityFailed`);
  }
});

// Regression contract for the empty-day staff filter (2026-06-21 review): the page
// filter rendered {staff.map(...)} (appointment-derived staff only), so a day with 0
// appointments had an empty filter even though branch staff exists and the create
// modal loads it. The filter must source branch staff.
test('Appointments page staff filter sources branch staff, usable even with zero appointments', () => {
  // The <select> renders branch-first options, not the raw appointment-derived staff.
  assert.match(
    viewSource,
    /const filterStaffOptions = useMemo\(\s*\(\) => \(staffList\.length > 0 \? staffList : staff\),/,
  );
  assert.match(
    viewSource,
    /\{filterStaffOptions\.map\(s => <option key=\{s\.id\} value=\{s\.id\}>\{s\.name\}<\/option>\)\}/,
  );
  // The page filter no longer maps the appointment-derived staff array directly.
  assert.doesNotMatch(viewSource, /\{staff\.map\(/);

  // Branch staff (and services) load for the whole page, not only when the create
  // modal opens, so an empty appointment day still has staff options.
  assert.doesNotMatch(viewSource, /if \(showCreateModal\) \{\s*loadDropdownData\(\);/);
  assert.match(
    viewSource,
    /loadDropdownData\(\);\s*\}, \[bridge, branchId, effectiveOrgId, formData\.date, t\]\)/,
  );
});

test('Appointments staff filter resets a stale selection and still passes staffFilter to fetching', () => {
  // If the selected staff id is no longer among the loaded options, reset to "all"
  // so the filter cannot get stuck on an invisible selection.
  assert.match(
    viewSource,
    /if \(\s*staffFilter !== 'all' &&\s*filterStaffOptions\.length > 0 &&\s*!filterStaffOptions\.some\(\(member\) => member\.id === staffFilter\)\s*\)\s*\{\s*setStaffFilter\('all'\);/,
  );

  // Selecting a staff member still feeds staffFilter into the appointment fetch.
  assert.match(viewSource, /if \(staffFilter !== 'all'\) \{\s*baseFilters\.staffFilter = staffFilter;/);
  // The filters memo (passed to useAppointments) depends on staffFilter.
  assert.match(viewSource, /\}, \[selectedDate, quickFilter, staffFilter, searchTerm\]\)/);
});

test('useAppointments routes all toasts through i18n (no hardcoded English / raw status enum)', () => {
  assert.match(hookSource, /import \{ useTranslation \} from 'react-i18next';/);
  assert.match(hookSource, /const \{ t \} = useTranslation\(\);/);
  assert.match(hookSource, /t\('appointmentsView\.toasts\.created'/);
  assert.match(hookSource, /t\('appointmentsView\.toasts\.createFailed'/);
  assert.match(hookSource, /t\('appointmentsView\.toasts\.updateStatusFailed'/);
  assert.match(hookSource, /t\('appointmentsView\.toasts\.checkedIn'/);
  assert.match(hookSource, /t\('appointmentsView\.toasts\.checkInFailed'/);
  assert.match(hookSource, /t\('appointmentsView\.toasts\.completed'/);
  assert.match(hookSource, /t\('appointmentsView\.toasts\.completeFailed'/);
  // Status uses explicit per-status keys, never raw enum text.
  assert.match(hookSource, /t\(`appointmentsView\.toasts\.status\.\$\{status\}`/);

  // The previously hardcoded English literals and raw-status toast are gone.
  assert.doesNotMatch(hookSource, /toast\.success\('Appointment created successfully'\)/);
  assert.doesNotMatch(hookSource, /toast\.success\('Customer checked in'\)/);
  assert.doesNotMatch(hookSource, /toast\.success\('Appointment completed'\)/);
  assert.doesNotMatch(hookSource, /toast\.success\(`Appointment \$\{status/);
});

test('appointment toast keys (incl. all status enums) exist in every locale, Greek is translated', () => {
  const FLAT = ['created', 'createFailed', 'updateStatusFailed', 'checkedIn', 'checkInFailed', 'completed', 'completeFailed'];
  const STATUSES = ['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'];
  const GREEK = new RegExp('[\\u0370-\\u03FF]');

  for (const lang of ['en', 'el', 'de', 'fr', 'it']) {
    const toasts = locale(lang).appointmentsView?.toasts;
    assert.ok(toasts, `${lang} missing appointmentsView.toasts`);
    for (const k of FLAT) {
      assert.equal(typeof toasts[k], 'string', `${lang}.appointmentsView.toasts.${k} missing`);
    }
    for (const s of STATUSES) {
      assert.equal(typeof toasts.status?.[s], 'string', `${lang}.appointmentsView.toasts.status.${s} missing`);
    }
  }

  const el = locale('el').appointmentsView.toasts;
  const en = locale('en').appointmentsView.toasts;
  assert.match(el.created, GREEK);
  assert.notEqual(el.created, en.created);
  for (const s of STATUSES) {
    assert.match(el.status[s], GREEK, `el appointment status.${s} should be Greek`);
    assert.notEqual(el.status[s], en.status[s], `el appointment status.${s} must differ from English`);
  }
});

// Round 230 (live QA): the top refresh button + main date prev/next arrows were exposed in the
// accessibility tree as empty unnamed buttons, the page had many hover-only Tailwind classes, and the
// modal customer-clear button used a native title tooltip. The icon-only buttons now carry localized
// aria-labels and are 44x44 centred touch controls with active feedback; hover utilities are replaced with
// active:, and the native title is gone. Behaviour is unchanged.
test('Round 230: AppointmentsView icon buttons are named + touch-safe, with no hover/title', () => {
  // Touch-first: no hover-only utilities and no native title tooltip anywhere in the view.
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /\btitle=/);

  // Slice the <button> that contains a given anchor token.
  const button = (anchor: string): string => {
    const i = viewSource.indexOf(anchor);
    assert.notEqual(i, -1, `expected to find ${anchor}`);
    return viewSource.slice(viewSource.lastIndexOf('<button', i), viewSource.indexOf('</button>', i) + '</button>'.length);
  };

  // Top refresh button: localized accessible name + 44x44 centred sizing + active feedback.
  const refresh = button('onClick={() => refetch()}');
  assert.match(refresh, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.match(refresh, /h-11 w-11 items-center justify-center/);
  assert.match(refresh, /active:scale-95/);

  // Main date previous / next day buttons.
  const prevDay = button("navigateDate('prev')");
  assert.match(prevDay, /aria-label=\{t\('appointments\.previousDay', 'Previous day'\)\}/);
  assert.match(prevDay, /h-11 w-11 items-center justify-center/);
  const nextDay = button("navigateDate('next')");
  assert.match(nextDay, /aria-label=\{t\('appointments\.nextDay', 'Next day'\)\}/);
  assert.match(nextDay, /h-11 w-11 items-center justify-center/);

  // Modal close button (anchored on its unique close key; still wires onClose elsewhere in the panel).
  const close = button("t('common.actions.close', 'Close')");
  assert.match(close, /aria-label=\{t\('common\.actions\.close', 'Close'\)\}/);
  assert.match(close, /h-11 w-11 items-center justify-center/);
  assert.match(viewSource, /onClick=\{onClose\}/);

  // Customer clear: the native title is replaced by an aria-label only.
  const clear = button('onClick={onClearCustomer}');
  assert.match(clear, /aria-label=\{t\('appointments\.modal\.clearCustomer', 'Clear'\)\}/);
  assert.match(clear, /items-center justify-center/);
  assert.doesNotMatch(clear, /\btitle=/);

  // Modal calendar previous / next month buttons (anchored on their unique aria-label keys, since
  // getMonth() +/- 1 also appears in date formatting elsewhere).
  const prevMonth = button("t('appointments.modal.previousMonth'");
  assert.match(prevMonth, /aria-label=\{t\('appointments\.modal\.previousMonth', 'Previous month'\)\}/);
  assert.match(prevMonth, /h-11 w-11 items-center justify-center/);
  assert.match(prevMonth, /getMonth\(\) - 1/);
  // Round 266 (live QA): the chevron icon now has an explicit visible color in BOTH themes (it was
  // near-blank inheriting currentColor on the dark bg-zinc-950 button); button keeps no hover/title.
  assert.match(prevMonth, /text-zinc-200/);
  assert.match(prevMonth, /text-gray-700/);
  assert.doesNotMatch(prevMonth, /hover:/);
  assert.doesNotMatch(prevMonth, /\btitle=/);
  const nextMonth = button("t('appointments.modal.nextMonth'");
  assert.match(nextMonth, /aria-label=\{t\('appointments\.modal\.nextMonth', 'Next month'\)\}/);
  assert.match(nextMonth, /h-11 w-11 items-center justify-center/);
  assert.match(nextMonth, /getMonth\(\) \+ 1/);
  assert.match(nextMonth, /text-zinc-200/);
  assert.match(nextMonth, /text-gray-700/);
  assert.doesNotMatch(nextMonth, /hover:/);
  assert.doesNotMatch(nextMonth, /\btitle=/);
});

test('Round 230: appointment date/month nav + reused refresh/close accessible names exist in every locale', () => {
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const j = locale(language);
    const a = j.appointments;
    for (const key of ['previousDay', 'nextDay']) {
      assert.equal(typeof a[key], 'string', `${language}.appointments.${key} missing`);
      assert.ok(a[key].length > 0, `${language}.appointments.${key} empty`);
    }
    for (const key of ['previousMonth', 'nextMonth', 'clearCustomer']) {
      assert.equal(typeof a.modal?.[key], 'string', `${language}.appointments.modal.${key} missing`);
    }
    // Reused common labels (refresh + close) are localized too.
    assert.equal(typeof j.common.refresh, 'string', `${language}.common.refresh missing`);
    assert.equal(typeof j.common.actions?.close, 'string', `${language}.common.actions.close missing`);
  }
  // Greek nav labels are real translations, not English.
  const el = locale('el').appointments;
  const en = locale('en').appointments;
  for (const key of ['previousDay', 'nextDay']) {
    assert.notEqual(el[key], en[key], `el.appointments.${key} must be a Greek translation`);
    assert.match(el[key], GREEK, `el.appointments.${key} must be Greek`);
  }
  for (const key of ['previousMonth', 'nextMonth']) {
    assert.notEqual(el.modal[key], en.modal[key], `el.appointments.modal.${key} must be a Greek translation`);
    assert.match(el.modal[key], GREEK, `el.appointments.modal.${key} must be Greek`);
  }
});

// --- Round 240 (live QA): the New Appointment modal is a glass, two-column booking flow whose
// sticky footer never clips the availability guidance / time slots at short heights (1282x802). ---

test('Round 240: the New Appointment modal is a glass two-column booking flow with a reserved footer', () => {
  // The scroll body reserves footer space and can shrink/scroll (min-h-0) so nothing is clipped.
  assert.match(viewSource, /p-4 sm:p-6 overflow-y-auto flex-1 min-h-0 scrollbar-hide/);

  // Translucent, blurred glass dialog (not an opaque slab) in both themes. Round 355 made the shell more
  // translucent still (bg-zinc-950/55 dark, bg-white/18 light) to match the shared POS glass modal system.
  assert.match(viewSource, /bg-zinc-950\/55 backdrop-blur-2xl/);
  assert.match(viewSource, /bg-white\/18 backdrop-blur-2xl/);
  assert.match(viewSource, /isDark \? 'bg-black\/55' : 'bg-black\/22'/);

  // Sectioned glass panels (translucent + blur) — the five form sections (Round 355: lighter, blur-xl).
  const glassPanels = viewSource.match(/bg-zinc-900\/35 backdrop-blur-xl border-white\/10/g) || [];
  assert.ok(glassPanels.length >= 5, `expected >=5 glass panels, found ${glassPanels.length}`);
  const lightGlassPanels = viewSource.match(/bg-white\/14 backdrop-blur-xl border-white\/50/g) || [];
  assert.ok(lightGlassPanels.length >= 5, `expected >=5 light glass panels, found ${lightGlassPanels.length}`);

  // Two-column booking flow with section headers: left = customer/staff/service, right = date/time.
  assert.match(viewSource, /xl:col-span-5 space-y-3/);
  assert.match(viewSource, /xl:col-span-7 space-y-3/);
  assert.match(viewSource, /t\('appointments\.modal\.sections\.guestService', 'Customer & Service'\)/);
  assert.match(viewSource, /t\('appointments\.modal\.sections\.dateTime', 'Date & Time'\)/);

  // The footer is a sticky glass bar (blurred + translucent), and the modal keeps its robust max-h.
  assert.match(viewSource, /shrink-0 backdrop-blur-xl/);
  assert.match(viewSource, /max-h-\[calc\(100%-1\.5rem\)\] sm:max-h-\[calc\(100%-3rem\)\]/);

  // Touch POS: still no hover-only effects and no native title tooltips after the polish.
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /\btitle=/);
});

// Round 355 (live QA): the New Appointment modal is brought fully in line with the shared POS glass modal
// system -- a more-translucent blurred shell with a subtle scale/opacity OPEN ANIMATION, semantic red Cancel +
// green Create with a clear disabled state -- while preserving the openCreateSignal hub flow, Escape/dialog
// semantics, GlassSelect, availability checks, and the hidden-scrollbar pattern (UI-only).
test('Round 355: the appointment modal is an animated translucent glass dialog with red Cancel + green Create', () => {
  // The dialog panel is a motion.div with a subtle scale + fade-in open animation (matches LiquidGlassModal feel).
  assert.match(
    viewSource,
    /<motion\.div\s*\n\s*ref=\{dialogRef\}[\s\S]*?initial=\{\{ opacity: 0, scale: 0\.97 \}\}[\s\S]*?animate=\{\{ opacity: 1, scale: 1 \}\}/,
    'the appointment dialog panel must animate open (scale + fade)',
  );
  // Rounded + ringed translucent blurred glass shell.
  assert.match(viewSource, /role="dialog"[\s\S]*?rounded-3xl border ring-1[\s\S]*?backdrop-blur-2xl/);

  // Cancel reads as soft destructive RED in both themes.
  assert.match(
    viewSource,
    /onClick=\{onClose\} className=\{`px-5 py-2\.5 rounded-xl font-medium border[\s\S]*?border-red-500\/40 bg-red-500\/10 text-red-300[\s\S]*?border-red-300 bg-red-50 text-red-700/,
  );
  // Create reads as semantic GREEN and stays clearly DISABLED until staff + service + start time are chosen.
  assert.match(viewSource, /onClick=\{handleCreateAppointment\}[\s\S]*?bg-emerald-600 text-white border border-emerald-500/);
  assert.match(
    viewSource,
    /onClick=\{handleCreateAppointment\}\s*\n\s*disabled=\{isSubmitting \|\| !formData\.staffId \|\| !formData\.serviceId \|\| !formData\.startTime\}[\s\S]*?disabled:bg-zinc-400\/20[\s\S]*?disabled:cursor-not-allowed/,
  );

  // Behaviour preserved: the hub still opens Create via openCreateSignal; touch-first (no hover / native title).
  assert.match(viewSource, /if \(openCreateSignal && openCreateSignal > 0\) \{\s*setShowCreateModal\(true\);/);
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /\btitle=/);
});

test('Round 240: modal Cancel is soft-destructive red, Create is green primary with a clear disabled state', () => {
  // Cancel = red (both themes) with active tap feedback; the old neutral cancel fill is gone.
  assert.match(viewSource, /border-red-500\/40 bg-red-500\/10 text-red-300 active:bg-red-500\/20/);
  assert.match(viewSource, /\{t\('appointments\.modal\.cancel', 'Cancel'\)\}/);
  assert.doesNotMatch(viewSource, /bg-zinc-900 border-zinc-700 text-zinc-200 active:bg-zinc-800/);

  // Create = emerald green primary, never the old white/black slab, with an explicit disabled state.
  // (Round 248 swapped the disabled treatment from a dimmed-green `disabled:opacity-50` to an
  // explicit neutral/muted glass; this guard only pins the enabled emerald + a disabled-* state.)
  assert.match(
    viewSource,
    /onClick=\{handleCreateAppointment\}\s*disabled=\{[^}]*\}\s*className="px-5 py-2\.5 rounded-xl font-semibold bg-emerald-600 text-white[^"]*disabled:cursor-not-allowed/,
  );
  // Scope the negative check to the Create button (the old white/black slab also appears on unrelated
  // page action buttons, which are intentionally untouched).
  const createBtn = viewSource.slice(
    viewSource.indexOf('onClick={handleCreateAppointment}'),
    viewSource.indexOf('appointments.modal.creating'),
  );
  assert.ok(createBtn.length > 0, 'create button markup must be found');
  assert.doesNotMatch(createBtn, /bg-zinc-100 text-black/);

  // The close (X) icon button stays centered at 44x44.
  assert.match(
    viewSource,
    /aria-label=\{t\('common\.actions\.close', 'Close'\)\}[\s\S]*?inline-flex h-11 w-11 items-center justify-center/,
  );
});

test('Round 240: appointment modal section-header keys exist and are translated in every locale', () => {
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const sections = locale(language).appointments.modal.sections;
    assert.ok(sections, `${language} missing appointments.modal.sections`);
    for (const key of ['guestService', 'dateTime']) {
      assert.equal(typeof sections[key], 'string', `${language}.appointments.modal.sections.${key} missing`);
      assert.ok(sections[key].length > 0, `${language}.appointments.modal.sections.${key} empty`);
    }
  }
  const elSections = locale('el').appointments.modal.sections;
  assert.match(elSections.guestService, GREEK, 'el guestService should be Greek');
  assert.match(elSections.dateTime, GREEK, 'el dateTime should be Greek');
});

// --- Round 248 (live QA, Greek/dark): the New Appointment availability controls (selected
// calendar day, Morning/Afternoon/Evening period, time slot) rendered as stark white slabs
// (bg-zinc-100 text-black) in dark / black slabs (bg-black text-white) in light — off the POS
// black/yellow/glass palette. They must use the core yellow/amber selected accent with black
// text in both themes. The disabled Create button only dimmed its green (disabled:opacity-50),
// still reading as a green submit; disabled Create must be clearly neutral/muted glass while
// enabled Create stays emerald and Cancel stays red. No behaviour/i18n/sizing changes. ---

test('Round 248: New Appointment availability controls use the yellow selected accent, not white/black slabs', () => {
  // Scope to the modal's availability region only (calendar + period + time slots), so the
  // intentionally-untouched page-level quick filters / view toggles / row action buttons
  // (which still use bg-zinc-100/bg-black) are not swept in.
  const availability = viewSource.slice(
    viewSource.indexOf('{/* Calendar */}'),
    viewSource.indexOf('{/* Summary */}'),
  );
  assert.ok(availability.length > 0, 'modal availability region (Calendar..Summary) must be found');

  // No stark white/black selected slabs survive inside the availability controls.
  assert.doesNotMatch(availability, /bg-zinc-100 text-black/, 'no white slab in availability controls');
  assert.doesNotMatch(availability, /bg-black text-white/, 'no black slab in availability controls');

  // All three selected states (calendar day, period segment, time slot) use the core
  // yellow accent with black text — identical in light and dark.
  const yellowSelected = availability.match(/bg-yellow-400 text-black border-yellow-400/g) || [];
  assert.ok(
    yellowSelected.length >= 3,
    `expected >=3 yellow selected accents (calendar/period/slot), found ${yellowSelected.length}`,
  );

  // Each selected branch specifically resolves to the yellow accent (no theme-split slab).
  assert.match(viewSource, /\$\{isSelected \? 'bg-yellow-400 text-black border-yellow-400' : ''\}/);
  assert.match(viewSource, /timePeriod === p\s*\?\s*'bg-yellow-400 text-black border-yellow-400'/);
  assert.match(viewSource, /\$\{selected\s*\?\s*'bg-yellow-400 text-black border-yellow-400'/);

  // Touch/glass invariants for the modal are unchanged (no hover-only effects, no native titles).
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /\btitle=/);
});

test('Round 248: disabled Create is neutral/muted glass while enabled Create stays emerald', () => {
  const createBtn = viewSource.slice(
    viewSource.indexOf('onClick={handleCreateAppointment}'),
    viewSource.indexOf('appointments.modal.creating'),
  );
  assert.ok(createBtn.length > 0, 'create button markup must be found');

  // Enabled state stays emerald green primary.
  assert.match(createBtn, /bg-emerald-600 text-white border border-emerald-500/);

  // Disabled state is explicit neutral/muted glass (translucent zinc fill + muted zinc text +
  // neutral border + no green shadow) — not a dimmed green.
  assert.match(createBtn, /disabled:bg-zinc-400\/20/);
  assert.match(createBtn, /disabled:text-zinc-400/);
  assert.match(createBtn, /disabled:border-zinc-400\/30/);
  assert.match(createBtn, /disabled:shadow-none/);

  // The old dimmed-green disabled treatment is gone (it kept the button reading as green).
  assert.doesNotMatch(createBtn, /disabled:opacity-50/);

  // The disabled override never recolours the button back to green.
  assert.doesNotMatch(createBtn, /disabled:bg-emerald/);

  // Disabled logic and touch behaviour preserved.
  assert.match(viewSource, /disabled=\{isSubmitting \|\| !formData\.staffId \|\| !formData\.serviceId \|\| !formData\.startTime\}/);
  assert.match(createBtn, /disabled:cursor-not-allowed disabled:active:scale-100/);

  // Cancel stays soft-destructive red (unchanged by this round).
  assert.match(viewSource, /border-red-500\/40 bg-red-500\/10 text-red-300 active:bg-red-500\/20/);
});

// --- Round 249 (live QA after Round 248, Greek/dark): the page-level (outside-modal) selected/
// primary controls on the Services/Appointments tab still rendered as old white slabs
// (bg-zinc-100 text-black border-zinc-300) — the Today/Tomorrow/Week quick filter, the
// Timeline/List view toggle, and the primary row quick-actions (timeline + list). They now use the
// core yellow selected accent with black text, while success stays green and danger stays red. The
// Round 248 modal availability controls are untouched. ---

test('Round 249: page-level selected/primary controls use the yellow accent, not white/black slabs', () => {
  // Scope to the page component (everything before the modal content component), so this guard
  // covers the Services/Appointments tab chrome and not the Round 248 modal availability controls.
  const pageRegion = viewSource.slice(0, viewSource.indexOf('const CreateAppointmentModalContent'));
  assert.ok(pageRegion.length > 0, 'page region (AppointmentsView body) must be found');

  // Quick filter (Today/Tomorrow/Week) selected branch → yellow accent.
  assert.match(pageRegion, /quickFilter === filter\s*\?\s*'bg-yellow-400 text-black border border-yellow-400'/);
  // View mode (Timeline/List) selected branch → yellow accent.
  assert.match(pageRegion, /viewMode === mode \? 'bg-yellow-400 text-black border border-yellow-400'/);
  // Primary row quick-actions (timeline + list) → yellow accent (both occurrences).
  const primaryYellow = pageRegion.match(/action\.variant === 'primary' \? 'bg-yellow-400 text-black border border-yellow-400/g) || [];
  assert.ok(primaryYellow.length >= 2, `expected >=2 primary row actions on the yellow accent, found ${primaryYellow.length}`);

  // Semantic row-action colours are preserved: success stays green, danger stays red.
  assert.match(pageRegion, /action\.variant === 'success' \? 'bg-green-600 text-white/);
  assert.match(pageRegion, /action\.variant === 'danger' \? 'bg-red-600 text-white/);

  // The old white/black slabs are gone from the page region (both the dark zinc slab and its
  // light-mode black twin).
  assert.doesNotMatch(pageRegion, /bg-zinc-100 text-black/, 'no white slab in page-level controls');
  assert.doesNotMatch(pageRegion, /bg-black text-white/, 'no black slab in page-level controls');

  // Inactive styling preserved (not collapsed into the yellow accent).
  assert.match(pageRegion, /bg-gray-800 text-gray-300 active:bg-gray-700/);

  // Touch/glass invariants unchanged across the whole view: no hover-only effects, no native titles.
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /\btitle=/);
});

// --- Round 255 (live QA, 1282x802 Greek/dark): on first open the New Appointment date/time column
// buried the time-slot availability below the fold. A first compacting attempt (smaller paddings,
// h-9 day cells, tighter grids) was NOT enough live — the first slot row (07:00…08:00) still sat
// behind the footer. The robust fix RESTRUCTURES the Date & Time section: on xl/desktop the Calendar
// and Time Slots panels sit SIDE-BY-SIDE (xl:grid-cols-2) so the period controls + first slot row land
// in the first viewport; mobile/tablet stay stacked (grid-cols-1). Booking behaviour, the selected
// yellow/black controls, and the Round 240 footer-reservation + slot-scroll contract are preserved. ---

test('Round 255: the New Appointment Date & Time section is a side-by-side calendar/time grid (first-view availability)', () => {
  // The robust fix: Calendar | Time Slots side-by-side on xl (stacked on mobile/tablet) so the
  // time-slot grid is not pushed below the calendar/footer.
  assert.match(viewSource, /<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">/);
  // The compacted panels live inside that shell (calendar panel padding + tighter header/grids/day cells).
  assert.match(viewSource, /p-3 rounded-2xl border \$\{isDark \? 'bg-zinc-900\/35 backdrop-blur-xl border-white\/10'/);
  assert.match(viewSource, /<div className="flex items-center justify-between mb-2">/);
  assert.match(viewSource, /<div className="grid grid-cols-7 gap-1 mb-1\.5">/);
  assert.match(viewSource, /<div className="grid grid-cols-7 gap-1">/);
  assert.match(viewSource, /className=\{`h-9 rounded-xl text-sm transition-all border/);
  // Time-slot panel padding + spacing compacted.
  assert.match(viewSource, /p-3 rounded-2xl border space-y-2\.5 \$\{isDark/);

  // The old roomier spacing is gone in the calendar / time section.
  assert.doesNotMatch(viewSource, /className=\{`h-10 rounded-xl text-sm transition-all border/);
  assert.doesNotMatch(viewSource, /grid grid-cols-7 gap-1\.5/);
  assert.doesNotMatch(viewSource, /p-4 rounded-2xl border space-y-3 \$\{isDark/);

  // The Round 240 footer-reservation body + the slot grid's own scroll are preserved (compaction
  // never reintroduces clipping under the sticky footer).
  assert.match(viewSource, /p-4 sm:p-6 overflow-y-auto flex-1 min-h-0 scrollbar-hide/);
  assert.match(viewSource, /max-h-56 overflow-y-auto pr-1 scrollbar-hide/);

  // Selected calendar day / period / time slot stay yellow + black (3 branches); no hover / native title.
  const yellowSelected = viewSource.match(/bg-yellow-400 text-black border-yellow-400/g) || [];
  assert.ok(
    yellowSelected.length >= 3,
    `calendar/period/slot selected controls must stay yellow/black (found ${yellowSelected.length})`,
  );
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /\btitle=/);
});

// --- Round 278 (live QA, Greek/light): the New Appointment modal still read flat/opaque/grey-admin in
// light theme vs the approved POS glass language. The light shell is now more transparent glass, the
// five section panels are warm white glass (translucent + blur, no grey-admin border-gray-200), and the
// section eyebrows are normal readable case (not shouted uppercase). Availability logic, handlers, footer
// button semantics, dark theme, and the touch/glass invariants are unchanged. ---

test('Round 278: the light New Appointment modal is warm glass (transparent shell, glass panels, normal-case headers)', () => {
  // Light shell is translucent glass, not the old bg-white/85 flat slab.
  assert.match(viewSource, /bg-white\/18 backdrop-blur-2xl border-white\/70 ring-white\/45/);
  assert.doesNotMatch(viewSource, /bg-white\/85/, 'the opaque light slab is gone');

  // The five form section panels use warm white glass (translucent + blur + white border), not the
  // grey-admin bg-white/60 + border-gray-200.
  const lightGlassPanels = viewSource.match(/bg-white\/14 backdrop-blur-xl border-white\/50/g) || [];
  assert.ok(lightGlassPanels.length >= 5, `expected >=5 light glass panels, found ${lightGlassPanels.length}`);
  assert.doesNotMatch(viewSource, /bg-white\/60 backdrop-blur-md border-gray-200/, 'no grey-admin section card remains');

  // Section eyebrows are normal readable case (multilingual UI is not shouted): the uppercase
  // tracking-wide eyebrow treatment is gone, replaced by a normal-case label.
  assert.doesNotMatch(viewSource, /font-semibold uppercase tracking-wide/, 'section eyebrows must not be uppercase');
  assert.match(viewSource, /text-xs font-semibold \$\{isDark \? 'text-zinc-300' : 'text-gray-600'\}/);
  // The section labels still route through i18n (title-case translations), unchanged.
  assert.match(viewSource, /t\('appointments\.modal\.sections\.guestService', 'Customer & Service'\)/);
  assert.match(viewSource, /t\('appointments\.modal\.sections\.dateTime', 'Date & Time'\)/);

  // Dark theme glass is preserved (Round 240/255 dark panels untouched by the light-only polish).
  const darkGlassPanels = viewSource.match(/bg-zinc-900\/35 backdrop-blur-xl border-white\/10/g) || [];
  assert.ok(darkGlassPanels.length >= 5, `dark glass panels must be preserved, found ${darkGlassPanels.length}`);

  // Button semantics preserved: Cancel red glass, Create emerald enabled / neutral-zinc disabled.
  assert.match(viewSource, /border-red-500\/40 bg-red-500\/10 text-red-300 active:bg-red-500\/20/);
  assert.match(viewSource, /bg-emerald-600 text-white border border-emerald-500/);
  assert.match(viewSource, /disabled:bg-zinc-400\/20 disabled:text-zinc-400 disabled:border-zinc-400\/30/);

  // Touch/glass invariants: no hover-only effects, no native title tooltips, modal body scroll hidden.
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /\btitle=/);
  assert.match(viewSource, /p-4 sm:p-6 overflow-y-auto flex-1 min-h-0 scrollbar-hide/);
});

// --- Round 279 (live QA after Round 278, Greek/light): the lower Notes card started under the right
// Date/Time column and was clipped by the sticky footer on first view, and the light header/footer/close
// still read as opaque grey-admin chrome. Notes is moved into the LEFT (Customer & Service) column (which
// had spare vertical space) so it is no longer clipped; Summary stays in the right column (it depends on
// the selected date/time/service). The light header divider, footer bar, and close button are now
// translucent warm glass. Availability logic, handlers, dark theme, and touch/glass invariants unchanged. ---

test('Round 279: Notes lives in the left column (not clipped under the right Date/Time column); Summary stays right', () => {
  const leftStart = viewSource.indexOf('xl:col-span-5 space-y-3');
  const rightStart = viewSource.indexOf('xl:col-span-7 space-y-3');
  const bodyEnd = viewSource.indexOf('{/* Footer');
  assert.ok(leftStart >= 0 && rightStart > leftStart && bodyEnd > rightStart, 'the two-column modal body must be found');
  const leftColumn = viewSource.slice(leftStart, rightStart);
  const rightColumn = viewSource.slice(rightStart, bodyEnd);

  // Notes panel is in the LEFT (Customer & Service) column, not below the right Date/Time column.
  assert.match(leftColumn, /appointments\.modal\.notesLabel/, 'Notes must live in the left column');
  assert.doesNotMatch(rightColumn, /appointments\.modal\.notesLabel/, 'Notes must not sit below the right Date/Time column');

  // Summary (date/time/service dependent) stays in the RIGHT (Date & Time) column.
  assert.match(rightColumn, /formData\.startTime && selectedService && selectedDay/, 'Summary stays in the right column');
  assert.doesNotMatch(leftColumn, /formData\.startTime && selectedService && selectedDay/);

  // Notes textarea state binding is preserved (the move is layout-only).
  assert.match(viewSource, /value=\{formData\.notes\}/);
  assert.match(viewSource, /setFormData\(prev => \(\{ \.\.\.prev, notes: e\.target\.value \}\)\)/);
});

test('Round 279: light modal header/footer/close are translucent warm glass, not grey-admin chrome', () => {
  // Modal-only light branches now use translucent white (glass), not border-gray-200 / bg-white/70 /
  // bg-gray-50 admin chrome.
  assert.match(viewSource, /border-b shrink-0 \$\{isDark \? 'border-white\/10 bg-zinc-950\/25' : 'border-white\/40 bg-white\/12'\}/);
  assert.match(viewSource, /border-t shrink-0 backdrop-blur-xl \$\{isDark \? 'border-white\/10 bg-zinc-950\/55' : 'border-white\/40 bg-white\/14'\}/);
  assert.match(viewSource, /'bg-white\/25 border-white\/65 text-gray-800 active:bg-white\/45'/);

  // The old grey-admin modal chrome is gone (these exact modal strings).
  assert.doesNotMatch(viewSource, /border-b shrink-0 \$\{isDark \? 'border-zinc-800' : 'border-gray-200'\}/);
  assert.doesNotMatch(viewSource, /'border-gray-200 bg-white\/70'/);
  assert.doesNotMatch(viewSource, /'bg-gray-50 border-gray-300 text-gray-700 active:bg-gray-100'/);

  // Dark theme header/footer glass is intact.
  assert.match(viewSource, /border-white\/10 bg-zinc-950\/55/);

  // Close button stays a 44x44 centered touch control with its accessible name.
  assert.match(
    viewSource,
    /aria-label=\{t\('common\.actions\.close', 'Close'\)\}[\s\S]*?inline-flex h-11 w-11 items-center justify-center/,
  );

  // Touch/glass invariants + the Round 240/278 panel-glass counts are preserved.
  assert.doesNotMatch(viewSource, /hover:/);
  assert.doesNotMatch(viewSource, /\btitle=/);
  const darkPanels = viewSource.match(/bg-zinc-900\/35 backdrop-blur-xl border-white\/10/g) || [];
  const lightPanels = viewSource.match(/bg-white\/14 backdrop-blur-xl border-white\/50/g) || [];
  assert.ok(darkPanels.length >= 5, `dark glass panels preserved (found ${darkPanels.length})`);
  assert.ok(lightPanels.length >= 5, `light glass panels preserved (found ${lightPanels.length})`);
});

// --- Round 285 (live QA, Greek/light): the New Appointment time slots were selectable before staff +
// service were chosen, which implies availability was checked when it was not. A slot is now disabled
// until BOTH staff and service are selected (muted glass, 44px touch target); changing staff or service
// clears the picked startTime so availability is re-evaluated in context; and the guidance asks for
// staff AND service (10-year-old clear). The backend availability validation in handleCreateAppointment
// + the Create disabled condition are unchanged. ---

test('Round 285/307: New Appointment slots stay gated on staff + service (in-context selectable; pre-context is the Round 307 empty state)', () => {
  // Derived gate boolean.
  assert.match(viewSource, /const hasStaffAndService = Boolean\(formData\.staffId && formData\.serviceId\)/);

  // Round 307 replaced the pre-context grid of disabled muted-glass slots with a friendly empty state, so
  // the real slot grid now renders only in the staff+service branch. In that branch a slot keeps its
  // >=44px touch target, is disabled only when booked, and uses the selected-yellow / booked-red semantics.
  assert.match(viewSource, /min-h-\[44px\]/);
  assert.match(viewSource, /disabled=\{booked\}/);
  assert.match(viewSource, /selected\s*\?\s*'bg-yellow-400 text-black border-yellow-400'/);
  assert.match(viewSource, /bg-red-500\/10 border-red-500\/30 text-red-300 line-through cursor-not-allowed/);
  // The old per-button pre-context muted-glass disabled slot is gone (the empty state replaces it).
  assert.doesNotMatch(viewSource, /disabled=\{booked \|\| !hasStaffAndService\}/);
  assert.doesNotMatch(viewSource, /bg-white\/\[0\.03\] border-white\/10 text-zinc-600 cursor-not-allowed/);

  // Changing staff or service clears the picked time so availability is recalculated in context.
  // Round 308: the staff/service fields are the GlassSelect listbox, whose onChange passes the value
  // directly (not a DOM event), so the clear-startTime contract reads `<id>: value, startTime: ''`.
  assert.match(viewSource, /staffId: value, startTime: ''/);
  assert.match(viewSource, /serviceId: value, startTime: ''/);

  // Round 285 follow-up (live QA): handleTimeSelect hard-guards on staff + service (defense in depth beyond
  // the structural render gate), and the create form carries NO default '09:00' time anywhere -- so a slot
  // can only become the yellow selected state after staff + service exist and a slot was actually chosen.
  assert.match(viewSource, /if \(!formData\.staffId \|\| !formData\.serviceId \|\| isTimeSlotBooked\(time\)\) return;/);
  assert.doesNotMatch(viewSource, /startTime: '09:00'/, 'no preselected 09:00 default may remain');

  // Backend availability validation (Create-time) + the Create disabled condition are unchanged.
  assert.match(viewSource, /availabilityResult/);
  assert.match(
    viewSource,
    /disabled=\{isSubmitting \|\| !formData\.staffId \|\| !formData\.serviceId \|\| !formData\.startTime\}/,
  );
});

test('Round 285: the staff+service availability guidance key exists in every locale (Greek is real Greek)', () => {
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const v = locale(language).appointments.modal.selectStaffServiceAvailability;
    assert.equal(typeof v, 'string', `${language} missing appointments.modal.selectStaffServiceAvailability`);
    assert.ok(v.length > 0, `${language} empty selectStaffServiceAvailability`);
  }
  const el = locale('el').appointments.modal.selectStaffServiceAvailability;
  const en = locale('en').appointments.modal.selectStaffServiceAvailability;
  assert.notEqual(el, en, 'el guidance must be a Greek translation, not English');
  assert.match(el, GREEK, 'el guidance must be real Greek');
});

// --- Round 307 (live QA, Greek/light): the New Appointment Date & Time panel showed a grid of disabled
// time-slot buttons before staff AND service were chosen, which reads like broken availability. Before both
// are chosen, the right column now renders a friendly warm-glass empty state with a Staff/Service checklist
// (no slot grid); the real period buttons + available/booked slots render only once both exist. ---

test('Round 307: pre-context Date & Time shows a warm-glass empty state + checklist, not a disabled slot grid', () => {
  const emptyIdx = viewSource.indexOf('data-appointment-slots-empty');
  assert.ok(emptyIdx > 0, 'a pre-context empty state must exist');
  const inContextIdx = viewSource.indexOf(') : selectedDay ? (', emptyIdx);
  assert.ok(inContextIdx > emptyIdx, 'the staff+service (in-context) branch must follow the empty state');
  const summaryIdx = viewSource.indexOf('{/* Summary */}', inContextIdx);
  assert.ok(summaryIdx > inContextIdx, 'the Summary marker must close the Date & Time region');

  const preContext = viewSource.slice(emptyIdx, inContextIdx);
  const inContext = viewSource.slice(inContextIdx, summaryIdx);

  // The Date & Time column branches on the staff+service gate FIRST (not selectedDay), so the empty state
  // shows immediately instead of a disabled grid seeded by the default selectedDay.
  assert.match(viewSource, /\{!hasStaffAndService \? \(/);

  // Pre-context: NO slot grid / booked computation -- just the empty-state copy + a Staff/Service checklist.
  assert.doesNotMatch(preContext, /timeSlots\.map/, 'the pre-context empty state must not render the slot grid');
  assert.doesNotMatch(preContext, /isTimeSlotBooked/, 'the pre-context empty state must not compute booked slots');
  assert.match(preContext, /slotsEmpty\.title/);
  assert.match(preContext, /slotsEmpty\.help/);
  assert.match(preContext, /slotsEmpty\.staffStep/);
  assert.match(preContext, /slotsEmpty\.serviceStep/);
  // The two checklist chips reflect each step's completion from the real form state.
  assert.match(preContext, /done: Boolean\(formData\.staffId\)/);
  assert.match(preContext, /done: Boolean\(formData\.serviceId\)/);
  // Warm glass + rounded, on-palette only (amber/emerald/neutral -- no blue/sky/purple drift), no hover/title.
  assert.match(preContext, /rounded-2xl/);
  assert.doesNotMatch(preContext, /\b(?:bg|text|border|from|to|ring)-(?:blue|sky|indigo|violet|cyan|purple)-/);
  assert.doesNotMatch(preContext, /hover:/);
  assert.doesNotMatch(preContext, /\btitle=/);

  // In-context: the real slot grid + period buttons + selected/available/booked behavior live here.
  assert.match(inContext, /timeSlots\.map/, 'the real slot grid must live in the staff+service branch');
  assert.match(inContext, /onClick=\{\(\) => handleTimeSelect\(slot\)\}/);
  assert.match(inContext, /selected\s*\?\s*'bg-yellow-400 text-black border-yellow-400'/);
  assert.match(inContext, /bg-red-500\/10 border-red-500\/30 text-red-300 line-through/);
  assert.match(inContext, /appointments\.modal\.periods\.morning/);
});

// --- Round 308 (live QA, Greek/dark): the New Appointment staff + service fields used native <select>
// controls, whose OS/WebView dropdown rendered a harsh grey strip and non-glass styling, sometimes outside
// the modal surface, and cramped the selected label under the arrow. They are now a touch-first in-modal
// glass listbox (GlassSelect): no native <select>/<option>, role=listbox/option + aria-haspopup/expanded/
// controls, a >=44px trigger whose selected value truncates clear of the chevron, Escape-to-close, and no
// hover/title. Selection behavior (ids, clearing startTime, availability gating, Create condition) is
// unchanged. ---
test('Round 308: New Appointment staff/service use a glass listbox, not native selects', () => {
  // Scope to the modal's Staff & Service region (between its marker and the Notes panel that follows).
  const region = viewSource.slice(
    viewSource.indexOf('data-appointment-staff-service'),
    viewSource.indexOf('appointments.modal.notesLabel'),
  );
  assert.ok(region.length > 0, 'the staff & service region must be found');

  // No native <select>/<option> remain in the staff/service fields.
  assert.doesNotMatch(region, /<select/, 'staff/service must not use a native <select>');
  assert.doesNotMatch(region, /<option/, 'staff/service must not use native <option>s');

  // Exactly two GlassSelect controls (staff + service), bound to the same form ids as before.
  const glassUses = region.match(/<GlassSelect/g) || [];
  assert.equal(glassUses.length, 2, 'staff + service each render a GlassSelect');
  assert.match(region, /value=\{formData\.staffId\}/);
  assert.match(region, /value=\{formData\.serviceId\}/);

  // Behavior preserved: both changes clear startTime; placeholder + labels reuse the existing i18n keys.
  assert.match(region, /staffId: value, startTime: ''/);
  assert.match(region, /serviceId: value, startTime: ''/);
  assert.match(region, /placeholder=\{t\('appointments\.modal\.selectPlaceholder', 'Select\.\.\.'\)\}/);
  assert.match(region, /ariaLabel=\{t\('appointments\.modal\.staffLabel', 'Staff \*'\)\}/);
  assert.match(region, /ariaLabel=\{t\('appointments\.modal\.serviceLabel', 'Service \*'\)\}/);
  // The service option label keeps the "(duration min)" suffix via the localized minutes unit.
  assert.match(region, /label: `\$\{s\.name\} \(\$\{s\.duration\}\$\{t\('common\.minutes', 'min'\)\}\)`/);
});

test('Round 308: GlassSelect is a touch-first glass listbox (aria, 44px, truncating value, Escape, no hover/title)', () => {
  const glass = viewSource.slice(
    viewSource.indexOf('const GlassSelect:'),
    viewSource.indexOf('const CreateAppointmentModalContent'),
  );
  assert.ok(glass.length > 0, 'the GlassSelect component must be found');

  // Listbox/combobox a11y wiring on the trigger + popup.
  assert.match(glass, /aria-haspopup="listbox"/);
  assert.match(glass, /aria-expanded=\{open\}/);
  assert.match(glass, /aria-controls=\{listboxId\}/);
  assert.match(glass, /role="listbox"/);
  assert.match(glass, /role="option"/);
  assert.match(glass, /aria-selected=\{isSelected\}/);

  // Touch target >=44px; the selected value text truncates and cannot overlap the chevron.
  assert.match(glass, /min-h-\[44px\]/);
  assert.match(glass, /min-w-0 flex-1 truncate/);
  assert.match(glass, /<ChevronDown/);
  assert.match(glass, /shrink-0/, 'the chevron stays a fixed-size sibling beside the truncating label');

  // The popup is an in-modal blurred glass surface (not portaled to body, not an OS dropdown).
  assert.match(glass, /role="listbox"[\s\S]*?backdrop-blur-2xl/);
  assert.doesNotMatch(glass, /renderModalPortal|createPortal/, 'the dropdown stays inside the modal DOM');

  // Escape closes the open dropdown via a capture-phase listener that stops propagation (so the modal's
  // own Escape handler does not also close the dialog).
  assert.match(glass, /addEventListener\('keydown', handleEscapeCapture, true\)/);
  assert.match(glass, /event\.stopPropagation\(\);\s*setOpen\(false\)/);
  // Outside-pointer close.
  assert.match(glass, /addEventListener\('pointerdown', handlePointerDown\)/);

  // Touch-first invariants: no hover-only utilities, no native title tooltip, on-palette only.
  assert.doesNotMatch(glass, /hover:/);
  assert.doesNotMatch(glass, /\btitle=/);
  assert.doesNotMatch(glass, /\b(?:bg|text|border|from|to|ring)-(?:blue|sky|indigo|violet|cyan|purple)-/);
});

// --- Round 333 (live QA, Greek/dark, 1282x802): opening the Staff (or Service) GlassSelect rendered its
// listbox BEHIND the Notes card. Both the Staff & Service card and the Notes card use backdrop-blur, so each
// is its own stacking context; as later-in-DOM siblings at z:auto, Notes painted over the listbox no matter
// the listbox's inner z. Fix (no portal, no native select): lift the Staff & Service card above Notes and
// raise the open select's own stacking context + listbox so the dropdown overlays the panels below. ---
test('Round 333: an open GlassSelect listbox overlays the Notes card (stacking fixed, still in-modal)', () => {
  const glass = viewSource.slice(
    viewSource.indexOf('const GlassSelect:'),
    viewSource.indexOf('const CreateAppointmentModalContent'),
  );
  assert.ok(glass.length > 0, 'the GlassSelect component must be found');

  // The GlassSelect wrapper raises its OWN stacking context while open (z-50) and stays low when closed.
  assert.match(glass, /<div ref=\{containerRef\} className=\{`relative \$\{open \? 'z-50' : 'z-10'\}`\}>/);
  // The open listbox is absolutely positioned at a high z (above following panels) and stays in the modal
  // DOM -- not portaled to body, not a native dropdown.
  assert.match(glass, /role="listbox"[\s\S]*?absolute[\s\S]*?\bz-50\b/);
  assert.doesNotMatch(glass, /createPortal|renderModalPortal/);

  // The Staff & Service card is its own ELEVATED, overflow-visible layer (z-20) so the absolutely-positioned
  // listbox can spill over the cards below it.
  const region = viewSource.slice(
    viewSource.indexOf('data-appointment-staff-service'),
    viewSource.indexOf('appointments.modal.notesLabel'),
  );
  assert.match(region, /data-appointment-staff-service className=\{`relative z-20 overflow-visible /);
  assert.ok(region.includes('z-20'), 'staff/service card must be z-20 (above Notes z-10)');

  // The Notes card stays at a LOWER stacking level (z-10) than the staff/service card, so the open listbox
  // overlays it instead of rendering behind it.
  const notesBlock = viewSource.slice(
    viewSource.indexOf('kept at a LOWER stacking level'),
    viewSource.indexOf('appointments.modal.notesPlaceholder'),
  );
  assert.ok(notesBlock.length > 0, 'the Notes card block must be found');
  assert.match(notesBlock, /<div className=\{`relative z-10 rounded-2xl border p-4 /);
  assert.match(notesBlock, /appointments\.modal\.notesLabel/);

  // Touch-first invariants unchanged by the stacking fix: no hover-only utilities, no native title tooltips.
  assert.doesNotMatch(glass, /hover:/);
  assert.doesNotMatch(glass, /\btitle=/);
});

test('Round 307: the slot-empty-state copy + checklist labels exist in every locale (Greek is real Greek)', () => {
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const s = locale(language).appointments.modal.slotsEmpty;
    assert.ok(s, `${language} missing appointments.modal.slotsEmpty`);
    for (const key of ['title', 'help', 'staffStep', 'serviceStep']) {
      assert.equal(typeof s[key], 'string', `${language}.appointments.modal.slotsEmpty.${key} missing`);
      assert.ok(s[key].length > 0, `${language}.appointments.modal.slotsEmpty.${key} empty`);
    }
  }
  const el = locale('el').appointments.modal.slotsEmpty;
  const en = locale('en').appointments.modal.slotsEmpty;
  for (const key of ['title', 'help']) {
    assert.notEqual(el[key], en[key], `el slotsEmpty.${key} must be a Greek translation`);
    assert.match(el[key], GREEK, `el slotsEmpty.${key} must be real Greek`);
  }
});
