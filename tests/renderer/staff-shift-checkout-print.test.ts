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
const checkoutFooterActionsPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'StaffShiftCheckoutFooterActions.tsx',
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

test('StaffShiftModal separates cash handover from tip allocation in every checkout role', () => {
  const modal = source(staffShiftModalPath);
  const locales = ['en', 'el', 'de', 'fr', 'it'];
  const requiredKeys = [
    'cashToHandToCashier',
    'cashReturnHelper',
    'cashActuallyHandedOver',
    'tipsReceived',
    'tipsSeparateFromCashReturn',
    'tipAllocations',
    'tipOrder',
  ];

  assert.match(modal, /const renderTipsSummaryCard = \(\) =>/);
  assert.match(modal, /data-testid="staff-checkout-tips"/);
  assert.match(modal, /shiftSummary\?\.tipsReceived/);
  assert.match(modal, /shiftSummary\?\.tipAllocations/);
  assert.match(modal, /modals\.staffShift\.cashToHandToCashier/);
  assert.match(modal, /modals\.staffShift\.cashActuallyHandedOver/);

  for (const locale of locales) {
    const staffShift = JSON.parse(
      source(path.join(projectRoot, 'src', 'locales', `${locale}.json`)),
    ).modals.staffShift;
    for (const key of requiredKeys) {
      assert.equal(typeof staffShift[key], 'string', `${locale}.${key} must exist`);
      assert.notEqual(staffShift[key].trim(), '', `${locale}.${key} must not be empty`);
    }
  }
});

test('StaffShiftModal renders checkout add actions as yellow icon-only buttons', () => {
  const modal = source(staffShiftModalPath);

  // Yellow icon-only action button. Touch-first: no hover-era class on this touch POS.
  assert.match(
    modal,
    /const checkoutActionButtonClass = 'flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-yellow-400 text-black[^']*'/,
  );
  assert.doesNotMatch(
    modal,
    /checkoutActionButtonClass = '[^']*hover:bg-yellow-300/,
    'add-action button must not carry a hover-era class on this touch POS',
  );
  // Icon-only Plus buttons keep aria-label as their sole accessible name; the native title= tooltip is gone.
  assert.match(
    modal,
    /aria-label=\{t\('modals\.staffShift\.addExpense'\)\}[\s\S]*?<Plus className="h-6 w-6" strokeWidth=\{3\} \/>/,
  );
  assert.match(
    modal,
    /aria-label=\{t\('modals\.staffShift\.addPayment', 'Add Payment'\)\}[\s\S]*?<Plus className="h-6 w-6" strokeWidth=\{3\} \/>/,
  );
  assert.doesNotMatch(modal, /title=\{t\('modals\.staffShift\.addExpense'\)\}/);
  assert.doesNotMatch(modal, /title=\{t\('modals\.staffShift\.addPayment', 'Add Payment'\)\}/);
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

  assert.match(modal, /className="[^"]*bg-yellow-400[^"]*text-black/);
  assert.doesNotMatch(
    modal,
    /className="[^"]*bg-yellow-400[^"]*hover:bg-yellow-300/,
    'staff QR action must not carry a hover-era class on this touch POS',
  );
  assert.match(modal, /t\('modals\.staffShift\.resolveQr', 'Scan QR'\)/);
  assert.doesNotMatch(modal, /bg-cyan-600 px-5 py-3 text-sm font-bold text-white/);
});

