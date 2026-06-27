import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// NOTE: like menu-item-card-currency, this test does NOT import
// src/renderer/utils/format (it transitively imports '../../lib/i18n' with no
// extension, unresolvable under a direct `node --test <file>`). We prove (a) the
// OrderCard delegates to the shared formatCurrency via source assertions, and (b)
// the locale-aware currency contract it is built on (the same Intl.NumberFormat
// config) yields Greek "18,50 €", not the hardcoded "€18.50".

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
const cardSource = read('src/renderer/components/order/OrderCard.tsx');

// Mirrors src/renderer/utils/format.ts formatCurrency's Intl config.
const eur = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

test('OrderCard renders the card amount via formatCurrency, not hardcoded € + toFixed(2)', () => {
  assert.match(cardSource, /import \{ formatCurrency \} from '\.\.\/\.\.\/utils\/format';/);
  assert.match(cardSource, /\{formatCurrency\(totalNormalized\)\}/);
  // The hardcoded English-style "€{totalNormalized.toFixed(2)}" render is gone.
  assert.doesNotMatch(cardSource, /€\{totalNormalized\.toFixed\(2\)\}/);
  assert.doesNotMatch(cardSource, /totalNormalized\.toFixed\(2\)/);
});

test('order-card amount formats locale-aware: Greek "18,50 €", not "€18.50"', () => {
  const el = eur(18.5, 'el-GR');
  assert.match(el, /18,50/); // comma decimal separator
  assert.ok(el.includes('€'));
  assert.notEqual(el, '€18.50'); // not the old hardcoded English-style value
  // English stays English-style.
  assert.equal(eur(18.5, 'en-US'), '€18.50');
});

// Round 213 → 218 (founder screenshot, supervisor review): the live Dashboard pickup order-row icon was
// boxed in a green badge by round 213, but the supervisor confirmed on the running POS that the filled
// green chip still reads as a separate boxed treatment. It must now match the standalone OrdersPage row
// (round 218): the shared PickupOrderIcon rendered as a PLAIN bag at row scale (w-6 h-6) with a
// theme-aware semantic green stroke and no holder. The shared glyph is preserved (never a raw
// ShoppingBag, never a Store/Package/storefront), and delivery + table icons stay unchanged.
test('OrderCard pickup row icon is the shared plain bag at row scale, no green badge (matches OrdersPage)', () => {
  // Shared component (not a storefront / inline glyph) -- same source the chooser uses.
  assert.match(cardSource, /import PickupOrderIcon from '\.\.\/icons\/PickupOrderIcon';/);
  assert.match(cardSource, /import TableOrderIcon from '\.\.\/icons\/TableOrderIcon';/);

  // Pickup branch: the shared PickupOrderIcon as a PLAIN bag at row scale (w-6 h-6, matching the sibling
  // delivery/table icons) with a theme-aware semantic green stroke (light text-green-600 / dark
  // text-green-400) and stroke weight 2 -- no wrapper.
  assert.match(
    cardSource,
    /<PickupOrderIcon\s+className=\{`w-6 h-6 \$\{resolvedTheme === 'light' \? 'text-green-600' : 'text-green-400'\}`\}\s+strokeWidth=\{2\}\s*\/>/,
  );

  // The boxed green badge/holder treatment (round 213) must be gone: no green chip, no rounded chip, and
  // the bag is never forced white-on-green any more.
  assert.doesNotMatch(cardSource, /<span className="inline-flex h-7 w-7 items-center justify-center rounded-\[10px\] bg-green-600">/);
  assert.doesNotMatch(cardSource, /<PickupOrderIcon className="w-4 h-4 text-white" strokeWidth=\{2\} \/>/);
  // The row must not render a Store/Package/storefront glyph or a raw ShoppingBag anywhere.
  assert.doesNotMatch(cardSource, /<Store|<Package|<Storefront/);
  assert.doesNotMatch(cardSource, /<ShoppingBag/);

  // Table/delivery logic unchanged: the table row icon keeps its own treatment (strokeWidth 1.6).
  assert.match(
    cardSource,
    /<TableOrderIcon\s+className=\{`w-6 h-6 \$\{resolvedTheme === 'light' \? 'text-gray-700' : 'text-gray-300'\}`\}\s+strokeWidth=\{1\.6\}\s*\/>/,
  );
});

// Round 173 (touch-first): the delivery "Get Directions" affordance is a clickable div that used a
// native title= tooltip; on a touchscreen it must expose its label/disabled-reason via aria-label
// and announce itself as a (possibly disabled) button. OrderCard renders no modal title props, so
// no native title= should remain anywhere in the file.
test('OrderCard delivery directions affordance uses aria-label/role, not a native title tooltip', () => {
  assert.doesNotMatch(cardSource, /\btitle=/);
  assert.match(cardSource, /role="button"/);
  assert.match(
    cardSource,
    /aria-label=\{isEnabled \? \(t\('orderCard\.getDirections'\) \|\| 'Get Directions'\) : disabledReason\}/,
  );
  assert.match(cardSource, /aria-disabled=\{!isEnabled\}/);
});

