import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
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
    /:\s*'border-neutral-700\/60 bg-neutral-950\/55 text-neutral-200 hover:border-neutral-500 hover:bg-neutral-900 dark:border-neutral-700\/60 dark:bg-neutral-950\/55 dark:text-neutral-200 dark:hover:border-neutral-500 dark:hover:bg-neutral-900'/,
  );
  assert.doesNotMatch(
    source,
    /border-blue-500\/60 bg-blue-600 text-white/,
  );
  assert.doesNotMatch(
    source,
    /hover:border-blue-300|hover:text-blue-700|dark:hover:border-blue-500\/30|dark:hover:text-blue-300/,
  );
});

test('ExpenseModal uses neutral cards and black drawer input fields', () => {
  assert.match(
    source,
    /const drawerPanelClass = 'rounded-\[28px\] border border-neutral-700\/70 bg-neutral-950\/80 p-6[\s\S]*dark:bg-neutral-950\/80'/,
  );
  assert.match(
    source,
    /const drawerSidePanelClass = 'rounded-\[28px\] border border-neutral-700\/70 bg-neutral-950\/80 p-5[\s\S]*dark:bg-neutral-950\/80'/,
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
  assert.match(source, /className=\{`\$\{drawerInputClass\} min-h-\[150px\] resize-none`\}/);
  assert.doesNotMatch(source, /liquid-glass-modal-input/);
  assert.doesNotMatch(source, /dark:bg-slate-(900|950)/);
  assert.doesNotMatch(source, /bg-neutral-50\/85|bg-neutral-100\/90|bg-white\/80/);
});

test('ExpenseModal keeps drawer submit button wrappers transparent with colored icon text', () => {
  assert.match(
    source,
    /const drawerExpenseSubmitClass = '!border-neutral-700\/60 !bg-transparent !font-bold !text-emerald-400 !shadow-none hover:!border-neutral-500 hover:!bg-transparent disabled:!text-emerald-400 disabled:!opacity-100'/,
  );
  assert.match(
    source,
    /const drawerStaffPaymentSubmitClass = '!border-neutral-700\/60 !bg-transparent !font-bold !text-yellow-400 !shadow-none hover:!border-neutral-500 hover:!bg-transparent disabled:!text-yellow-400 disabled:!opacity-100'/,
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
    /renderEmptyState\(\s*<Banknote className="mx-auto block h-10 w-10 text-emerald-400" strokeWidth=\{2\.2\} \/>[\s\S]*\{ wrapIcon: false \},/,
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
