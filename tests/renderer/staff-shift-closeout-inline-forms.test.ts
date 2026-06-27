import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Cashier closeout inline forms (StaffShiftModal): decimal-comma amount input,
// submit-disabled validation mirroring ExpenseModal, and opened forms scrolling
// into view above the sticky footer.
const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'StaffShiftModal.tsx'),
  'utf8',
);

test('closeout inline expense amount input accepts a decimal comma', () => {
  // The old filter stripped everything except digits and '.', turning "2,50" into "250".
  assert.doesNotMatch(
    source,
    /replace\(\/\[\^0-9\.\]\/g, ''\)/,
    'expense amount input must not strip the decimal comma',
  );
  // Both expense amount inputs route through the comma-aware money formatter.
  const formatterUsages = source.match(/setExpenseAmount\(formatMoneyInputWithCents\(e\.target\.value\)\)/g);
  assert.ok(
    formatterUsages && formatterUsages.length >= 2,
    'both expense amount inputs should use formatMoneyInputWithCents',
  );
});

test('closeout inline expense submit is disabled until amount > 0 and description present', () => {
  assert.match(
    source,
    /const canRecordInlineExpense =\s+!loading && parseMoneyInputValue\(expenseAmount\) > 0 && expenseDescription\.trim\(\)\.length > 0;/,
    'inline expense must require a positive amount and a description',
  );
  const gatedButtons = source.match(/disabled=\{!canRecordInlineExpense\}/g);
  assert.ok(
    gatedButtons && gatedButtons.length >= 2,
    'both Record-expense buttons should be gated by canRecordInlineExpense',
  );
  // Disabled affordance (cursor + opacity) for accessibility/visuals.
  assert.match(source, /disabled:cursor-not-allowed disabled:opacity-50/);
});

