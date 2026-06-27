import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Z-report "Close day assistant" redesign (Round 320). Live POS feedback: the modal still read like a
 * technical report (loud "Z Report" header, three competing day/checks/submit step cards, tools above the
 * fold, too much text before the cashier knew what to do). The first view is now ONE calm decision panel
 * that answers a single question -- "Can I close the day now?":
 *   - a compact business-day control + a quiet, single-line window/terminal detail,
 *   - a large ready / needs-action / locked verdict with one issue-count badge,
 *   - exactly ONE primary action, a 3-way mutually-exclusive switch:
 *       locked (this terminal cannot close) -> a calm Locked chip + plain reason (no submit),
 *       ready (+ executable)                -> the green submit, with the EXACT preserved gating,
 *       blocked                             -> one amber "Review issues" jump to the Review tab.
 * The header is calm ("Close day" + status + close). Refresh / Print / CSV and the Money/Staff/Orders/Review
 * ledgers live behind the secondary detail tabs (progressive disclosure). These are source assertions only;
 * they never exercise day-close / submit behaviour.
 */

const modalPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'modals',
  'ZReportModal.tsx',
);

const source = readFileSync(modalPath, 'utf8');

function slice(src: string, marker: string, endMarker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `marker ${marker} missing`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `end marker ${endMarker} missing after ${marker}`);
  return src.slice(start, end);
}

