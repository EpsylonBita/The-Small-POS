import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// role-labels is a leaf util (no relative imports), so the explicit .ts extension
// keeps the behavioral role-label assertion runnable under a direct `node --test`.
import { translateRoleName } from '../../src/renderer/utils/role-labels.ts';

const projectRoot = process.cwd();

// A t() backed by the real Greek locale, returning the key when unmapped (so
// translateRoleName's "translated !== key" guard behaves like the live i18next).
const loadLocale = (locale: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${locale}.json`), 'utf8'));
const makeLocaleT = (locale: string) => {
  const dict = loadLocale(locale);
  return (key: string): string => {
    const value = key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      dict,
    );
    return typeof value === 'string' ? value : key;
  };
};

const expenseModalPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'ExpenseModal.tsx',
);

const source = readFileSync(expenseModalPath, 'utf8');

test('ExpenseModal uses yellow selected tabs and neutral inactive tabs', () => {
  assert.match(
    source,
    /active\s*\?\s*'border-yellow-400 bg-yellow-400 text-black shadow-\[0_14px_34px_rgba\(250,204,21,0\.24\)\]'/,
  );
  assert.match(
    source,
    /:\s*'border-neutral-700\/60 bg-neutral-950\/55 text-neutral-200 dark:border-neutral-700\/60 dark:bg-neutral-950\/55 dark:text-neutral-200'/,
  );
  assert.doesNotMatch(
    source,
    /border-blue-500\/60 bg-blue-600 text-white/,
  );
  assert.doesNotMatch(
    source,
    /hover:border-blue-300|hover:text-blue-700|dark:hover:border-blue-500\/30|dark:hover:text-blue-300/,
  );
  assert.doesNotMatch(source, /hover:/);
});

test('ExpenseModal uses neutral cards and black drawer input fields', () => {
  assert.match(
    source,
    /const drawerPanelClass = 'rounded-\[28px\] border border-neutral-700\/70 bg-neutral-950\/80 p-5[\s\S]*dark:bg-neutral-950\/80'/,
  );
  assert.match(
    source,
    /const drawerSidePanelClass = 'rounded-\[28px\] border border-neutral-700\/70 bg-neutral-950\/80 p-3\.5[\s\S]*dark:bg-neutral-950\/80'/,
  );
  assert.match(
    source,
    /const drawerSummaryCardClass = 'rounded-3xl border border-neutral-700\/70 bg-black\/50[\s\S]*dark:bg-black\/50/,
  );
  assert.match(
    source,
    /const drawerEmptyStateClass = 'rounded-3xl border border-dashed border-neutral-700\/70 bg-neutral-900\/70[\s\S]*dark:bg-neutral-900\/70'/,
  );
  assert.match(
    source,
    /const drawerInputClass = 'w-full rounded-2xl border border-neutral-700\/80 bg-black px-4 py-3 text-white[\s\S]*focus:border-yellow-400\/70/,
  );
  assert.match(source, /className=\{drawerPanelClass\}/);
  assert.match(source, /className=\{drawerSidePanelClass\}/);
  assert.match(source, /className=\{`\$\{drawerInputClass\} flex items-center justify-between gap-3 text-left/);
  assert.match(source, /className=\{`\$\{drawerInputClass\} !pl-10 text-lg font-bold`\}/);
  assert.match(source, /className=\{`\$\{drawerInputClass\} min-h-\[92px\] resize-none`\}/);
  assert.doesNotMatch(source, /liquid-glass-modal-input/);
  assert.doesNotMatch(source, /dark:bg-slate-(900|950)/);
  assert.doesNotMatch(source, /bg-neutral-50\/85|bg-neutral-100\/90|bg-white\/80/);
});

test('ExpenseModal keeps drawer submit button wrappers transparent with colored icon text', () => {
  assert.match(
    source,
    /const drawerExpenseSubmitClass = '!border-neutral-700\/60 !bg-transparent !font-bold !text-emerald-400 !shadow-none active:!scale-\[0\.98\] disabled:!text-emerald-400 disabled:!opacity-100'/,
  );
  assert.match(
    source,
    /const drawerStaffPaymentSubmitClass = '!border-neutral-700\/60 !bg-transparent !font-bold !text-yellow-400 !shadow-none active:!scale-\[0\.98\] disabled:!text-yellow-400 disabled:!opacity-100'/,
  );
  assert.match(
    source,
    /variant="success"[\s\S]*icon=\{<Receipt className="h-4 w-4" \/>\}[\s\S]*className=\{drawerExpenseSubmitClass\}/,
  );
  assert.match(
    source,
    /variant="warning"[\s\S]*icon=\{<BadgeDollarSign className="h-4 w-4" \/>\}[\s\S]*className=\{drawerStaffPaymentSubmitClass\}/,
  );
});

