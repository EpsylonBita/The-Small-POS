import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const modalSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'SplitPaymentModal.tsx'),
  'utf8',
);

const glassCss = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'styles', 'glassmorphism.css'),
  'utf8',
);

// --- Round 252 (live QA, Greek/dark, 1282x802): the Split Payment modal clipped the lower person
// card under the footer in by-item mode, and the split-mode (By Amount / By Items) + receipt-mode
// (All Together / Separate) segmented controls used a grey/white selected slab. The modal content
// is now a bounded min-h-0 flex column whose body is the single flex-1/min-h-0 scroll region (so the
// footer can never cover content), and the selected segments use the core yellow/black accent.
// Cash/card method + confirm semantic greens stay green; no hover-only utilities or native title=. ---

test('Round 252/298: SplitPaymentModal gives LiquidGlassModal a bounded, compact flex-column content contract', () => {
  // contentClassName makes the modal content a bounded min-h-0 flex column (nothing overflows under footer).
  // Round 298 correction: padding is reduced to !px-6 !py-5 (from the shell's default 2rem) to reclaim
  // vertical space so both person cards fit on first open.
  assert.match(modalSource, /contentClassName="flex min-h-0 flex-col overflow-hidden !px-6 !py-5"/);
  // The inner content is a flex column that can shrink (min-h-0); Round 298 tightened its rhythm to space-y-3.
  assert.match(modalSource, /<div className="flex min-h-0 flex-1 flex-col space-y-3">/);
  // The order-total header and the split-mode segmented control are fixed (flex-shrink-0).
  assert.match(modalSource, /<div className="flex-shrink-0 text-center">/);
  assert.match(modalSource, /<div className="flex flex-shrink-0 gap-1 rounded-xl border/);
});

test('Round 252/298: the split body is the single flex-1/min-h-0 scroll region with FOOTER-SAFE clearance', () => {
  // A real bounded scroll region (flex-1 min-h-0 overflow-y-auto scrollbar-hide) wraps the tab content so
  // the last person / add-person row is reachable.
  //
  // Round 298 (live QA, 1282x802, Greek/light): the earlier `pb-4` (16px) bottom padding was NOT enough --
  // the modal footer still covered the lower-right person card ("Person 2" in Greek) on
  // first open. The clearance is now `pb-24` PLUS `scroll-pb-24`, so the scroll RANGE itself reserves footer
  // space and the last card scrolls fully ABOVE the footer in both "By Amount" and "By Items" (one shared
  // scroll region renders both tabs). The hidden touch scrollbar is preserved (no visible native rail).
  assert.match(modalSource, /<div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide pb-24 scroll-pb-24">/);
  assert.match(
    modalSource,
    /scrollbar-hide pb-24 scroll-pb-24">\{activeTab === 'by-amount' \? renderByAmountTab\(\) : renderByItemsTab\(\)\}<\/div>/,
  );
  // The too-small pb-4 footer clearance (the Round 298 finding) must be gone.
  assert.doesNotMatch(modalSource, /scrollbar-hide pb-4"/);
  // The bounded scroll region keeps min-h-0 / flex-1 / overflow-y-auto + the hidden scrollbar utility.
  assert.match(modalSource, /min-h-0 flex-1 overflow-y-auto scrollbar-hide/);

  // The old inner scrollers that fought the body (and clipped under the footer) are gone.
  assert.doesNotMatch(modalSource, /max-h-\[380px\]/);
  assert.doesNotMatch(modalSource, /max-h-\[500px\]/);
  // By-item layout is no longer a naked fixed-height grid; it grows inside the bounded body (Round 298
  // tightened the two-column gap to gap-3 so both columns + the second person card fit on first open).
  assert.doesNotMatch(modalSource, /grid max-h-\[500px\] grid-cols-2/);
  assert.match(modalSource, /<div className="grid grid-cols-2 gap-3">/);
});

// --- Round 298 SECOND correction (first pass FAILED live QA): the initial fix only raised the scroll
// region's bottom padding to pb-24 / scroll-pb-24. Codex re-checked the running POS at 1282x802 and the
// By-Product "Person 2" card was STILL clipped at the footer/body boundary, and PageDown did not move
// the content -- i.e. the modal was overflowing the viewport rather than scrolling, so padding alone could
// never reveal the card. The correction makes the FIRST-OPEN layout fit: a taller shell cap (!max-h-[96vh]),
// reduced content padding (!px-6 !py-5), a smaller order-total header (text-2xl, mb-0.5), compact tab
// buttons (py-2), and tighter vertical rhythm (space-y-3 + gap-3). Single hidden-scroll body preserved;
// no nested scrollers, no visible native scrollbar. ---
test('Round 298: the modal uses a compact, taller-capped layout so the second person card is not clipped on first open', () => {
  // Shell may use more of the viewport height so the bounded body has room for both person cards.
  assert.match(modalSource, /className="!max-w-4xl !max-h-\[96vh\]"/);
  // Reduced content padding reclaims vertical space (vs the shell default 2rem).
  assert.match(modalSource, /contentClassName="flex min-h-0 flex-col overflow-hidden !px-6 !py-5"/);
  // Tighter internal rhythm: outer column space-y-3, smaller order-total header, compact tabs, gap-3 grid.
  assert.match(modalSource, /flex min-h-0 flex-1 flex-col space-y-3/);
  assert.match(modalSource, /text-2xl font-bold tracking-tight text-emerald-500/);
  assert.doesNotMatch(modalSource, /text-3xl font-bold tracking-tight text-emerald-500/);
  assert.match(modalSource, /gap-2 rounded-2xl py-2 text-sm font-medium transition-all/);
  assert.match(modalSource, /grid grid-cols-2 gap-3/);

  // The footer-safe scroll body is retained (padding is necessary but, as the first pass proved, NOT
  // sufficient on its own -- the compact/taller layout above is what makes the card reachable at first open).
  assert.match(modalSource, /min-h-0 flex-1 overflow-y-auto scrollbar-hide pb-24 scroll-pb-24/);

  // No nested fighting scrollers: exactly one overflow-y-auto region, and it carries scrollbar-hide.
  const scrollers = (modalSource.match(/overflow-y-auto/g) ?? []).length;
  assert.equal(scrollers, 1, 'exactly one scroll body (no nested competing scrollers)');
  assert.match(modalSource, /overflow-y-auto scrollbar-hide/);

  // Touch-first safety preserved (no hover-only utilities). Native-tooltip safety is covered by the
  // Round 252 test below; the LiquidGlassModal `title` PROP is a heading, not a DOM tooltip.
  assert.doesNotMatch(modalSource, /hover:/);
});

test('Round 425: SplitPaymentModal uses smooth radii for controls with no small-radius leftovers', () => {
  assert.doesNotMatch(modalSource, /rounded-md|rounded-lg/);
  assert.doesNotMatch(modalSource, /className="rounded /);
  assert.match(modalSource, /flex gap-1 rounded-2xl bg-white\/5 p-0\.5/);
  assert.match(modalSource, /className="rounded-full p-1 text-red-400\/60 transition-colors active:bg-red-500\/10 active:text-red-400"/);
  assert.match(modalSource, /className="w-full rounded-2xl border border-white\/20 bg-white\/10 py-2 pl-7 pr-3 text-sm/);
});

// --- Round 298 THIRD correction (FIRST pass FAILED, SECOND correction FAILED live QA). The first two
// passes only shaved the shell/header/padding: pass 1 raised the scroll clearance to pb-24/scroll-pb-24;
// pass 2 added !max-h-[96vh] + !px-6 !py-5 + a compacter header/tabs/grid. Codex re-checked the running POS
// at 1282x802 (Greek/light) and the By-Product (By Items) "Person 2" card was STILL clipped at the
// footer/body boundary on first open. The REAL cause was the by-items People cards rendering the full
// renderPortionDetails stack (subtotal + discount + payable rows, the Collected By owner, and the discount
// editor button) even for the two INITIAL empty 0,00 EUR people that have NO assigned items -- two over-tall
// cards that cannot both clear the footer. The third correction compacts an empty draft by-items portion to
// just its label, "No items assigned", 0,00 EUR, and the cash/card MethodToggle; the full renderPortionDetails
// stack renders only once a portion has items, a positive amount, a discount, or a paid|processing state, so
// no real functionality is removed from active/assigned portions. Payment/split/settlement logic, handlers,
// and locale keys are unchanged. ---
test('Round 298 (third correction): empty by-items person cards are compact and skip the renderPortionDetails stack', () => {
  // A module-level predicate marks a compact-eligible portion: draft + no items + nothing payable + no discount.
  assert.match(
    modalSource,
    /const isEmptyByItemsPortion = \(portion: SplitPortion\): boolean => portion\.status === 'draft' && portion\.items\.length === 0 && portion\.amount <= 0\.009 && portion\.discountAmount <= 0\.009;/,
  );

  // The by-items People card branches on that predicate: compact ? : full.
  assert.match(modalSource, /\{isEmptyByItemsPortion\(portion\) \? \(/);

  // Isolate the compact (truthy) branch: from `isEmptyByItemsPortion(portion) ? (` up to the `) : (` that
  // opens the full branch. The compact branch shows the person's "no items" line + the 0,00 EUR amount + the
  // cash/card MethodToggle, and must NOT render the tall renderPortionDetails settlement stack.
  const compactBranch = modalSource.match(/isEmptyByItemsPortion\(portion\) \? \(([\s\S]*?)\) : \(/);
  assert.ok(compactBranch, 'the by-items person card uses an isEmptyByItemsPortion ? compact : full ternary');
  assert.match(compactBranch[1], /t\('splitPayment\.noItems', 'No items assigned'\)/);
  assert.match(compactBranch[1], /formatCurrency\(portion\.amount\)/);
  assert.match(compactBranch[1], /<MethodToggle portion=\{portion\} \/>/);
  assert.doesNotMatch(
    compactBranch[1],
    /renderPortionDetails/,
    'empty 0,00 EUR by-items people must NOT render the full subtotal/discount/payable/discount-editor stack (the real Round 298 cause)',
  );

  // The full (assigned / positive / discounted / paid|processing) else-branch STILL renders the settlement
  // controls, so active portions keep every detail + payment control.
  const elseStart = modalSource.indexOf(') : (', modalSource.indexOf('isEmptyByItemsPortion(portion) ?'));
  assert.ok(elseStart > 0, 'the compact ternary has a full else branch');
  assert.match(modalSource.slice(elseStart), /renderPortionDetails\(portion\)/);

  // renderPortionDetails is still wired in exactly two places (the By Amount card + the By Items FULL
  // branch). The compact empty by-items card is the only place it is intentionally skipped.
  const detailCalls = (modalSource.match(/renderPortionDetails\(portion\)/g) ?? []).length;
  assert.equal(detailCalls, 2, 'renderPortionDetails renders for the by-amount card + the by-items full branch only');
});

test('Round 252/316: split-mode (activeTab) selected segments use the yellow/black accent + the scoped contrast class', () => {
  // Both By Amount / By Items selected branches are yellow/black AND carry the Round 316 contrast class so
  // the black text/icon survives the global glass .font-medium override.
  const yellowActive = modalSource.match(/activeTab === 'by-(amount|items)' \? 'bg-yellow-400 text-black shadow-sm split-payment-segment-selected'/g) || [];
  assert.equal(yellowActive.length, 2, 'both split-mode tabs should use the yellow selected accent');
  // The old grey/white selected slab is gone for these tabs.
  assert.doesNotMatch(modalSource, /activeTab === 'by-(amount|items)' \? 'bg-white\/10 liquid-glass-modal-text shadow-sm'/);
  // Unselected stays neutral with active (touch) feedback, not hover.
  assert.match(
    modalSource,
    /activeTab === 'by-amount' \? 'bg-yellow-400 text-black shadow-sm split-payment-segment-selected' : 'text-white\/40 active:text-white\/60'/,
  );
});

test('Round 252/316: receipt-mode selected segments use the yellow/black accent + the scoped contrast class', () => {
  const yellowReceipt = modalSource.match(/receiptMode === '(combined|individual)' \? 'border border-yellow-400 bg-yellow-400 text-black split-payment-segment-selected'/g) || [];
  assert.equal(yellowReceipt.length, 2, 'both receipt-mode toggles should use the yellow selected accent');
  // The old grey/white selected slab is gone.
  assert.doesNotMatch(modalSource, /receiptMode === '(combined|individual)' \? 'border border-white\/20 bg-white\/10 liquid-glass-modal-text'/);
  // Unselected stays neutral + active feedback.
  assert.match(
    modalSource,
    /receiptMode === 'combined' \? 'border border-yellow-400 bg-yellow-400 text-black split-payment-segment-selected' : 'text-white\/40 active:text-white\/60'/,
  );
});

// --- Round 316 (live QA, Greek/dark): the Split Payment selected segmented controls (top split-mode
// "By Amount"/"By Items" and footer receipt-mode "All Together"/"Separate") rendered pale/white text on
// yellow instead of high-contrast black. Root cause: those selected buttons carry `font-medium`, so the
// broad `.liquid-glass-modal-shell .font-medium` glass override (slate-800 light / slate-100 dark, both
// !important) out-specified their `text-black` utility. The fix is a SCOPED contrast class
// (`split-payment-segment-selected`) whose glassmorphism.css rule wins by HIGHER specificity
// (`button.<class>`) AND later source order, and also forces the lucide icon black (child <svg>
// currentColor). Payment behavior, handlers, and semantic green/emerald/slate are untouched. ---
test('Round 316: selected yellow segments carry a scoped class that forces black text + icon over the glass font override', () => {
  // The contrast class rides ONLY the yellow/black selected slabs (2 split-mode + 2 receipt-mode = 4),
  // never an unselected branch.
  const taggedCount = (modalSource.match(/split-payment-segment-selected/g) ?? []).length;
  assert.equal(taggedCount, 4, 'exactly the four yellow selected segments carry the contrast class');
  const onYellowSlab = (modalSource.match(/bg-yellow-400 text-black[^']*split-payment-segment-selected/g) ?? []).length;
  assert.equal(onYellowSlab, 4, 'the contrast class must only ride a yellow + text-black selected slab');

  // The scoped override is defined in glassmorphism.css for BOTH themes, forcing black on the button AND
  // its lucide <svg> icon with !important.
  assert.match(glassCss, /\.liquid-glass-modal-shell button\.split-payment-segment-selected\b/);
  assert.match(glassCss, /\.liquid-glass-modal-shell button\.split-payment-segment-selected svg\b/);
  assert.match(glassCss, /\.dark \.liquid-glass-modal-shell button\.split-payment-segment-selected\b/);
  assert.match(glassCss, /\.dark \.liquid-glass-modal-shell button\.split-payment-segment-selected svg\b/);
  assert.match(
    glassCss,
    /button\.split-payment-segment-selected[\s\S]*?\{[\s\S]*?color:\s*#000\s*!important/,
    'the override must force #000 with !important',
  );

  // It must out-rank the broad `.font-medium` override two ways, so a future reorder cannot regress it:
  //   (1) HIGHER specificity -- `button.split-payment-segment-selected` (element+class) beats the bare
  //       `.liquid-glass-modal-shell .font-medium` class selector in both light and dark.
  //   (2) LATER in source order -- placed after the .font-medium block as a tiebreak.
  const fontMediumAt = glassCss.indexOf('.liquid-glass-modal-shell .font-medium');
  const overrideAt = glassCss.indexOf('button.split-payment-segment-selected');
  assert.ok(fontMediumAt >= 0, 'the broad .font-medium glass override still exists (we override, not delete it)');
  assert.ok(overrideAt > fontMediumAt, 'the split-segment override must come AFTER the .font-medium rule');
  // The broad rule itself is NOT narrowed/deleted (avoids broad regressions in other modals).
  assert.match(glassCss, /\.liquid-glass-modal-shell \.font-medium \{\s*color: #1e293b !important;/);
  assert.match(glassCss, /\.dark \.liquid-glass-modal-shell \.font-medium \{\s*color: #f1f5f9 !important;/);
});

test('Round 252: payment semantics stay green and no hover/native title tooltips are introduced', () => {
  // Cash method + confirm button stay green (not recolored to yellow) - payment semantics preserved.
  assert.match(modalSource, /portion\.method === 'cash' \? 'border border-green-400\/30 bg-green-500\/20 text-green-400'/);
  assert.match(modalSource, /canConfirm \? 'border border-emerald-500\/30 bg-emerald-600\/20 text-emerald-400/);
  // Touch terminal: no hover-only utilities anywhere.
  assert.doesNotMatch(modalSource, /hover:/);
  // No DOM native title= tooltip on any HTML element. (The LiquidGlassModal `title=` PROP - a
  // visible modal heading - is a React component prop, not a DOM attribute, so it is allowed.)
  assert.doesNotMatch(modalSource, /<[a-z][^>]*\stitle=/);
  assert.match(modalSource, /title=\{t\('splitPayment\.title', 'Split Payment'\)\}/);
});

// Round 284 (live QA, Greek/light): the Split Payment section labels (Collected By, Order Items, People)
// were forced uppercase + letter-spaced, which reads shouted in Greek and longer locales. They now use
// normal case (font-semibold + muted white). Labels still route through i18n (text unchanged).
test('Round 284: SplitPaymentModal section labels are normal case (no uppercase/tracking)', () => {
  // The Collected By / Order Items / People labels are normal-case now (font-semibold + muted white).
  assert.match(modalSource, /font-semibold text-white\/40/);
  // No shouted uppercase / letter-spacing survives anywhere in the split modal labels.
  assert.doesNotMatch(modalSource, /\buppercase\b/, 'no shouted uppercase labels remain');
  assert.doesNotMatch(modalSource, /tracking-wider|tracking-\[/, 'no letter-spacing on the section labels');

  // The labels still resolve through i18n with their existing default values (text/behaviour unchanged).
  assert.match(modalSource, /t\('splitPayment\.collectedBy', \{ defaultValue: 'Collected By' \}\)/);
  assert.match(modalSource, /t\('splitPayment\.orderItems', 'Order Items'\)/);
  assert.match(modalSource, /t\('splitPayment\.people', 'People'\)/);
});

// --- Round 311 (live QA, Greek/dark, 1282x802): in By Amount the second person card was partially clipped
// under the fixed footer on first open (scrolling revealed it, but it read as footer overlap). The by-amount
// person cards are now compacter: a zero-discount portion suppresses its Subtotal/Discount rows (Subtotal ==
// Payable, so only Payable shows), the card/portion-list vertical rhythm is tighter, and the discount button
// is shorter -- so both default people + the Add Person affordance clear the footer at first open. Discount
// logic, settlement, handlers, and the single footer-safe scroll body are unchanged. ---
test('Round 311: by-amount portion details suppress the zero-discount Subtotal/Discount rows (compact first view)', () => {
  // renderPortionDetails is now a block body that computes a hasDiscount gate and only renders the Subtotal
  // + Discount rows when a discount actually exists; the Payable line always shows.
  assert.match(modalSource, /const hasDiscount = portion\.discountAmount > 0\.009;/);
  assert.match(
    modalSource,
    /\{hasDiscount && \(\s*<>[\s\S]*?modals\.orderDetails\.subtotal[\s\S]*?modals\.orderDetails\.discount[\s\S]*?<\/>\s*\)\}/,
    'the Subtotal + Discount rows must be gated behind hasDiscount',
  );
  // The Payable line is always present (outside the gate), and the detail rhythm tightened to space-y-1.5.
  assert.match(modalSource, /splitPayment\.payable/);
  assert.match(modalSource, /const renderPortionDetails = \(portion: SplitPortion\) => \{[\s\S]*?<div className="space-y-1\.5">/);
  // The old always-on space-y-2 subtotal/discount/payable arrow-returns-paren form is gone.
  assert.doesNotMatch(modalSource, /const renderPortionDetails = \(portion: SplitPortion\) => \(\s*<div className="space-y-2">/);
  // The discount button is shorter (py-1, was py-1.5).
  assert.match(modalSource, /rounded-2xl px-3 py-1 text-xs font-medium transition-all \$\{portion\.grossAmount > 0\.009/);
});

test('Round 311: the by-amount person card + portion list use tighter spacing, footer-safe body preserved', () => {
  // The by-amount person card is space-y-2 (was space-y-3) and the portions list wrapper is space-y-2.
  assert.match(modalSource, /className="space-y-2 rounded-2xl border border-white\/10 bg-white\/5 p-3"/);
  assert.doesNotMatch(modalSource, /className="space-y-3 rounded-2xl border border-white\/10 bg-white\/5 p-3"/);
  assert.match(modalSource, /<div className="space-y-2"><AnimatePresence mode="popLayout">/);

  // No regression to the bounded single scroll body / footer clearance from Round 298.
  assert.match(modalSource, /min-h-0 flex-1 overflow-y-auto scrollbar-hide pb-24 scroll-pb-24/);
  const scrollers = (modalSource.match(/overflow-y-auto/g) ?? []).length;
  assert.equal(scrollers, 1, 'still exactly one scroll body (no nested competing scrollers)');
  assert.doesNotMatch(modalSource, /hover:/);

  // renderPortionDetails still wired exactly twice (the by-amount card + the by-items full branch) -- no
  // functionality removed, only the zero-discount display rows are hidden.
  const detailCalls = (modalSource.match(/renderPortionDetails\(portion\)/g) ?? []).length;
  assert.equal(detailCalls, 2, 'renderPortionDetails still renders in both the by-amount card and the by-items full branch');
});