test('Round 320: first view is ONE close-day decision panel, then the secondary detail tabs', () => {
  const assistantAt = source.indexOf('data-z-report-close-assistant');
  const panelAt = source.indexOf('data-z-report-decision-panel');
  const actionAt = source.indexOf('data-z-report-primary-action');
  const detailsAt = source.indexOf('data-z-report-details');

  assert.ok(assistantAt > 0, 'the close-day assistant wrapper is missing');
  assert.ok(panelAt > assistantAt, 'the decision panel lives inside the assistant');
  assert.ok(actionAt > panelAt, 'the single primary action lives inside the decision panel');
  assert.ok(detailsAt > actionAt, 'the detail tabs must follow the decision panel');

  // The assistant is above the fold (shrink-0); details is the flex-1 scroll region.
  assert.match(source, /data-z-report-close-assistant className="flex shrink-0 flex-col gap-2\.5"/);
  assert.match(source, /data-z-report-details\s+className=\{`mt-3 flex min-h-0 flex-1 flex-col overflow-hidden/);

  // Round 320 collapsed the three step cards (and every older competing surface) into ONE panel; those
  // markers are gone.
  assert.doesNotMatch(source, /data-z-report-steps\b/, 'the three-step flow container must be gone');
  assert.doesNotMatch(source, /data-z-report-step-day/);
  assert.doesNotMatch(source, /data-z-report-step-checks/);
  assert.doesNotMatch(source, /data-z-report-step-submit/);
  assert.doesNotMatch(source, /data-z-report-assistant-panel/);
  assert.doesNotMatch(source, /data-z-report-checks\b/);
  // The whole-checklist .map (an old five-card row) must not render on the first screen; the only remaining
  // checklist render is the .filter(...).map drill-down inside the Review tab.
  assert.doesNotMatch(source, /closeoutChecklistItems\.map/);
});

test('Round 322: the decision panel shows ONE verdict + subtitle; the day picker & From/Until move to a details summary', () => {
  // The verdict region runs from the panel open to the day-details summary.
  const verdict = slice(source, 'data-z-report-decision-panel', 'data-z-report-day-details');
  assert.match(verdict, /\{closeoutStatusLabel\}/);
  assert.match(verdict, /\{closeoutSubtitle\}/);
  assert.doesNotMatch(verdict, /data-z-report-issues-badge/);
  assert.doesNotMatch(verdict, /clarity\.issues/);
  // The verdict region no longer carries the day picker, the live chip, or a raw window line -- those are
  // demoted into the details summary, so the first view is just the verdict + one action.
  assert.doesNotMatch(verdict, /type="date"/, 'the day picker moved into the details summary');
  assert.doesNotMatch(verdict, /liveModeLabel/);
  assert.doesNotMatch(verdict, /modals\.zReport\.businessWindow/);
  assert.doesNotMatch(verdict, /\b(?:bg|text|border|from|to|ring)-(?:blue|indigo|violet|cyan|sky)-/);
  assert.doesNotMatch(verdict, /hover:/);
  assert.doesNotMatch(verdict, /\btitle=/);

  // The day-details <details> summary holds the (now secondary) day picker + plain From/Until/terminal,
  // with the native disclosure marker hidden (theme-matched, no ugly rail).
  const dayDetails = slice(source, 'data-z-report-day-details', '{submitResult');
  assert.match(dayDetails, /<summary[\s\S]*?\[&::-webkit-details-marker\]:hidden/);
  assert.match(dayDetails, /clarity\.detailsSummary/);
  assert.match(dayDetails, /clarity\.dayStepTitle/);
  assert.match(dayDetails, /type="date"/);
  assert.match(dayDetails, /value=\{selectedDate\}/);
  assert.match(dayDetails, /setIsUsingLiveDefaultDate\(false\)/);
  assert.match(dayDetails, /setSelectedDate\(e\.target\.value\)/);
  assert.match(dayDetails, /aria-label=\{t\('modals\.zReport\.selectBusinessDay'\)\}/);
  assert.match(dayDetails, /disabled=\{lockDate\}/);
  // Plain From/Until words replace the technical "time window"; terminal stays inside the summary.
  assert.match(dayDetails, /clarity\.from/);
  assert.match(dayDetails, /clarity\.until/);
  assert.match(dayDetails, /modals\.zReport\.terminal/);
  assert.doesNotMatch(dayDetails, /modals\.zReport\.businessWindow/, 'the technical time-window label is gone');
  // Touch target on the date input; on-palette, no hover/title.
  assert.match(dayDetails, /min-h-\[44px\]/);
  assert.doesNotMatch(dayDetails, /\b(?:bg|text|border|to|ring)-(?:blue|indigo|violet|cyan|sky)-/);
  assert.doesNotMatch(dayDetails, /hover:/);
  assert.doesNotMatch(dayDetails, /\btitle=/);
});

test('Round 322/355: the single next action is a plain Commit Z report button -- green ready, grey inactive', () => {
  const action = slice(source, 'data-z-report-primary-action', 'data-z-report-day-details');

  // The commit action is wired once, and the button itself carries the full readiness gate.
  const submits = action.match(/onClick=\{handleSubmitReport\}/g) ?? [];
  assert.equal(submits.length, 1, 'submit must be wired exactly once');
  assert.match(action, /onClick=\{handleSubmitReport\}[\s\S]*?bg-emerald-600/);
  assert.match(action, /disabled=\{!canCommitZReport\}/);
  assert.match(
    source,
    /const canCommitZReport =[\s\S]*?!lockedTerminal[\s\S]*?closeoutReady[\s\S]*?!submitting[\s\S]*?!loading[\s\S]*?!Boolean\(resolvingBlockerKey\)[\s\S]*?paymentBlockers\.length === 0;/,
    'commit must stay blocked unless the report is ready and no loading/resolving/blockers exist',
  );
  assert.match(action, /cursor-not-allowed border-white\/\[0\.14\] bg-white\/\[0\.08\] text-white\/55 opacity-70/);
  assert.match(action, /\{submitButtonLabel\}/);
  assert.doesNotMatch(action, /setActiveTab\('review'\)/);
  assert.doesNotMatch(action, /clarity\.fixAction/);
  assert.doesNotMatch(action, /clarity\.reviewIssues/);
  assert.doesNotMatch(action, /<ListChecks/);

  // On-palette, no hover/title.
  assert.doesNotMatch(action, /\b(?:bg|text|border|from|to|ring)-(?:blue|indigo|violet|cyan|sky)-/);
  assert.doesNotMatch(action, /hover:/);
  assert.doesNotMatch(action, /\btitle=/);
});

test('Round 320: lockedTerminal is derived from canExecuteZReport (gate unchanged, checked first)', () => {
  assert.match(source, /const lockedTerminal = !canExecuteZReport;/);
  assert.match(source, /const canCommitZReport =[\s\S]*?!lockedTerminal[\s\S]*?closeoutReady/);
  assert.match(source, /disabled=\{!canCommitZReport\}/);
});

test('Round 322/355: locked and blocked explanations live in the subtitle, not issue chips or fix buttons', () => {
  const panel = slice(source, 'data-z-report-decision-panel', 'data-z-report-day-details');

  // Locked uses the existing main-terminal / loading messages through the shared subtitle.
  assert.match(source, /const closeoutSubtitle = lockedTerminal/);
  assert.match(source, /terminal\.messages\.zReportMainOnly/);
  assert.match(source, /common\.loading/);

  // No repeated issue wording and no separate fix/review action; the verdict is a title + plain subtitle.
  assert.doesNotMatch(panel, /clarity\.checksNeedAttention/);
  assert.doesNotMatch(panel, /data-z-report-issues-badge/);
  assert.doesNotMatch(panel, /clarity\.fixAction/);
  assert.doesNotMatch(panel, /clarity\.reviewIssues/);
});

test('Round 320: handleSubmitReport is wired exactly once in the whole modal (the ready-only path)', () => {
  const submits = source.match(/onClick=\{handleSubmitReport\}/g) ?? [];
  assert.equal(submits.length, 1, 'handleSubmitReport must be wired exactly once across the entire modal');
});

test('Round 322: the header shows a friendly date + live/past-day chip, and never repeats the verdict', () => {
  const header = slice(source, 'data-z-report-command-header', 'size="full"');

  // Human title (Close day) + the working day as a FRIENDLY localized date (not a raw ISO string).
  assert.match(header, /clarity\.assistantTitle/);
  assert.match(header, /\{friendlyBusinessDate\}/);
  assert.doesNotMatch(header, /\{resolvedBusinessDate\}/, 'the raw ISO date must not show in the header');

  // A small live/past-day chip replaces the old verdict badge.
  assert.match(header, /data-z-report-day-chip/);
  assert.match(header, /clarity\.dayLive/);
  assert.match(header, /clarity\.dayHistorical/);

  // The verdict ("ready" / "needs attention") lives ONLY in the status card -- the header must not repeat it.
  assert.doesNotMatch(header, /\{closeoutStatusLabel\}/, 'the status verdict must not also render in the header');
  assert.doesNotMatch(header, /data-z-report-header-status/, 'the old header status badge is gone');

  // Close button intact; no tools, no submit, no window/terminal/live clutter in the header.
  assert.match(header, /aria-label=\{t\('common\.actions\.close'\)\}/);
  assert.match(header, /onClick=\{onClose\}/);
  assert.doesNotMatch(header, /data-z-report-utility-tools/, 'the tools cluster must not be in the header');
  assert.doesNotMatch(header, /handleSubmitReport/, 'the header never submits');
  assert.doesNotMatch(header, /businessWindow/);
  assert.doesNotMatch(header, /modals\.zReport\.terminal/);
  assert.doesNotMatch(header, /liveModeLabel/);

  // No native title tooltips on a touch POS; on-palette only.
  assert.doesNotMatch(header, /\btitle=/);
  assert.doesNotMatch(header, /\b(?:bg|text|border|from|to|ring)-(?:blue|indigo|violet|cyan|sky)-/);
  assert.doesNotMatch(header, /hover:/);
});

// Round 351 (live QA, Greek/dark): the header showed "Πέμπτη 25 Ιουνίου 2026" while the chip said "Σήμερα"
// (system date 2026-06-26) -- a past/open business day read as today. Root cause: isLiveDay was derived from the
// INTENT flag (isUsingLiveDefaultDate && !lockDate), not the date actually displayed. The chip must be derived
// from the SAME date shown in the header (resolvedBusinessDate) compared to the terminal-local today, so a
// returned past zReport.date can never read as "Today". Display-only -- lockDate/submit/closeout unchanged.
test('Round 352: the Review tab headline is live store earnings from staff check-in/check-out totals', () => {
  assert.match(source, /const staffEarnedSoFar = staffReportsSorted\.reduce/);
  assert.match(source, /resolveShiftEarnedTotal\(staff\)/);
  assert.match(source, /const storeEarnedSoFar = hasStaffEarnedSoFar \? staffEarnedSoFar : totalSales;/);
  assert.match(source, /const storeOrderCountSoFar = hasStaffEarnedSoFar \? staffOrderCountSoFar : totalOrders;/);

  const reviewMoney = slice(source, 'data-z-report-review-money-overview', 'paymentBlockers.length > 0');
  assert.match(reviewMoney, /formatMoney\(storeEarnedSoFar\)/);
  assert.match(reviewMoney, /data-z-report-earned-source/);
  assert.match(reviewMoney, /liveCurrentWindow/);
  assert.match(reviewMoney, /activeShiftCount/);
  assert.match(reviewMoney, /closedShiftCount/);
  assert.doesNotMatch(
    reviewMoney,
    /formatMoney\(totalSales\)/,
    'the first-tab money headline must not fall back to raw totalSales when staff live totals exist',
  );
});

test('Round 351: the day chip is derived from the displayed business date vs local today, not the live-default flag', () => {
  // The buggy derivation (chip == live-default intent flag) is gone. The intent flag may still drive other
  // things (liveModeLabel / auto-refresh), so the guard is scoped to the `const isLiveDay =` line specifically.
  assert.doesNotMatch(
    source,
    /const isLiveDay = isUsingLiveDefaultDate && !lockDate;/,
    'isLiveDay must not be derived only from isUsingLiveDefaultDate && !lockDate',
  );

  // isLiveDay now compares the displayed business date to the terminal-local today, gated by validity + !lockDate.
  assert.match(source, /const businessDateValue = parseLocalDateString\(resolvedBusinessDate\);/);
  assert.match(source, /const isBusinessDateValid = !Number\.isNaN\(businessDateValue\.getTime\(\)\);/);
  assert.match(source, /const localToday = toLocalDateString\(new Date\(\)\);/);
  assert.match(
    source,
    /const isLiveDay = !lockDate && isBusinessDateValid && resolvedBusinessDate === localToday;/,
    'isLiveDay must be resolvedBusinessDate === localToday (valid, not locked)',
  );

  // The header date and the chip share the SAME source so they cannot disagree: friendlyBusinessDate derives
  // from resolvedBusinessDate, and the chip class/icon/text are all gated by isLiveDay.
  assert.match(
    source,
    /const friendlyBusinessDate = !isBusinessDateValid\s*\n?\s*\? resolvedBusinessDate/,
  );
  const header = slice(source, 'data-z-report-command-header', 'size="full"');
  assert.match(header, /\$\{isLiveDay \?/, 'the chip class is gated by isLiveDay');
  assert.match(header, /isLiveDay\s*\n?\s*\? t\('modals\.zReport\.clarity\.dayLive'/, 'chip text says Today only when isLiveDay');
});

test('Round 320: the details area carries the four tabs + the quiet (secondary) tools cluster + one hidden-scrollbar body', () => {
  const details = slice(source, 'data-z-report-details', '</LiquidGlassModal>');

  // Tabs rendered from the shared list; content gated per tab. The Review step keeps the 'review' key.
  assert.match(details, /\{reportTabs\.map\(/);
  assert.match(details, /activeTab === 'review'/);
  assert.match(details, /activeTab === 'money'/);
  assert.match(details, /activeTab === 'staff'/);
  assert.match(details, /activeTab === 'orders'/);
  assert.doesNotMatch(details, /activeTab === 'issues'/);
  assert.match(details, /const TabIcon = tab\.icon;/);
  assert.match(details, /<TabIcon className="h-4 w-4" \/>/);

  // Refresh / Print / CSV are quiet secondary tools here (not above the close-day decision), handlers +
  // aria-labels intact, no native title tooltips.
  assert.match(details, /data-z-report-utility-tools/);
  assert.match(details, /onClick: handleRefreshReport/);
  assert.match(details, /onClick: handlePrintReport/);
  assert.match(details, /onClick: handleExportReport/);
  assert.match(details, /onClick=\{action\.onClick\}/);
  assert.match(details, /aria-label=\{action\.label\}/);

  // The Review tab drills into ONLY the non-ready checks (clean day stays short) + the full blocker panel.
  assert.match(details, /closeoutChecklistItems\.filter\(\(item\) => item\.state !== 'ready'\)\.map/);
  assert.match(details, /closeoutStateLabel\(item\.state\)/, 'each non-ready Review row must show a short localized status word');
  assert.match(details, /<UnsettledPaymentBlockersPanel/);
  assert.match(details, /clarity\.readyHint/, 'a clean day shows a short all-clear in the Review tab');
  assert.doesNotMatch(details, /type="date"/, 'the date picker lives in the decision panel, not the Review tab');

  // The two money facts live behind the Money tab (progressive disclosure), still reachable.
  assert.match(details, /data-z-report-money-glance/);
  assert.match(details, /clarity\.totalSales/);
  assert.match(details, /formatMoney\(totalSales\)/);
  assert.match(details, /clarity\.expectedCash/);
  assert.match(details, /formatMoney\(expectedCash\)/);

  // Single scroll body: hidden native scrollbar + bottom breathing room so nothing is clipped.
  assert.match(
    details,
    /data-z-report-center-scroll className="[^"]*overflow-y-auto[^"]*pb-6[^"]*scroll-pb-6[^"]*scrollbar-hide[^"]*"/,
    'central tab body must be the hidden-scrollbar scroll region with pb-6 + scroll-pb-6',
  );

  // Tab labels are translation-keyed; the four tabs declare Review/Money/Staff/Orders icons in order.
  assert.match(source, /clarity\.tabReview/);
  assert.match(source, /clarity\.tabMoney/);
  assert.match(
    source,
    /reportTabs[\s\S]*?icon: ListChecks[\s\S]*?icon: Banknote[\s\S]*?icon: Users[\s\S]*?icon: Receipt/,
    'the four tabs must declare Review/Money/Staff/Orders icons in order',
  );
  // The Review tab is the default on open (guided close-day flow).
  assert.match(source, /useState<'review' \| 'money' \| 'staff' \| 'orders'>\('review'\)/);
});

test('Round 321: the Staff tab grid avoids a lonely half-width card (single staff spans full width)', () => {
  const details = slice(source, 'data-z-report-details', '</LiquidGlassModal>');

  // The staff grid only becomes two-column when there is more than one report; a lone card uses grid-cols-1
  // (full width) instead of a half-width column with an empty second track.
  assert.match(
    details,
    /grid gap-3 \$\{staffReportsSorted\.length > 1 \? 'xl:grid-cols-2' : 'grid-cols-1'\}/,
    'staff grid columns must depend on the report count',
  );
  // The old unconditional two-column staff grid must be gone.
  assert.doesNotMatch(details, /<div className="grid gap-3 xl:grid-cols-2">/, 'staff grid must not be unconditionally two-column');

  // Layout-only: the staff card still renders every report with its badges + stat tiles.
  assert.match(details, /staffReportsSorted\.map\(\(staff\) => \{/);
  assert.match(details, /translateRoleName\(t, staff\.role \|\| ''\)/);
  assert.match(details, /\{statRows\.map\(\(row\) => \(/);
  assert.doesNotMatch(details, /hover:/);
});

test('Round 323: cash drawer copy splits checkout-needed (zero variance) from a real variance review; action is issue-specific; state stays amber', () => {
  const item = slice(source, "key: 'cash-drawer'", "key: 'expenses'");

  // Zero-variance unreconciled -> calm "cashier checkout needed", NOT a money discrepancy warning.
  assert.match(item, /: t\('modals\.zReport\.cashDrawerCheckoutNeeded'\)/);
  // A real variance -> money review wording that carries the variance amount.
  assert.match(item, /cashDrawerNeedsReview', \{ variance: formatMoney\(closeoutDrawerVariance\) \}/);
  // Both unreconciled AND variance -> short checkout + variance line (still carries the amount).
  assert.match(item, /cashDrawerCheckoutAndVariance', \{ variance: formatMoney\(closeoutDrawerVariance\) \}/);
  // Variance is the discriminator (not merely the unreconciled count), so the copy branches on it.
  assert.match(item, /closeoutHasVariance\s*\n?\s*\?/);

  // Issue-specific amber action: reconcile when there is variance, otherwise checkout -- not the generic "Fix X".
  assert.match(item, /actionLabel: cashDrawerNeedsAttention/);
  assert.match(item, /clarity\.cashDrawerReconcileAction/);
  assert.match(item, /clarity\.cashDrawerCheckoutAction/);

  // Cash drawer stays amber/warning -- never escalated to a red error (that is reserved for sync/payment).
  assert.match(item, /state: cashDrawerNeedsAttention \? 'warning' : 'ready'/);
  assert.doesNotMatch(item, /'error'/, 'an unreconciled / variance drawer must not render as a red error');

  // Blocking is preserved: an unreconciled drawer still counts toward the issue total (close stays gated).
  assert.match(source, /closeoutIssueCount =[\s\S]*?closeoutUnreconciledDrawers/);

  // The Review row still prefers the issue-specific actionLabel.
  assert.match(source, /item\.actionLabel \?\? closeoutStateLabel\(item\.state\)/);
});

test('Round 353: cashier-checkout-only blocker is named directly, not repeated as generic needs-check', () => {
  assert.match(source, /const closeoutNeedsCashierCheckout =/);
  assert.match(source, /closeoutUnreconciledDrawers > 0/);
  assert.match(source, /!closeoutHasVariance/);
  assert.match(
    source,
    /closeoutNeedsCashierCheckout\s*\n?\s*\?\s*t\('modals\.zReport\.clarity\.cashDrawerCheckoutAction'/,
    'the hero status should say close cashier shift for the active-drawer-only case',
  );
  assert.match(
    source,
    /closeoutNeedsCashierCheckout\s*\n?\s*\?\s*t\('modals\.zReport\.cashDrawerCheckoutNeeded'\)/,
    'the money overview helper should explain the active cashier shift instead of generic review copy',
  );
  assert.match(
    source,
    /item\.actionLabel \?\? closeoutStateLabel\(item\.state\)/,
    'the issue row should show the issue-specific action label when available',
  );
});

test('Round 354: active staff disables Z-report commit with an all-staff checkout message', () => {
  assert.match(source, /const hasActiveStaffShifts = activeShiftCount > 0;/);
  assert.match(source, /\(hasActiveStaffShifts \? 1 : 0\)/);
  assert.match(source, /const closeoutNeedsStaffCheckout =/);
  assert.match(source, /hasActiveStaffShifts/);
  assert.match(source, /t\('modals\.zReport\.allStaffCheckoutTitle'\)/);
  assert.match(source, /t\('modals\.zReport\.allStaffCheckoutSubtitle', \{ count: activeShiftCount \}\)/);
  assert.match(source, /const submitButtonLabel = t\('modals\.zReport\.commitZReport'\);/);

  const action = slice(source, 'data-z-report-primary-action', 'data-z-report-day-details');
  assert.match(action, /disabled=\{!canCommitZReport\}/);
  assert.match(action, /cursor-not-allowed border-white\/\[0\.14\] bg-white\/\[0\.08\] text-white\/55 opacity-70/);
  assert.doesNotMatch(action, /<ListChecks/);

  const staffItem = slice(source, "key: 'staff'", "];");
  assert.match(staffItem, /hasActiveStaffShifts/);
  assert.match(staffItem, /allStaffCheckoutSubtitle/);
  assert.match(staffItem, /allStaffCheckoutTitle/);
});

test('Round 297/320: every overflow-y-auto region hides its native scrollbar (touch scrollbar policy)', () => {
  const classAttrs = source.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? [];
  const scrollers = classAttrs.filter((cls) => /\boverflow-y-auto\b/.test(cls));
  assert.ok(scrollers.length >= 1, `expected at least the central scroll body, found ${scrollers.length}`);
  for (const cls of scrollers) {
    assert.match(cls, /\bscrollbar-hide\b/, `scroll region must include scrollbar-hide: ${cls}`);
  }
});

test('Round 297/320: data sources, handlers, filters and blocker safety are unchanged (UI-only redesign)', () => {
  for (const handler of [
    'handleSubmitReport',
    'handlePrintReport',
    'handleExportReport',
    'handleResolveBlocker',
    'handleRefreshReport',
  ]) {
    assert.match(source, new RegExp(handler), `${handler} must still be wired`);
  }
  // Print / export stay reachable from the (secondary) tools cluster, wired through the action array.
  assert.match(source, /onClick: handlePrintReport/);
  assert.match(source, /onClick: handleExportReport/);
  assert.match(source, /onClick=\{action\.onClick\}/);
  // Filters + business-day selection preserved.
  assert.match(source, /setOrderTypeFilter/);
  assert.match(source, /setPaymentMethodFilter/);
  assert.match(source, /setSelectedDate\(e\.target\.value\)/);
  // Resolve-blocker safety still routed through the shared panel.
  assert.match(source, /onResolveBlocker=\{handleResolveBlocker\}/);
});

test('Round 297/320: action + close buttons use aria-label, not native title tooltips', () => {
  assert.doesNotMatch(source, /title=\{action\.label\}/);
  assert.doesNotMatch(source, /title=\{t\('common\.actions\.close'\)\}/);
  assert.match(source, /aria-label=\{action\.label\}/);
  assert.match(source, /aria-label=\{t\('common\.actions\.close'\)\}/);

  // The two legitimate component-prop title=s remain (modal heading + payment-blocker panel heading).
  assert.match(source, /<LiquidGlassModal[\s\S]*?title=\{title\}/);
  assert.match(source, /title=\{t\('modals\.zReport\.paymentIntegrityTitle'/);
});

test('Round 297/320: modal stays portaled/blurred (LiquidGlassModal shell + content) -- close/submit wiring intact', () => {
  assert.match(source, /<LiquidGlassModal/);
  assert.match(source, /className=\{modalShellClassName\}/);
  assert.match(source, /contentClassName=\{modalContentClassName\}/);
  assert.match(source, /onClick=\{onClose\}/);
});

test('Round 320: new redesign copy is translation-keyed in all five POS locales (no raw literals; Greek is real Greek)', () => {
  // Every clarity.* key the redesign uses must resolve to a real string in every POS locale -- so no new
  // visible text is hardcoded as a raw English/Greek JSX literal.
  const used = Array.from(
    new Set((source.match(/clarity\.([a-zA-Z]+)/g) ?? []).map((m) => m.split('.')[1])),
  );
  assert.ok(used.length >= 7, `expected several clarity.* keys, found ${used.join(',')}`);
  // The redesign's header + decision-panel + details-summary copy must be among the used keys.
  for (const required of ['assistantTitle', 'dayLive', 'dayHistorical', 'dayStepTitle', 'detailsSummary', 'from', 'until', 'cashDrawerCheckoutAction', 'cashDrawerReconcileAction']) {
    assert.ok(used.includes(required), `the redesign must use clarity.${required}`);
  }

  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const load = (lng: string): any => JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));
  const en = load('en');
  const el = load('el');
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const c = load(lng).modals?.zReport?.clarity;
    assert.ok(c, `${lng} missing modals.zReport.clarity`);
    for (const k of used) {
      assert.equal(typeof c[k], 'string', `${lng} missing clarity.${k}`);
      assert.ok(c[k].trim().length > 0, `${lng} empty clarity.${k}`);
    }
  }
  // Greek must be a real translation (not the English fallback) for the label keys.
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const k of ['assistantTitle', 'dayLive', 'dayHistorical', 'detailsSummary', 'fixAction', 'cashDrawerReconcileAction', 'totalSales', 'tabMoney']) {
    assert.notEqual(el.modals.zReport.clarity[k], en.modals.zReport.clarity[k], `el clarity.${k} must differ from English`);
    assert.match(el.modals.zReport.clarity[k], GREEK, `el clarity.${k} must be Greek`);
  }
});
