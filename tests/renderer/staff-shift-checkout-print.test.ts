import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveCashierCheckoutExpenseTotal } from '../../src/renderer/utils/staffShiftCheckoutPrint';

const projectRoot = process.cwd();
const staffShiftModalPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'StaffShiftModal.tsx',
);
const progressStepperPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'ui',
  'ProgressStepper.tsx',
);

const source = (filePath: string) => readFileSync(filePath, 'utf8');

test('resolveCashierCheckoutExpenseTotal keeps checkout display aligned with persisted summary total', () => {
  const summary = { totalExpenses: 0 };
  const staleExpenses = [
    { shiftId: 'previous-shift', amount: 15 },
  ];

  assert.equal(
    resolveCashierCheckoutExpenseTotal(summary, staleExpenses, 'current-shift'),
    0,
  );
});

test('resolveCashierCheckoutExpenseTotal can fall back to current-shift expense rows when summary has no total', () => {
  const expenses = [
    { shiftId: 'current-shift', amount: 10 },
    { staff_shift_id: 'current-shift', amount: 5 },
    { shiftId: 'other-shift', amount: 99 },
  ];

  assert.equal(
    resolveCashierCheckoutExpenseTotal({}, expenses, 'current-shift'),
    15,
  );
});

test('StaffShiftModal shows raw close-shift IPC rejection messages to the operator', () => {
  const modal = source(staffShiftModalPath);

  assert.match(
    modal,
    /catch \(err\) \{[\s\S]*setError\(\s*extractErrorMessage\(\s*err,\s*t\('modals\.staffShift\.closeShiftFailed'\)\s*\)\s*\)/,
    'close-shift failures must preserve raw string IPC errors instead of falling back to the generic translation',
  );
});

test('StaffShiftModal renders checkout add actions as yellow icon-only buttons', () => {
  const modal = source(staffShiftModalPath);

  assert.match(
    modal,
    /const checkoutActionButtonClass = 'flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-yellow-400 text-black[\s\S]*hover:bg-yellow-300'/,
  );
  assert.match(
    modal,
    /aria-label=\{t\('modals\.staffShift\.addExpense'\)\}[\s\S]*title=\{t\('modals\.staffShift\.addExpense'\)\}[\s\S]*<Plus className="h-6 w-6" strokeWidth=\{3\} \/>/,
  );
  assert.match(
    modal,
    /aria-label=\{t\('modals\.staffShift\.addPayment', 'Add Payment'\)\}[\s\S]*title=\{t\('modals\.staffShift\.addPayment', 'Add Payment'\)\}[\s\S]*<Plus className="h-6 w-6" strokeWidth=\{3\} \/>/,
  );
  assert.doesNotMatch(
    modal,
    /bg-blue-600 hover:bg-blue-700 text-white[\s\S]*modals\.staffShift\.addExpense/,
  );
  assert.doesNotMatch(
    modal,
    /text-blue-500 hover:text-blue-400[\s\S]*modals\.staffShift\.addPayment/,
  );
  assert.doesNotMatch(
    modal,
    /<span className="min-w-0 text-center leading-tight whitespace-normal">[\s\S]*modals\.staffShift\.(addExpense|addPayment)/,
  );
});

test('StaffShiftModal gates staff QR check-in behind an acquired and active ERGANI plugin', () => {
  const modal = source(staffShiftModalPath);

  assert.match(modal, /const ERGANI_PLUGIN_ID = 'ergani_digital_schedule'/);
  assert.match(modal, /posApiGet<\{ integrations\?: PosIntegrationPayload\[\] \}>\(\s*`\/pos\/integrations\?provider=\$\{ERGANI_PLUGIN_ID\}`/);
  assert.match(modal, /integration\.is_purchased === true &&\s*integration\.is_enabled === true &&\s*integration\.is_active === true/);
  assert.match(modal, /\{hasActiveErganiPlugin && \(\s*<div className="rounded-\[24px\][\s\S]*staffQrBadge/);
  assert.match(modal, /if \(!hasActiveErganiPlugin\) \{[\s\S]*qrRequiresErgani/);
});

test('StaffShiftModal renders staff QR action in yellow with black text', () => {
  const modal = source(staffShiftModalPath);

  assert.match(modal, /className="[^"]*bg-yellow-400[^"]*text-black[^"]*hover:bg-yellow-300/);
  assert.match(modal, /t\('modals\.staffShift\.resolveQr', 'Scan QR'\)/);
  assert.doesNotMatch(modal, /bg-cyan-600 px-5 py-3 text-sm font-bold text-white/);
});

test('StaffShiftModal keeps check-in user icons and PIN action surfaces unfilled', () => {
  const modal = source(staffShiftModalPath);
  const nonTransparentBackground = /(?:^|\s)(?:dark:)?(?:hover:)?bg-(?!transparent\b)/;
  const iconSurfaces = [...modal.matchAll(/iconSurface:\s*'([^']+)'/g)].map((match) => match[1]);
  const buttonSurfaces = [...modal.matchAll(/buttonSurface:\s*'([^']+)'/g)].map((match) => match[1]);

  assert.ok(iconSurfaces.length >= 6, 'expected one icon surface per role presentation');
  assert.ok(buttonSurfaces.length >= 6, 'expected one button surface per role presentation');

  for (const value of iconSurfaces) {
    assert.doesNotMatch(value, nonTransparentBackground);
  }

  for (const value of buttonSurfaces) {
    assert.doesNotMatch(value, nonTransparentBackground);
  }

  assert.match(
    modal,
    /border-slate-200\/70 bg-transparent dark:border-white\/10 dark:bg-transparent/,
  );
});

test('StaffShiftModal renders PIN step without the current-role wrapper or ready chip', () => {
  const modal = source(staffShiftModalPath);

  assert.doesNotMatch(
    modal,
    /rounded-\[24px\] border p-4 \$\{summaryPresentation\.accentBorder\} \$\{summaryPresentation\.accentSurface\}/,
  );
  assert.match(
    modal,
    /<div className="mt-5 flex items-center gap-4">[\s\S]*currentRoleLabel/,
  );
  assert.match(
    modal,
    /renderSelectedStaffSummary\(\{\s*helper: t\('modals\.staffShift\.enterPinHelper'\),\s*\}\)/,
  );
});

test('StaffShiftModal renders PIN continue action in yellow with black text', () => {
  const modal = source(staffShiftModalPath);

  assert.match(
    modal,
    /className="[^"]*bg-yellow-400[^"]*text-black[^"]*hover:bg-yellow-300[^"]*sm:min-w-\[220px\]"/,
  );
  assert.doesNotMatch(
    modal,
    /bg-blue-600 px-6 py-3\.5 text-base font-bold text-white/,
  );
});

test('ProgressStepper renders check-in step dots without filled shells', () => {
  const stepper = source(progressStepperPath);

  assert.match(stepper, /active:\s*\{[\s\S]*shell: 'bg-transparent dark:bg-transparent'/);
  assert.match(stepper, /complete:\s*\{[\s\S]*shell: 'bg-transparent dark:bg-transparent'/);
  assert.match(stepper, /error:\s*\{[\s\S]*shell: 'bg-transparent dark:bg-transparent'/);
  assert.match(stepper, /case 'active':\s*return <Circle className="h-4 w-4" strokeWidth=\{2\.1\} \/>/);
  assert.doesNotMatch(stepper, /bg-cyan-500\/\[0\.08\]|dark:bg-cyan-500\/10|bg-emerald-500\/\[0\.08\]|dark:bg-emerald-500\/10/);
  assert.doesNotMatch(stepper, /rounded-full bg-current shadow-\[0_0_18px_currentColor\]/);
});

test('StaffShiftModal renders cashier-first role gate warning text in white', () => {
  const modal = source(staffShiftModalPath);

  assert.match(
    modal,
    /cashierFirstGateActive && \([\s\S]*text-sm text-white[\s\S]*<AlertTriangle className="mt-0\.5 h-5 w-5 shrink-0 text-white" \/>[\s\S]*<p className="text-white">/,
  );
  assert.doesNotMatch(modal, /text-amber-900[\s\S]*cashierFirstCheckInRequired/);
  assert.doesNotMatch(modal, /text-amber-800\/90[\s\S]*cashierFirstCheckInHelper/);
});

test('StaffShiftModal renders role-selection chips as wrapperless text labels', () => {
  const modal = source(staffShiftModalPath);

  assert.match(
    modal,
    /className=\{`text-xs font-semibold \$\{/,
  );
  assert.match(
    modal,
    /role\.is_primary \? rolePresentation\.accentText : rolePresentation\.iconColor/,
  );
  assert.match(
    modal,
    /<span className="text-xs font-semibold text-amber-600 dark:text-amber-200">[\s\S]*roleLockedUntilCashier/,
  );
  assert.doesNotMatch(
    modal,
    /inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold \$\{[\s\S]*role\.is_primary[\s\S]*rolePresentation\.badgeFilled/,
  );
  assert.doesNotMatch(
    modal,
    /inline-flex items-center rounded-full border border-amber-300\/80 bg-amber-50 px-3 py-1 text-xs font-semibold/,
  );
});

test('StaffShiftModal renders cash-entry euro icon without a wrapper', () => {
  const modal = source(staffShiftModalPath);

  assert.match(
    modal,
    /<Euro\s+className=\{`h-14 w-14 shrink-0 \$\{selectedRolePresentation\.iconColor\}`\}\s+strokeWidth=\{3\}\s+\/>/,
  );
  assert.doesNotMatch(
    modal,
    /className=\{`flex h-16 w-16 shrink-0 items-center justify-center rounded-\[20px\] border \$\{selectedRolePresentation\.iconSurface\}`\}[\s\S]*<Euro className=\{`h-8 w-8 \$\{selectedRolePresentation\.iconColor\}`\} \/>/,
  );
});

test('StaffShiftModal renders active shift cards with yellow card fill and neutral inner controls', () => {
  const modal = source(staffShiftModalPath);

  assert.match(
    modal,
    /border border-emerald-400\/45 bg-transparent px-3 py-1 text-xs font-semibold text-emerald-600 dark:border-emerald-400\/30 dark:bg-transparent/,
  );
  assert.match(
    modal,
    /className=\{`group w-full rounded-\[24px\] border p-4 text-left[\s\S]*\$\{activePresentation\.accentBorder\} \$\{activePresentation\.accentSurface\}`\}/,
  );
  assert.match(
    modal,
    /className=\{`flex h-16 w-16 shrink-0 items-center justify-center rounded-\[20px\] border bg-black\/45 dark:bg-black\/45 \$\{activePresentation\.accentBorder\}`\}/,
  );
  assert.match(
    modal,
    /className="inline-flex items-center gap-1 rounded-full border border-white\/20 bg-black\/45 px-3 py-1 text-xs font-semibold text-white/,
  );
  assert.match(
    modal,
    /className="inline-flex items-center justify-center gap-2 rounded-xl border border-white\/20 bg-black\/45 px-4 py-2 text-sm font-semibold text-white/,
  );
  assert.doesNotMatch(
    modal,
    /activePresentation\.iconSurface[\s\S]*<User className=\{`h-8 w-8 \$\{activePresentation\.iconColor\}`\}/,
  );
  assert.doesNotMatch(
    modal,
    /inline-flex items-center gap-1\.5 text-emerald-600 dark:text-emerald-300[\s\S]*shift\.labels\.active/,
  );
  assert.doesNotMatch(
    modal,
    /\$\{activePresentation\.buttonSurface\}/,
  );
  assert.doesNotMatch(
    modal,
    /\$\{activePresentation\.badgeFilled\}/,
  );
  assert.doesNotMatch(
    modal,
    /border-emerald-200\/90 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700/,
  );
});
