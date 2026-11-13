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
  const locales = ['en', 'el', 'de', 'fr', 'it', 'sq'];
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
    // The kit yellow primary (yellow fill, dark words), icon only, 48 px (founder 01/11).
    /const checkoutActionButtonClass = 'pos-solid-btn pos-solid-btn--primary h-12 w-12 shrink-0 p-0'/,
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
  // founder 11/11/2026: keep the ERGANI gate; its panel now reveals as glass.
  assert.match(modal, /\{hasActiveErganiPlugin && \(\s*<motion\.div key="reveal-\d+" \{\.\.\.revealMotion\} className="pos-glass-form-card p-4!">[\s\S]*staffQrBadge/);
  assert.match(modal, /if \(!hasActiveErganiPlugin\) \{[\s\S]*qrRequiresErgani/);
});

// Founder 01/11 («δεν έχουμε διορθώσει αυτά τα modals»): the check-in steps moved to the kit. The intent of
// the older guards stays: one yellow primary with dark words, no hover-era classes, standalone neutral icons,
// a readable cashier-first warning, and no decorative fills.
test('StaffShiftModal renders the staff QR action as the kit yellow primary', () => {
  const modal = source(staffShiftModalPath);
  const css = source(path.join(projectRoot, 'src', 'renderer', 'styles', 'glassmorphism.css'));

  assert.match(
    modal,
    /disabled=\{resolvingStaffQr \|\| staffQrCode\.trim\(\)\.length === 0\}\s*className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary"/,
  );
  assert.match(css, /\.pos-solid-btn--primary \{ background: var\(--pos-s-yellow\); border-color: var\(--pos-s-yellow\); box-shadow: var\(--pos-s-depth-yellow\); color: var\(--pos-s-yellow-fg\); \}/);
  assert.doesNotMatch(modal, /className="[^"]*bg-yellow-400[^"]*hover:bg-yellow-300/, 'no hover-era class on this touch POS');
  assert.match(modal, /t\('modals\.staffShift\.resolveQr', 'Scan QR'\)/);
  assert.doesNotMatch(modal, /bg-cyan-600 px-5 py-3 text-sm font-bold text-white/);
});

test('StaffShiftModal keeps check-in person icons standalone and neutral', () => {
  const modal = source(staffShiftModalPath);
  const nonTransparentBackground = /(?:^|\s)(?:dark:)?(?:hover:)?bg-(?!transparent\b)/;
  const buttonSurfaces = [...modal.matchAll(/buttonSurface:\s*'([^']+)'/g)].map((match) => match[1]);

  for (const value of buttonSurfaces) {
    assert.doesNotMatch(value, nonTransparentBackground);
  }

  assert.doesNotMatch(modal, /iconSurface:/, 'decorative icon-tile presentation tokens must be removed');
  assert.match(modal, /<User className="h-7 w-7 shrink-0 liquid-glass-modal-text-muted" strokeWidth=\{1\.8\} \/>/);
  assert.doesNotMatch(modal, /activePresentation|primaryPresentation|summaryPresentation|selectedRolePresentation/);
});

test('StaffShiftModal says each check-in fact once: the chosen person is one line, the step help appears once', () => {
  const modal = source(staffShiftModalPath);
  const pinStart = modal.indexOf('data-testid="staff-pin-section"');
  const pinEnd = modal.indexOf('data-testid="staff-role-section"', pinStart);
  const pinStep = modal.slice(pinStart, pinEnd);

  assert.match(pinStep, /\{renderSelectedStaffSummary\(\)\}/);
  assert.equal((pinStep.match(/t\('modals\.staffShift\.enterPinHelper'\)/g) ?? []).length, 1);
  // The summary keeps the role for screen readers under its label, and no longer repeats the step help.
  assert.match(modal, /<span className="sr-only">\{t\('modals\.staffShift\.currentRoleLabel'\)\}: <\/span>/);
  assert.doesNotMatch(modal, /renderSelectedStaffSummary\(\{\s*helper:/);
  // The cash step shows the chosen role once (in the summary line), not again as a badge.
  assert.match(modal, /\{renderSelectedStaffSummary\(\{ highlightedRoleName: roleType \}\)\}/);
});

test('StaffShiftModal renders the PIN continue action as the kit yellow primary', () => {
  const modal = source(staffShiftModalPath);
  const footerStart = modal.indexOf('const renderCheckInFooter = () => {');
  const footer = modal.slice(footerStart, modal.indexOf('// Keyboard Shortcuts', footerStart));

  assert.match(
    footer,
    /disabled=\{loading \|\| enteredPin\.length !== 4\}\s*className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary sm:min-w-\[220px\]"/,
  );
  assert.doesNotMatch(footer, /hover:/, 'no hover-era class on this touch POS');
  assert.doesNotMatch(modal, /bg-blue-600 px-6 py-3\.5 text-base font-bold text-white/);
});

test('ProgressStepper is the kit stepper: yellow current step, ticked done steps, no green, no pulse', () => {
  const stepper = source(progressStepperPath);

  assert.match(stepper, /active:\s*\{\s*circle: 'border-\(--pos-s-sel-bg\) bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\)'/);
  assert.match(stepper, /if \(status === 'complete'\) return <Check /);
  assert.doesNotMatch(stepper, /emerald|green-|cyan-/);
  assert.doesNotMatch(stepper, /repeat: Infinity/, 'no endlessly pulsing halo');
  assert.match(stepper, /aria-current=\{step\.status === 'active' \? 'step' : undefined\}/);
});

test('StaffShiftModal renders the cashier-first role gate as a readable kit warning', () => {
  const modal = source(staffShiftModalPath);
  const cashierFirstFallbacks = [
    'The first check-in for this business day must be a cashier.',
    'Start a cashier shift first. The other roles unlock after the cashier checks in.',
    'This staff member does not have a cashier role. Go back and choose a cashier first.',
    'Cashier must start the current business day before this role can check in.',
    'Locked until cashier starts',
  ];

  // founder 11/11/2026: the same readable kit warning now reveals with the form.
  assert.match(
    modal,
    /cashierFirstGateActive && \(\s*<motion\.div key="reveal-\d+" \{\.\.\.revealMotion\} className="pos-notice pos-notice--warn mt-4 text-sm"><ShiftRevealContent>\s*<AlertTriangle className="pos-notice__icon h-5 w-5" \/>/,
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
});

test('cashier-first role gate copy exists in every POS locale and Greek is not English fallback', () => {
  const keys = [
    'cashierFirstCheckInRequired',
    'cashierFirstCheckInHelper',
    'cashierFirstCheckInBlocked',
    'cashierFirstRoleLockedHelper',
    'roleLockedUntilCashier',
  ];
  const locales = ['en', 'el', 'de', 'fr', 'it', 'sq'];
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

test('StaffShiftModal renders role choices as glass cards with plain primary/secondary words', () => {
  const modal = source(staffShiftModalPath);
  const roleStart = modal.indexOf('data-testid="staff-role-section"');
  const roleStep = modal.slice(roleStart, modal.indexOf("if (checkInStep === 'enter-cash'", roleStart));

  // founder 11/11/2026: raised glass choices, with the original role words and lock state.
  assert.match(roleStep, /className="pos-glass-tap-card flex min-h-\[56px\] w-full items-center justify-between gap-3 px-4 py-3"/);
  assert.match(roleStep, /<span className="text-sm liquid-glass-modal-text-muted">\s*\{role\.is_primary/);
  assert.match(roleStep, /<span className="text-sm font-semibold text-\(--pos-s-warn\)">\s*\{t\('modals\.staffShift\.roleLockedUntilCashier'\)\}/);
  assert.doesNotMatch(roleStep, /rolePresentation|badgeFilled|bg-amber-50/);
});

test('StaffShiftModal renders the cash-entry icon neutral, without a wrapper tile', () => {
  const modal = source(staffShiftModalPath);

  assert.match(modal, /<CashHandIcon\s+className="h-10 w-10 shrink-0 liquid-glass-modal-text-muted"\s*\/>/);
  assert.doesNotMatch(
    modal,
    /rounded-\[20px\] border \$\{selectedRolePresentation\.iconSurface\}[\s\S]*<CashHandIcon/,
  );
});

test('StaffShiftModal lists staff on shift as glass cards; the card itself opens the shift', () => {
  const modal = source(staffShiftModalPath);
  const listStart = modal.indexOf('data-testid="checkin-active-shifts"');
  const list = modal.slice(listStart, modal.indexOf('data-testid="checkin-ready-staff"', listStart));

  assert.match(list, /activeCheckInStaff\.length > 0 \? 'text-\(--pos-s-ok\)' : 'liquid-glass-modal-text-muted'/);
  assert.match(list, /className="pos-glass-tap-card flex min-h-\[56px\] w-full items-center justify-between gap-3 px-4 py-3 relative text-left"/);
  // founder 11/11/2026: state words and icons stay green, with no decorative colour bar.
  assert.match(list, /className="truncate text-base font-semibold text-\(--pos-s-ok\)">\{staffMember\.name\}/);
  assert.match(list, /<User className="h-7 w-7 shrink-0 text-\(--pos-s-ok\)"/);
  assert.match(list, /<span className="inline-flex items-center gap-1 font-semibold text-\(--pos-s-ok\)">\s*<CheckCircle/);
  assert.match(list, /\{t\('modals\.staffShift\.manageActiveShift'\)\}\s*<ChevronRight className="h-5 w-5 shrink-0" \/>/);
  assert.match(list, /satelliteShiftsByStaffId\.get\(staffMember\.id\) \|\|\s*staffActiveShifts\.get\(staffMember\.id\)/);
  assert.doesNotMatch(list, /emerald|bg-black\/45|accentSurface|badgeFilled/);
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
// now FLOATS -- it lives OUTSIDE the scrollable reconciliation body and overlays the cards while they continue
// behind it. This guards the layout (relative shell + shrinkable padded scroll body + absolute sibling footer) and proves
// the footer placement stays intact. Payment-state behavior is covered by the mounted checkout tests.
// Touch-first: no hover, no native title on the footer.
test('Round 338: the checkout action footer floats over the scrollable reconciliation body', () => {
  const modal = source(staffShiftModalPath);

  // The checkout pane fills the modal content box so the body can scroll while the footer floats. Check-in keeps
  // its capped-height behaviour; the shells are distinguished by data-testid.
  assert.match(
    modal,
    /className=\{`pos-progressive-form relative flex \$\{effectiveMode === 'checkout' \? 'flex-1 min-h-0' : 'max-h-\[84vh\]'\} flex-col`\}/,
    // founder 11/11/2026: the focus-visible scope keeps the same bounded scrolling shell.
    'the checkout shell must fill the modal (flex-1 min-h-0) so its body scrolls and the footer floats',
  );
  assert.match(
    modal,
    /data-testid=\{effectiveMode === 'checkout' \? 'staff-checkout-shell' : 'staff-checkin-shell'\}/,
  );

  // The reconciliation body is the single scroller, extends beneath the floating footer, and keeps
  // enough internal bottom space that its final controls remain reachable above the overlay.
  const scrollAnchor = 'data-testid="staff-shift-scroll-body"';
  const scrollIdx = modal.indexOf(scrollAnchor);
  assert.notEqual(scrollIdx, -1, 'the scrollable reconciliation body marker must exist');
  const scrollOpenTag = modal.slice(modal.lastIndexOf('<div', scrollIdx), modal.indexOf('>', scrollIdx) + 1);
  assert.match(scrollOpenTag, /flex-1/);
  assert.match(scrollOpenTag, /min-h-0/);
  assert.match(scrollOpenTag, /overflow-y-auto/);
  assert.match(scrollOpenTag, /scrollbar-hide/);
  assert.match(scrollOpenTag, /pb-36/);

  // The footer must be a SIBLING outside the scroll body. Its marker exists and renders after the body...
  const footerIdx = modal.indexOf('data-testid="staff-checkout-footer"');
  assert.notEqual(footerIdx, -1, 'the pinned checkout footer marker must exist');
  assert.ok(footerIdx > scrollIdx, 'the footer must render after the scrollable body');

  const footerOpenTag = modal.slice(modal.lastIndexOf('<div', footerIdx), modal.indexOf('>', footerIdx) + 1);
  assert.match(
    footerOpenTag,
    /absolute inset-x-0 bottom-0 z-20/,
    'the expected-amount/action bar must overlay the reconciliation page instead of reserving a grey row',
  );
  assert.doesNotMatch(
    footerOpenTag,
    /bg-white|border-t|backdrop-blur/,
    'the floating bar must not sit on a second white footer sheet',
  );

  // ...and the scroll body's closing </div> immediately precedes the footer conditional, proving the footer is
  // a sibling rendered AFTER (outside) the overflow-y-auto region rather than nested within it. If anyone ever
  // re-nests the footer inside the scroller this seam disappears and the guard fails.
  assert.match(
    modal,
    /<\/div>\s*\{effectiveMode === 'checkout' && checkoutFooterData && \(\s*<div\s+data-testid="staff-checkout-footer"/,
    'the checkout footer must be a sibling rendered immediately after the scroll body closes (outside the scroller)',
  );

  // Keep this layout test independent of payment-state expressions. The mounted financial-opening and
  // gift-close suites exercise ordinary checkout, pending proof, confirmation and asynchronous print guards.
  assert.match(modal, /<StaffShiftCheckoutFooterActions/);
});

test('Round 338: the checkout footer action rail stays touch-first (no hover, no native title)', () => {
  const footer = source(checkoutFooterActionsPath);

  assert.doesNotMatch(footer, /hover:/, 'the footer action rail must not use hover variants on this touch POS');
  assert.doesNotMatch(footer, /\btitle=/, 'the footer action rail must not use native title tooltips');
  // Tap feedback only: the kit buttons press through the shared base rule (founder 01/11), and the stable
  // testids the live QA relies on.
  assert.match(footer, /pos-solid-btn/);
  assert.match(footer, /data-testid="staff-checkout-print-button"/);
  assert.match(footer, /data-testid="staff-checkout-confirm-button"/);
});

test('StaffShiftModal chips are plain words, never pills (founder 01/11 «βγάλε τα wrappers από τα chips»)', () => {
  const modal = source(staffShiftModalPath);

  assert.doesNotMatch(modal, /\bpos-badge\b/, 'no kit pill badges in the shift window');
  assert.doesNotMatch(modal, /rounded-full border px-2\.5 py-1/, 'no pill-shaped status chips');
  // Order status in the audit list: coloured words only.
  assert.match(modal, /<span className=\{`inline-flex items-center text-\[13px\] font-semibold \$\{getAuditStatusBadgeClass\(order\.status\)\}`\}>/);
});

test('StaffShiftModal checkout says each heading once and keeps every amount colour', () => {
  const modal = source(staffShiftModalPath);

  // No small-capitals, letter-spaced labels anywhere in the window (sentence case, kit muted).
  assert.doesNotMatch(modal, /className="[^"]*\buppercase\b/);
  // The card titles are not repeated by an eyebrow above them.
  assert.equal((modal.match(/\{t\('modals\.staffShift\.auditDetails', 'Audit Details'\)\}/g) ?? []).length, 1);
  assert.doesNotMatch(modal, /<(?:div|p|span) className="[^"]*text-(?:xs|\[11px\])[^"]*">\s*\{t\('modals\.staffShift\.expenses'\)\}/);
  // Founder 01/11 («δεν ήθελα να βγάλεις τα χρώματα στα ποσά»): every amount keeps the colour that gives it
  // meaning, zero included: income green, deductions red, payouts yellow, tips yellow, expenses red.
  assert.doesNotMatch(modal, /row\.amount > 0 \? row\.tone/);
  assert.match(modal, /tone: 'text-emerald-600 dark:text-emerald-300', prefix: '\+'/);
  assert.match(modal, /tone: 'text-rose-600 dark:text-rose-300', prefix: '-'/);
  assert.match(modal, /amount: breakdown\.deductedStaffPayments, tone: 'text-yellow-700 dark:text-yellow-300'/);
  assert.match(modal, /className="mt-1 text-2xl font-black text-rose-500 dark:text-rose-300">\s*\{formatCurrency\(totalExpenses\)\}/);
  assert.match(modal, /text-3xl font-black tracking-tight text-yellow-700 dark:text-yellow-300">\s*\{formatCurrency\(tipsReceived\)\}/);
  // Founder 01/11/2026 («κανε το αναμενομενο πρασινο και στα 2»): the expected cash is green in the card and the bar;
  // «Not entered» is amber until the counted cash is typed.
  assert.match(modal, /accentClass: 'text-\(--pos-s-ok\)'/);
  assert.match(modal, /data-expected-in-drawer className="mt-3 text-4xl font-black tracking-tight text-\(--pos-s-ok\)"/);
  assert.match(modal, /actual === null \? 'text-\(--pos-s-warn\)' : Math\.abs\(actual - breakdown\.expected\) < 0\.005 \? 'text-\(--pos-s-ok\)' : 'text-rose-500 dark:text-rose-300'/);
  // The checkout action is the one kit yellow primary (it was a red gradient).
  const footer = source(checkoutFooterActionsPath);
  assert.match(footer, /data-testid="staff-checkout-confirm-button"\s*className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary/);
  assert.doesNotMatch(footer, /from-red-600|to-red-700/);
});

test('the shift window text key «noOrdersYet» exists in every POS language', () => {
  for (const locale of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
    const staffShift = JSON.parse(source(path.join(projectRoot, 'src', 'locales', `${locale}.json`))).modals.staffShift;
    assert.equal(typeof staffShift.noOrdersYet, 'string', `${locale}.noOrdersYet`);
    assert.notEqual(staffShift.noOrdersYet.trim(), '');
  }
});
