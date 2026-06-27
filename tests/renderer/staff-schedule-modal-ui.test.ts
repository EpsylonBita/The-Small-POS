import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const viewSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'verticals', 'salon', 'StaffScheduleView.tsx'),
  'utf8',
);

const loadLocale = (language: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${language}.json`), 'utf8'));

test('add-shift modal is a bounded flex column that fits the viewport below the title bar', () => {
  // The card is a height-capped flex column that clips overflow, so header/body/footer
  // are laid out independently instead of the whole card scrolling as one unit.
  assert.match(
    viewSource,
    /relative flex h-\[calc\(100vh-3\.5rem\)\] max-h-\[calc\(100vh-3\.5rem\)\] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border/,
    'modal card should have a definite viewport-bounded flex height with hidden overflow',
  );
  // The overlay leaves room for the fixed 32px (h-8) CustomTitleBar at the top.
  assert.match(
    viewSource,
    /fixed inset-0 z-50 flex items-center justify-center px-4 pb-4 pt-10/,
    'modal overlay should clear the fixed title bar so the close button stays reachable',
  );
  // The previous "whole card scrolls" layout must be gone.
  assert.doesNotMatch(
    viewSource,
    /max-h-\[calc\(100vh-2rem\)\] w-full max-w-3xl overflow-y-auto scrollbar-hide rounded-2xl border p-5 md:p-6/,
  );
});

test('staff schedule modals portal outside the page container and blur the app backdrop', () => {
  assert.match(viewSource, /import \{ createPortal \} from 'react-dom';/);
  assert.match(viewSource, /const renderModalPortal = \(modal: React\.ReactNode\) => \{/);
  assert.match(viewSource, /return createPortal\(modal, document\.body\);/);
  assert.match(viewSource, /\{previewWeekOpen && renderModalPortal\(/);
  assert.match(viewSource, /\{createModalOpen && createModalDate && renderModalPortal\(/);
  assert.match(viewSource, /className="absolute inset-0 bg-black\/60 backdrop-blur-sm"/);
});

test('add-shift modal keeps a scrollable body and a non-scrolling footer for Cancel/Create', () => {
  // Scrollable body.
  assert.match(viewSource, /flex-1 min-h-0 overflow-y-auto scrollbar-hide space-y-4 p-5 md:p-6/);
  // Footer stays out of the scroll region (shrink-0 + top divider) so the actions stay visible.
  assert.match(
    viewSource,
    /flex items-center justify-end gap-3 shrink-0 border-t \$\{isDark \? 'border-zinc-800' : 'border-gray-200'\} p-5 md:p-6/,
  );
  // Header is also pinned (non-scrolling) so the close button stays visible.
  assert.match(
    viewSource,
    /flex items-start justify-between gap-3 shrink-0 border-b \$\{isDark \? 'border-zinc-800' : 'border-gray-200'\} p-5 md:p-6/,
  );
});

test('next-day shortcut only rolls the end date for a genuine overnight wrap', () => {
  assert.match(
    viewSource,
    /import \{[\s\S]*shouldRollEndToNextDay[\s\S]*\} from '\.\.\/\.\.\/\.\.\/utils\/staff-shift-duration';/,
  );
  // The shortcut consults the helper and only advances the date when it returns true.
  assert.match(viewSource, /const rollToNextDay = shouldRollEndToNextDay\(/);
  assert.match(viewSource, /if \(rollToNextDay\) \{\s*endDay\.setDate\(endDay\.getDate\(\) \+ 1\);/);
  // The old unconditional "+1 day then setEndDate" is gone (no setDate immediately
  // before setCreateEndDate without the guard).
  assert.doesNotMatch(
    viewSource,
    /endDay\.setDate\(endDay\.getDate\(\) \+ 1\);\s*setCreateEndDate/,
  );
});

test('preview and submit share one duration validator so they cannot disagree', () => {
  assert.match(
    viewSource,
    /import \{[\s\S]*evaluateShiftDuration[\s\S]*\} from '\.\.\/\.\.\/\.\.\/utils\/staff-shift-duration';/,
  );
  // Used in both the live preview memo and the create handler.
  const usages = viewSource.match(/evaluateShiftDuration\(startIso, endIso\)/g) || [];
  assert.ok(usages.length >= 2, `expected evaluateShiftDuration in preview and submit, found ${usages.length}`);
  // Both surfaces flag the over-long case with the localized validation key.
  const tooLong = viewSource.match(/staffSchedule\.validation\.tooLong/g) || [];
  assert.ok(tooLong.length >= 2, `expected the tooLong validation in preview and submit, found ${tooLong.length}`);
  // The naive end<=start-only gate that allowed the 30h shift is gone from submit.
  assert.doesNotMatch(viewSource, /new Date\(endIso\)\.getTime\(\) <= new Date\(startIso\)\.getTime\(\)/);
});

test('staffSchedule.validation.tooLong exists in every locale with the {{hours}} token and Greek is translated', () => {
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const value = loadLocale(language).staffSchedule?.validation?.tooLong;
    assert.equal(typeof value, 'string', `${language} missing staffSchedule.validation.tooLong`);
    assert.match(value, /\{\{hours\}\}/, `${language} tooLong must keep the {{hours}} token`);
  }
  assert.notEqual(
    loadLocale('el').staffSchedule.validation.tooLong,
    loadLocale('en').staffSchedule.validation.tooLong,
    'el tooLong must differ from the English source',
  );
});

// Regression contract for the Staff Schedule modal Escape behavior (2026-06-21 live QA):
// the Week Preview modal did not close on Escape, and the Add Shift modal used a broad
// window keydown. Both must use the shared topmost-[role="dialog"] close-only gate.
test('add-shift modal closes on Escape via the topmost-dialog gate, not while saving', () => {
  // Labelled dialog semantics so the panel joins the [role="dialog"] stack the gate scans.
  assert.match(viewSource, /const createDialogRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(viewSource, /const createTitleId = useId\(\);/);
  assert.match(
    viewSource,
    /ref=\{createDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{createTitleId\}/,
  );
  assert.match(viewSource, /<h3 id=\{createTitleId\}[^>]*>\{t\('staffSchedule\.addShift', 'Add Shift'\)\}/);

  // Escape effect: gated on createModalOpen + not saving, topmost-gated against the panel,
  // routed to the close-only state reset (no create).
  assert.match(viewSource, /if \(event\.key !== 'Escape' \|\| creatingShift\) \{\s*return;\s*\}/);
  assert.match(viewSource, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== createDialogRef\.current/);
  assert.match(
    viewSource,
    /event\.preventDefault\(\);\s*setCreateModalOpen\(false\);\s*setCreateModalDate\(null\);/,
  );
  // It listens on document (topmost gate), not the broad window listener it replaced.
  assert.match(viewSource, /document\.addEventListener\('keydown', handleEscape\)/);
  assert.doesNotMatch(viewSource, /window\.addEventListener\('keydown', handleKeyDown\)/);
  // Escape never creates a shift.
  assert.doesNotMatch(viewSource, /event\.preventDefault\(\);\s*(void )?handleCreateShift/);
});

test('week preview modal closes on Escape via the same topmost-dialog close-only gate', () => {
  // The preview panel is a labelled dialog.
  assert.match(viewSource, /const previewDialogRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(viewSource, /const previewTitleId = useId\(\);/);
  assert.match(
    viewSource,
    /ref=\{previewDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{previewTitleId\}/,
  );
  assert.match(viewSource, /<h3 id=\{previewTitleId\}[^>]*>\s*\{t\('staffSchedule\.previewWeek\.title', 'Week preview'\)\}/);

  // Escape effect: gated on previewWeekOpen, topmost-gated against the preview panel,
  // routed to the close-only setPreviewWeekOpen(false).
  assert.match(viewSource, /if \(!previewWeekOpen\) \{\s*return;\s*\}/);
  assert.match(viewSource, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== previewDialogRef\.current/);
  assert.match(viewSource, /event\.preventDefault\(\);\s*setPreviewWeekOpen\(false\);/);

  // Both modals still portal outside the container with a blurred backdrop, and the
  // existing backdrop/X close handlers are preserved.
  assert.match(viewSource, /\{previewWeekOpen && renderModalPortal\(/);
  assert.match(viewSource, /\{createModalOpen && createModalDate && renderModalPortal\(/);
  assert.ok(
    (viewSource.match(/absolute inset-0 bg-black\/60 backdrop-blur-sm/g) || []).length >= 2,
    'both modals keep the blurred app backdrop',
  );
  assert.match(viewSource, /onClick=\{closeCreateModal\}/);
  assert.match(viewSource, /onClick=\{\(\) => setPreviewWeekOpen\(false\)\}/);
});

test('creating a shift optimistically updates the current week without waiting for a manual refresh', () => {
  // handleCreateShift inserts an optimistic shift from the create payload BEFORE the
  // post-create refetch, so the grid/stats update immediately even when the Tauri
  // read-after-write is momentarily stale.
  const createFn = viewSource.match(/const handleCreateShift = async \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(createFn, 'handleCreateShift not found');
  assert.match(createFn[0], /const optimisticShift: ScheduleShift = \{/);
  assert.match(createFn[0], /staff_id: createStaffId,/);
  assert.match(createFn[0], /start_time: startIso,/);
  assert.match(createFn[0], /end_time: endIso,/);
  assert.match(createFn[0], /setOptimisticShifts\(prev =>/);
  // The optimistic insert must run before the (possibly stale) refetch so it is not
  // clobbered before it can show.
  assert.ok(
    createFn[0].indexOf('setOptimisticShifts') < createFn[0].indexOf('fetchStaffData'),
    'optimistic insert must happen before the post-create fetchStaffData',
  );
});

test('the schedule grid renders the merged optimistic+server shifts, not raw server shifts only', () => {
  // weeklyShifts (which feeds the day grid, stats, and unscheduled list) iterates the
  // merged displayShifts so an optimistic shift is visible immediately.
  assert.match(viewSource, /const displayShifts = useMemo<ScheduleShift\[\]>\(/);
  assert.match(viewSource, /for \(const shift of displayShifts\)/);
  assert.doesNotMatch(viewSource, /for \(const shift of shifts\) \{/);
  // Optimistic shifts already reflected by the server are filtered out (no duplicates).
  assert.match(
    viewSource,
    /optimisticShifts\.filter\(shift => !serverIdentities\.has\(getShiftIdentity\(shift\)\)\)/,
  );
});

test('a successful fetch reconciles (prunes) optimistic shifts the server now returns', () => {
  // Once a later fetch includes the created shift, the optimistic copy is dropped so
  // it never lingers or double-renders, while still-unsynced ones survive.
  assert.match(viewSource, /const serverIdentities = new Set\(serverShifts\.map\(getShiftIdentity\)\)/);
  assert.match(
    viewSource,
    /setOptimisticShifts\(prev =>\s*prev\.length === 0\s*\? prev\s*: prev\.filter\(shift => !serverIdentities\.has\(getShiftIdentity\(shift\)\)\),?\s*\)/,
  );
});
