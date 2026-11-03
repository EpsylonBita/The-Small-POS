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

// Founder 01/11 (screenshot of «Drawer Outflows»): the window in the kit style of the shift check-out
// forms — kit cards on the solid shell, sentence-case labels, each heading once, kit fields, one yellow
// primary per form — while every amount keeps the colour that gives it meaning.
test('ExpenseModal tabs are kit options: the open tab in the kit selection yellow', () => {
  assert.match(source, /aria-pressed=\{active\}\s*className=\{`pos-choice\$\{active \? ' is-selected' : ''\}`\}/);
  assert.doesNotMatch(source, /border-blue-500\/60 bg-blue-600 text-white/);
  assert.doesNotMatch(source, /hover:/);
});

test('ExpenseModal sits on the shared glass shell with kit cards, labels and fields', () => {
  // Founder 01/11: «το modal των εξόδων δεν το έκανες γυαλί όπως τα υπόλοιπα» — the shared glass shell, its kit
  // cards frost inside it.
  assert.doesNotMatch(source, /blur=\{false\}/);
  assert.match(source, /const drawerListItemClass = 'pos-frost /);
  assert.match(source, /const drawerPanelClass = 'pos-card flex flex-col p-5';/);
  assert.match(source, /const drawerSidePanelClass = 'pos-card p-4';/);
  assert.match(source, /const drawerSummaryCardClass = 'pos-card p-4';/);
  assert.match(source, /const drawerLabelClass = 'mb-1 block text-sm font-semibold text-\(--pos-s-fg\)';/);
  assert.match(source, /const drawerInputClass = 'min-h-\[48px\] w-full rounded-xl border border-\(--pos-s-control\) bg-\(--pos-s-surface\)[^']*focus:border-\(--pos-s-yellow\)/);
  assert.match(source, /className=\{`\$\{drawerInputClass\} flex items-center justify-between gap-3 text-left/);
  assert.match(source, /className=\{`\$\{drawerInputClass\} pl-10! text-lg font-bold`\}/);
  assert.match(source, /className=\{`\$\{drawerInputClass\} min-h-\[92px\] resize-none`\}/);
  assert.doesNotMatch(source, /liquid-glass-modal-input/);
  // No small-capitals eyebrows; no translucent glass surfaces.
  assert.doesNotMatch(source, /\buppercase\b/);
  assert.doesNotMatch(source, /backdrop-blur|bg-white\/\d|bg-black\/\d|bg-neutral-950\/\d/);
  // The form headings are said once (the eyebrow repeated the button's words).
  assert.doesNotMatch(source, /modals\.expense\.expenseFormTitle/);
  assert.doesNotMatch(source, /modals\.expense\.staffPaymentFormTitle/);
  assert.doesNotMatch(source, /modals\.expense\.latestEntries/);
});

test('ExpenseModal record actions are the kit yellow primary, row actions kit buttons', () => {
  assert.match(source, /const drawerSubmitClass = 'pos-solid-btn pos-solid-btn--md pos-solid-btn--primary';/);
  assert.equal((source.match(/className=\{drawerSubmitClass\}/g) ?? []).length, 2);
  assert.match(source, /\{submittingExpense \? drawerSpinner : <Receipt className="h-4 w-4" \/>\}/);
  assert.match(source, /\{submittingPayment \? drawerSpinner : <BadgeDollarSign className="h-4 w-4" \/>\}/);
  assert.equal((source.match(/className=\{`\$\{drawerRowActionClass\} pos-solid-btn--danger`\}/g) ?? []).length, 4);
  assert.doesNotMatch(source, /POSGlassButton|POSGlassBadge/);
  assert.doesNotMatch(source, /text-emerald-700!|text-amber-700!/);
});

test('ExpenseModal keeps every amount colour (founder 01/11)', () => {
  assert.match(source, /'text-rose-500 dark:text-rose-300',\s*\)\}/);
  assert.match(source, /'text-amber-500 dark:text-amber-300',\s*\)\}/);
  assert.match(source, /'text-emerald-500 dark:text-emerald-300',\s*\)\}/);
  assert.match(source, /<div className="text-base font-black text-rose-500 dark:text-rose-300">\s*-\{formatCurrency\(expense\.amount\)\}/);
  assert.match(source, /<div className="text-base font-black text-amber-500 dark:text-amber-300">\s*-\{formatCurrency\(payment\.amount\)\}/);
  // Activity labels are coloured words, never pills.
  assert.match(source, /isExpense \? 'text-rose-600 dark:text-rose-300' : 'text-amber-600 dark:text-amber-300'/);
});

test('ExpenseModal renders recent expenses empty state with the founder cash glyph, unwrapped', () => {
  // Founder 01/11 («αντικατέστησε και εδώ το εικονίδιο των μετρητών»): the payment window's cash glyph.
  assert.match(source, /import \{ CashHandIcon \} from '\.\.\/icons\/PaymentMethodIcons';/);
  assert.match(
    source,
    /renderEmptyState\([\s\S]{0,400}<CashHandIcon className="h-11 w-11 payment-option-cash-icon" \/>[\s\S]*\{ wrapIcon: false \},/,
  );
  assert.match(source, /options\?: \{ wrapIcon\?: boolean \}/);
  assert.match(source, /options\?\.wrapIcon === false \? icon : \(/);
  assert.doesNotMatch(source, /renderEmptyState\(\s*<Receipt className="h-6 w-6" \/>[\s\S]*noExpenses/);
});

test('ExpenseModal dropdowns open the kit list and the form has no total chips', () => {
  assert.match(source, /type DrawerDropdownKey = 'expenseType' \| 'staffMember' \| 'paymentType'/);
  assert.match(
    source,
    /const drawerDropdownMenuClass = 'absolute left-0 right-0 top-full z-50 [^']*rounded-\[14px\] border border-\(--pos-s-border\) bg-\(--pos-s-surface\)/,
  );
  assert.match(source, /const drawerDropdownOptionClass = 'flex min-h-11 w-full/);
  assert.match(source, /selected \? 'bg-\(--pos-s-sel-bg\)! font-semibold text-\(--pos-s-sel-fg\)!' : ''/);
  assert.match(source, /const renderDrawerDropdown = \(\{/);
  assert.match(source, /aria-haspopup="listbox"/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /<ChevronDown/);
  assert.match(source, /dropdownKey: 'expenseType'/);
  assert.match(source, /dropdownKey: 'staffMember'/);
  assert.match(source, /dropdownKey: 'paymentType'/);
  assert.doesNotMatch(source, /<select/);
  assert.doesNotMatch(source, /<option/);
  assert.doesNotMatch(source, /variant="error">\{formatCurrency\(totalExpenses\)\}/);
  assert.doesNotMatch(source, /variant="warning">\{formatCurrency\(totalStaffPayments\)\}/);
});

test('ExpenseModal puts the record actions at the foot of each form card, without a band of their own', () => {
  // Founder 01/11 («βλέπεις τα λάθη;»): on the glass shell a sticky bar with its own glass fill or blur drew a
  // lighter band and left empty card below it. The bar now sits at the card's foot (a spacer fills the stretched
  // card) with only a hairline above it.
  assert.match(
    source,
    /const drawerFooterClass = '-mx-5 -mb-5 flex flex-wrap items-center gap-3 border-t border-\(--modal-glass-line\) px-5 py-4';/,
  );
  assert.equal(
    (source.match(/<div aria-hidden="true" className="min-h-4 flex-1" \/>\s*<div className=\{drawerFooterClass\}>/g) ?? []).length,
    2,
    'both the expense and staff-payment action rows sit at the foot of their card',
  );
  // The long staff-payment helper paragraph stays above the action row.
  assert.match(
    source,
    /<p className="mt-4 text-sm text-\(--pos-s-muted\)">\s*\{t\(\s*'modals\.expense\.staffPaymentHelper'/,
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
  assert.match(source, /disabled=\{!canSubmitExpense \|\| submittingExpense\}/);
  assert.match(
    source,
    /\{expenseValidationHint && \(\s*<p className="text-sm text-\(--pos-s-muted\)">\s*\{expenseValidationHint\}/,
    'the hint paragraph should only render when there is an actual blocking reason',
  );
  assert.doesNotMatch(
    source,
    /<p className="[^"]*">\s*\{t\('modals\.expense\.justificationRequired'/,
    'the justification message must not render unconditionally next to an enabled button',
  );
});

test('ExpenseModal expense fields bind to independent draft keys', () => {
  // Amount, justification (reason) and receipt/reference must each keep their own value.
  assert.match(
    source,
    /<CentsMoneyInput[^>]*?value=\{expenseDraft\.amount\}\s*onValueChange=\{\(amount\) => setExpenseDraft\(\(current\) => \(\{ \.\.\.current, amount \}\)\)\}/,
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