// Round 343 (live QA, delivered/history tab): a completed pickup row showed a huge red elapsed timer
// ("4570λ") plus an age-based red left edge -- it read like a broken urgency counter. Terminal rows
// (completed / delivered / cancelled / canceled) must show a calm timestamp instead of the live
// elapsed-minute timer, and must not use age-based red/amber left-edge coloring. Active rows keep both.
test('Round 343: terminal rows show a calm timestamp, never the age-based elapsed timer', () => {
  // Terminal detection covers completed/delivered + both cancelled spellings.
  assert.match(cardSource, /const isTerminalOrder = isDeliveredOrCompleted \|\| isCancelledTerminal/);
  assert.match(cardSource, /const isCancelledTerminal = isCancelled \|\| isCanceled/);

  // The time display is a ternary: terminal -> calm timestamp label, active -> live elapsed minutes.
  assert.match(
    cardSource,
    /\{isTerminalOrder \? \(\s*<span[\s\S]*?terminalTimestampLabel[\s\S]*?\) : \(\s*<span[\s\S]*?orders\.time\.minutes[\s\S]*?getElapsedMinutes\(order\.created_at[\s\S]*?\)\}/,
    'time display must branch terminal->timestamp vs active->elapsed minutes',
  );

  // Scope to the terminal branch: it must NOT render the elapsed timer, the minutes key, or the age color.
  const tStart = cardSource.indexOf('{isTerminalOrder ? (');
  assert.notEqual(tStart, -1, 'the terminal time-display branch must exist');
  const tElse = cardSource.indexOf(') : (', tStart);
  assert.notEqual(tElse, -1, 'the time-display ternary must have an active branch');
  const terminalBranch = cardSource.slice(tStart, tElse);
  assert.doesNotMatch(terminalBranch, /getElapsedMinutes/, 'terminal row must not compute elapsed minutes');
  assert.doesNotMatch(terminalBranch, /orders\.time\.minutes/, 'terminal row must not render the minutes timer key');
  assert.doesNotMatch(terminalBranch, /getTimeColorClass/, 'terminal timestamp must not use the age-based color');
  assert.match(terminalBranch, /terminalTimestampLabel/);
  assert.match(terminalBranch, /capitalize/, 'terminal timestamp verb is display-capitalized');

  // The active branch keeps the existing live timer + urgency color.
  const activeBranch = cardSource.slice(tElse, cardSource.indexOf('<OrderRoutingBadge', tElse));
  assert.match(activeBranch, /orders\.time\.minutes/);
  assert.match(activeBranch, /getElapsedMinutes\(order\.created_at/);
  assert.match(activeBranch, /getTimeColorClass\(order\.created_at/);
});

test('Round 343: terminal rows do not use the age-based left edge; active rows still do', () => {
  // The left-edge color is computed via a guarded const: terminal -> neutral/semantic, else -> getLeftEdgeColor.
  assert.match(cardSource, /const leftEdgeColorClass = isTerminalOrder/);
  assert.match(
    cardSource,
    /leftEdgeColorClass = isTerminalOrder[\s\S]{0,180}: getLeftEdgeColor\(orderCreatedAt\)/,
    'getLeftEdgeColor (age-based) must only be the ACTIVE branch of leftEdgeColorClass',
  );
  // Cancelled keeps a calm semantic red edge (status-based), completed/delivered a neutral edge -- not age-based.
  assert.match(cardSource, /isCancelledTerminal \? 'border-l-red-400\/50' : 'border-l-white\/30'/);

  // The row className uses the guarded class, not a direct age-based getLeftEdgeColor call anymore.
  assert.match(cardSource, /border-l-4 \$\{deliveryOlderThan40 \? 'border-l-red-500' : leftEdgeColorClass\}/);
  assert.doesNotMatch(
    cardSource,
    /border-l-4 \$\{deliveryOlderThan40 \? 'border-l-red-500' : getLeftEdgeColor\(orderCreatedAt\)\}/,
    'the row edge must no longer call getLeftEdgeColor directly (age-based) for every order',
  );
});

test('Round 343: terminal timestamp prefers terminal/most-recent fields, falling back to created_at', () => {
  assert.match(
    cardSource,
    /completed_at[\s\S]*?delivered_at[\s\S]*?cancelled_at[\s\S]*?canceled_at[\s\S]*?updated_at[\s\S]*?order\.created_at \|\| order\.createdAt \|\| null/,
    'terminal timestamp must prefer completed/delivered/cancelled/updated, then fall back to created_at',
  );
  // The calm timestamp reuses the existing localized status label (no new raw English literal in the JSX).
  assert.match(cardSource, /t\(`orders\.status\.\$\{terminalStatusKey\}`/);
});
