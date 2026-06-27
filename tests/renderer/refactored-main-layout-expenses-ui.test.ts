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

// Scope assertions to the top-right Expenses quick-action button block only.
function expensesButtonBlock(): string {
  const source = readFileSync(mainLayoutPath, 'utf8');
  const start = source.indexOf('{/* Top-right Expenses Button */}');
  assert.notEqual(start, -1, 'the Expenses quick-action button block should exist');
  const end = source.indexOf('</button>', start);
  assert.notEqual(end, -1, 'the Expenses button should close');
  return source.slice(start, end + '</button>'.length);
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

test('RefactoredMainLayout expenses quick-action button preserves behavior and visuals', () => {
  const block = expensesButtonBlock();

  // Opens the ExpenseModal, keeps the green icon color + glow, and the active press feedback.
  assert.match(block, /type="button"/);
  assert.match(block, /onClick=\{\(\) => setShowExpenses\(true\)\}/);
  assert.match(block, /right-24 sm:right-28/);
  assert.match(block, /text-green-400/);
  assert.match(block, /drop-shadow-\[0_0_8px_rgba\(34,197,94,0\.6\)\]/);
  assert.match(block, /active:scale-95/);
});

test('RefactoredMainLayout expenses quick-action stays visible in the POS shell', () => {
  const source = readFileSync(mainLayoutPath, 'utf8');
  const start = source.indexOf('{/* Top-right Expenses Button */}');
  const end = source.indexOf('{/* Expenses Modal */}', start);
  const block = source.slice(start, end);

  assert.match(block, /<button[\s\S]*aria-label=\{t\('expense\.buttonLabel'\)\}/);
  assert.doesNotMatch(block, /\{isShiftActive && \(/);
});