test('ExpenseModal renders recent expenses empty state with unwrapped green money icon', () => {
  assert.match(source, /Banknote,/);
  assert.match(
    source,
    /renderEmptyState\(\s*<Banknote className="mx-auto block h-9 w-9 text-emerald-400" strokeWidth=\{2\.2\} \/>[\s\S]*\{ wrapIcon: false \},/,
  );
  assert.match(
    source,
    /options\?: \{ wrapIcon\?: boolean \}/,
  );
  assert.match(
    source,
    /options\?\.wrapIcon === false \? icon : \(/,
  );
  assert.doesNotMatch(
    source,
    /<Receipt className="h-5 w-5 text-rose-500 dark:text-rose-300" \/>/,
  );
  assert.doesNotMatch(
    source,
    /renderEmptyState\(\s*<Receipt className="h-6 w-6" \/>[\s\S]*noExpenses/,
  );
});

test('ExpenseModal uses modern custom dropdowns and removes form total chips', () => {
  assert.match(source, /type DrawerDropdownKey = 'expenseType' \| 'staffMember' \| 'paymentType'/);
  assert.match(
    source,
    /const drawerDropdownMenuClass = 'absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-neutral-700\/80 bg-neutral-950/,
  );
  assert.match(source, /const renderDrawerDropdown = \(\{/);
  assert.match(source, /aria-haspopup="listbox"/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /<ChevronDown/);
  assert.match(source, /<Check className="h-4 w-4 shrink-0" \/>/);
  assert.match(source, /dropdownKey: 'expenseType'/);
  assert.match(source, /dropdownKey: 'staffMember'/);
  assert.match(source, /dropdownKey: 'paymentType'/);
  assert.doesNotMatch(source, /<select/);
  assert.doesNotMatch(source, /<option/);
  assert.doesNotMatch(source, /variant="error">\{formatCurrency\(totalExpenses\)\}/);
  assert.doesNotMatch(source, /variant="warning">\{formatCurrency\(totalStaffPayments\)\}/);
});

test('ExpenseModal pins the record actions in sticky bars so they stay visible at small viewport heights', () => {
  // At 1282x802 the form was taller than the modal and the save button sat below
  // the fold. Both the expense and staff-payment actions now live in a sticky bar.
  const stickyBars = source.match(
    /sticky bottom-0 z-10 -mx-5 -mb-5 mt-\d+ flex flex-wrap items-center gap-3 rounded-b-\[28px\] border-t border-neutral-700\/60 bg-neutral-950\/90 px-5 py-4 backdrop-blur-xl/g,
  );
  assert.ok(
    stickyBars && stickyBars.length === 2,
    'both the expense and staff-payment action rows should be sticky bottom bars',
  );
  // The long staff-payment helper paragraph now scrolls above the sticky bar.
  assert.match(
    source,
    /<p className="mt-6 text-sm text-slate-500 dark:text-slate-400">\s*\{t\(\s*'modals\.expense\.staffPaymentHelper'/,
    'the staff-payment helper text should sit above the sticky bar, not inside it',
  );
});

test('ExpenseModal validation hint matches the save button enabled state', () => {
  // The hint used to render unconditionally, so it claimed a justification was
  // required even when the button was enabled. It is now derived and conditional.
  assert.match(source, /const canSubmitExpense = canRecord && expenseAmountValue > 0 && hasExpenseDescription;/);
  assert.match(
    source,
    /const expenseValidationHint = !canRecord\s*\?\s*''[\s\S]*invalidAmount[\s\S]*justificationRequired[\s\S]*:\s*'';/,
    'the hint should explain the missing field and be empty once the form is valid',
  );
  assert.match(source, /disabled=\{!canSubmitExpense\}/);
  assert.match(
    source,
    /\{expenseValidationHint && \(\s*<p className="text-sm text-slate-500 dark:text-slate-400">\s*\{expenseValidationHint\}/,
    'the hint paragraph should only render when there is an actual blocking reason',
  );
  // Guard against regressing to the always-on "required" message.
  assert.doesNotMatch(
    source,
    /<p className="text-sm text-slate-500 dark:text-slate-400">\s*\{t\('modals\.expense\.justificationRequired'/,
    'the justification message must not render unconditionally next to an enabled button',
  );
});

test('ExpenseModal expense fields bind to independent draft keys', () => {
  // Amount, justification (reason) and receipt/reference must each keep their own value.
  assert.match(
    source,
    /value=\{expenseDraft\.amount\}\s*onChange=\{\(event\) => setExpenseDraft\(\(current\) => \(\{ \.\.\.current, amount: formatMoneyInputWithCents\(event\.target\.value\) \}\)\)\}/,
  );
  assert.match(
    source,
    /value=\{expenseDraft\.description\}\s*onChange=\{\(event\) => setExpenseDraft\(\(current\) => \(\{ \.\.\.current, description: event\.target\.value \}\)\)\}/,
  );
  assert.match(
    source,
    /\{canUseExpenseReceiptReference && \(\s*<div className="mt-4">[\s\S]*value=\{expenseDraft\.receiptNumber\}\s*onChange=\{\(event\) => setExpenseDraft\(\(current\) => \(\{ \.\.\.current, receiptNumber: event\.target\.value \}\)\)\}/,
    'the receipt/reference draft field should only render for fiscal-reporting orgs',
  );
});

test('ExpenseModal normalizes bridge expense rows before rendering them', () => {
  assert.match(source, /function normalizeShiftExpenseRow\(value: unknown\): ShiftExpense \| null/);
  assert.match(source, /row\.receipt_number \?\? row\.receiptNumber/);
  assert.match(source, /row\.expense_type \?\? row\.expenseType/);
  assert.match(source, /row\.created_at \?\? row\.createdAt/);
  assert.match(source, /setExpenses\(normalizeShiftExpenses\(loadedExpenses\)\)/);
});

test('ExpenseModal gates expense receipt references behind fiscal reporting entitlement', () => {
  assert.match(source, /import \{ loadFiscalOrderReportingEntitlement \} from '\.\.\/\.\.\/utils\/fiscal-integration-entitlement';/);
  assert.match(source, /const \[canUseExpenseReceiptReference, setCanUseExpenseReceiptReference\] = useState\(false\);/);
  assert.match(source, /loadFiscalOrderReportingEntitlement\(\)\.catch\(\(\) => false\)/);
  assert.match(
    source,
    /receiptNumber: canUseExpenseReceiptReference\s*\?\s*expenseDraft\.receiptNumber\.trim\(\) \|\| undefined\s*:\s*undefined/,
    'normal orgs must not send receipt/reference values with expenses',
  );
  assert.match(source, /function formatExpenseReference\(value: string \| null \| undefined\): string/);
  assert.match(
    source,
    /subtitle: \[\s*getExpenseTypeLabel\(t, expense\.expense_type\),\s*canUseExpenseReceiptReference \? formatExpenseReference\(expense\.receipt_number\) : '',\s*\]\.filter\(Boolean\)\.join\(' \| '\)/,
    'activity expense subtitle should only include saved receipt/reference values for fiscal-reporting orgs',
  );
  assert.match(
    source,
    /const metadata = \[\s*getExpenseTypeLabel\(t, expense\.expense_type\),\s*canUseExpenseReceiptReference \? formatExpenseReference\(expense\.receipt_number\) : '',\s*formatOptionalActivityDateTime\(expense\.created_at\),\s*\]\.filter\(Boolean\);/,
    'recent expense metadata should only include saved receipt/reference values for fiscal-reporting orgs',
  );
});

// --- Staff payment: role label localization (defect 2) --------------------

test('recent staff payment card localizes the role label and never renders the raw role slug', () => {
  // The role meta must go through the shared role-label helper (common.roleNames.*),
  // not render payment.role_type ("cashier") verbatim into Greek UI.
  assert.match(source, /import \{ translateRoleName \} from '\.\.\/\.\.\/utils\/role-labels';/);
  assert.match(source, /\{payment\.role_type && <><span>•<\/span><span>\{translateRoleName\(t, payment\.role_type\)\}<\/span><\/>\}/);
  // The pre-fix raw render of the slug must be gone.
  assert.doesNotMatch(source, /<span>\{payment\.role_type\}<\/span>/);
});

test('translateRoleName maps the "cashier" slug to a Greek label, not the raw English slug', () => {
  const elT = makeLocaleT('el');
  const enT = makeLocaleT('en');
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');

  const elLabel = translateRoleName(elT, 'cashier');
  assert.equal(elLabel, loadLocale('el').common.roleNames.cashier);
  assert.notEqual(elLabel, 'cashier', 'Greek UI must not show the raw "cashier" slug');
  assert.match(elLabel, GREEK_LETTER, `el cashier role label should be Greek: "${elLabel}"`);
  assert.equal(translateRoleName(enT, 'cashier'), loadLocale('en').common.roleNames.cashier);
});

// --- Staff payment: edit-amount update wiring (defect 1 regression lock) ---

test('staff payment edit routes through updateStaffPayment with the edited amount', () => {
  // The save button drives handleRecordStaffPayment; when editing, it must call the
  // dedicated update bridge with the parsed amount (not record a new payment).
  assert.match(source, /onClick=\{\(\) => \{ void handleRecordStaffPayment\(\); \}\}/);
  assert.match(source, /const amount = parseMoneyInputValue\(paymentDraft\.amount\);/);
  assert.match(
    source,
    /const result = editingPaymentId\s*\?\s*await bridge\.shifts\.updateStaffPayment\(\{[\s\S]*?paymentId: editingPaymentId,[\s\S]*?amount,[\s\S]*?\}\)/,
    'editing must call updateStaffPayment carrying the edited amount',
  );
});

test('successful staff payment save resets the form and reloads drawer activity', () => {
  // After a successful save the edit draft must clear and the totals/recent/activity
  // must be reloaded so the new amount is reflected (the live "stays 0,02" symptom).
  assert.match(source, /resetPaymentForm\(\);\s*await loadShiftActivity\(cashierShift\);/);
  // Totals are summed from the reloaded staffPayments array, so a persisted amount
  // change is always reflected in the displayed total.
  assert.match(
    source,
    /const totalStaffPayments = useMemo\(\s*\(\) =>\s*staffPayments\.reduce\(\(sum, payment\) => sum \+ Number\(payment\.amount \|\| 0\), 0\)/,
  );
});

test('ExpenseModal localizes recent staff payment role labels through the shared helper', () => {
  assert.match(
    source,
    /import \{ translateRoleName \} from '\.\.\/\.\.\/utils\/role-labels';/,
    'the helper must be imported before rendering translated role labels',
  );
  assert.match(
    source,
    /\{payment\.role_type && <><span>•<\/span><span>\{translateRoleName\(t, payment\.role_type\)\}<\/span><\/>\}/,
    'recent staff payments should not render raw role slugs like cashier',
  );
});

// --- Staff payment selector/dropdown role label localization --------------

test('staff payment selector localizes the option role label via the shared helper', () => {
  // The dropdown option must route the role through translateRoleName so Greek UI
  // shows "Sofia Keller - Ταμίας", not the English "Cashier" display string. The
  // slug drives the common.roleNames.* lookup; the display name is the readable
  // fallback for custom/data roles.
  assert.match(
    source,
    /label: `\$\{option\.name\} - \$\{translateRoleName\(t, option\.roleSlug \|\| option\.role, option\.role\)\}`/,
  );
  // The pre-fix raw role render in the option label is gone.
  assert.doesNotMatch(source, /label: `\$\{option\.name\} - \$\{option\.role\}`/);
  // The option carries a localizable slug alongside the readable display role.
  assert.match(source, /interface StaffOption \{[\s\S]*?roleSlug\?: string;[\s\S]*?\}/);
  assert.match(source, /roleSlug:\s*\n?\s*primaryRole\?\.name \|\|/);
});

test('staff role labels localize known slugs and preserve custom display names', () => {
  const elT = makeLocaleT('el');
  // Known role: the slug resolves to the localized Greek common.roleNames label.
  assert.equal(translateRoleName(elT, 'cashier', 'Cashier'), loadLocale('el').common.roleNames.cashier);
  assert.notEqual(translateRoleName(elT, 'cashier', 'Cashier'), 'Cashier');
  // Custom/data role: no localized key exists, so the readable display name is kept
  // verbatim (acronyms/casing preserved) rather than humanized away.
  assert.equal(translateRoleName(elT, 'vip_host', 'VIP Host'), 'VIP Host');
});