test('opened closeout inline forms scroll into view above the sticky footer', () => {
  assert.match(source, /const expenseFormRef = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(source, /const staffPaymentFormRef = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(
    source,
    /expenseFormRef\.current\?\.scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/,
  );
  assert.match(
    source,
    /staffPaymentFormRef\.current\?\.scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/,
  );
  // Refs are attached to the rendered form containers.
  assert.match(source, /ref=\{expenseFormRef\}/);
  assert.match(source, /ref=\{staffPaymentFormRef\}/);
});

test('closeout inline expense receipt field is fiscal-entitlement gated', () => {
  assert.match(source, /import \{ loadFiscalOrderReportingEntitlement \} from '\.\.\/\.\.\/utils\/fiscal-integration-entitlement';/);
  assert.match(source, /const \[canUseExpenseReceiptReference, setCanUseExpenseReceiptReference\] = useState\(false\);/);
  assert.match(source, /loadFiscalOrderReportingEntitlement\(\)\.catch\(\(\) => false\)/);
  assert.match(
    source,
    /receiptNumber: canUseExpenseReceiptReference \? expenseReceipt \|\| undefined : undefined/,
    'normal orgs must not send inline checkout receipt/reference values',
  );
  const gatedInputs = source.match(
    /\{canUseExpenseReceiptReference && \(\s*<input[\s\S]*?value=\{expenseReceipt\}[\s\S]*?placeholder=\{expenseReceiptPlaceholder\}/g,
  );
  assert.ok(
    gatedInputs && gatedInputs.length >= 2,
    'both inline checkout receipt/reference inputs should only render for fiscal-reporting orgs',
  );
});

// --- Audit order-history payment/status badge localization ----------------

test('audit order-history payment badge localizes the unpaid "pending" slug (no raw leak)', () => {
  // translateAuditPaymentMethod must explicitly handle the unpaid payment_method
  // slug ("pending"/"unpaid") so the closeout order-history badge beside the card
  // icon never renders the raw backend slug in staff-facing UI.
  assert.match(
    source,
    /case 'pending':\s*case 'unpaid':[\s\S]*?return t\('modals\.staffShift\.orderStatuses\.pending'\);/,
  );
  // The order-history card renders the payment label through that translator.
  assert.match(source, /<span>\{translateAuditPaymentMethod\(order\.payment_method\)\}<\/span>/);

  // 'pending' must be cased BEFORE the raw-returning default branch (the pre-fix
  // path that leaked the slug).
  const fnStart = source.indexOf('const translateAuditPaymentMethod =');
  assert.ok(fnStart > -1, 'translateAuditPaymentMethod not found');
  const fnSlice = source.slice(fnStart, source.indexOf('};', fnStart));
  assert.ok(
    fnSlice.indexOf("case 'pending':") > -1 &&
      fnSlice.indexOf("case 'pending':") < fnSlice.indexOf('default:'),
    "'pending' must be handled before the raw-returning default branch",
  );
});

test('closeout order-history pending payment label resolves to the Greek "Σε αναμονή"', () => {
  const loadLocale = (locale: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${locale}.json`), 'utf8'));
  const el = loadLocale('el').modals.staffShift.orderStatuses.pending;
  const en = loadLocale('en').modals.staffShift.orderStatuses.pending;
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');

  assert.equal(el, 'Σε αναμονή');
  assert.notEqual(el, 'pending'); // never the raw backend slug
  assert.notEqual(el, en); // genuinely translated, not an English echo
  assert.match(el, GREEK_LETTER, `el pending label should be Greek: "${el}"`);
});

// --- Touch-first checkout polish: native title tooltips, hidden scrollbars, semantic colors ---

test('checkout add-action buttons drop native title tooltips but keep aria-label (no duplicated description)', () => {
  // The add expense / add payment controls are icon-only Plus buttons, so aria-label is
  // their sole accessible name. A native title= duplicating that same string leaks a second
  // "Description" node into the accessibility tree on this touch POS (and tooltips never fire
  // without hover). The native titles are gone; the aria-labels remain.
  assert.doesNotMatch(source, /title=\{t\('modals\.staffShift\.addExpense'\)\}/);
  assert.doesNotMatch(source, /title=\{t\('modals\.staffShift\.addPayment'/);
  assert.match(source, /aria-label=\{t\('modals\.staffShift\.addExpense'\)\}/);
  assert.match(source, /aria-label=\{t\('modals\.staffShift\.addPayment'/);

  // The busy-elsewhere check-in card and the delivery-address cell no longer carry native
  // tooltips (their content is already visible in the card body / truncated cell).
  assert.doesNotMatch(source, /title=\{t\('modals\.staffShift\.busyElsewhere'/);
  assert.doesNotMatch(source, /title=\{delivery\.delivery_address\}/);

  // Legitimate COMPONENT-prop title=s are preserved (modal heading + alert + blocker-panel
  // heading). These are React props, not native DOM tooltips.
  assert.match(source, /<LiquidGlassModal[\s\S]*?title=\{effectiveMode === 'checkin'/);
  assert.match(source, /<ErrorAlert title=\{t\('modals\.error\.title'/);
  assert.match(source, /title=\{t\('modals\.staffShift\.paymentIntegrityTitle'/);
});

test('StaffShiftModal hides every scroll region (no custom-scrollbar, scrollbar-hide everywhere)', () => {
  // Touch POS scrollbar policy: the styled glass scrollbar (custom-scrollbar) is replaced by
  // the hidden-scrollbar utility used elsewhere in this modal, and no scroll region is left
  // with a bare native scrollbar.
  assert.doesNotMatch(source, /custom-scrollbar/, 'custom-scrollbar must be gone');

  const classAttrs = source.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? [];
  const scrollers = classAttrs.filter(
    (cls) => /\boverflow-y-auto\b/.test(cls) || /\boverflow-auto\b/.test(cls),
  );
  assert.ok(
    scrollers.length >= 6,
    `expected the modal's scroll regions to be guarded, found ${scrollers.length}`,
  );
  for (const cls of scrollers) {
    assert.match(cls, /\bscrollbar-hide\b/, `scroll region must hide its native scrollbar: ${cls}`);
  }
  // The main checkout content scroller specifically uses scrollbar-hide (was custom-scrollbar). Spacing
  // is matched tolerantly (Round 313 2nd follow-up tightened it space-y-6 -> space-y-4 to fit the PIN step);
  // the guard's intent is the bounded flex-1 scroll region with the hidden native scrollbar. Round 338 added
  // min-h-0 so this flex child actually shrinks and scrolls inside the shell (keeping the footer pinned).
  assert.match(source, /flex-1 min-h-0 space-y-\d+ overflow-y-auto pr-2 scrollbar-hide/);
});

test('StaffShiftModal keeps the touch palette: semantic add=yellow, no blue/hover-era classes', () => {
  // Add actions stay yellow (the semantic "add" color); save/record stay green and
  // destructive stay red elsewhere. No leftover blue palette and no hover-era Tailwind
  // classes from the old design -- this POS uses active:, not hover:.
  assert.match(source, /checkoutActionButtonClass = '[^']*\bbg-yellow-400\b[^']*\btext-black\b/);
  assert.doesNotMatch(source, /-blue-\d/, 'no blue palette classes');
  assert.doesNotMatch(
    source,
    /hover:(?:bg-|text-|border-|shadow|scale|opacity|ring)/,
    'no hover-era Tailwind classes (touch POS uses active:)',
  );
});