test('StaffShiftModal keeps check-in user icons and PIN action surfaces unfilled', () => {
  const modal = source(staffShiftModalPath);
  const nonTransparentBackground = /(?:^|\s)(?:dark:)?(?:hover:)?bg-(?!transparent\b)/;
  const iconSurfaces = [...modal.matchAll(/iconSurface:\s*'([^']+)'/g)].map((match) => match[1]);
  const buttonSurfaces = [...modal.matchAll(/buttonSurface:\s*'([^']+)'/g)].map((match) => match[1]);

  // Non-cashier roles share FALLBACK_ROLE_PRESENTATION, so there are two distinct surface
  // literals (fallback + cashier). Both must stay unfilled (asserted in the loops below).
  assert.ok(iconSurfaces.length >= 2, 'expected an icon surface for the fallback + cashier presentations');
  assert.ok(buttonSurfaces.length >= 2, 'expected a button surface for the fallback + cashier presentations');

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
  // The selected-summary current-role row still exists (proving currentRoleLabel renders in the summary).
  // Round 313 follow-up compacted this row (mt-5 gap-4 -> mt-3 gap-3), so match it spacing-tolerantly.
  assert.match(
    modal,
    /<div className="mt-\d+ flex items-center gap-\d+">[\s\S]*?currentRoleLabel/,
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
    /className="[^"]*bg-yellow-400[^"]*text-black[^"]*sm:min-w-\[220px\]"/,
  );
  assert.doesNotMatch(
    modal,
    /className="[^"]*bg-yellow-400[^"]*hover:bg-yellow-300[^"]*sm:min-w-\[220px\]"/,
    'PIN continue action must not carry a hover-era class on this touch POS',
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
  const cashierFirstFallbacks = [
    'The first check-in for this business day must be a cashier.',
    'Start a cashier shift first. The other roles unlock after the cashier checks in.',
    'This staff member does not have a cashier role. Go back and choose a cashier first.',
    'Cashier must start the current business day before this role can check in.',
    'Locked until cashier starts',
  ];

  assert.match(
    modal,
    /cashierFirstGateActive && \([\s\S]*text-sm text-white[\s\S]*<AlertTriangle className="mt-0\.5 h-5 w-5 shrink-0 text-white" \/>[\s\S]*<p className="text-white">/,
  );
  for (const fallback of cashierFirstFallbacks) {
    assert.doesNotMatch(modal, new RegExp(fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(modal, /t\('modals\.staffShift\.cashierFirstCheckInRequired'\)/);
  assert.match(modal, /t\('modals\.staffShift\.cashierFirstCheckInHelper'\)/);
  assert.match(modal, /t\('modals\.staffShift\.cashierFirstCheckInBlocked'\)/);
  assert.match(modal, /t\('modals\.staffShift\.cashierFirstRoleLockedHelper'\)/);
  assert.match(modal, /t\('modals\.staffShift\.roleLockedUntilCashier'\)/);
  assert.doesNotMatch(modal, /text-amber-900[\s\S]*cashierFirstCheckInRequired/);
  assert.doesNotMatch(modal, /text-amber-800\/90[\s\S]*cashierFirstCheckInHelper/);
});

test('cashier-first role gate copy exists in every POS locale and Greek is not English fallback', () => {
  const keys = [
    'cashierFirstCheckInRequired',
    'cashierFirstCheckInHelper',
    'cashierFirstCheckInBlocked',
    'cashierFirstRoleLockedHelper',
    'roleLockedUntilCashier',
  ];
  const locales = ['en', 'el', 'de', 'fr', 'it'];
  const english = JSON.parse(source(path.join(projectRoot, 'src', 'locales', 'en.json'))).modals.staffShift;

  for (const locale of locales) {
    const staffShift = JSON.parse(source(path.join(projectRoot, 'src', 'locales', `${locale}.json`))).modals.staffShift;
    for (const key of keys) {
      assert.equal(typeof staffShift[key], 'string', `${locale}.${key} must be present`);
      assert.notEqual(staffShift[key].trim(), '', `${locale}.${key} must not be empty`);
      assert.doesNotMatch(staffShift[key], /\[NEEDS/i, `${locale}.${key} must not be placeholder copy`);
      if (locale !== 'en') {
        assert.notEqual(staffShift[key], english[key], `${locale}.${key} must not fall back to English`);
      }
    }
  }
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
    /className=\{`w-full rounded-\[24px\] border p-4 text-left[\s\S]*\$\{activePresentation\.accentBorder\} \$\{activePresentation\.accentSurface\}`\}/,
  );
  assert.match(
    modal,
    /className=\{`flex h-16 w-16 shrink-0 items-center justify-center rounded-\[20px\] border bg-black\/45 dark:bg-black\/45 \$\{activePresentation\.accentBorder\}`\}/,
  );
  assert.match(
    modal,
    /className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white\/20 bg-black\/45 px-3 py-1 text-xs font-semibold text-white/,
  );
  // The manage-shift affordance is a full-width rounded-xl control that uses the role
  // presentation's always-unfilled buttonSurface (guarded as transparent in the unfilled
  // surfaces test) -- no group/hover, no static fill.
  assert.match(
    modal,
    /className=\{`inline-flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-2\.5 text-sm font-semibold leading-tight \$\{activePresentation\.buttonSurface\}`\}/,
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
    /\$\{activePresentation\.badgeFilled\}/,
  );
  assert.doesNotMatch(
    modal,
    /border-emerald-200\/90 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700/,
  );
});

test('Greek staff-shift/staff-payment closeout copy uses Greek, not the English word "checkout"', () => {
  const el = JSON.parse(source(path.join(projectRoot, 'src', 'locales', 'el.json')));

  const offenders: string[] = [];
  const scan = (value: unknown, keyPath: string) => {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        scan(v, keyPath ? `${keyPath}.${k}` : k);
      }
    } else if (typeof value === 'string' && /checkout|check-out/i.test(value)) {
      offenders.push(`${keyPath} = ${JSON.stringify(value)}`);
    }
  };

  // All staff-shift closeout copy.
  scan((el.modals?.staffShift ?? {}) as Record<string, unknown>, 'modals.staffShift');

  // The staff-payment delete confirmation also lives under modals.expense.
  const staffPaymentDeleteMsg = el.modals?.expense?.deleteStaffPaymentConfirmMessage;
  if (typeof staffPaymentDeleteMsg === 'string' && /checkout|check-out/i.test(staffPaymentDeleteMsg)) {
    offenders.push(`modals.expense.deleteStaffPaymentConfirmMessage = ${JSON.stringify(staffPaymentDeleteMsg)}`);
  }

  assert.deepEqual(
    offenders,
    [],
    `Greek staff-shift/staff-payment copy must use Greek (e.g. "κλείσιμο ταμείου"), not English "checkout":\n${offenders.join('\n')}`,
  );
});

// Round 338 (live POS QA, 1280x800 Greek/dark): the cashier checkout opened with the expected-amount summary
// and the print + complete action rail below the fold, forcing a long scroll to reach the footer. The footer is
// now PINNED -- it lives OUTSIDE the scrollable reconciliation body so it stays visible while the cards scroll
// above it. This guards the layout (fill-the-modal shell + shrinkable scroll body + sibling footer) and proves
// the checkout logic / disabled conditions are untouched. Touch-first: no hover, no native title on the footer.
test('Round 338: the checkout action footer is pinned outside the scrollable reconciliation body', () => {
  const modal = source(staffShiftModalPath);

  // The checkout pane fills the modal content box so the body can scroll while the footer pins. Check-in keeps
  // its capped-height behaviour; the shells are distinguished by data-testid.
  assert.match(
    modal,
    /className=\{`flex \$\{effectiveMode === 'checkout' \? 'flex-1 min-h-0' : 'max-h-\[84vh\]'\} flex-col`\}/,
    'the checkout shell must fill the modal (flex-1 min-h-0) so its body scrolls and the footer pins',
  );
  assert.match(
    modal,
    /data-testid=\{effectiveMode === 'checkout' \? 'staff-checkout-shell' : 'staff-checkin-shell'\}/,
  );

  // The reconciliation body is the single scroller and is allowed to shrink (min-h-0) inside the flex shell.
  const scrollAnchor = 'data-testid="staff-shift-scroll-body"';
  const scrollIdx = modal.indexOf(scrollAnchor);
  assert.notEqual(scrollIdx, -1, 'the scrollable reconciliation body marker must exist');
  const scrollOpenTag = modal.slice(modal.lastIndexOf('<div', scrollIdx), modal.indexOf('>', scrollIdx) + 1);
  assert.match(scrollOpenTag, /flex-1/);
  assert.match(scrollOpenTag, /min-h-0/);
  assert.match(scrollOpenTag, /overflow-y-auto/);
  assert.match(scrollOpenTag, /scrollbar-hide/);

  // The footer must be a SIBLING outside the scroll body. Its marker exists and renders after the body...
  const footerIdx = modal.indexOf('data-testid="staff-checkout-footer"');
  assert.notEqual(footerIdx, -1, 'the pinned checkout footer marker must exist');
  assert.ok(footerIdx > scrollIdx, 'the footer must render after the scrollable body');

  // ...and the scroll body's closing </div> immediately precedes the footer conditional, proving the footer is
  // a sibling rendered AFTER (outside) the overflow-y-auto region rather than nested within it. If anyone ever
  // re-nests the footer inside the scroller this seam disappears and the guard fails.
  assert.match(
    modal,
    /<\/div>\s*\{effectiveMode === 'checkout' && checkoutFooterData && \(\s*<div\s+data-testid="staff-checkout-footer"/,
    'the checkout footer must be a sibling rendered immediately after the scroll body closes (outside the scroller)',
  );

  // The footer hosts the expected-amount summary + the print/complete action rail, and the checkout logic and
  // disabled conditions are preserved exactly (layout change only -- no calc/print/submit/data changes).
  assert.match(modal, /<StaffShiftCheckoutFooterActions/);
  assert.match(modal, /isCheckoutDisabled=\{loading \|\| isCheckoutAmountMissing\}/);
  assert.match(modal, /isPrintDisabled=\{loading \|\| isPrintCheckoutLoading \|\| !canPrintCheckoutSnapshot\}/);
  assert.match(modal, /isCheckoutLoading=\{loading\}/);
  assert.match(modal, /onCheckout=\{[\s\S]*?handleCheckOut\(\)/);
  assert.match(modal, /onPrint=\{[\s\S]*?handlePrintCheckout\(\)/);
});

test('Round 338: the checkout footer action rail stays touch-first (no hover, no native title)', () => {
  const footer = source(checkoutFooterActionsPath);

  assert.doesNotMatch(footer, /hover:/, 'the footer action rail must not use hover variants on this touch POS');
  assert.doesNotMatch(footer, /\btitle=/, 'the footer action rail must not use native title tooltips');
  // Tap feedback only (active:), rounded glass language, and the stable testids the live QA relies on.
  assert.match(footer, /active:/);
  assert.match(footer, /data-testid="staff-checkout-print-button"/);
  assert.match(footer, /data-testid="staff-checkout-confirm-button"/);
});
