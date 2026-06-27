import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Round 289 (Director task, live QA Greek/light): PaymentTerminalsPage.tsx -- the standalone + embedded
// "Card machines" page, distinct from the already-cleaned PaymentTerminalsSection settings embed (Round
// 229) -- still carried pre-palette chrome: blue Discover/Test controls, a black/white inverted Refresh,
// native DOM title= tooltips, hover-only effects, and flat grey/white cards. This guards the touch-first
// palette cleanup: no title=, no hover, amber-glass Discover+Refresh, semantic-green Add, neutral Test,
// and rounded translucent glass panels. IPC/data behaviour is unchanged.

const projectRoot = process.cwd();
const source = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'pages', 'PaymentTerminalsPage.tsx'),
  'utf8',
);

// Slice a single <button> from a marker inside its body back to its opening <button> and forward to
// </button>, so a per-button palette/aria assertion never bleeds into a neighbouring control.
function sliceButton(text: string, marker: string): string {
  const idx = text.indexOf(marker);
  assert.notEqual(idx, -1, `expected to find "${marker}"`);
  const start = text.lastIndexOf('<button', idx);
  assert.notEqual(start, -1, `expected <button before "${marker}"`);
  const end = text.indexOf('</button>', idx);
  assert.notEqual(end, -1, `expected </button> after "${marker}"`);
  return text.slice(start, end + '</button>'.length);
}

test('Round 289: PaymentTerminalsPage is touch-first -- no native title tooltips, no hover utilities', () => {
  // The five native title= tooltips (refresh / discover / add / empty-discover / test) are gone, and there
  // are no component-prop title= in this file either (the ECR modals are separate components).
  assert.doesNotMatch(source, /\btitle=/);
  // No hover-only behaviour on a touchscreen POS.
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /dark:hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  // The old transition-colors-only animation is replaced by transition-all + active: feedback.
  assert.doesNotMatch(source, /transition-colors/);
});

test('Round 289: blue controls are re-themed to the POS palette (no blue/indigo/violet/cyan/sky/purple/slate)', () => {
  assert.doesNotMatch(source, /\b(?:bg|text|border|from|to|ring)-(?:blue|indigo|violet|cyan|sky|purple|slate)-/);
  // The loading spinner is amber, not blue.
  assert.match(source, /Loader2[\s\S]*?text-amber-400[\s\S]*?text-amber-500/);
});

