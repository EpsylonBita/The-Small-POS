import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Round 177 (touch-first, live QA): the top-right Expenses quick action in RefactoredMainLayout
// showed a native Greek tooltip (expense.buttonLabel) on hover and used hover-only effects. On a
// touchscreen POS it must expose its name via aria-label with no native `title=` and no hover
// utilities, while keeping its green glow, position, onClick -> ExpenseModal, and active press.
//
// This lives in its own file (not custom-titlebar-ui.test.ts) so the Expenses guard has clean,
// isolated verification independent of that file's pre-existing CustomTitleBar failures.

const mainLayoutPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'RefactoredMainLayout.tsx',
);

// Founder 31/10: the Expenses button has a fixed place in the right utility rail (between health and
// theme) instead of floating top-right of the page; the main layout still owns the Expenses window.
function expensesButtonBlock(): string {
  const source = readFileSync(mainLayoutPath, 'utf8');
  const start = source.indexOf('{/* Expenses: its fixed place in the right utility rail');
  assert.notEqual(start, -1, 'the Expenses quick-action button block should exist');
  const end = source.indexOf('</UtilityRailExpensesSlot>', start);
  assert.notEqual(end, -1, 'the Expenses slot should close');
  return source.slice(start, end + '</UtilityRailExpensesSlot>'.length);
}

test('RefactoredMainLayout expenses quick-action button uses aria-label, no native title or hover', () => {
  const block = expensesButtonBlock();

  // Touch-first: accessible name via aria-label, no native title tooltip, no hover utilities.
  assert.match(block, /aria-label=\{t\('expense\.buttonLabel'\)\}/);
  assert.doesNotMatch(block, /\btitle=/);
  assert.doesNotMatch(block, /hover:/);
  assert.doesNotMatch(block, /dark:hover:/);
  assert.doesNotMatch(block, /group-hover:/);
});

test('RefactoredMainLayout expenses quick-action button preserves behavior and sits in the rail', () => {
  const block = expensesButtonBlock();

  // Opens the ExpenseModal with the active press; the rail's quiet icon ink like the navigation rail.
  assert.match(block, /<UtilityRailExpensesSlot>/);
  assert.match(block, /type="button"/);
  assert.match(block, /onClick=\{\(\) => setShowExpenses\(true\)\}/);
  assert.match(block, /h-12 w-12/);
  assert.match(block, /resolvedTheme === 'dark' \? 'text-zinc-400' : 'text-black'/);
  assert.doesNotMatch(block, /drop-shadow-\[/);
  assert.doesNotMatch(block, /fixed top-12 right-24/);
  assert.match(block, /active:scale-95/);
});

test('RefactoredMainLayout expenses quick-action stays visible in the POS shell', () => {
  const block = expensesButtonBlock();
  assert.match(block, /<button[\s\S]*aria-label=\{t\('expense\.buttonLabel'\)\}/);
  assert.doesNotMatch(block, /\{isShiftActive && \(/);
  // Founder 31/10: expenses on top, the heart in the middle, the theme below.
  const rail = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'UtilityRail.tsx'), 'utf8');
  const health = rail.indexOf('<SyncStatusIndicator layout="rail"');
  const slot = rail.indexOf('id={UTILITY_RAIL_EXPENSES_SLOT_ID}');
  const theme = rail.indexOf('data-utility-rail-theme');
  assert.ok(slot > 0 && slot < health && health < theme, 'expenses, then health, then theme');
});

// Founder 31/10 («να είναι τελείως διάφανη η συνέχεια και να αφήνει να διαπερνάει ο φωτισμός»): the
// main column used margins to make room for the two rails, so its clipping box (and ContentContainer's)
// stopped 80px from each window edge and cut the panel's glow in a strip beside each rail. The column
// spans the window; the rails' room is ContentContainer's side padding, so the glow passes behind them.
test('the main column reaches the window edges so the panel glow is not cut beside the rails', () => {
  const layout = readFileSync(mainLayoutPath, 'utf8');
  assert.match(layout, /<div className="flex-1 flex flex-col overflow-hidden min-h-0">\s*<ContentContainer/);
  assert.doesNotMatch(layout, /\b(?:ml|mr)-(?:16|20)\b|sm:(?:ml|mr)-20/);
  const container = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'ui', 'ContentContainer.tsx'),
    'utf8',
  );
  // Rail room (64 / 80px) + the old gutter (16 / 24 / 32 / 48px) on each side; the same top and bottom.
  assert.match(container, /className="flex-1 py-4 sm:py-6 md:py-8 lg:py-12 px-20 sm:px-26 md:px-28 lg:px-32 overflow-hidden relative"/);
});
