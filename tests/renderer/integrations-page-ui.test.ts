import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'IntegrationsPage.tsx'),
  'utf8',
);

// Round 286 (live QA, Greek/light): the IntegrationsPage header refresh button was a stark solid-black
// square in light mode, and several touch controls (logo, configure, toggle, refresh) carried native DOM
// title= tooltips -- the a11y tree reported a duplicated "Description" on this touchscreen POS. The
// refresh now uses the shared amber-glass icon-button pattern, and the native titles are replaced by
// aria-label. The LiquidGlassModal `title` PROPS are component headings (not DOM tooltips) and must stay.

test('Round 286: IntegrationsPage refresh is the shared amber-glass icon button (not a solid black/white slab)', () => {
  // Amber glass in BOTH themes, centered 44-48px, active press, neutral disabled/loading.
  assert.match(source, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(source, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.match(source, /h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all/);
  assert.match(source, /\$\{isRefreshing \|\| !isOnline \? 'opacity-60 cursor-not-allowed' : 'active:scale-95'\}/);

  // The old solid black/white inversion (and its shadow) are gone.
  assert.doesNotMatch(source, /border border-black bg-black text-white/);
  assert.doesNotMatch(source, /border border-white\/80 bg-white text-black/);

  // Refresh keeps its localized accessible name via aria-label (no native title), handler + disabled intact.
  assert.match(
    source,
    /onClick=\{handleRefresh\}\s*disabled=\{isRefreshing \|\| !isOnline\}\s*aria-label=\{t\('common\.refresh', 'Refresh'\)\}/,
  );
});

test('Round 286: IntegrationsPage touch controls use aria-label, not native DOM title tooltips', () => {
  // The four removed native titles (logo / configure / toggle / refresh) are gone.
  assert.doesNotMatch(source, /title=\{logo\?\.label \|\| integration\.name\}/);
  assert.doesNotMatch(source, /title=\{t\('integrations\.configure'/);
  assert.doesNotMatch(source, /title=\{toggleDisabledMessage/);
  assert.doesNotMatch(source, /title=\{t\('common\.refresh'/);

  // The ONLY remaining title= are the two LiquidGlassModal component-prop headings (modal titles, not DOM
  // button tooltips) -- scoped explicitly so this guard never wrongly strips a component title prop.
  const titleAttrs = source.match(/\btitle=/g) ?? [];
  assert.equal(titleAttrs.length, 2, 'only the two LiquidGlassModal title props may remain');
  assert.match(source, /<LiquidGlassModal[\s\S]*?title=\{t\('integrations\.mydata\.title'/);
  assert.match(source, /title=\{activePlugin \? `\$\{activePlugin\.name\}/);

  // The logo stays named (aria-label + img alt); configure + toggle expose aria-labels; the toggle folds
  // its disabled reason into the accessible name without enabling it.
  assert.match(source, /aria-label=\{logo \? `\$\{logo\.label\} logo` : integration\.name\}/);
  assert.match(source, /<img[\s\S]*?alt=\{logo\.label\}/);
  assert.match(source, /aria-label=\{t\('integrations\.configure', 'Configure'\)\}/);
  assert.match(
    source,
    /aria-label=\{isToggleDisabled && toggleDisabledMessage \? toggleDisabledMessage : t\('integrations\.togglePlugin', 'Toggle plugin'\)\}/,
  );
});

test('Round 286: IntegrationsPage is touch-first (no hover utilities) and preserves handlers/disabled behavior', () => {
  assert.doesNotMatch(source, /hover:/, 'no hover-only utilities on a touch POS');
  assert.doesNotMatch(source, /group-hover:|dark:hover:/);

  // Handlers + disabled gating preserved (enabling/configuring is not made easier).
  assert.match(source, /onClick=\{handleRefresh\}/);
  assert.match(source, /onClick=\{\(\) => onConfigure\(integration\)\}/);
  assert.match(source, /onClick=\{\(\) => !isToggleDisabled && onToggle\(integration\.id\)\}/);
  assert.match(source, /disabled=\{isToggleDisabled\}/);
  assert.match(source, /disabled=\{isRefreshing \|\| !isOnline\}/);
});

// myDATA simple setup: the MyData modal used to be a dead end (read-only status + fiscal
// device wiring, no hint that real setup lives in the web Admin Dashboard). It now opens
// with a plain-language amber banner explaining that credentials/VAT/activation happen in
// the Admin Dashboard under Plugins -> MyData, plus an "Open Admin Dashboard" action that
// routes through the secure external-url gateway. The three MyData toasts are i18n'd.

test('MyData modal signposts full setup in the Admin Dashboard (banner + secure opener)', () => {
  // Banner copy is i18n-driven with plain-language fallbacks.
  assert.match(source, /t\('integrations\.mydata\.dashboardBanner\.title'/);
  assert.match(source, /t\(\s*'integrations\.mydata\.dashboardBanner\.body'/);
  assert.match(source, /t\('integrations\.mydata\.dashboardBanner\.openButton'/);

  // The URL is derived from the paired admin_dashboard_url (normalized, trailing
  // slashes stripped) and targets the /plugins page.
  assert.match(source, /normalizeAdminDashboardUrl\(stored\)\.replace\(\/\\\/\+\$\/, ''\)/);
  assert.match(source, /`\$\{base\}\/plugins`/);

  // The open button only renders when a dashboard URL is known, and routes through the
  // secure external-url gateway (never a raw window.open in this page).
  assert.match(source, /\{adminDashboardPluginsUrl && \(/);
  assert.match(source, /onClick=\{handleOpenAdminDashboard\}/);
  assert.match(source, /await openExternalUrl\(adminDashboardPluginsUrl\)/);
  assert.doesNotMatch(source, /window\.open\(/);

  // Clipboard copy is the fallback when the opener fails (e.g. host not allowlisted).
  assert.match(source, /navigator\.clipboard\.writeText\(adminDashboardPluginsUrl\)/);
  assert.match(source, /t\('integrations\.mydata\.dashboardBanner\.linkCopied'/);
  assert.match(source, /t\('integrations\.mydata\.dashboardBanner\.openFailed'/);
});

test('myDATA card carries a plain-language reporting status line gated on real transmission', () => {
  // Fiscal failures are silent by design, so the CARD (not just the modal) must tell the
  // owner in one sentence whether receipts are actually being reported to AADE. The line is
  // scoped to the mydata plugin only.
  assert.match(source, /integration\.id === 'mydata' && \(/);

  // Codex P1 (PR #102): plugin-card status alone (branch_plugin_configs.status) is NOT enough
  // for the green sentence — actual transmission also requires provider_status.is_enabled from
  // GET /pos/mydata/config. The green branch must require BOTH connected AND the fetched flag.
  assert.match(
    source,
    /integration\.status === 'connected' && myDataReportingEnabled === true/,
  );

  // While the flag is unknown (null, e.g. offline/fetch failed) on a connected card, NO status
  // line renders at all — the card must not claim either way.
  assert.match(
    source,
    /integration\.status !== 'connected' \|\| myDataReportingEnabled !== null/,
  );

  // The flag is fetched quietly from /pos/mydata/config and derived from provider_status
  // .is_enabled, with 404 (nothing configured) treated as "not reporting".
  assert.match(source, /const \[myDataReportingEnabled, setMyDataReportingEnabled\] = useState<boolean \| null>\(null\)/);
  assert.match(source, /providerStatus\['is_enabled'\] === true/);
  assert.match(source, /if \(result\.status === 404\) return false;/);

  // Both states are i18n-driven with plain-language fallbacks: green when actually reporting,
  // amber warning when transmission is off or the plugin is pending/disconnected.
  assert.match(
    source,
    /t\('integrations\.mydata\.statusLine\.reporting', 'Receipts are sent to the tax office \(AADE\) automatically\.'\)/,
  );
  assert.match(
    source,
    /t\('integrations\.mydata\.statusLine\.notReporting', 'Not set up yet — receipts are NOT being sent to AADE\. Finish setup in your Admin Dashboard\.'\)/,
  );

  // The line is tone-coded per state with theme-aware (isDark) classes, no hover utilities.
  assert.match(source, /\? isDark \? 'text-emerald-400' : 'text-emerald-600'/);
  assert.match(source, /: isDark \? 'text-amber-300' : 'text-amber-600'/);
});

test('MyData toasts are localized (no hardcoded English strings)', () => {
  assert.match(source, /t\('integrations\.mydata\.serialPortRequired', 'Serial port is required for USB connection'\)/);
  assert.match(source, /t\('integrations\.mydata\.bluetoothAddressRequired', 'Bluetooth address is required'\)/);
  assert.match(source, /t\('integrations\.mydata\.configSaved', 'MyData configuration saved'\)/);
  assert.doesNotMatch(source, /toast\.error\('Serial port is required for USB connection'\)/);
  assert.doesNotMatch(source, /toast\.error\('Bluetooth address is required'\)/);
  assert.doesNotMatch(source, /toast\.success\('MyData configuration saved'\)/);
});

test('Round 439: IntegrationsPage uses smooth rounded surfaces without stripping modal headings', () => {
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/);

  // Plugin brand colors are intentionally style-driven, but the shared app chrome should stay smooth
  // and touch-first.
  assert.match(source, /p-2 rounded-2xl inline-flex items-center justify-center transition-transform/);
  assert.match(source, /w-full flex items-center justify-between p-3 rounded-2xl mb-3 transition-transform active:scale-\[0\.99\]/);
  assert.match(source, /w-8 h-8 rounded-2xl flex items-center justify-center/);
  assert.match(source, /w-10 h-10 rounded-2xl flex items-center justify-center/);
  assert.match(source, /rounded-2xl p-3 text-sm/);
  assert.match(source, /rounded-2xl p-3 text-xs/);

  const titleAttrs = source.match(/\btitle=/g) ?? [];
  assert.equal(titleAttrs.length, 2, 'modal heading title props should remain the only title props');
});