test('Round 289: Refresh is an amber-glass icon button with an accessible name + active feedback', () => {
  const btn = sliceButton(source, 'onClick={handleRefresh}');
  // The shared amber-glass icon-button pattern (both themes), 44-48px, active press, neutral loading.
  assert.match(btn, /h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all/);
  assert.match(btn, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(btn, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.match(btn, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.match(btn, /\$\{isRefreshing \? 'opacity-60 cursor-not-allowed' : 'active:scale-95'\}/);
  // The old black/white inversion (and its shadow) are gone.
  assert.doesNotMatch(btn, /bg-white text-black|bg-black text-white|shadow-sm/);
  // Handler + disabled gating + spinner icon preserved.
  assert.match(btn, /disabled=\{isRefreshing\}/);
  assert.match(btn, /<RefreshCw/);
});

test('Round 289: Discover (header + empty state) is amber glass; disabled-reason folds into aria-label', () => {
  const header = sliceButton(source, "{t('ecr.discover', 'Discover')}");
  assert.match(header, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(header, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.match(header, /active:scale-95/);
  // Disabled-reason exposed as an aria-label only when actually disabled (no native title tooltip).
  assert.match(
    header,
    /aria-label=\{discoverAction\.disabled && discoverAction\.message \? discoverAction\.message : undefined\}/,
  );
  assert.match(header, /disabled=\{discoverAction\.disabled\}/);

  const empty = sliceButton(source, "{t('ecr.discoverTerminals', 'Discover Terminals')}");
  assert.match(empty, /border border-amber-400\/30 bg-amber-500\/15/);
  assert.match(empty, /border border-amber-400\/40 bg-amber-50/);
  assert.match(
    empty,
    /aria-label=\{discoverAction\.disabled && discoverAction\.message \? discoverAction\.message : undefined\}/,
  );
});

test('Round 289: Add Terminal is semantic green primary; Test is neutral glass (palette is not all-yellow)', () => {
  const add = sliceButton(source, "{t('ecr.addManual', 'Add Terminal')}");
  assert.match(add, /border border-green-500 bg-green-600 active:bg-green-700/);
  assert.match(add, /text-white/);
  assert.match(add, /active:scale-95/);
  // Behaviour preserved: Add stays gated on discoverAction.disabled exactly as before.
  assert.match(add, /disabled=\{discoverAction\.disabled\}/);
  // It is green, not amber/yellow (so the header is not a wall of yellow).
  assert.doesNotMatch(add, /bg-amber|bg-yellow/);

  const testBtn = sliceButton(source, "{t('ecr.testPayment.button'");
  // Neutral zinc glass (secondary per-device utility) -- amber stays reserved for discover/refresh.
  assert.match(testBtn, /border border-white\/10 bg-white\/5 text-zinc-200 active:bg-white\/10/);
  assert.match(testBtn, /border border-black\/10 bg-white\/70 text-zinc-700 active:bg-black\/5/);
  // Connected-only + offline gating preserved.
  assert.match(
    testBtn,
    /disabled=\{statuses\[device\.id\]\?\.state !== 'connected' \|\| testAction\.disabled\}/,
  );
  assert.doesNotMatch(testBtn, /bg-amber|bg-yellow|bg-green/);
});

test('Round 289: stats cards, empty state, and test-payment panel are rounded translucent glass (not flat grey boxes)', () => {
  // StatsCard + Test Payment panel: rounded-2xl translucent glass with subtle border + backdrop blur.
  const glass2xl = source.match(/rounded-2xl border backdrop-blur-sm/g) || [];
  assert.ok(glass2xl.length >= 2, 'StatsCard + test-payment panel should both use rounded-2xl glass');
  // Empty state: even smoother rounded-3xl glass.
  assert.match(source, /rounded-3xl border backdrop-blur-sm/);
  // Theme-safe translucent surfaces (no flat bg-white / bg-gray-800/50 admin boxes on these panels).
  assert.match(source, /border-white\/10 bg-white\/5/);
  assert.match(source, /border-black\/5 bg-white\/70/);
  // The old flat panel backgrounds are gone from this file.
  assert.doesNotMatch(source, /rounded-xl \$\{isDark \? 'bg-gray-800\/50' : 'bg-white'\}/);
  // The stat icon wrapper is rounded-xl (smoother than the old rounded-lg).
  assert.match(source, /w-10 h-10 rounded-xl flex items-center justify-center/);
  // Status semantics preserved: connected green, disconnected neutral grey, error red.
  assert.match(source, /color="#22c55e"/);
  assert.match(source, /color="#6b7280"/);
  assert.match(source, /color="#ef4444"/);
});

test('Round 433: PaymentTerminalsPage online status pill uses smooth touch radius', () => {
  assert.match(source, /className=\{`flex items-center gap-2 px-3 py-1\.5 rounded-2xl \$\{/);
  assert.doesNotMatch(source, /rounded-lg/);
});

test('Round 289: data/IPC behaviour and the ECR modal wiring are unchanged (UI-only round)', () => {
  assert.match(source, /onClick=\{handleRefresh\}/);
  assert.match(source, /onConnect=\{\(\) => handleConnect\(device\.id\)\}/);
  assert.match(source, /onDisconnect=\{\(\) => handleDisconnect\(device\.id\)\}/);
  assert.match(source, /onDelete=\{\(\) => handleDelete\(device\.id\)\}/);
  assert.match(source, /onSetDefault=\{\(\) => handleSetDefault\(device\.id\)\}/);
  assert.match(source, /<TerminalDiscoveryModal/);
  assert.match(source, /<TerminalConfigModal/);
  assert.match(source, /<PaymentDialog/);
  assert.match(source, /processPayment=\{\(amount: number\) =>/);
});

test('Round 289: the TerminalConfigModal footer/switch contract from earlier rounds still holds', () => {
  // Point 5: preserve the good modal behaviour (red Cancel, green Add/Save, green glass switch, footer
  // clearance). Re-asserts the modal contract; also guarded by Round 228 (terminal-card-tooltip-ui.test.ts)
  // and Round 294 below, which widened the modal and increased the footer clearance.
  const config = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'ecr', 'TerminalConfigModal.tsx'),
    'utf8',
  );
  assert.match(config, /onClick=\{onClose\}[\s\S]*?bg-red-500\/10 active:bg-red-500\/20[\s\S]*?text-red-600/);
  assert.match(config, /type="submit"[\s\S]*?bg-green-600 active:bg-green-700 text-white[\s\S]*?disabled:opacity-50/);
  // Round 295: the green ECR switch is now the shared POSGlassSwitch (no local peer/pseudo class).
  assert.match(config, /<POSGlassSwitch\b/);
  assert.doesNotMatch(config, /peer-checked:/);
  // Round 294: the form body is compact (space-y-4) and reserves a large footer clearance (pb-28); the old
  // too-small pb-6 is gone.
  assert.match(config, /<form id="terminal-config-form"[\s\S]*?className="space-y-4 pb-28"/);
  assert.doesNotMatch(config, /hover:/);
});

// --- Round 294 (live QA, Greek/light, 1282x802): Settings > Card Machines > Configure > Add Terminal --
// the pinned glass footer (Cancel / Add) overlapped the lower Settings section on FIRST open: the label
// "Χρονικό Όριο Συναλλαγής" (Transaction Timeout) was cut behind the footer before scrolling.
// Three iterations: (1) pb-6 -> pb-28 FAILED live QA -- more bottom padding helped scrolling but not the
// first-open overlap. (2) Removing the forced-narrow className="!max-w-lg" (so size="md" drives max-w-2xl)
// stopped the Greek title wrapping to two lines, but live QA PARTIAL FAIL: the label showed yet the first
// Transaction Timeout INPUT was still clipped by the footer on first open. (3) Final: compact the form
// vertical stack space-y-6 -> space-y-4 so the first Settings field (label + input) clears the footer at
// 1282x802 on first open. The wider modal (no !max-w-lg, size="md") and pb-28 are kept; touch targets are
// unchanged. Footer contract (red Cancel / green Add-Save / green switch / handlers) + glass shell unchanged.

test('Round 294: TerminalConfigModal is not forced narrow and keeps substantial footer clearance (last fields never hidden)', () => {
  const config = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'ecr', 'TerminalConfigModal.tsx'),
    'utf8',
  );

  // Width: the modal is no longer forced to the narrow !max-w-lg cap; size="md" drives the standard width
  // (max-w-2xl in LiquidGlassModal) so the Greek title fits on one line and two-column fields breathe.
  assert.doesNotMatch(config, /!max-w-lg/, 'the forced-narrow !max-w-lg override must be gone');
  assert.match(config, /size="md"/, 'the modal should use the standard size="md" width');

  // The form body is compact (space-y-4) AND reserves a large bottom padding (>= pb-24) to clear the
  // pinned footer. The compact stack is what lets the FIRST Settings field clear the footer on first open
  // (the wider modal + pb-28 alone still clipped the Transaction Timeout input -- third Round 294 finding).
  const formMatch = config.match(/<form id="terminal-config-form"[^>]*className="space-y-4 (pb-\d+)"/);
  assert.ok(formMatch, 'the config form must declare the compact space-y-4 + a pb-N bottom clearance');
  const pb = Number(formMatch![1].replace('pb-', ''));
  assert.ok(pb >= 24, `the form bottom padding must be >= pb-24 to clear the sticky footer (got ${formMatch![1]})`);
  // The old looser space-y-6 stack and the too-small pb-6 are both gone.
  assert.doesNotMatch(config, /<form id="terminal-config-form"[^>]*space-y-6/);
  assert.doesNotMatch(config, /<form id="terminal-config-form"[\s\S]*?space-y-6 pb-6"/);

  // Footer contract preserved: red Cancel (close-only) + green submit (Add/Save) bound to the form, handlers intact.
  assert.match(config, /onClick=\{onClose\}[\s\S]*?bg-red-500\/10 active:bg-red-500\/20[\s\S]*?text-red-600/);
  assert.match(config, /type="submit"\s+form="terminal-config-form"[\s\S]*?bg-green-600 active:bg-green-700 text-white[\s\S]*?disabled:opacity-50/);
  // The sticky glass footer shelf is intact (Round 352: shelf holds the glass; buttons in an inner row).
  assert.match(config, /px-8 py-4 border-t[\s\S]*?backdrop-blur-xl[\s\S]*?<div className="flex justify-end gap-3">/);

  // Touch-first + palette: no hover, no off-theme colour, and the ONLY title= is the LiquidGlassModal
  // heading PROP (a visible heading, not a native tooltip) -- so no native tooltip crept in.
  assert.doesNotMatch(config, /hover:/);
  assert.doesNotMatch(config, /\b(?:bg|text|border|from|to|ring)-(?:blue|indigo|violet|cyan|sky|purple|slate)-/);
  const titleAttrs = config.match(/\btitle=/g) || [];
  assert.equal(titleAttrs.length, 1, 'only the LiquidGlassModal heading title prop may exist (no native tooltips)');
});

// Round 352 (live QA, Settings > Card Machines > Add Terminal): the green Add button was active while required
// fields were empty -- the cashier could tap Add and only then get a toast. The primary action is now disabled
// until the required VISIBLE fields are valid (name + the connection field for the current connection type), and
// a calm localized inline hint explains what is missing. handleSubmit keeps its toasts as a safety fallback.
test('Round 352: Add/Save is disabled until required visible fields are valid, with a localized inline hint', () => {
  const config = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'ecr', 'TerminalConfigModal.tsx'),
    'utf8',
  );

  // Required-fields flag = name + the connection field for the CURRENT connection type (bluetooth/serial_usb/network).
  assert.match(
    config,
    /const requiredConnectionField =[\s\S]*?connectionType === 'bluetooth'[\s\S]*?btAddress[\s\S]*?serial_usb[\s\S]*?serialPort[\s\S]*?networkIp/,
  );
  assert.match(
    config,
    /const requiredFieldsComplete = name\.trim\(\)\.length > 0 && requiredConnectionField\.trim\(\)\.length > 0/,
  );

  // The submit button is gated by isSaving AND the valid-required flag (not isSaving alone).
  assert.match(config, /type="submit"[\s\S]*?disabled=\{isSaving \|\| !requiredFieldsComplete\}/);
  assert.doesNotMatch(config, /disabled=\{isSaving\}/, 'submit must not be gated by isSaving alone anymore');

  // handleSubmit validation/toasts remain as a safety fallback.
  assert.match(config, /if \(!name\.trim\(\)\) \{[\s\S]*?ecr\.config\.nameRequired/);

  // A localized inline hint (not a native title tooltip) renders ONLY while incomplete + idle, on-palette amber.
  assert.match(config, /\{!requiredFieldsComplete && !isSaving && \(/);
  assert.match(config, /data-terminal-required-hint/);
  assert.match(config, /t\('ecr\.config\.missingRequired'/);
  assert.match(config, /data-terminal-required-hint[\s\S]*?text-amber-700 dark:text-amber-300/);

  // The new hint key exists, is non-empty, and is a real translation in every POS locale (el is Greek, != en).
  const loadLocale = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', `${lng}.json`), 'utf8'));
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const v = loadLocale(lng)?.ecr?.config?.missingRequired;
    assert.equal(typeof v, 'string', `${lng} missing ecr.config.missingRequired`);
    assert.ok((v as string).length > 0, `${lng} empty ecr.config.missingRequired`);
  }
  const enHint = loadLocale('en').ecr.config.missingRequired;
  const elHint = loadLocale('el').ecr.config.missingRequired;
  assert.notEqual(elHint, enHint, 'el ecr.config.missingRequired must be a Greek translation');
  assert.match(elHint, /[Ͱ-Ͽ]/, 'el ecr.config.missingRequired must contain Greek letters');
});
