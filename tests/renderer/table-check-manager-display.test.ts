import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';

// table-display and role-labels are leaf modules (no imports), so the explicit
// .ts extension keeps this file runnable under a direct `node --test`. We do NOT
// import utils/format here: it transitively imports ../../lib/i18n without an
// extension, which breaks the direct run — its Intl.NumberFormat currency contract
// is replicated by the local `eur` helper below instead.
import { formatTableDisplayNumber } from '../../src/renderer/utils/table-display.ts';
import { translateRoleName } from '../../src/renderer/utils/role-labels.ts';

const eur = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

const modalSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TableCheckManagerModal.tsx'),
  'utf8',
);

const overlayPath = (locale: string) =>
  path.join(process.cwd(), 'src', 'locales', 'overlays', `${locale}.table-check.json`);

const createT = async (locale: string) => {
  const overlay = JSON.parse(readFileSync(overlayPath(locale), 'utf8'));
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: locale,
    resources: { [locale]: { translation: overlay } },
    interpolation: { escapeValue: false },
  });
  return instance.getFixedT(locale);
};

const loadMainLocale = (locale: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${locale}.json`), 'utf8'));

// A t() bound to the full main locale, where common.roleNames.* lives.
const createMainT = async (locale: string) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: 'en',
    resources: {
      en: { translation: loadMainLocale('en') },
      el: { translation: loadMainLocale('el') },
    },
    interpolation: { escapeValue: false },
  });
  return instance.getFixedT(locale);
};

// --- Behavioral: localized table label + currency -------------------------

test('TableCheckManager title renders the shared "#TB04" convention, not raw "B04"', async () => {
  assert.equal(formatTableDisplayNumber('B04'), '#TB04');

  const el = await createT('el');
  assert.equal(
    el('tableCheckManager.title', { number: formatTableDisplayNumber('B04') }),
    'Λογαριασμός τραπεζιού #TB04',
  );
  // The pre-fix raw title (the live repro) must not be produced.
  assert.notEqual(
    el('tableCheckManager.title', { number: formatTableDisplayNumber('B04') }),
    'Λογαριασμός τραπεζιού B04',
  );
});

test('TableCheckManager table labels use the shared display convention across table codes', () => {
  assert.equal(formatTableDisplayNumber('B04'), '#TB04');
  assert.equal(formatTableDisplayNumber('P01'), '#TP01');
  assert.equal(formatTableDisplayNumber('TP01'), '#TP01');
  assert.equal(formatTableDisplayNumber('T06'), '#T06');
});

test('TableCheckManager money is locale-aware (Greek "16,65 €", not hardcoded "€16.65")', () => {
  const el = eur(16.65, 'el-GR');
  assert.match(el, /16,65/); // comma decimal separator
  assert.ok(el.includes('€'));
  assert.notEqual(el, '€16.65'); // not the old hardcoded English-style value
  // English stays English-style.
  assert.equal(eur(16.65, 'en-US'), '€16.65');
  // The discount value is localized the same way.
  assert.match(eur(1.85, 'el-GR'), /1,85/);
});

// --- Source wiring (display only; data writes preserved) ------------------

test('TableCheckManager money() delegates to the shared locale-aware currency formatter', () => {
  assert.match(modalSource, /import \{ formatCurrency \} from '\.\.\/\.\.\/utils\/format';/);
  assert.match(modalSource, /const money = \(value: unknown\) => formatCurrency\(Number\(value \|\| 0\)\)/);
  // The hardcoded "€" + toFixed(2) money helper is gone.
  assert.doesNotMatch(modalSource, /€\$\{Number/);
});

test('TableCheckManager staff-facing table labels go through formatTableDisplayNumber', () => {
  assert.match(modalSource, /import \{ formatTableDisplayNumber \} from '\.\.\/\.\.\/utils\/table-display';/);
  assert.match(
    modalSource,
    /tr\('title', 'Table \{\{number\}\} Check', \{ number: formatTableDisplayNumber\(table\.tableNumber\) \}\)/,
  );
  // The modal's accessible name now comes from aria-labelledby -> the title <h2>
  // (asserted above), which already formats the table number; the standalone
  // aria.tableCheck label was removed in favor of aria-labelledby.
  assert.match(modalSource, /tr\('labels\.fromTable',[^)]*formatTableDisplayNumber\(table\.tableNumber\)/);
  assert.match(modalSource, /tr\('labels\.intoTable',[^)]*formatTableDisplayNumber\(table\.tableNumber\)/);
  assert.match(modalSource, /number: formatTableDisplayNumber\(candidate\.tableNumber\)/);
  assert.match(modalSource, /formatTableDisplayNumber\(linked\.tableNumber\)/);
  // The old raw "T${linked.tableNumber}" hardcoded label is gone.
  assert.doesNotMatch(modalSource, /`T\$\{linked\.tableNumber\}`/);
});

test('TableCheckManager preserves the raw table number in the session-open payload (data write)', () => {
  // buildTableSessionOpenPayload customerName must keep the raw table.tableNumber;
  // display formatting must never leak into stored/matching data.
  assert.match(
    modalSource,
    /customerName: tr\('labels\.tableNumber', 'Table \{\{number\}\}', \{ number: table\.tableNumber \}\)/,
  );
});

// --- Assign-waiter role labels --------------------------------------------

test('TableCheckManager assign-waiter option localizes the role via translateRoleName', () => {
  assert.match(modalSource, /import \{ translateRoleName \} from '\.\.\/\.\.\/utils\/role-labels';/);
  assert.match(modalSource, /translateRoleName\(t, waiter\.role \|\| '', staffMemberFallbackLabel\)/);
  // The raw role slug render ("cashier") is gone.
  assert.doesNotMatch(modalSource, /\{waiter\.role \|\| tr\('labels\.staffMember'/);
});

test('assign-waiter role labels render Greek role names, not raw slugs like "cashier"', async () => {
  const el = await createMainT('el');
  const en = await createMainT('en');
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');

  const elCashier = translateRoleName(el, 'cashier');
  assert.notEqual(elCashier, 'cashier', 'Greek must not render the raw "cashier" slug');
  assert.match(elCashier, GREEK_LETTER, `el cashier role should be Greek: "${elCashier}"`);
  // It resolves through the shared common.roleNames.* namespace.
  assert.equal(elCashier, loadMainLocale('el').common.roleNames.cashier);
  assert.equal(translateRoleName(en, 'cashier'), loadMainLocale('en').common.roleNames.cashier);

  // An empty role falls back to a localized "staff member" label, never blank.
  const elFallback = translateRoleName(el, '', loadMainLocale('el').common.roleNames.staff);
  assert.ok(elFallback.length > 0);
  assert.notEqual(elFallback, '');
});

test('TableCheckManager loadSession clears the spinner on local lookup failure / fallback paths', () => {
  const start = modalSource.indexOf('const loadSession = useCallback');
  assert.ok(start > -1, 'loadSession not found');
  const end = modalSource.indexOf('}, [isOpen, localOrders', start);
  assert.ok(end > start, 'loadSession dependency array not found');
  const slice = modalSource.slice(start, end);

  const loadingTrueIdx = slice.indexOf('setIsLoading(true)');
  const tryIdx = slice.indexOf('try {');
  const bridgeIdx = slice.indexOf('fetchBridgeOrders()');
  const snapshotIdx = slice.indexOf('fetchLocalPaymentSnapshot(');
  const finallyIdx = slice.indexOf('} finally {');
  const loadingFalseIdx = slice.indexOf('setIsLoading(false)');

  // The local bridge + payment-snapshot lookups run INSIDE the guarded try (which
  // opens after setIsLoading(true)) — never before it, where a throw would strand
  // the spinner.
  assert.ok(loadingTrueIdx > -1 && tryIdx > loadingTrueIdx, 'try must open after setIsLoading(true)');
  assert.ok(bridgeIdx > tryIdx, 'fetchBridgeOrders must run inside the guarded try');
  assert.ok(snapshotIdx > tryIdx, 'fetchLocalPaymentSnapshot must run inside the guarded try');
  // Loading is always cleared in the finally on every success/fallback/error path.
  assert.ok(finallyIdx > -1 && loadingFalseIdx > finallyIdx, 'setIsLoading(false) must be in the finally block');

  // Each local lookup is TIME-BOUNDED (resolveWithTimeout), so a hung promise that
  // never settles — not only a throw/reject — still falls back and lets the load
  // proceed instead of leaving the spinner forever.
  assert.match(slice, /resolveWithTimeout\(fetchBridgeOrders\(\), \[\] as Order\[\]\)/);
  assert.match(slice, /resolveWithTimeout\(\s*fetchLocalPaymentSnapshot\(localOrder\?\.id\),/);

  // The timeout helper races the lookup against a timer and resolves to the fallback
  // on hang (setTimeout) as well as rejection.
  assert.match(modalSource, /function resolveWithTimeout<T>\(promise: Promise<T>, fallback: T/);
  assert.match(modalSource, /const timer = setTimeout\(\(\) => finish\(fallback\), timeoutMs\)/);

  // The old unbounded awaits (which a hang could strand) must be gone.
  assert.doesNotMatch(modalSource, /const bridgeOrders = await fetchBridgeOrders\(\);/);
  assert.doesNotMatch(slice, /bridgeOrders = \(await fetchBridgeOrders\(\)\) as any\[\];/);
});

test('TableCheckManager item rows use explicit readable text colors (legible on the dark glass row)', () => {
  // The item name must NOT rely on liquid-glass-modal-text (var(--modal-c-content),
  // no dark-shell override) — that rendered near-invisible dark-on-dark.
  assert.match(modalSource, /text-base font-semibold text-gray-900 dark:text-white">\{itemDisplayName/);
  assert.doesNotMatch(modalSource, /font-semibold liquid-glass-modal-text">\{itemDisplayName/);

  // Item details (qty / unpaid / discount) use an explicit muted-but-readable color.
  assert.match(modalSource, /flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-zinc-300/);

  // Per-line Total and "each" amounts are readable too (no bare muted glass class).
  assert.match(modalSource, /text-xs text-gray-600 dark:text-zinc-300">[\s\S]*?labels\.totalAmount/);
  assert.match(modalSource, /text-xs text-gray-600 dark:text-zinc-300">[\s\S]*?labels\.eachAmount/);
});

// --- Table destination picker (dark-mode contrast) -----------------------

test('table-destination secondary sheets no longer use native select/option dropdowns', () => {
  // Native Windows/Tauri <select> option popups are unstyleable (light-gray menu,
  // low-contrast white option text) over the dark glass modal. None of the four
  // destination sheets (batch-transfer, transfer-item, move-table, merge-table)
  // may fall back to a native control.
  assert.doesNotMatch(modalSource, /<select/);
  assert.doesNotMatch(modalSource, /<option/);
  // The now-unused native-select class is gone too.
  assert.doesNotMatch(modalSource, /glassSelectClass/);
});

test('table-destination sheets render the dark-mode-safe TableDestinationPicker listbox', () => {
  // A custom listbox of explicitly-colored buttons replaces the native select, so
  // contrast is controlled in CSS instead of by the OS popup.
  assert.match(modalSource, /const TableDestinationPicker: React\.FC<TableDestinationPickerProps>/);
  assert.match(modalSource, /role="listbox"/);
  assert.match(modalSource, /role="option"/);
  assert.match(modalSource, /aria-selected=\{selected\}/);

  // Explicit readable colors for both themes: selected high-contrast, unselected
  // legible on light AND dark glass (no reliance on the native popup styling).
  assert.match(modalSource, /selected[\s\S]{0,40}'bg-blue-600 text-white/);
  assert.match(modalSource, /text-gray-900 hover:bg-black\/5 dark:text-zinc-100 dark:hover:bg-white\/10/);

  // All four destination sheets are wired to the picker (3 target + 1 merge).
  const pickerUses = modalSource.match(/<TableDestinationPicker\b/g) || [];
  assert.equal(pickerUses.length, 4, `expected 4 TableDestinationPicker usages, found ${pickerUses.length}`);
});

test('TableDestinationPicker preserves raw table ids for writes/matching (display via optionLabel)', () => {
  // value/onChange carry the raw id; only the visible label is formatted. The three
  // target sheets bind targetTableId, merge-table binds mergeTableId.
  const targetBindings = modalSource.match(/value=\{targetTableId\}/g) || [];
  assert.equal(targetBindings.length, 3, 'batch-transfer, transfer-item, move-table must bind targetTableId');
  assert.match(modalSource, /onChange=\{setTargetTableId\}/);
  assert.match(modalSource, /value=\{mergeTableId\}/);
  assert.match(modalSource, /onChange=\{setMergeTableId\}/);

  // Display label still flows through the shared formatter; raw tableNumber never
  // leaks into the selected id.
  assert.match(
    modalSource,
    /optionLabel=\{\(candidate\) => tr\('labels\.tableNumber'[\s\S]*?formatTableDisplayNumber\(candidate\.tableNumber\)/,
  );

  // The action handlers still send the raw selected id and stay disabled until set.
  assert.match(modalSource, /target_table_id: targetTableId/);
  assert.match(modalSource, /table_ids: \[mergeTableId\]/);
  assert.match(modalSource, /disabled=\{isSaving \|\| !targetTableId\}/);
  assert.match(modalSource, /disabled=\{isSaving \|\| !mergeTableId\}/);
});

test('Move and Merge openers clear any stale destination before opening (no carry-over)', () => {
  // Direct Move/Merge must reset the destination so a canceled prior target cannot
  // re-enable the final action on reopen (transfer/batch already reset on open).
  assert.match(
    modalSource,
    /const openMoveTableModal = \(\) => \{[\s\S]*?setTargetTableId\(''\);[\s\S]*?setSecondaryModal\('move-table'\);[\s\S]*?\};/,
  );
  assert.match(
    modalSource,
    /const openMergeTableModal = \(\) => \{[\s\S]*?setMergeTableId\(''\);[\s\S]*?setSecondaryModal\('merge-table'\);[\s\S]*?\};/,
  );

  // The reset must precede opening the sheet in each opener.
  const moveStart = modalSource.indexOf('const openMoveTableModal');
  const moveSlice = modalSource.slice(moveStart, moveStart + 280);
  assert.ok(
    moveSlice.indexOf("setTargetTableId('')") > -1 &&
      moveSlice.indexOf("setTargetTableId('')") < moveSlice.indexOf("setSecondaryModal('move-table')"),
    'move opener must clear targetTableId before opening move-table',
  );
  const mergeStart = modalSource.indexOf('const openMergeTableModal');
  const mergeSlice = modalSource.slice(mergeStart, mergeStart + 280);
  assert.ok(
    mergeSlice.indexOf("setMergeTableId('')") > -1 &&
      mergeSlice.indexOf("setMergeTableId('')") < mergeSlice.indexOf("setSecondaryModal('merge-table')"),
    'merge opener must clear mergeTableId before opening merge-table',
  );

  // The Move/Merge buttons go through the resetting openers, not a bare
  // setSecondaryModal(...) that would skip the reset (the live repro).
  assert.match(modalSource, /onClick=\{openMoveTableModal\}/);
  assert.match(modalSource, /onClick=\{openMergeTableModal\}/);
  assert.doesNotMatch(modalSource, /onClick=\{\(\) => setSecondaryModal\('move-table'\)\}/);
  assert.doesNotMatch(modalSource, /onClick=\{\(\) => setSecondaryModal\('merge-table'\)\}/);
});

test('table-destination picker fields use the non-<label> FieldGroup (no listbox inside a label)', () => {
  // FormField renders a <label>; a <label> must not wrap the listbox's option
  // buttons — it folds the field label into every option's accessible name (the
  // live "Τραπέζι προορισμού Τραπέζι #TP01" double-announce). A div-based
  // FieldGroup with aria-labelledby is used for picker fields instead.
  assert.match(modalSource, /const FieldGroup: React\.FC<FieldGroupProps> = /);
  assert.match(modalSource, /<div role="group" aria-labelledby=\{labelId\}>/);
  assert.match(modalSource, /<span id=\{labelId\}/);

  // All four picker fields are wrapped by FieldGroup (none by FormField).
  const fieldGroupWraps =
    modalSource.match(/<FieldGroup label=\{tr\([^)]*\)\} labelId="table-check-(batch|transfer|move|merge)-target">/g) || [];
  assert.equal(fieldGroupWraps.length, 4, `expected 4 FieldGroup-wrapped picker fields, found ${fieldGroupWraps.length}`);

  // Each picker is named by its FieldGroup span via aria-labelledby, not aria-label.
  assert.match(modalSource, /aria-labelledby=\{labelledBy\}/);
  assert.doesNotMatch(modalSource, /aria-label=\{ariaLabel\}/);
  const labelledByUses = modalSource.match(/labelledBy="table-check-(batch|transfer|move|merge)-target"/g) || [];
  assert.equal(labelledByUses.length, 4, 'all four pickers must reference their FieldGroup label id');

  // FormField stays a <label> for ordinary inputs (it must not regress to a div).
  assert.match(
    modalSource,
    /const FormField: React\.FC<FormFieldProps> = \(\{ label, children \}\) => \(\s*<label className="block">/,
  );
});

test('TableCheckManager secondary sheets portal to body with a full-viewport blur above the main modal', () => {
  // Secondary sheets (pay-table, batch-*, item-actions, transfer/move/merge, assign-waiter,
  // covers) must mount at document.body, not as an absolute overlay inside the modal shell.
  assert.match(modalSource, /import \{ renderModalPortal \} from '\.\.\/\.\.\/utils\/render-modal-portal';/);
  assert.match(
    modalSource,
    /const SecondarySheet: React\.FC<SecondarySheetProps> = \([\s\S]*?\) => \{[\s\S]*?return renderModalPortal\(/,
  );
  // Full-viewport fixed overlay stacked above the main table-check modal (z 20000),
  // dimmed + blurred so the rest of the POS screen is obscured.
  assert.match(modalSource, /className="fixed inset-0 z-\[20050\][^"]*bg-black\/35[^"]*backdrop-blur-md/);
  // The old in-shell absolute overlay (clipped by the modal container) is gone.
  assert.doesNotMatch(modalSource, /className="absolute inset-0 z-10 flex items-center justify-center bg-black\/35/);
});

// --- Topmost-dialog Escape + dialog semantics ----------------------------

test('table-account modal has labelled dialog semantics and closes on Escape (topmost-gated)', () => {
  // The modal was already role="dialog"; it is now labelled by its title via a stable
  // useId and keyboard-dismissible like the other app-level POS modals.
  assert.match(modalSource, /const mainTitleId = useId\(\);/);
  assert.match(modalSource, /ref=\{mainDialogRef\}/);
  assert.match(modalSource, /aria-modal="true"/);
  assert.match(modalSource, /aria-labelledby=\{mainTitleId\}/);
  assert.match(modalSource, /<h2 id=\{mainTitleId\}/);
  // The old aria-label (no stable id) is replaced by aria-labelledby.
  assert.doesNotMatch(modalSource, /aria-label=\{tr\('aria\.tableCheck'/);

  const escEffect = modalSource.match(
    /useEffect\(\(\) => \{\s*if \(!isOpen\) \{\s*return;\s*\}\s*const handleEscape = \(event: KeyboardEvent\)[\s\S]*?\}, \[isOpen, onClose\]\);/,
  );
  assert.ok(escEffect, 'main modal isOpen-gated Escape effect must exist');
  assert.match(escEffect[0], /if \(event\.key !== 'Escape'\) \{\s*return;\s*\}/);
  assert.match(escEffect[0], /document\.querySelectorAll\('\[role="dialog"\]'\)/);
  assert.match(escEffect[0], /dialogs\[dialogs\.length - 1\] !== mainDialogRef\.current/);
  // Escape routes through the close-only onClose (never settle/pay).
  assert.match(escEffect[0], /event\.preventDefault\(\);\s*onClose\(\);/);
});

test('nested secondary sheet is a labelled dialog and closes only itself on Escape (topmost-gated)', () => {
  assert.match(modalSource, /const sheetTitleId = useId\(\);/);
  assert.match(modalSource, /ref=\{sheetRef\}/);
  assert.match(modalSource, /aria-labelledby=\{sheetTitleId\}/);
  assert.match(modalSource, /<h3 id=\{sheetTitleId\}/);

  // The sheet's own Escape effect (no isOpen gate - mounted only while open), topmost
  // gated against its own ref, routes through onClose (closeSecondaryModal).
  const sheetEsc = modalSource.match(/const sheetRef = useRef<HTMLDivElement>\(null\);[\s\S]*?\}, \[onClose\]\);/);
  assert.ok(sheetEsc, 'secondary sheet Escape effect must exist');
  assert.match(sheetEsc[0], /dialogs\[dialogs\.length - 1\] !== sheetRef\.current/);
  assert.match(sheetEsc[0], /event\.preventDefault\(\);\s*onClose\(\);/);

  // Both the table-account modal AND the nested sheet now declare role="dialog", so the
  // topmost gate dismisses only the frontmost (parent stays open while the sheet closes).
  const dialogRoles = modalSource.match(/role="dialog"/g) || [];
  assert.ok(dialogRoles.length >= 2, `both the modal and the sheet must be role="dialog" (found ${dialogRoles.length})`);
});
