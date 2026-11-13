import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// UI audit 30/10/2026: motion is short, shared and optional. Founder rule: checkout
// never freezes, so no sale, payment or print may wait for an animation to finish.
const projectRoot = process.cwd();
const rendererRoot = path.join(projectRoot, 'src', 'renderer');
const read = (...parts: string[]) => readFileSync(path.join(rendererRoot, ...parts), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

test('every screen follows the Windows "reduce motion" setting through one MotionConfig', () => {
  const app = read('App.tsx');
  const configs = app.match(/<MotionConfig reducedMotion="user">/g) || [];
  // The POS tree and the connected customer/kitchen display tree.
  assert.equal(configs.length, 2);
});

test('shared motion tokens and classes exist and switch off under reduced motion', () => {
  const css = read('styles', 'glassmorphism.css');
  // Subtle on a till: every shared duration stays within 150-250 ms.
  const tokens = [...css.matchAll(/--pos-motion-(fast|base|slow): (\d+)ms;/g)].map(m => Number(m[2]));
  assert.deepEqual(tokens, [150, 180, 240]);
  for (const ms of tokens) assert.ok(ms >= 150 && ms <= 250, `${ms} ms is outside 150-250 ms`);
  // Ease-out only: no overshoot (a bezier y above 1) and no infinite loops in the motion block.
  const block = css.slice(css.indexOf('Motion (UI audit 30/10/2026)'));
  assert.doesNotMatch(block, /cubic-bezier\([^)]*,\s*1\.[1-9]/);
  assert.doesNotMatch(block, /infinite/);
  assert.match(css, /\.pos-enter \{\s*animation: pos-enter var\(--pos-motion-base\)/);
  assert.match(css, /\.pos-enter-stagger > \*:nth-child\(n \+ 8\) \{ animation-delay: 210ms; \}/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pos-enter,\s*\.pos-enter-stagger > \*,\s*\.pos-saved,\s*\.pos-value \{\s*animation: none !important;/,
  );
  // Modal buttons animate only what changes, on the fast token.
  assert.doesNotMatch(css, /transition: all 0\.3s cubic-bezier\(0\.4, 0, 0\.2, 1\);\n  min-height: 44px;/);
  assert.match(css, /transition-property: transform, background-color, border-color, color, box-shadow;/);
});

test('no screen waits for an animation to finish before acting (checkout never freezes)', () => {
  const offenders = walk(rendererRoot)
    .filter(file => !file.endsWith(path.join('components', 'ui', 'pos-glass-components.tsx')))
    .filter(file => /onAnimationComplete|onExitComplete|onAnimationEnd/.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(rendererRoot, file));
  assert.deepEqual(offenders, [], 'only the modal shell may listen for animation end, and it has a fallback');

  // The modal shell's own close always settles within a bounded time.
  const glass = read('components', 'ui', 'pos-glass-components.tsx');
  assert.match(glass, /const MODAL_EXIT_FALLBACK_MS = 260/);
});

// The order, payment and print paths: motion there is CSS or a framer layout slide, and
// nothing in them may hold content back until an exit animation ends.
const SALE_PATH = [
  'components/OrderFlow.tsx',
  'components/OrderGrid.tsx',
  'components/OrderTabsBar.tsx',
  'components/order',
  'components/menu',
  'components/ecr/PaymentDialog.tsx',
  'components/printing',
  'components/modals/PaymentModal.tsx',
  'components/modals/SplitPaymentModal.tsx',
  'components/modals/SinglePaymentCollectionModal.tsx',
  'components/modals/OutstandingPaymentMethodModal.tsx',
  'components/modals/EditPaymentMethodModal.tsx',
  'components/modals/TipModal.tsx',
];
const salePathFiles = () =>
  walk(rendererRoot).filter(file => {
    const rel = path.relative(rendererRoot, file).split(path.sep).join('/');
    return SALE_PATH.some(entry => rel === entry || rel.startsWith(`${entry}/`));
  });

test('the order, payment and print paths never wait for an exit animation', () => {
  const files = salePathFiles();
  assert.ok(files.length > 20, 'the sale-path list still points at real files');
  const waiting = files
    .filter(file => /<AnimatePresence[^>]*mode="wait"|\.finished\b/.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(rendererRoot, file));
  assert.deepEqual(waiting, [], 'AnimatePresence mode="wait" or an awaited animation would delay the next screen');
});

test('wave 5 motion on the sale path is CSS or a layout slide, with no timer and the same handlers', () => {
  // Totals cross-fade by remounting a span keyed by its value: no effect, no timer.
  const changing = read('components', 'ui', 'ChangingValue.tsx');
  assert.match(changing, /<span key=\{String\(value\)\} className=/);
  assert.doesNotMatch(changing, /useEffect|setTimeout|requestAnimationFrame|useState/);
  const payment = read('components', 'modals', 'PaymentModal.tsx');
  assert.match(payment, /<ChangingValue value=\{formatCurrency\(payableTotal\)\} \/>/);
  assert.match(payment, /<ChangingValue value=\{hasEnoughCash \? formatCurrency\(changeAmount\) : formatCurrency\(amountShort\)\} \/>/);
  const cart = read('components', 'menu', 'MenuCart.tsx');
  assert.match(cart, /value=\{formatCurrency\(totalWithDeliveryFee\)\}/);
  // founder 11/11/2026: quantity taps keep lines still; conditional blocks reveal with reduced-motion support.
  assert.match(cart, /className=\{`p-3 rounded-xl border transition-colors/);
  assert.doesNotMatch(cart, /className=\{`pos-enter p-3|<motion\.div[^>]*key=\{item\.id\}/);
  assert.match(cart, /<motion\.div key="cart-empty" \{\.\.\.revealMotion\}/);
  assert.match(cart, /const reduceMotion = useReducedMotion\(\)/);

  // Order tabs: the selected background slides with a layoutId; the tab still changes on the press.
  const tabs = read('components', 'OrderTabsBar.tsx');
  assert.match(tabs, /layoutId="order-tabs-indicator"/);
  assert.match(tabs, /transition=\{\{ duration: 0\.18, ease: \[0\.2, 0\.8, 0\.2, 1\] \}\}/);
  assert.match(tabs, /onClick=\{\(\) => handleTabChange\(tab\.id\)\}/);

  // New order cards fade in through a wrapper; the card's own click is untouched.
  const grid = read('components', 'OrderGrid.tsx');
  assert.match(grid, /<div key=\{order\.id\} className="pos-enter">\s*<OrderCard/);

  for (const source of [changing, tabs, grid]) assert.doesNotMatch(source, /setTimeout|requestAnimationFrame/);

  // No hover on the touch tills: see the dedicated test below.

  // One press language: a pressed control shrinks; none grows (checkout used active:scale-[1.02]).
  const growing = walk(rendererRoot)
    .filter(file => /active:scale-(\[1\.\d+\]|1(0[1-9]|[1-9]\d))/.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(rendererRoot, file));
  assert.deepEqual(growing, []);
  assert.match(cart, /'bg-yellow-400 text-black active:bg-yellow-300 active:scale-\[0\.97\]'/);
});

// Founder 31/10: a selected order in the dashboard list settles slightly smaller (it grew and the scrolling
// list cut it), and the selection actions bar opens like iOS: a critically damped spring (no overshoot)
// that glides the height open so the list below moves smoothly. No handler waits for it.
test('founder 31/10: selected orders shrink, never grow; the actions bar opens on an iOS spring', () => {
  const card = read('components', 'order', 'OrderCard.tsx');
  assert.match(card, /isSelected \? 'ring-2 ring-inset ring-\(--pos-s-sel-bg\) scale-\[0\.98\]'/);
  assert.doesNotMatch(card, /isSelected \? '[^']*scale-(?:\[1\.\d+\]|1(?:0[1-9]|[1-9]\d))/);
  const bar = read('components', 'BulkActionsBar.tsx');
  assert.match(bar, /const IOS_SPRING = \{ type: 'spring', duration: 0\.38, bounce: 0 \} as const;/);
  assert.match(bar, /<AnimatePresence initial=\{false\}>\s*\{selectedCount > 0 && \(/);
  assert.match(bar, /initial=\{\{ height: 0, opacity: 0, overflow: 'hidden' \}\}/);
  assert.match(bar, /exit=\{\{ height: 0, opacity: 0, overflow: 'hidden', pointerEvents: 'none' \}\}/);
  assert.doesNotMatch(bar, /onAnimationComplete|onExitComplete/);
  // Founder 31/10 «το πλαίσιο δεν είναι ισομετρικό»: an invisible, never-used progress strip (mt-3 h-1,
  // opacity 0) added 16 px under the buttons only. The bar's padding is now the same on every side.
  assert.doesNotMatch(bar, /opacity-0|Progress indicator/);
});

test('no hover anywhere: the tills are touch screens (founder 30/10/2026)', () => {
  // A tapped control keeps :hover until the next tap elsewhere, which is worse than nothing.
  const rel = (file: string) => path.relative(rendererRoot, file).split(path.sep).join('/');
  const sources = walk(rendererRoot);
  const hoverClasses = sources.filter(file => /hover:[a-z[]/.test(readFileSync(file, 'utf8'))).map(rel);
  assert.deepEqual(hoverClasses, [], 'no hover: / group-hover: / dark:hover: classes');
  // No framer hover motion, no JS hover styling, no hover feature detection. The one mouse
  // listener left is MenuCategoryTabs' onMouseLeave, which ends a mouse drag-to-scroll.
  const hoverScript = sources
    .filter(file => /whileHover|onHoverStart|onHoverEnd|onMouseEnter|onMouseOver|\(hover: hover\)/.test(readFileSync(file, 'utf8')))
    .map(rel);
  assert.deepEqual(hoverScript, []);

  const cssFiles: string[] = [];
  (function walkCss(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walkCss(full);
      else if (name.endsWith('.css')) cssFiles.push(full);
    }
  })(path.join(projectRoot, 'src'));
  assert.ok(cssFiles.length >= 5, 'the stylesheet scan still finds the renderer CSS');
  const hoverCss = cssFiles
    .filter(file => /:hover\b|\(\s*hover\s*:\s*hover\s*\)/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
    .map(file => path.relative(projectRoot, file));
  assert.deepEqual(hoverCss, [], 'no :hover rule or hover media query in any stylesheet');

  // Both Tailwind entries turn the hover: variant off, so even a stray class never matches.
  for (const entry of [path.join(projectRoot, 'src', 'index.css'), path.join(rendererRoot, 'styles', 'globals.css')]) {
    assert.match(readFileSync(entry, 'utf8'), /\n@custom-variant hover \(&:not\(\*\)\);\n/);
  }
});

test('every control gets press and focus feedback from one shared rule', () => {
  const css = read('styles', 'glassmorphism.css');
  const base = css.slice(css.lastIndexOf('/*', css.indexOf('Press and focus feedback for every control')));
  const rules = base.replace(/\/\*[\s\S]*?\*\//g, '');
  // In the base layer, so a control's own Tailwind active:/focus: classes win.
  assert.match(base, /^[\s\S]*?\*\/\n@layer base \{/);
  assert.match(base, /:where\(button, \[role='button'\], \[role='tab'\], \[role='switch'\]/);
  assert.match(base, /:not\(:disabled, \[aria-disabled='true'\], \[data-press='off'\], \[draggable='true'\]/);
  assert.match(
    base,
    /\):active,\s*\/\*[\s\S]*?\*\/\s*:where\([^)]*\)\[data-pressed\]:not\(:active, :disabled, [^{]*\) \{\s*scale: 0\.97;\s*filter: brightness\(0\.94\);/,
  );
  // WebView2 sets :active on touch only at release, so touch-down marks the control instead:
  // passive listeners, no preventDefault, installed once at startup.
  const press = read('utils', 'press-feedback.ts');
  assert.match(press, /const options = \{ capture: true, passive: true \} as const;/);
  assert.doesNotMatch(press, /preventDefault\(|stopPropagation\(/);
  const entry = readFileSync(path.join(projectRoot, 'src', 'main.tsx'), 'utf8');
  assert.match(entry, /await import\('\.\/renderer\/utils\/press-feedback'\);\s*installTouchPressFeedback\(\);/);
  assert.match(base, /transition-duration: var\(--pos-motion-fast, 150ms\);/);
  // Press shows on touch: a tap answers at once (the global tap highlight is already transparent).
  assert.match(base, /summary\) \{\s*touch-action: manipulation;/);
  assert.match(read('styles', 'globals.css'), /-webkit-tap-highlight-color: transparent;/);
  // Touch tills (founder 30/10/2026): no hover effects, because a tapped control keeps :hover.
  assert.doesNotMatch(rules, /:hover|\(hover: hover\)/);
  assert.match(base, /:focus-visible \{\s*outline: 2px solid var\(--pos-focus-ring, #b45309\);/);
  // Reduce motion: a press still changes colour, but nothing scales anywhere.
  assert.match(base, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?:active,\s*\[data-pressed\] \{\s*scale: none !important;/);
  assert.match(base, /\.liquid-glass-modal-button:active,[\s\S]*?\{\s*transform: none !important;/);

  // Modals enter and leave on the shared tokens.
  for (const name of ['backdropEnter', 'liquidModalEnter', 'liquidModalExit', 'backdropExit']) {
    assert.match(css, new RegExp(`animation: ${name} var\\(--pos-motion-base, 180ms\\) var\\(--pos-ease`));
  }
});

test('page changes use the same short timings and swap at once under reduce motion', () => {
  const tokens = read('components', 'ui', 'page-motion.ts');
  assert.match(tokens, /export const pageMotionEase = \[0\.2, 0\.8, 0\.2, 1\] as const;/);
  assert.match(tokens, /POS_MOTION_FAST_S = 0\.15;[\s\S]*POS_MOTION_BASE_S = 0\.18;[\s\S]*POS_MOTION_SLOW_S = 0\.24;/);
  assert.match(tokens, /POS_MOTION_STAGGER_MAX_S = 0\.21;/);
  const page = read('components', 'ui', 'PageLoadMotion.tsx');
  assert.match(page, /\.slice\(0, 8\)/);
  assert.match(page, /animate: \{ opacity: 1, transition: \{ duration: 0 \} \}/);
  assert.match(page, /exit: \{ opacity: 0, transition: \{ duration: 0 \} \}/);
  assert.doesNotMatch(page, /duration: 0\.3[0-9]/);
});

test('settings sections, printer views and wizard steps use the shared enter motion', () => {
  assert.match(read('components', 'modals', 'ConnectionSettingsModal.tsx'), /key=\{activeSettingsSection\} className="pos-enter /);
  const printer = read('components', 'modals', 'PrinterSettingsModal.tsx');
  assert.match(printer, /<div key=\{viewMode\} className="pos-enter p-6">/);
  assert.match(printer, /className="pos-enter-stagger"/);
  assert.match(read('components', 'modals', 'PrinterSetupWizard.tsx'), /<div key=\{currentStep\} className="pos-enter">/);
  assert.match(read('components', 'ui', 'pos-glass-components.tsx'), /duration-200 ease-\[cubic-bezier\(0\.2,0\.8,0\.2,1\)\]/);
});
