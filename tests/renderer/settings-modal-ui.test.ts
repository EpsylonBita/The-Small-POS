import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveTerminalConfigHealth } from '../../src/renderer/utils/terminal-config-health';

const projectRoot = process.cwd();
const modalPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'ConnectionSettingsModal.tsx',
);

const source = readFileSync(modalPath, 'utf8');
const paymentTerminalsSectionSource = readFileSync(
  path.join(
    projectRoot,
    'src',
    'renderer',
    'components',
    'ecr',
    'PaymentTerminalsSection.tsx',
  ),
  'utf8',
);
const printerSettingsModalSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'PrinterSettingsModal.tsx'),
  'utf8',
);
const printerSetupWizardSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'PrinterSetupWizard.tsx'),
  'utf8',
);

// Scope assertions to a single <button> by slicing from a marker inside its opening tag (or onClick
// body) to its closing </button>. Lets us assert a native `title=` attribute on a control is gone
// while a component `title` PROP (modal heading) elsewhere in the file is preserved.
function sliceButton(text: string, startMarker: string): string {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `expected to find "${startMarker}"`);
  const end = text.indexOf('</button>', start);
  assert.notEqual(end, -1, `expected </button> after "${startMarker}"`);
  return text.slice(start, end + '</button>'.length);
}

test('ConnectionSettingsModal uses a responsive settings hub shell', () => {
  // Current architecture: a `data-settings-hub` shell with a two-column grid (left nav rail +
  // right detail pane), replacing the former data-settings-workbench shell.
  assert.match(source, /data-settings-hub/);
  assert.match(source, /settings-hub flex min-h-0 flex-1 flex-col overflow-hidden/);
  assert.match(source, /md:grid-cols-\[minmax\(0,300px\)_minmax\(0,1fr\)\]/);
  // The right detail pane scrolls independently and resets to top on section change.
  assert.match(source, /const detailScrollRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(source, /ref=\{detailScrollRef\}/);
  assert.match(source, /detailScrollRef\.current\?\.scrollTo\(\{ top: 0 \}\)/);
  // Left-rail wrapping and visible thin scrollbars keep both columns discoverable.
  assert.match(source, /block break-words text-sm font-semibold leading-tight/);
  assert.equal((source.match(/\[scrollbar-width:thin\]/g) ?? []).length, 2);
  assert.doesNotMatch(source, /scrollbar-hide/);
  assert.match(source, /contentClassName="!overflow-hidden !p-4 sm:!p-5"/);
  // The old workbench shell identifiers are gone.
  assert.doesNotMatch(source, /data-settings-workbench/);
  assert.doesNotMatch(source, /settings-workbench/);
  assert.doesNotMatch(source, /w-56 shrink-0/);
  assert.doesNotMatch(source, /line-clamp-2/);
});

test('ConnectionSettingsModal exposes navigable settings sections via the hub left rail', () => {
  // Grouped left-rail navigation (daily / device / system) over the section ids.
  assert.match(source, /const settingsNavGroups: Array<\{ id: 'daily' \| 'device' \| 'system'; items: SettingsSectionId\[\] \}>/);
  assert.match(source, /\{ id: 'daily', items: \['admin', 'connection', 'platforms'\] \}/);
  assert.match(source, /items: \(\['printing', 'payments', 'waiter_devices', 'hardware', 'terminal'\] as SettingsSectionId\[\]\)\.filter\(/);
  assert.match(source, /\(id\) => id !== 'waiter_devices' \|\| isMainTerminal/);
  assert.match(source, /\{ id: 'system', items: \['security', 'database', 'about'\] \}/);

  // A left-rail row selects its section via openSection -> setActiveSettingsSection, marked aria-current.
  assert.match(source, /const openSection = \(section: SettingsSectionId\) => \{/);
  assert.match(source, /setActiveSettingsSection\(section\)/);
  assert.match(source, /onClick=\{\(\) => openSection\(id\)\}/);
  assert.match(source, /aria-current=\{isActive \? 'page' : undefined\}/);

  // Each section body renders directly, gated by the active section (no setShow* visibility booleans).
  for (const section of ['admin', 'connection', 'platforms', 'terminal', 'security', 'database', 'hardware', 'printing', 'payments', 'waiter_devices', 'about']) {
    assert.match(source, new RegExp(`activeSettingsSection === '${section}'`), `section ${section} must render conditionally`);
  }
  // admin is surfaced as the "This register" status label; the rest use hub section labels.
  assert.match(source, /settings\.settingsHub\.status\.register/);
  for (const section of ['connection', 'platforms', 'terminal', 'security', 'database', 'hardware', 'printing', 'payments', 'waiter_devices', 'about']) {
    assert.match(source, new RegExp(`settings\\.settingsHub\\.sections\\.${section}\\.label`), `${section} needs a hub section label`);
  }

  // The removed per-section visibility booleans / handler are gone.
  assert.doesNotMatch(source, /handleSettingsSectionSelect/);
  assert.doesNotMatch(source, /setShowConnectionSettings\(true\)/);
  assert.doesNotMatch(source, /setShowPinSettings\(true\)/);
});

test('Settings left-rail icons are standalone yellow line icons without decorative tiles', () => {
  const navStart = source.indexOf('const settingsNav: Array<{ id: SettingsSectionId; icon: React.ReactNode }>');
  assert.notEqual(navStart, -1, 'settingsNav must exist');
  const navEnd = source.indexOf('const settingsNavGroups', navStart);
  assert.notEqual(navEnd, -1, 'settingsNavGroups must follow settingsNav');
  const navBlock = source.slice(navStart, navEnd);

  const yellowIconCount = (navBlock.match(/className="h-5 w-5 shrink-0 text-yellow-600 dark:text-yellow-300"/g) ?? []).length;
  assert.equal(yellowIconCount, 11, `all eleven Settings nav icons must use standalone yellow strokes (found ${yellowIconCount})`);
  assert.doesNotMatch(navBlock, /text-black/);

  const navRenderStart = source.indexOf('aria-current={isActive');
  const navRenderEnd = source.indexOf('</button>', navRenderStart);
  const navRender = source.slice(navRenderStart, navRenderEnd);
  assert.match(navRender, /\{navItem\?\.icon\}/);
  assert.doesNotMatch(navRender, /h-9 w-9|bg-yellow-400 text-black|ring-yellow-500/);
});

test('Settings detail headers use standalone yellow line icons without decorative tiles', () => {
  const helperStart = source.indexOf('const sectionHeader = (icon: React.ReactNode, title: string, help?: string)');
  assert.notEqual(helperStart, -1, 'sectionHeader helper must exist');
  const helperEnd = source.indexOf('return (', helperStart);
  assert.notEqual(helperEnd, -1, 'sectionHeader helper must be declared before modal return');
  const helperBlock = source.slice(helperStart, helperEnd);

  assert.match(helperBlock, /\{icon\}/);
  assert.doesNotMatch(helperBlock, /rounded-xl|bg-yellow|ring-yellow|shadow-/);

  const sectionHeaderYellowIconCount = (
    source.match(/sectionHeader\(\s*\n\s*<\w+ className="h-5 w-5 shrink-0 text-yellow-600 dark:text-yellow-300"/g) ?? []
  ).length;
  assert.equal(
    sectionHeaderYellowIconCount,
    (source.match(/sectionHeader\(\s*\n\s*<\w+ className=/g) ?? []).length,
    'every current Settings detail header icon must use standalone yellow strokes',
  );
  assert.doesNotMatch(source, /sectionHeader\(\s*\n\s*<\w+ className="h-5 w-5 text-black"/);
});

test('Payment terminal settings icons are standalone instead of nested in colored icon tiles', () => {
  assert.doesNotMatch(paymentTerminalsSectionSource, /w-10 h-10 rounded-xl flex items-center justify-center/);
  assert.doesNotMatch(paymentTerminalsSectionSource, /w-7 h-7 rounded-md flex items-center justify-center/);
  assert.doesNotMatch(paymentTerminalsSectionSource, /\bbg:\s*'bg-(?:amber|green|gray|red)-500\/20'/);
  assert.match(paymentTerminalsSectionSource, /<Icon size=\{18\} className=/);
  assert.match(paymentTerminalsSectionSource, /<CreditCard\s+size=\{24\}/);
});

test('ConnectionSettingsModal keeps critical hardware and admin integrations wired', () => {
  assert.match(source, /PaymentTerminalsSection/);
  assert.match(source, /PrinterSettingsModal/);
  assert.match(source, /PrintQueuePanel/);
  assert.match(source, /CashRegisterSection/);
  assert.match(source, /CallerIdSection/);
  assert.match(source, /handleManualPolicySync/);
  assert.match(source, /handleSaveConnection/);
});

test('printer quick setup receives only persisted logo availability and opens the parent expert view', () => {
  assert.match(printerSettingsModalSource, /const \[persistedLogoConfigured, setPersistedLogoConfigured\] = useState\(false\)/);
  assert.match(printerSettingsModalSource, /logoConfigured=\{logoLoaded && persistedLogoConfigured\}/);

  const openLogoStart = printerSettingsModalSource.indexOf('onOpenLogoSettings={() => {');
  assert.notEqual(openLogoStart, -1, 'wizard must expose its logo-settings handoff');
  const openLogoEnd = printerSettingsModalSource.indexOf('onCancel=', openLogoStart);
  assert.notEqual(openLogoEnd, -1, 'logo-settings handoff must stay inside the wizard props');
  const openLogoHandler = printerSettingsModalSource.slice(openLogoStart, openLogoEnd);
  assert.match(openLogoHandler, /setSetupMode\('expert'\)/);
  assert.match(openLogoHandler, /logo: true/);
  assert.match(openLogoHandler, /setViewMode\('add'\)/);
  assert.doesNotMatch(openLogoHandler, /resetForm\(/, 'opening logo settings must preserve the expert draft');

  assert.doesNotMatch(printerSetupWizardSource, /<LiquidGlassModal\b|role=["']dialog["']/);
});

test('printer logo evidence fails closed during every load and after a failed reopen', () => {
  const loadStart = printerSettingsModalSource.indexOf('const loadReceiptLogoSettings = useCallback(async () => {');
  assert.notEqual(loadStart, -1, 'receipt logo loader must exist');
  const loadEnd = printerSettingsModalSource.indexOf('const loadReceiptActionSettings', loadStart);
  assert.notEqual(loadEnd, -1, 'receipt action loader must follow the logo loader');
  const loader = printerSettingsModalSource.slice(loadStart, loadEnd);

  const tryIndex = loader.indexOf('try {');
  const firstAwait = loader.indexOf('await Promise.all');
  assert.ok(tryIndex > 0 && firstAwait > tryIndex, 'logo loader must reset before awaiting persisted settings');
  const beforeTry = loader.slice(0, tryIndex);
  assert.match(beforeTry, /setLogoLoaded\(false\)/);
  assert.match(beforeTry, /setPersistedLogoConfigured\(false\)/);

  const coreLoad = loader.slice(tryIndex, loader.indexOf('setLogoEnabled', tryIndex));
  assert.match(coreLoad, /await Promise\.all\(\[/);
  assert.match(coreLoad, /key: 'show_logo'/);
  assert.match(coreLoad, /key: 'logo_source'/);
  assert.match(coreLoad, /key: 'logo_url'/);
  assert.doesNotMatch(coreLoad, /key: 'text_scale'|key: 'logo_scale'|key: 'layout_density_scale'/,
    'non-critical scale reads must not make core logo evidence unknown');
  assert.match(loader, /Promise\.allSettled\(\[/,
    'non-critical scale reads must settle independently after core logo evidence');

  const catchIndex = loader.indexOf('catch (e)');
  assert.notEqual(catchIndex, -1, 'logo loader must handle a failed reopen');
  const catchBlock = loader.slice(catchIndex);
  assert.match(catchBlock, /setLogoLoaded\(false\)/);
  assert.match(catchBlock, /setPersistedLogoConfigured\(false\)/);
  assert.doesNotMatch(catchBlock, /setLogoLoaded\(true\)/, 'failed loads must never unlock Branding');
});

const localesDir = path.join(projectRoot, 'src', 'locales');
const getKey = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
const loadLocale = (lng: string): unknown =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

test('ConnectionSettingsModal hardware section uses settings.peripherals.*, not the missing settings.hardware.*', () => {
  // settings.hardware.* does not exist in any locale; the section must read from
  // the translated settings.peripherals.* keys instead.
  assert.doesNotMatch(source, /t\('settings\.hardware\./);
  assert.match(source, /t\('settings\.peripherals\.title'/);
  assert.match(source, /t\('settings\.peripherals\.helpText'/);
  assert.match(source, /t\('settings\.peripherals\.saveButton'/);
});

test('ConnectionSettingsModal localizes enabled module names through resolveNavigationLabel', () => {
  assert.match(source, /import \{ resolveNavigationLabel \} from ['"]\.\.\/\.\.\/utils\/i18nLabels['"]/);
  assert.match(source, /resolveNavigationLabel\(t, module\.module\.id, module\.module\.name\)/);
  // The raw API display-name path is gone.
  assert.doesNotMatch(source, /enabledModules\.map\(\(module\) => module\.module\.name\)/);
});

// Round 194 (Settings "This register" overview redesign, live QA): the admin section used to be a dense
// grid where register id, dashboard URL, allowed-action pills, active-area pills and sync all had
// near-equal visual weight. It is redesigned into an operator-friendly overview -- a plain-language
// status card, large summary tiles (register type / sync / PIN), calm allowed-actions + active-areas
// (a count badge plus the individual localized labels inline, no wall of pills), and a QUIET technical
// details area for register id + dashboard address. Behaviour/data are preserved.
function adminOverviewSection(text: string): string {
  const start = text.indexOf('data-settings-register-overview');
  assert.notEqual(start, -1, 'admin section must carry the data-settings-register-overview marker');
  const end = text.indexOf('id="settings-section-connection"', start);
  assert.notEqual(end, -1, 'the connection section must follow the admin section');
  return text.slice(start, end);
}

test('Round 194: admin "This register" section is an operator-friendly overview with a layout marker', () => {
  const admin = adminOverviewSection(source);

  // The redesigned admin section carries the layout marker for live-QA / future guards.
  assert.match(source, /id="settings-section-admin"[\s\S]*?data-settings-register-overview/);

  // 1. Plain-language status card with the sync-health tone dot.
  assert.match(admin, /data-register-status-card/);
  assert.match(admin, /\{syncStatusTitle\}/);
  assert.match(admin, /\{syncStatusHelp\}/);
  assert.match(admin, /rounded-full \$\{syncToneClass\}/);

  // 2. Three large readable summary tiles: register type, sync state, PIN status.
  assert.equal((admin.match(/data-register-summary-tile/g) || []).length, 3, 'expected exactly 3 summary tiles');
  assert.match(admin, /t\('settings\.deviceSetup\.overview\.registerType'/);
  assert.match(admin, /t\('settings\.deviceSetup\.overview\.syncState'/);
  assert.match(admin, /t\('settings\.deviceSetup\.overview\.pinStatus'/);
  // Register-type tile reuses the existing managedTerminalSummary; PIN tile keeps its short + full copy.
  assert.match(admin, /\{managedTerminalSummary\}/);
  assert.match(admin, /t\('settings\.deviceSetup\.overview\.pinResetShort'/);
  assert.match(admin, /t\('settings\.deviceSetup\.overview\.pinOkShort'/);
  assert.match(admin, /pinResetRequired \? 'bg-yellow-400' : 'bg-green-500'/);
  // The original full PIN sentences are preserved (information not lost).
  assert.match(admin, /t\('settings\.deviceSetup\.pinResetRequired'/);
  assert.match(admin, /t\('settings\.deviceSetup\.pinResetClear'/);

  // 3. Round 347: the raw register-id / dashboard-address technical-details disclosure is REMOVED from the
  // overview entirely -- it was a raw-ID leak surface a cashier never needs (the editable terminal-id /
  // admin-url credential fields live in the Connection section). None of its markers, keys, runtime id
  // values, or disclosure chrome may appear in the admin overview anymore.
  assert.doesNotMatch(admin, /data-register-technical-details/);
  assert.doesNotMatch(admin, /settings\.deviceSetup\.overview\.technicalDetails/);
  assert.doesNotMatch(admin, /runtimeTerminalId/, 'the runtime register id must not render in the overview');
  assert.doesNotMatch(admin, /runtimeAdminUrl/, 'the runtime dashboard url must not render in the overview');
  assert.doesNotMatch(admin, /<details/, 'no disclosure should remain in the admin overview');
  assert.doesNotMatch(admin, /<summary/, 'no summary should remain in the admin overview');
  assert.doesNotMatch(admin, /group-open/, 'no group-open chevron should remain in the admin overview');

  // 4. Allowed actions + active areas are scannable CHIPS (round 222): a count badge plus the first
  // OVERVIEW_CHIP_LIMIT localized labels as soft rounded chips, then a calm localized "+N more" summary
  // chip. No paragraph dump, no unlimited wall of pills; labels/counts/localization are preserved.
  assert.match(admin, /data-register-allowed-actions/);
  assert.match(admin, /data-register-active-areas/);
  assert.match(admin, /t\('settings\.deviceSetup\.allowedActions'/);
  assert.match(admin, /t\('settings\.deviceSetup\.activeAreas'/);
  // Counts are still rendered.
  assert.match(admin, /\{enabledFeatureLabels\.length\}/);
  assert.match(admin, /\{enabledModuleNames\.length\}/);

  // Scope to the overview chip cards (allowed-actions -> active-areas -> end of overview; the technical-
  // details block that used to bound this region was removed in Round 347).
  const overviewChips = admin.slice(
    admin.indexOf('data-register-allowed-actions'),
  );
  assert.ok(overviewChips.length > 0, 'overview chips region must exist');

  // Capped chip rendering: the first OVERVIEW_CHIP_LIMIT labels are sliced, then mapped to soft chips.
  assert.match(overviewChips, /enabledFeatureLabels\.slice\(0, OVERVIEW_CHIP_LIMIT\)\.map\(/);
  assert.match(overviewChips, /\(showAllModules \? enabledModuleNames : enabledModuleNames\.slice\(0, OVERVIEW_CHIP_LIMIT\)\)\.map\(/);
  assert.match(overviewChips, /aria-expanded=\{showAllModules\}/);
  assert.match(overviewChips, /onClick=\{\(\) => setShowAllModules\(value => !value\)\}/);
  assert.match(overviewChips, /rounded-full/);

  // The old paragraph dump (bullet join) is gone.
  assert.doesNotMatch(overviewChips, /enabledFeatureLabels\.join\(' · '\)/);
  assert.doesNotMatch(overviewChips, /enabledModuleNames\.join\(' · '\)/);
  // No unlimited wall of pills: labels are never mapped without the cap (no bare .map over the arrays).
  assert.doesNotMatch(overviewChips, /enabledFeatureLabels\.map\(/);
  assert.doesNotMatch(overviewChips, /enabledModuleNames\.map\(/);

  // A localized "+N more" summary chip is rendered for overflow, via the moreCount key with the remainder.
  assert.match(
    overviewChips,
    /enabledFeatureLabels\.length > OVERVIEW_CHIP_LIMIT[\s\S]*?t\('settings\.deviceSetup\.overview\.moreCount'/,
  );
  assert.match(
    overviewChips,
    /enabledModuleNames\.length > OVERVIEW_CHIP_LIMIT[\s\S]*?t\('settings\.deviceSetup\.overview\.moreCount'/,
  );
  assert.match(overviewChips, /count: enabledFeatureLabels\.length - OVERVIEW_CHIP_LIMIT/);
  assert.match(overviewChips, /count: enabledModuleNames\.length - OVERVIEW_CHIP_LIMIT/);

  // Touch-first: no hover-only behaviour in the overview chip section.
  assert.doesNotMatch(overviewChips, /hover:/);

  // The "+N more" label is localized in every POS locale and interpolates the count.
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const value = getKey(loadLocale(lng), 'settings.deviceSetup.overview.moreCount') as string;
    assert.equal(typeof value, 'string', `${lng} missing settings.deviceSetup.overview.moreCount`);
    assert.match(value, /\{\{count\}\}/, `${lng} moreCount must interpolate {{count}}`);
  }
  assert.notEqual(
    getKey(loadLocale('el'), 'settings.deviceSetup.overview.moreCount'),
    getKey(loadLocale('en'), 'settings.deviceSetup.overview.moreCount'),
    'el moreCount must be a Greek translation, not English',
  );

  // enabledModuleNames is still built via resolveNavigationLabel (localized) and rendered above.
  assert.match(
    source,
    /const enabledModuleNames = enabledModules\.map\(\(module\) =>\s*resolveNavigationLabel\(t, module\.module\.id, module\.module\.name\),?\s*\)/,
  );

  // Behaviour preserved AND (round 194 follow-up, live QA) the primary Sync action now lives inside
  // the top status card — the first viewport at 1280x800 — not only at the bottom below the long
  // content where it required guessing there was hidden scroll. It still calls handleManualPolicySync.
  const statusCard = admin.slice(
    admin.indexOf('data-register-status-card'),
    admin.indexOf('data-register-summary-tile'),
  );
  assert.match(statusCard, /data-register-sync-action/);
  assert.match(statusCard, /onClick=\{handleManualPolicySync\}/);
  assert.match(statusCard, /t\('settings\.deviceSetup\.syncButton'/);
  // Exactly one Sync action in the overview — the old bottom-centered duplicate button is gone.
  assert.equal((admin.match(/data-register-sync-action/g) || []).length, 1, 'expected exactly one Sync action');
  assert.equal((admin.match(/onClick=\{handleManualPolicySync\}/g) || []).length, 1, 'no duplicate Sync button');
  assert.doesNotMatch(admin, /flex justify-center/);

  // Touchscreen: no native title tooltip + no hover utilities inside the redesigned admin section.
  assert.doesNotMatch(admin, /\btitle=/);
  assert.doesNotMatch(admin, /hover:/);
  assert.doesNotMatch(admin, /dark:hover:/);
  assert.doesNotMatch(admin, /group-hover:/);
});

test('Round 194: register-overview new keys are localized in every POS locale (Greek not English)', () => {
  const keys = [
    'settings.deviceSetup.overview.statusTitle',
    'settings.deviceSetup.overview.statusHelp',
    'settings.deviceSetup.overview.registerType',
    'settings.deviceSetup.overview.syncState',
    'settings.deviceSetup.overview.pinStatus',
    'settings.deviceSetup.overview.pinResetShort',
    'settings.deviceSetup.overview.pinOkShort',
  ];
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const json = loadLocale(lng);
    for (const key of keys) {
      const value = getKey(json, key);
      assert.equal(typeof value, 'string', `${lng} missing ${key}`);
      assert.ok((value as string).length > 0, `${lng} empty ${key}`);
      assert.notEqual(value, key, `${lng} ${key} leaks the dotted key`);
    }
  }
  // Greek must be a real translation for the prose keys (not the English fallback).
  const en = loadLocale('en');
  const el = loadLocale('el');
  for (const key of [
    'settings.deviceSetup.overview.statusTitle',
    'settings.deviceSetup.overview.statusHelp',
    'settings.deviceSetup.overview.registerType',
  ]) {
    assert.notEqual(getKey(el, key), getKey(en, key), `el ${key} must differ from English`);
  }
});

// Round 324 -> Round 347 (live QA, raw-ID leak hardening): the admin overview previously collapsed the
// register ID + dashboard URL behind a "Technical details" <details> disclosure. That was still a raw-ID leak
// surface a cashier never needs, and the obsolete "Technical details" / "For support" strings lingered in the
// bundle (resurfacing in a stale/embedded build). The disclosure is now REMOVED entirely -- no
// data-register-technical-details block, no details/summary/group-open, no rendered runtime ids -- and the two
// settings.deviceSetup.overview technicalDetails* locale keys are pruned from every POS locale so a rebuilt
// renderer bundle can no longer carry them. Editable terminal-id / admin-url credentials stay in Connection.
test('Round 347: the register technical-details disclosure is removed and its locale keys are pruned', () => {
  const admin = adminOverviewSection(source);

  // The disclosure and all of its parts are gone from the admin overview.
  assert.doesNotMatch(admin, /data-register-technical-details/);
  assert.doesNotMatch(admin, /<details/, 'no disclosure should remain in the admin overview');
  assert.doesNotMatch(admin, /<summary/, 'no summary should remain in the admin overview');
  assert.doesNotMatch(admin, /group-open/, 'no group-open chevron should remain in the admin overview');
  assert.doesNotMatch(admin, /settings\.deviceSetup\.overview\.technicalDetails/);
  assert.doesNotMatch(admin, /runtimeTerminalId/, 'the register id must not render in the overview');
  assert.doesNotMatch(admin, /runtimeAdminUrl/, 'the dashboard url must not render in the overview');

  // Touch-first contract still holds in the overview.
  assert.doesNotMatch(admin, /hover:/);
  assert.doesNotMatch(admin, /\btitle=/);

  // The overview still has exactly one sync action and three summary tiles (unchanged).
  assert.equal((admin.match(/data-register-sync-action/g) || []).length, 1, 'exactly one sync action');
  assert.equal((admin.match(/data-register-summary-tile/g) || []).length, 3, 'exactly three summary tiles');

  // Locale guard: the obsolete deviceSetup overview technicalDetails keys are absent in every POS locale, so a
  // rebuilt renderer bundle no longer carries the "Technical details" / "For support" strings.
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const overview = getKey(loadLocale(lng), 'settings.deviceSetup.overview') as Record<string, unknown>;
    assert.equal(typeof overview, 'object', `${lng} settings.deviceSetup.overview must exist`);
    assert.ok(!('technicalDetails' in overview), `${lng}: settings.deviceSetup.overview.technicalDetails must be removed`);
    assert.ok(!('technicalDetailsHelper' in overview), `${lng}: settings.deviceSetup.overview.technicalDetailsHelper must be removed`);
  }
});

// Round 325 (live QA, Greek/dark, 1282x768): Settings -> Data mixed recovery snapshots, safe repair tools
// and permanent deletion/reset tools in one long flow, so destructive actions were openly exposed below the
// snapshot list. The section now reads as three zones: recovery snapshots -> calm green "Safe fixes"
// (keeps your data) -> an "Advanced reset tools" disclosure that is COLLAPSED by default. The three
// destructive actions + their exact handlers/confirmation chain live only inside the expanded disclosure.
function databaseSection(text: string): string {
  const start = text.indexOf('id="settings-section-database"');
  assert.notEqual(start, -1, 'database section must exist');
  const end = text.indexOf('id="settings-section-hardware"', start);
  assert.notEqual(end, -1, 'the hardware section must follow the database section');
  return text.slice(start, end);
}

test('Round 325: Data section is three zones — recovery, green safe fixes, then a collapsed danger disclosure', () => {
  const db = databaseSection(source);

  // Zone order: RecoveryPanel -> safe fixes -> danger tools.
  const recoveryAt = db.indexOf('<RecoveryPanel');
  const safeAt = db.indexOf('data-database-safe-fixes');
  const dangerAt = db.indexOf('data-database-danger-zone');
  assert.ok(recoveryAt >= 0, 'RecoveryPanel must render in the data section');
  assert.ok(safeAt > recoveryAt, 'safe fixes must come after recovery snapshots');
  assert.ok(dangerAt > safeAt, 'danger tools must come after the safe fixes (repair before danger)');

  // Zone 2 — safe fixes: short plain title/help + three repair buttons via the shared green class; handlers kept.
  const safe = db.slice(safeAt, dangerAt);
  assert.match(safe, /t\('settings\.database\.repairToolsTitle', 'Safe fixes'\)/);
  assert.match(safe, /t\('settings\.database\.repairToolsHelp', 'Keeps your data'\)/);
  assert.equal((safe.match(/className=\{DB_REPAIR_BTN_MD\}/g) || []).length, 3, 'three safe-repair buttons share the green class');
  assert.match(safe, /bridge\.sync\.clearAll\(\)/);
  assert.match(safe, /bridge\.sync\.clearOldOrders\(\)/);
  assert.match(safe, /bridge\.sync\.cleanupDeletedOrders\(\)/);

  // Zone 3 — danger is a native <details> disclosure, collapsed by default (no `open`).
  assert.match(db, /<details\s+data-database-danger-zone/);
  assert.doesNotMatch(db, /<details\s+data-database-danger-zone[^>]*\bopen\b/, 'danger tools must be collapsed by default');

  const danger = db.slice(dangerAt);
  const summaryEnd = danger.indexOf('</summary>');
  assert.ok(summaryEnd > 0, 'the danger disclosure must have a <summary>');
  const summary = danger.slice(0, summaryEnd);
  const expanded = danger.slice(summaryEnd);

  // Collapsed summary: a short warning title + summary + chevron, native marker hidden, 44px target -- and
  // it must NOT expose any destructive handler/label before the operator expands.
  assert.match(summary, /<summary[\s\S]*?list-none[\s\S]*?\[&::-webkit-details-marker\]:hidden/);
  assert.match(summary, /min-h-\[44px\]/);
  assert.match(summary, /t\('settings\.database\.advancedResetTitle', 'Advanced reset tools'\)/);
  assert.match(summary, /t\('settings\.database\.advancedResetSummary', 'Deletes data'\)/);
  assert.match(summary, /<ChevronDown[\s\S]*?group-open:rotate-180/);
  assert.doesNotMatch(summary, /handleClearDatabase/, 'destructive actions must not sit in the collapsed summary');
  assert.doesNotMatch(summary, /clearAllOrders/, 'destructive actions must not sit in the collapsed summary');
  assert.doesNotMatch(summary, /setShowClearOperationalConfirm/, 'destructive actions must not sit in the collapsed summary');

  // Expanded region keeps the three destructive actions + their EXACT handlers/confirm chain + red buttons.
  assert.equal((expanded.match(/className=\{DB_DANGER_BTN_MD\}/g) || []).length, 3, 'three destructive buttons share the red class');
  assert.match(expanded, /bridge\.sync\.clearAllOrders\(\)/);
  assert.match(expanded, /onClick=\{\(\) => setShowClearOperationalConfirm\(true\)\}/);
  assert.match(expanded, /onClick=\{handleClearDatabase\}/);
  assert.match(expanded, /t\('settings\.database\.dangerDeleteOrdersButton'/);
  assert.match(expanded, /t\('settings\.database\.dangerEraseDataButton'/);
  assert.match(expanded, /t\('settings\.database\.dangerFactoryResetButton'/);
  // The scary "Cannot be undone" copy stays behind the disclosure, not on the first view.
  assert.match(expanded, /t\('settings\.database\.cannotUndo'/);

  // Consistent sizing/alignment: repair + danger buttons share ONE touch geometry; only the color differs.
  assert.match(source, /const DB_ACTION_GEOMETRY =\s*\n?\s*'inline-flex min-h-\[44px\] items-center justify-center/);
  assert.match(source, /const DB_REPAIR_BTN_MD = `\$\{DB_ACTION_GEOMETRY\}[^`]*emerald/);
  assert.match(source, /const DB_DANGER_BTN_MD = `\$\{DB_ACTION_GEOMETRY\}[^`]*red/);

  // Touch-first: no hover-only utilities, no native title tooltip anywhere in the data section.
  assert.doesNotMatch(db, /hover:/);
  assert.doesNotMatch(db, /\btitle=/);

  // New/updated zone copy localized in every POS locale (Greek not English, no raw-key leak).
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    for (const key of [
      'settings.database.advancedResetTitle',
      'settings.database.advancedResetSummary',
      'settings.database.repairToolsTitle',
      'settings.database.repairToolsHelp',
    ]) {
      const value = getKey(loadLocale(lng), key);
      assert.equal(typeof value, 'string', `${lng} missing ${key}`);
      assert.ok((value as string).length > 0, `${lng} empty ${key}`);
      assert.notEqual(value, key, `${lng} ${key} leaks the dotted key`);
    }
  }
  const en = loadLocale('en');
  const el = loadLocale('el');
  for (const key of ['settings.database.advancedResetTitle', 'settings.database.advancedResetSummary', 'settings.database.repairToolsTitle']) {
    assert.notEqual(getKey(el, key), getKey(en, key), `el ${key} must be a Greek translation`);
  }
});

// Round 195 (Settings → Connection action bar hierarchy, live QA): the connection actions were one
// flat `flex flex-wrap items-center gap-2 pt-1` row, so the green Save wrapped to its own left-aligned
// line under the secondary buttons and read like leftover content. The action area is restructured
// into a marked action bar: a grouped neutral secondary cluster (Paste / Test when allowed / Sync) and
// a separate primary Save slot, end-aligned on desktop and full-width on narrow. Handlers unchanged.
function connectionSection(text: string): string {
  const start = text.indexOf('id="settings-section-connection"');
  assert.notEqual(start, -1, 'connection section must exist');
  const end = text.indexOf('id="settings-section-security"', start);
  assert.notEqual(end, -1, 'the security section must follow the connection section');
  return text.slice(start, end);
}

test('Round 195: Connection action bar gives Save a deliberate primary slot, not a wrapped leftover', () => {
  const connection = connectionSection(source);

  // A marked action bar that stacks a grouped secondary cluster above its own primary Save slot. (Round
  // 293 refined the desktop layout from a justify-between row into this stacked, centered design.)
  assert.match(connection, /data-connection-action-bar/);
  assert.match(connection, /data-connection-action-bar[\s\S]*?flex flex-col gap-3/);

  // Secondary cluster groups Paste, Test (only when allowed) and Sync as neutral glass buttons.
  assert.match(connection, /data-connection-secondary-actions/);
  const secondary = connection.slice(
    connection.indexOf('data-connection-secondary-actions'),
    connection.indexOf('data-connection-primary-action'),
  );
  assert.match(secondary, /onClick=\{handlePasteBoth\}/);
  assert.match(secondary, /\{allowManualCredentials && \([\s\S]*?onClick=\{handleTest\}/);
  assert.match(secondary, /onClick=\{handleManualPolicySync\}/);
  assert.match(secondary, /liquidGlassModalButton\('secondary', 'md'\)/);
  // The secondary cluster does NOT contain the Save action (it lives in its own primary slot).
  assert.doesNotMatch(secondary, /handleSaveConnection/);
  assert.doesNotMatch(secondary, /SAVE_BTN_MD/);

  // Primary Save slot: green SAVE_BTN_MD in its own centered slot, 44px+, full-width on narrow.
  assert.match(connection, /data-connection-primary-action/);
  const primary = connection.slice(connection.indexOf('data-connection-primary-action'));
  assert.match(primary, /data-connection-primary-action className="flex justify-center"/);
  assert.match(primary, /onClick=\{handleSaveConnection\}/);
  assert.match(primary, /className=\{SAVE_BTN_MD \+ ' min-h-\[44px\] w-full sm:w-auto sm:min-w-\[240px\]'\}/);
  assert.match(primary, /t\('modals\.connectionSettings\.save'\)/);

  // The old unstructured flat action row is gone from the connection section.
  assert.doesNotMatch(connection, /flex flex-wrap items-center gap-2 pt-1/);

  // Touchscreen: no native title tooltip / hover utilities anywhere in the connection section.
  assert.doesNotMatch(connection, /\btitle=/);
  assert.doesNotMatch(connection, /hover:/);
  assert.doesNotMatch(connection, /dark:hover:/);
  assert.doesNotMatch(connection, /group-hover:/);
});

// Runtime preferences have their own behavioral tests; this guard keeps the parent handoff explicit.
function terminalSection(text: string): string {
  const start = text.indexOf('id="settings-section-terminal"');
  assert.notEqual(start, -1, 'terminal section must exist');
  const end = text.indexOf('id="settings-section-database"', start);
  assert.notEqual(end, -1, 'the database section must follow the terminal section');
  return text.slice(start, end);
}

test('Screen & Sound delegates working preferences and provides explicit destinations', () => {
  const terminal = terminalSection(source);
  assert.match(terminal, /<SettingsRuntimePreferences/);
  assert.match(terminal, /onOpenPrinterSettings=\{\(\) => openSection\('printing'\)\}/);
  assert.match(terminal, /onOpenSecurity=\{\(\) => openSection\('security'\)\}/);
  assert.doesNotMatch(terminal, /terminal-screen-timeout|terminal-touch-sensitivity|terminal-display-brightness|terminal-receipt-autoprint-label/);
  assert.doesNotMatch(terminal, /setScreenTimeoutMinutes|setTouchSensitivity|setDisplayBrightness|setReceiptAutoPrint/);
  assert.doesNotMatch(terminal, /\btitle=|hover:|group-hover:/);
});

// Round 227 (history): the Settings switch was redesigned into a premium green/neutral glass switch.
// Round 295 superseded the local implementation: ConnectionSettingsModal no longer defines its own switch
// track class -- every switch renders the shared POSGlassSwitch (geometry pinned in Round 295 below). This
// test now guards that migration so the local class cannot creep back in.
test('Round 227/295: ConnectionSettingsModal switches use the shared POSGlassSwitch (no local track class)', () => {
  // The local switch-track class + the old label/peer-checkbox wrapper are gone.
  assert.doesNotMatch(source, /const switchTrackClass =/);
  assert.doesNotMatch(source, /sr-only peer/);
  assert.doesNotMatch(source, /<label className="relative inline-flex min-h-\[44px\] items-center justify-center cursor-pointer">/);

  // The active hardware switches and receipt prompt retain the shared component.
  // Unsupported preferences and the retired custom timeout are no longer controls.
  const switches = source.match(/<POSGlassSwitch\b/g) || [];
  assert.ok(switches.length >= 4, `expected active hardware and receipt switches, found ${switches.length}`);
  assert.match(source, /import \{ LiquidGlassModal, POSGlassSwitch \} from '\.\.\/ui\/pos-glass-components'/);

  // The working hardware controls retain visible labels and programmatic switch names.
  const hardwareSwitches: ReadonlyArray<{ readonly id: string; readonly state: string }> = [
    { id: 'peripheral-scale-label', state: 'scaleEnabled' },
    { id: 'peripheral-display-label', state: 'displayEnabled' },
    { id: 'peripheral-scanner-label', state: 'scannerEnabled' },
  ];
  for (const { id, state } of hardwareSwitches) {
    // The visible title span carries the id...
    assert.match(source, new RegExp(`<span id="${id}"[^>]*>\\{t\\('settings\\.peripherals\\.`), `${id} must be on a visible title span`);
    // ...and the matching switch is named by it (aria-labelledby pointing at that id), state preserved.
    assert.match(
      source,
      new RegExp(`<POSGlassSwitch aria-labelledby="${id}" checked=\\{${state}\\}`),
      `${state} switch must be named via aria-labelledby="${id}"`,
    );
  }
});

// Session access is informational until the backend supports configurable expiry.
function sessionTimeoutCard(text: string): string {
  const start = text.indexOf('data-session-timeout-card');
  assert.notEqual(start, -1, 'session-timeout card must carry the data-session-timeout-card marker');
  const end = text.indexOf('id="settings-section-database"', start);
  assert.notEqual(end, -1, 'the database section must follow the session-timeout card');
  return text.slice(start, end);
}

test('Session settings state the fixed native limits without ineffective custom controls', () => {
  const card = sessionTimeoutCard(source);
  assert.match(card, /settings\.workflow\.sessionTitle/);
  assert.match(card, /30-minute inactivity limit/);
  assert.match(card, /maximum session duration of 2 hours/);
  assert.match(card, /Custom auto-lock timing is not available/);
  assert.doesNotMatch(card, /<input|<POSGlassSwitch|handleToggleSessionTimeout|handleSaveSessionTimeout/);
  assert.doesNotMatch(source, /session_timeout_enabled|session_timeout_minutes/);
  assert.match(card, /onClick=\{\(\) => openSection\('terminal'\)\}/);
  assert.doesNotMatch(card, /\btitle=|hover:|group-hover:/);
});

test('settings help keys exist and are localized in every POS locale', () => {
  const keys = [
    'settings.terminal.helpText',
    'settings.security.pinHelp',
    'settings.peripherals.title',
    'settings.peripherals.helpText',
    'settings.peripherals.saveButton',
  ];
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const json = loadLocale(lng);
    for (const key of keys) {
      const value = getKey(json, key);
      assert.equal(typeof value, 'string', `${lng} missing ${key}`);
      assert.ok((value as string).length > 0, `${lng} empty ${key}`);
    }
  }
  // Greek help text must be a real translation, not the English fallback.
  const en = loadLocale('en');
  const el = loadLocale('el');
  assert.notEqual(getKey(el, 'settings.terminal.helpText'), getKey(en, 'settings.terminal.helpText'));
  assert.notEqual(getKey(el, 'settings.security.pinHelp'), getKey(en, 'settings.security.pinHelp'));
});

test('Greek admin enabled-modules labels contain no English "module" text', () => {
  const el = loadLocale('el');
  const label = getKey(el, 'settings.managedByAdmin.enabledModulesLabel') as string;
  const core = getKey(el, 'settings.managedByAdmin.coreModulesOnly') as string;
  assert.doesNotMatch(label, /modules?/i);
  assert.doesNotMatch(core, /modules?/i);
});

const LANGUAGE_BUTTONS: ReadonlyArray<{ readonly name: string; readonly key: string }> = [
  { name: 'English', key: 'langEnglish' },
  { name: 'Greek', key: 'langGreek' },
  { name: 'German', key: 'langGerman' },
  { name: 'French', key: 'langFrench' },
  { name: 'Italian', key: 'langItalian' },
];

test('language switcher buttons read accessible names from settings.display.lang* for every language', () => {
  // Round 171: language buttons expose their accessible name via aria-label (no native title
  // tooltip), still sourced from the per-language translation key.
  for (const { name } of LANGUAGE_BUTTONS) {
    assert.match(
      source,
      new RegExp(`aria-label=\\{t\\('settings\\.display\\.lang${name}'\\)\\}`),
      `${name} button aria-label must use the settings.display.lang${name} key`,
    );
  }
  // The layout fix must not have touched the language-switch behavior or save toast.
  for (const code of ['en', 'el', 'de', 'fr', 'it']) {
    assert.match(source, new RegExp(`handleLanguageChange\\('${code}'\\)`), `${code} must invoke the language-change handler`);
  }
  assert.match(source, /await setLanguage\(language\)/);
  assert.match(source, /toast\.success\(t\('modals\.connectionSettings\.languageSaved'\)\)/);
  // Portal/blur behavior preserved: the modal still renders through LiquidGlassModal.
  assert.match(source, /<LiquidGlassModal/);
});

test('settings.display.lang* names exist and never leak the raw key in any POS locale', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const json = loadLocale(lng);
    for (const { key } of LANGUAGE_BUTTONS) {
      const dotted = `settings.display.${key}`;
      const value = getKey(json, dotted);
      assert.equal(typeof value, 'string', `${lng} missing ${dotted}`);
      assert.ok((value as string).length > 0, `${lng} empty ${dotted}`);
      // The original defect: missing keys fell through to the raw key string at runtime.
      assert.notEqual(value, dotted, `${lng} ${dotted} leaks the dotted i18n key`);
      assert.notEqual(value, key, `${lng} ${dotted} leaks the bare key name`);
    }
  }
});

const EXPECTED_LANGUAGE_NAMES = {
  en: {
    langGerman: 'German',
    langFrench: 'French',
    langItalian: 'Italian',
  },
  el: {
    langGerman: '\u0393\u03b5\u03c1\u03bc\u03b1\u03bd\u03b9\u03ba\u03ac',
    langFrench: '\u0393\u03b1\u03bb\u03bb\u03b9\u03ba\u03ac',
    langItalian: '\u0399\u03c4\u03b1\u03bb\u03b9\u03ba\u03ac',
  },
  de: {
    langGerman: 'Deutsch',
    langFrench: 'Franz\u00f6sisch',
    langItalian: 'Italienisch',
  },
  fr: {
    langGerman: 'Allemand',
    langFrench: 'Fran\u00e7ais',
    langItalian: 'Italien',
  },
  it: {
    langGerman: 'Tedesco',
    langFrench: 'Francese',
    langItalian: 'Italiano',
  },
} as const;

test('settings.display lang names for DE/FR/IT are localized per locale, not English fallbacks', () => {
  const en = loadLocale('en');
  const el = loadLocale('el');

  // Greek must render the previously-leaking names in Greek, distinct from English.
  for (const key of ['langGerman', 'langFrench', 'langItalian']) {
    const dotted = `settings.display.${key}`;
    assert.notEqual(getKey(el, dotted), getKey(en, dotted), `el ${dotted} must be a Greek translation`);
  }

  for (const [locale, expected] of Object.entries(EXPECTED_LANGUAGE_NAMES)) {
    const json = loadLocale(locale);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(getKey(json, `settings.display.${key}`), value);
    }
  }
});

// Round 171 (touch-first cleanup): native DOM `title` tooltips are hover behaviour on a touchscreen
// and must be removed from the paste-both, theme, and language controls; the accessible name moves
// to aria-label, preserving the existing translated label.
const NO_TOOLTIP_CONTROLS: ReadonlyArray<{ readonly name: string; readonly marker: string; readonly aria: string }> = [
  { name: 'paste-both', marker: 'onClick={handlePasteBoth}', aria: "aria-label={t('modals.connectionSettings.pasteBothTooltip')}" },
  { name: 'theme light', marker: "onClick={() => handleSaveTheme('light')}", aria: "aria-label={t('modals.connectionSettings.light')}" },
  { name: 'theme dark', marker: "onClick={() => handleSaveTheme('dark')}", aria: "aria-label={t('modals.connectionSettings.dark')}" },
  { name: 'theme system', marker: "onClick={() => handleSaveTheme('auto')}", aria: "aria-label={t('modals.connectionSettings.system')}" },
  { name: 'lang en', marker: "handleLanguageChange('en')", aria: "aria-label={t('settings.display.langEnglish')}" },
  { name: 'lang el', marker: "handleLanguageChange('el')", aria: "aria-label={t('settings.display.langGreek')}" },
  { name: 'lang de', marker: "handleLanguageChange('de')", aria: "aria-label={t('settings.display.langGerman')}" },
  { name: 'lang fr', marker: "handleLanguageChange('fr')", aria: "aria-label={t('settings.display.langFrench')}" },
  { name: 'lang it', marker: "handleLanguageChange('it')", aria: "aria-label={t('settings.display.langItalian')}" },
];

test('ConnectionSettingsModal paste/theme/language controls use aria-label, not native title tooltips', () => {
  for (const { name, marker, aria } of NO_TOOLTIP_CONTROLS) {
    const block = sliceButton(source, marker);
    assert.doesNotMatch(block, /\btitle=/, `${name} button must not carry a native title tooltip`);
    assert.ok(block.includes(aria), `${name} button must expose its accessible name via ${aria}`);
  }
});

test('ConnectionSettingsModal preserves ConfirmDialog/LiquidGlass title heading props (title= not globally forbidden)', () => {
  // These `title` PROPS are visible modal headings, not browser tooltips, and must be preserved.
  assert.match(source, /title=\{t\('settings\.database\.confirmClearOperationalTitle'/);
  assert.match(source, /title=\{t\('settings\.database\.factoryResetWarningTitle'/);
  assert.match(source, /title=\{t\('settings\.database\.factoryResetFinalTitle'/);
  assert.match(source, /<LiquidGlassModal/);
});

// Round 217 (live QA): Settings → "This register" showed raw English "stale" (status line
// "Συγχρονισμός: stale" and the sync summary tile) because syncHealthLabel resolves
// settings.managedByAdmin.syncHealth.${runtimeSyncHealth} with the raw value as the fallback, while the
// locales lacked `stale` and other runtime health states. Those runtime values must now be localized in
// every POS locale, and the modal must keep resolving the label through the syncHealth key (not raw text).
test('Round 217: runtime sync-health states are localized in every POS locale (no raw English leak)', () => {
  // The runtime health values that previously fell through to the raw string (from syncToneClass +
  // the live "stale" leak): all must exist as non-empty strings in every POS locale.
  const runtimeKeys = [
    'stale',
    'failed',
    'fail',
    'disconnected',
    'connected',
    'good',
    'live',
    'ok',
    'synced',
    'degraded',
  ];
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const json = loadLocale(lng);
    for (const key of runtimeKeys) {
      const value = getKey(json, `settings.managedByAdmin.syncHealth.${key}`);
      assert.equal(typeof value, 'string', `${lng} settings.managedByAdmin.syncHealth.${key} missing`);
      assert.ok((value as string).length > 0, `${lng} settings.managedByAdmin.syncHealth.${key} empty`);
    }
  }

  // Greek "stale" must be a real Greek operator label, not the English fallback "stale"/"Stale".
  const elStale = getKey(loadLocale('el'), 'settings.managedByAdmin.syncHealth.stale') as string;
  assert.match(elStale, new RegExp('[\\u0370-\\u03FF]'), `el stale should be Greek: "${elStale}"`);
  assert.notEqual(elStale.toLowerCase(), 'stale', 'el stale must not be the raw English fallback');

  // The modal still derives the visible label from the localized syncHealth key (not raw display text),
  // so newly-added runtime states render localized too.
  assert.match(
    source,
    /const syncHealthLabel = syncHealth\.isHealthy \? t\('settings\.workflow\.configHealthyLabel'[\s\S]*?t\(`settings\.managedByAdmin\.syncHealth\.\$\{runtimeSyncHealth\}`/,
  );
  assert.match(source, /\{syncHealthLabel\}/);
});

// --- Round 241 (live QA): Settings -> Devices -> Cash Register -> Add/Edit fiscal device --------
// The Add/Edit form rendered inline in the scrolled settings page (so it could appear mid-form with
// the footer only reachable after scrolling). It is now a focused, portaled glass submodal with its
// own scroll body + a reserved sticky footer; ECR save/delete/test behavior is unchanged.

const cashRegisterSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'peripherals', 'CashRegisterSection.tsx'),
  'utf8',
);

test('Round 241: the Add/Edit fiscal device form is a focused glass submodal, not an inline page form', () => {
  // Portaled to body (escapes the settings page scroll offset) as a labelled, blurred glass dialog.
  assert.match(cashRegisterSource, /import \{ renderModalPortal \} from '\.\.\/\.\.\/utils\/render-modal-portal'/);
  assert.match(cashRegisterSource, /const renderFormModal = \(\) => renderModalPortal\(/);

  // The overlay must layer ABOVE the Settings LiquidGlassModal viewport (.liquid-glass-modal-viewport,
  // z-index: 20000) — Round 241 live QA caught it at z-[1200], rendering behind Settings.
  const overlayZMatch = cashRegisterSource.match(/fixed inset-0 z-\[(\d+)\][^"]*bg-black\/70 backdrop-blur-sm/);
  assert.ok(overlayZMatch, 'the fiscal device overlay must declare an explicit fixed-inset z-[N] backdrop');
  const overlayZ = Number(overlayZMatch[1]);
  const glassCss = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'styles', 'glassmorphism.css'),
    'utf8',
  );
  const viewportZMatch = glassCss.match(/\.liquid-glass-modal-viewport\s*\{[^}]*z-index:\s*(\d+)/);
  assert.ok(viewportZMatch, '.liquid-glass-modal-viewport z-index must be defined');
  const viewportZ = Number(viewportZMatch[1]);
  assert.ok(
    overlayZ > viewportZ,
    `fiscal overlay z (${overlayZ}) must exceed the LiquidGlassModal viewport z (${viewportZ})`,
  );
  // The too-low z-[1200] that rendered behind the Settings modal must not return.
  assert.doesNotMatch(cashRegisterSource, /fixed inset-0 z-\[1200\]/);
  assert.match(
    cashRegisterSource,
    /role="dialog"\s*aria-modal="true"\s*aria-labelledby="cash-register-device-form-title"/,
  );
  assert.match(cashRegisterSource, /backdrop-blur-2xl/);
  // Robust max-height + flex column so header/body/footer split predictably.
  assert.match(
    cashRegisterSource,
    /max-h-\[calc\(100%-1\.5rem\)\] sm:max-h-\[calc\(100%-3rem\)\] flex flex-col overflow-hidden/,
  );

  // Own scroll body with min-h-0 (reserves footer space; nothing overlaps at 1282x802) + hidden rail.
  assert.match(cashRegisterSource, /overflow-y-auto flex-1 min-h-0 scrollbar-hide/);
  // Sticky glass footer, reserved by the flex column (shrink-0).
  assert.match(cashRegisterSource, /border-t shrink-0 backdrop-blur-xl/);

  // The form opens as an overlay ON TOP of the list (list stays mounted), never returned inline.
  assert.match(
    cashRegisterSource,
    /\{renderListView\(\)\}\s*\{\(viewMode === 'add' \|\| viewMode === 'edit'\) && renderFormModal\(\)\}/,
  );
  assert.doesNotMatch(cashRegisterSource, /return renderFormView\(\)/);

  // X / backdrop / Escape all close (close-only — they never save).
  assert.match(cashRegisterSource, /const closeForm = useCallback\(/);
  assert.match(
    cashRegisterSource,
    /if \(event\.key !== 'Escape'\) return\s*event\.preventDefault\(\)\s*closeForm\(\)/,
  );
});

test('Round 241: fiscal submodal Cancel is red, Add/Save is green primary, and the list CTA is green', () => {
  // Cancel = soft destructive red (footer button, wired to the close-only handler).
  assert.match(
    cashRegisterSource,
    /onClick=\{closeForm\}\s*className="px-4 py-2 rounded-lg text-sm font-medium border[^"]*border-red-500\/40 bg-red-500\/10 text-red-600 dark:text-red-300 active:bg-red-500\/20/,
  );

  // Save/Add = emerald green primary with an explicit disabled state; no amber on the save button.
  const saveStart = cashRegisterSource.indexOf('onClick={handleSave}');
  const saveBtn = cashRegisterSource.slice(saveStart, cashRegisterSource.indexOf('</button>', saveStart));
  assert.ok(saveStart >= 0, 'save button must exist');
  assert.match(saveBtn, /bg-emerald-600 text-white[^"]*disabled:opacity-50 disabled:cursor-not-allowed/);
  assert.doesNotMatch(saveBtn, /bg-amber/);

  // List-level Add Device CTA is green, not amber.
  const addStart = cashRegisterSource.indexOf('onClick={handleAdd}');
  const addBtn = cashRegisterSource.slice(addStart, cashRegisterSource.indexOf('</button>', addStart));
  assert.ok(addStart >= 0, 'add CTA must exist');
  assert.match(addBtn, /bg-emerald-600 border border-emerald-500 text-white/);
  assert.doesNotMatch(addBtn, /bg-amber/);
});

test('Round 241: fiscal device icon actions use aria-labels, never native title tooltips', () => {
  // No native title attribute remains anywhere in the section (touch POS rule), and no hover styles.
  assert.doesNotMatch(cashRegisterSource, /[^a-zA-Z]title=/);
  assert.doesNotMatch(cashRegisterSource, /hover:/);

  // Edit / delete / refresh icon controls carry localized aria-labels.
  assert.match(
    cashRegisterSource,
    /onClick=\{\(\) => handleEdit\(device\)\}\s*aria-label=\{t\('common\.actions\.edit', 'Edit'\)\}/,
  );
  assert.match(
    cashRegisterSource,
    /onClick=\{\(\) => setDeleteConfirmId\(device\.id\)\}\s*aria-label=\{t\('common\.actions\.delete', 'Delete'\)\}/,
  );
  assert.match(
    cashRegisterSource,
    /onClick=\{\(\) => void loadDevices\(\)\}\s*disabled=\{loading\}\s*aria-label=\{t\('common\.refresh', 'Refresh'\)\}/,
  );
  // The submodal close (X) is a centered 44x44 touch target.
  assert.match(
    cashRegisterSource,
    /aria-label=\{t\('common\.actions\.close', 'Close'\)\}[\s\S]*?inline-flex h-11 w-11 items-center justify-center/,
  );
});

// --- Round 243 (live QA): Settings -> Devices -> Caller ID (VoIP/SIP) progressive child-friendly setup ---
// The section was too dense (SIP/PBX/router warnings + advanced auth all at once, actions below the
// fold). It is now a 3-step glass flow with technical fields behind Advanced, a quiet router note,
// a plain "what you need" checklist, and a sticky action row. CallerIdService/IPC/validation/polling
// are unchanged.

const callerIdSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'peripherals', 'CallerIdSection.tsx'),
  'utf8',
);

test('CallerIdSection is a server-managed 3-step FXO status flow', () => {
  assert.doesNotMatch(callerIdSource, /hover:/);
  assert.doesNotMatch(callerIdSource, /[^a-zA-Z]title=/);
  assert.match(callerIdSource, /callerId\.serverManaged\.step1/);
  assert.match(callerIdSource, /callerId\.serverManaged\.step2/);
  assert.match(callerIdSource, /callerId\.serverManaged\.step3/);
  assert.match(callerIdSource, /callerIdGetServerConfig/);

  assert.doesNotMatch(callerIdSource, /Provider preset|Manual SIP|Older PBX/);
  assert.doesNotMatch(callerIdSource, /sipServer|sipUsername|authUsername|passwordStored/);
  assert.doesNotMatch(callerIdSource, /callerIdSaveConfig|callerIdTestConnection/);
  assert.doesNotMatch(callerIdSource, /\b(?:bg|text|border|from|to|ring)-(?:blue|purple|indigo|violet|sky|cyan)-/);
});

test('CallerId Step 2 displays only the safe server-projected FXO fields', () => {
  for (const field of ['deviceProfileKey', 'trustedDeviceIp', 'sourceChannel', 'listenPort']) {
    assert.match(callerIdSource, new RegExp(`line\\.${field}`), `${field} must be visible`);
  }
  assert.match(callerIdSource, /line\.isReceivingTarget/);
  assert.doesNotMatch(callerIdSource, /credentials|credentialVersion/);
});

test('CallerId renders source, receiver-only, disabled and unassigned server states', () => {
  assert.match(callerIdSource, /serverConfig\?\.enabled && hasAssignment/);
  assert.match(callerIdSource, /sourceLines\.length === 0 && receivingLines\.length > 0/);
  assert.match(callerIdSource, /!hasAssignment && !serverError/);
  assert.match(callerIdSource, /ipTrustSourcePolicy === 'blocked'/);
});

test('CallerId uses one non-sticky refresh action instead of retired save/test controls', () => {
  assert.doesNotMatch(callerIdSource, /sticky bottom-0|pb-32/);
  assert.match(
    callerIdSource,
    /onClick=\{handleRefresh\}[\s\S]*?liquid-glass-modal-button[\s\S]*?min-h-\[44px\][\s\S]*?items-center justify-center/,
  );
  assert.doesNotMatch(callerIdSource, /handleSaveAndActivate|handleDisable|handleTest/);
});

test('server-managed CallerId labels exist in every locale and Greek copy is translated', () => {
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const c = getKey(loadLocale(lng), 'settings.peripherals.callerId') as Record<string, any>;
    assert.ok(c, `${lng} missing callerId`);
    for (const key of ['step1', 'step2', 'step3', 'centralBody', 'deviceIp', 'channel', 'port', 'refresh']) {
      assert.equal(typeof c.serverManaged?.[key], 'string', `${lng} callerId.serverManaged.${key} missing`);
    }
  }
  const el = getKey(loadLocale('el'), 'settings.peripherals.callerId') as Record<string, any>;
  assert.match(el.serverManaged.step1, GREEK);
  assert.match(el.serverManaged.centralBody, GREEK);
});

test('CallerId Step 3 follows Step 2 in normal document flow and refreshes in parallel', () => {
  const step2 = callerIdSource.indexOf('callerId.serverManaged.step2');
  const step3 = callerIdSource.indexOf('callerId.serverManaged.step3');
  assert.ok(step2 > 0 && step3 > step2, 'Step 3 must render after Step 2');
  assert.match(callerIdSource, /liquid-glass-modal-footer space-y-3/);
  assert.match(callerIdSource, /Promise\.allSettled\(\[\s*callerIdGetServerConfig\(\),\s*refreshLocalStatus\(\)/);
  assert.match(callerIdSource, /const refreshLocalStatus = useCallback\([\s\S]*?await callerIdGetStatus\(\)/);
});

// --- Round 280 (live QA, Greek/light): the Settings hub still forced many Greek labels into ALL-CAPS
// microcopy -- the left-rail group labels (daily/device/system) and the This-Register overview eyebrow
// labels (register type / sync / PIN / allowed actions / active areas / technical details). Across
// EN/EL/DE/FR/IT that reads shouted; they now use normal readable label styling. AND the status card no
// longer claims the register is "set up" while the sync dot is red: a derived isSyncHealthy boolean
// drives BOTH the dot tone and the title/help copy (healthy = set-up copy; otherwise a plain warning),
// without hiding the red state or triggering a sync. ---

test('Round 280: Settings hub left rail + This-Register overview labels are normal case (not shouted all-caps)', () => {
  // Left-rail group label (daily/device/system) is a normal-weight muted label, not uppercase.
  assert.match(source, /px-2 pb-1 text-\[11px\] font-semibold liquid-glass-modal-text-muted/);
  assert.doesNotMatch(source, /text-\[11px\] font-semibold uppercase tracking-wider/);

  // The This-Register overview eyebrow labels are normal case -- no uppercase / letter-spaced shouting
  // anywhere in the admin overview slice.
  const admin = adminOverviewSection(source);
  assert.doesNotMatch(admin, /uppercase/, 'admin overview labels must not be uppercase');
  assert.doesNotMatch(admin, /tracking-wide/, 'admin overview labels must not be letter-spaced shouted');
  assert.match(admin, /text-xs font-semibold liquid-glass-modal-text-muted/, 'overview eyebrows use a normal-case label');

  // The danger "Cannot be undone" badges (database section) intentionally keep their uppercase emphasis
  // and sit OUTSIDE the admin overview slice, so they are not affected by this change.
  assert.match(source, /font-semibold uppercase tracking-wide text-red-600/);
});

test('Configuration health drives status copy and tone without initiating sync', () => {
  assert.match(source, /const syncHealth = resolveTerminalConfigHealth\(runtimeSyncHealth\)/);
  assert.match(source, /const isSyncHealthy = syncHealth\.isHealthy/);
  assert.match(source, /const syncToneClass =[\s\S]*?success: 'bg-green-500'[\s\S]*?warning: 'bg-amber-500'[\s\S]*?danger: 'bg-red-500'[\s\S]*?neutral: 'bg-gray-400'[\s\S]*?\[syncHealth\.tone\]/);
  const admin = adminOverviewSection(source);
  assert.match(admin, /\{syncStatusTitle\}/);
  assert.match(admin, /\{syncStatusHelp\}/);
  const healthStart = source.indexOf('const syncHealth =');
  const healthEnd = source.indexOf('const sectionMeta', healthStart);
  const healthCopy = source.slice(healthStart, healthEnd);
  assert.match(healthCopy, /settings\.workflow\.configHealthyTitle/);
  assert.match(healthCopy, /settings\.workflow\.configHealthyHelp/);
  assert.doesNotMatch(healthCopy, /syncFromAdmin/);
});

// --- Round 281 (supervisor rejection of Round 280): the isSyncHealthy boolean used substring matching
// (`(runtimeSyncHealth || '').toLowerCase().includes(s)`), which wrongly marks negatives as healthy --
// "disconnected" and "not connected" both CONTAIN "connected". That would make the status card lie
// again. It now normalizes (trim + lowercase) and EXACT-matches a healthy Set. ---

test('Configuration health accepts normal polling but never treats disconnected substrings as healthy', () => {
  assert.match(source, /resolveTerminalConfigHealth\(runtimeSyncHealth\)/);
  assert.doesNotMatch(source, /runtimeSyncHealth[\s\S]{0,160}?\.includes\(/);
  for (const value of ['polling', 'healthy', 'online', 'ok', 'synced', 'connected', 'good', 'live', '  Connected ', 'OK']) {
    assert.equal(resolveTerminalConfigHealth(value).isHealthy, true, `${value} must be healthy`);
  }
  for (const value of ['disconnected', 'not connected', 'not_connected', 'offline', 'stale', 'failed', 'degraded', 'unknown', '']) {
    assert.equal(resolveTerminalConfigHealth(value).isHealthy, false, `${value} must not be healthy`);
  }
  assert.equal(resolveTerminalConfigHealth('stale').tone, 'warning');
  assert.equal(resolveTerminalConfigHealth('disconnected').tone, 'danger');
  assert.equal(resolveTerminalConfigHealth('unknown').tone, 'neutral');
});

test('Round 280: non-healthy status title/help keys are localized in every POS locale (Greek is real Greek)', () => {
  const keys = [
    'settings.deviceSetup.overview.statusTitleWarning',
    'settings.deviceSetup.overview.statusHelpWarning',
  ];
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const json = loadLocale(lng);
    for (const key of keys) {
      const value = getKey(json, key);
      assert.equal(typeof value, 'string', `${lng} missing ${key}`);
      assert.ok((value as string).length > 0, `${lng} empty ${key}`);
      assert.notEqual(value, key, `${lng} ${key} leaks the dotted key`);
    }
  }
  const en = loadLocale('en');
  const el = loadLocale('el');
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const key of keys) {
    assert.notEqual(getKey(el, key), getKey(en, key), `el ${key} must be a Greek translation, not English`);
    assert.match(getKey(el, key) as string, GREEK, `el ${key} must be real Greek`);
  }
  // The existing healthy keys are intact (not removed by the dynamic copy).
  assert.equal(typeof getKey(en, 'settings.deviceSetup.overview.statusTitle'), 'string');
  assert.equal(typeof getKey(en, 'settings.deviceSetup.overview.statusHelp'), 'string');
});

// --- Round 288 (live QA, Greek/light, 1282x802): Settings -> Printer -> Configure -> Add Printer showed
// the receipt Live Preview with a bright NATIVE vertical scrollbar on the right edge. The image-preview
// branch was already inside an `overflow-auto scrollbar-hide` viewport with a white edge mask, but the
// HTML-preview branch renders an <iframe srcDoc={preview.html}>: the iframe hosts its OWN document, so the
// parent viewport's `scrollbar-hide` cannot reach the iframe body's scrollbar. The fix prepends a small
// scrollbar-hiding <style> to the preview HTML so the iframe document hides its own rail in every engine
// while STILL scrolling. Printer discovery / save / preview data / receipt rendering are untouched. ---

const printerModalSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'PrinterSettingsModal.tsx'),
  'utf8',
);

test('Round 288: the receipt live-preview iframe injects scrollbar-hiding CSS so no native rail leaks', () => {
  // A module-level style constant carries the cross-engine scrollbar-hiding CSS (Firefox scrollbar-width,
  // legacy Edge -ms-overflow-style, WebKit/Chromium ::-webkit-scrollbar). WebView2 (Tauri on Windows) is
  // Chromium, so the ::-webkit-scrollbar rule is the one that actually kills the leaked rail.
  assert.match(printerModalSource, /const PREVIEW_HIDE_SCROLLBAR_STYLE =/);
  const styleMatch = printerModalSource.match(/const PREVIEW_HIDE_SCROLLBAR_STYLE =\s*'([^']*)'/);
  assert.ok(styleMatch, 'PREVIEW_HIDE_SCROLLBAR_STYLE must be a single-quoted string literal');
  const style = styleMatch![1];
  assert.match(style, /^<style>/, 'the injected snippet must be a <style> block');
  assert.match(style, /<\/style>$/);
  assert.match(style, /html,body\{[^}]*scrollbar-width:none/);
  assert.match(style, /-ms-overflow-style:none/);
  assert.match(style, /html::-webkit-scrollbar,body::-webkit-scrollbar\{[^}]*display:none/);

  // Scrolling + inspectability are preserved: the snippet only suppresses scrollbar chrome -- it must NOT
  // disable scrolling or clip the receipt, and must NOT reset margins (which would shift the layout).
  assert.doesNotMatch(style, /overflow\s*:\s*hidden/);
  assert.doesNotMatch(style, /margin/);

  // The HTML-preview branch composes the style INTO the iframe srcDoc; the raw (unprotected) srcDoc is gone.
  assert.match(printerModalSource, /srcDoc=\{PREVIEW_HIDE_SCROLLBAR_STYLE \+ preview\.html\}/);
  assert.doesNotMatch(printerModalSource, /srcDoc=\{preview\.html\}/);

  // Behaviour preserved: the iframe keeps its sandbox + reserved min-height, and the receipt HTML is still
  // the rendered payload (we only PREPEND a style -- preview.html itself is untouched).
  const iframeStart = printerModalSource.indexOf('srcDoc={PREVIEW_HIDE_SCROLLBAR_STYLE');
  const iframeBlock = printerModalSource.slice(iframeStart, printerModalSource.indexOf('/>', iframeStart) + 2);
  assert.match(iframeBlock, /sandbox="allow-same-origin"/);
  assert.match(iframeBlock, /minHeight: '500px'/);
});

test('Round 288: the live-preview viewport keeps scrollbar-hide and the image branch keeps its edge mask', () => {
  // The preview viewport container still hides its own (outer) scrollbar via the shared utility.
  assert.match(printerModalSource, /overflow-auto scrollbar-hide bg-black\/15 p-3/);

  // The image-preview branch is unchanged: still inside the hidden-scrollbar viewport with the white
  // aria-hidden edge mask (this round only adds the iframe-side fix; it must not regress the image path).
  assert.match(printerModalSource, /alt=\{t\('settings\.printer\.livePreview', 'Live Preview'\) as string\}/);
  assert.match(
    printerModalSource,
    /aria-hidden="true"\s*className="pointer-events-none absolute inset-y-0 right-0 w-4 rounded-r-md bg-white"/,
  );
});

// --- Round 290/291 (history): the cash-register switches were unified to a green/neutral premium glass
// switch with matched geometry. Round 295 superseded the local implementation: CashRegisterSection no
// longer defines its own switch-track class or an inline fiscal button-switch -- all three switches (Auto
// Fiscal Print, Set-as-default, Enabled) render the shared POSGlassSwitch (geometry pinned in Round 295
// below). This test guards that migration: no local class, no inline switch geometry, no yellow ON, and the
// fiscal/default/enabled handlers + aria are preserved. The Print-Mode SELECTION toggles (segmented
// min-h-[44px] button cards) legitimately keep yellow-selected -- those are selection states, not switches. ---

test('Round 290/291/295: cash-register switches use the shared POSGlassSwitch (no local class, no inline geometry, no yellow)', () => {
  // The local switch-track class + the old sr-only-peer track + the inline fiscal button-switch are gone.
  assert.doesNotMatch(cashRegisterSource, /CASH_REGISTER_SWITCH_TRACK_CLASS/);
  assert.doesNotMatch(cashRegisterSource, /role="switch"/, 'the inline fiscal button-switch is replaced by the shared component');
  assert.doesNotMatch(cashRegisterSource, /aria-checked=\{fiscalPrintEnabled\}/);
  // No yellow-gradient ON tokens linger anywhere (the Print-Mode selectors never used these).
  assert.doesNotMatch(cashRegisterSource, /from-yellow-300|to-yellow-500|shadow-yellow-500/);
  assert.doesNotMatch(cashRegisterSource, /peer-checked:bg-gradient-to-b/);

  // All three switches are the shared component, and it is imported.
  assert.match(cashRegisterSource, /import \{ POSGlassSwitch \} from '\.\.\/ui\/pos-glass-components'/);
  const switches = cashRegisterSource.match(/<POSGlassSwitch\b/g) || [];
  assert.ok(switches.length >= 3, `expected >=3 shared cash-register switches, found ${switches.length}`);

  // Handlers + aria preserved: fiscal toggle passes the boolean straight through; default/enabled update
  // the form; each switch is labelled.
  assert.match(cashRegisterSource, /checked=\{fiscalPrintEnabled\}\s*onChange=\{handleFiscalPrintToggle\}/);
  assert.match(cashRegisterSource, /aria-label=\{t\('settings\.peripherals\.cashRegister\.fiscalPrintLabel'/);
  assert.match(cashRegisterSource, /checked=\{form\.is_default\}\s*onChange=\{\(next\) => updateForm\(\{ is_default: next \}\)\}/);
  assert.match(cashRegisterSource, /checked=\{form\.enabled\}\s*onChange=\{\(next\) => updateForm\(\{ enabled: next \}\)\}/);
});

// --- Round 292 (live QA, Greek/light): the Settings > PIN & Lock session-timeout DURATION number field
// read as a dark blue/navy slab when disabled -- its disabled branch used bg-gray-800/50 / border-gray-700
// / text-gray-500, inconsistent with the neutral white/black/grey glass Settings system (and its enabled
// branch used dark-mode-only text-white). Both states now use the shared `.liquid-glass-modal-input` neutral
// glass family (same token as the terminal screen-timeout input); disabled is just muted (opacity +
// cursor-not-allowed), not a separate slab. Behaviour (disabled gate, aria, value, onChange, onBlur,
// min/max) and copy are unchanged. ---

test('Session access explanation keeps neutral glass styling and separates screen sleep from authentication', () => {
  const card = sessionTimeoutCard(source);
  assert.match(card, /liquid-glass-modal-text-muted/);
  assert.match(card, /settings\.workflow\.sessionShift/);
  assert.match(card, /Signing in again does not close the active shift/);
  assert.match(card, /Windows screen sleep is configured separately/);
  assert.doesNotMatch(card, /session-timeout-duration-label|setSessionTimeoutMinutes/);
  assert.doesNotMatch(card, /bg-gray-800\/50|border-gray-700|text-gray-600/);
  assert.doesNotMatch(card, /\b(?:bg|text|border)-(?:blue|indigo|navy|slate)-/);
});

// --- Round 293 (live QA, Greek/light, Settings > Connection): the action area read as assembled/vibecoded
// -- Paste + Test sat on one row, Sync dropped to a second row, and green Save floated separately at the
// right. The secondary cluster is now three EQUAL-WIDTH, SAME-HEIGHT centered neutral-glass buttons
// (flex-1 + min-h-[44px], wrap-friendly Greek) that stack full-width on narrow screens, and Save sits in
// its own CENTERED 44px primary slot below. Palette/handlers/aria unchanged; no hover, no off-theme
// colour, active tap only. (Reuses the connectionSection() helper + extends the Round 195 guard above.) ---

test('Round 293: the connection action bar is a balanced, centered, same-height touch layout with a deliberate Save slot', () => {
  const connection = connectionSection(source);

  // The action bar stacks the secondary cluster above the primary slot (stable column; no uneven wrap).
  assert.match(connection, /data-connection-action-bar className="flex flex-col gap-3 pt-2"/);

  // Secondary cluster: a responsive flex -- a full-width column on narrow, an equal-width row on >=sm with
  // same-height items (items-stretch) -- never the old uneven flex-wrap.
  const barStart = connection.indexOf('data-connection-secondary-actions');
  const primStart = connection.indexOf('data-connection-primary-action');
  const secondary = connection.slice(barStart, primStart);
  assert.match(connection, /data-connection-secondary-actions className="flex flex-col gap-2 sm:flex-row sm:items-stretch"/);
  assert.doesNotMatch(secondary, /flex-wrap/);

  // Each of the (2-3) secondary buttons is flex-1 (equal width), 44px+ tall, with centered wrap-friendly
  // content -- visually balanced, and Greek text wraps neatly centred rather than overflowing.
  const equalSized = secondary.match(/min-h-\[44px\] flex-1 items-center justify-center/g) || [];
  assert.ok(equalSized.length >= 3, 'all three secondary actions must be equal-width, same-height, centered');
  assert.match(secondary, /text-center leading-tight/);
  // They stay neutral glass; no Save / green ever leaks into the secondary cluster.
  const secondaryGlass = secondary.match(/liquidGlassModalButton\('secondary', 'md'\)/g) || [];
  assert.ok(secondaryGlass.length >= 3, 'secondary actions use the neutral glass button family');
  assert.doesNotMatch(secondary, /handleSaveConnection|SAVE_BTN_MD|bg-green/);

  // Primary Save slot: centered (flex justify-center), green SAVE_BTN_MD, 44px+, full-width on narrow with
  // a substantial desktop min-width so it never reads as a tiny floating leftover.
  const primary = connection.slice(primStart);
  assert.match(primary, /data-connection-primary-action className="flex justify-center"/);
  assert.match(primary, /className=\{SAVE_BTN_MD \+ ' min-h-\[44px\] w-full sm:w-auto sm:min-w-\[240px\]'\}/);
  assert.match(primary, /onClick=\{handleSaveConnection\}/);

  // Handlers + aria preserved exactly (UI-only change; no behaviour/sync/auth touched).
  assert.match(secondary, /onClick=\{handlePasteBoth\}/);
  assert.match(secondary, /aria-label=\{t\('modals\.connectionSettings\.pasteBothTooltip'\)\}/);
  assert.match(secondary, /onClick=\{handleTest\}/);
  assert.match(secondary, /onClick=\{handleManualPolicySync\}/);

  // Touch-first + palette: no hover utilities, no native title, no blue/purple/cyan/slate in the action bar.
  const actionBar = connection.slice(connection.indexOf('data-connection-action-bar'));
  assert.doesNotMatch(actionBar, /hover:/);
  assert.doesNotMatch(actionBar, /\btitle=/);
  assert.doesNotMatch(actionBar, /\b(?:bg|text|border|from|to|ring)-(?:blue|indigo|violet|cyan|sky|purple|slate)-/);
});

// --- Round 295 (live QA, Greek/light): Settings switches still rendered at visibly different apparent
// sizes because each surface built its own switch (a peer/pseudo-element track, a native checkbox, or a
// bespoke button). They are now ALL the single shared POSGlassSwitch in pos-glass-components.tsx -- one
// fixed visible geometry (58x34 pill, 28px white knob, 3px inset, 24px travel), green-on / neutral-off
// glass, amber focus, active tap, no hover, never yellow -- wrapped in a transparent >=44px touch target.
// POSGlassToggle delegates to it (its old h-8 w-14 geometry is gone). The per-file migrations are pinned in
// the Round 196/197/227 (ConnectionSettingsModal) and Round 290/291 (CashRegisterSection) tests above, and
// in payment-terminals-ui / terminal-card-tooltip-ui for TerminalConfigModal. ---

const glassComponentsSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'ui', 'pos-glass-components.tsx'),
  'utf8',
);

test('Round 295: POSGlassSwitch is the single shared switch with exact 58x34 / 28 / 3 / 24 geometry', () => {
  // One source of truth: exactly one exported POSGlassSwitch component.
  const defs = glassComponentsSource.match(/export const POSGlassSwitch:/g) || [];
  assert.equal(defs.length, 1, 'there must be exactly one POSGlassSwitch definition');

  // Slice the component body (definition -> displayName) so geometry assertions are scoped to it.
  const start = glassComponentsSource.indexOf('export const POSGlassSwitch:');
  const end = glassComponentsSource.indexOf('POSGlassSwitch.displayName', start);
  assert.ok(end > start, 'POSGlassSwitch.displayName must follow the component');
  const body = glassComponentsSource.slice(start, end);

  // Rendered as a button[role=switch] -- NOT a peer / pseudo-element / native-checkbox variant.
  assert.match(body, /role="switch"/);
  assert.match(body, /aria-checked=\{checked\}/);
  assert.doesNotMatch(body, /sr-only peer/);
  assert.doesNotMatch(body, /peer-checked:/);
  assert.doesNotMatch(body, /after:content/);

  // Transparent >=44px touch target wrapper; the visible pill never changes size.
  assert.match(body, /min-h-\[44px\] min-w-\[44px\][\s\S]*?bg-transparent/);

  // EXACT visible geometry: 58x34 pill, 28px (h-7 w-7) white knob, 3px inset, 24px travel.
  assert.match(body, /h-\[34px\] w-\[58px\] shrink-0 rounded-full/);
  assert.match(body, /absolute top-\[3px\] start-\[3px\] h-7 w-7 rounded-full bg-white/);
  assert.match(body, /translate-x-\[24px\] rtl:-translate-x-\[24px\]/);
  assert.match(body, /translate-x-0/);

  // ON = semantic green glass + soft green glow; OFF = neutral grey glass (light + dark).
  assert.match(body, /border-green-500\/70 bg-green-500 shadow-md shadow-green-500\/40/);
  assert.match(body, /bg-gray-200\/80 shadow-inner dark:border-white\/15 dark:bg-white\/10/);
  // Never a yellow ON for this switch family.
  assert.doesNotMatch(body, /yellow/);

  // Amber keyboard-focus ring + active tap; no hover utilities.
  assert.match(body, /group-focus-visible:ring-2 group-focus-visible:ring-amber-400\/60/);
  assert.match(body, /group-active:scale-95/);
  assert.doesNotMatch(body, /hover:/);
});

test('Round 295: POSGlassToggle delegates to the shared switch (its old h-8 w-14 geometry is gone)', () => {
  const start = glassComponentsSource.indexOf('export const POSGlassToggle:');
  assert.notEqual(start, -1, 'POSGlassToggle must still be exported');
  const body = glassComponentsSource.slice(start);
  // It renders the shared switch internally, forwarding state/handler/disabled.
  assert.match(body, /<POSGlassSwitch checked=\{checked\} onChange=\{onChange\} disabled=\{disabled\}/);
  // The old bespoke toggle geometry (h-8 w-14 track, h-6 w-6 knob, translate-x-7/x-1) is gone file-wide.
  assert.doesNotMatch(glassComponentsSource, /h-8 w-14/);
  assert.doesNotMatch(glassComponentsSource, /translate-x-7/);
});

// --- Round 301 (live QA, Greek/light): the PrinterSettingsModal "Automatic Receipt Actions" rows still
// used a bespoke warm-pill switch (h-8 w-14 track, bg-yellow-400 ON, translate-x-6 knob), contradicting the
// Round 295 unification to the shared green-on / neutral-off POSGlassSwitch. The rows now render
// POSGlassSwitch as the single interactive control (its role="switch" + aria-checked come from the shared
// component, guarded above; aria-label + the handleReceiptActionToggle(key) handler are passed in), so one
// tap toggles exactly once with no nested button. The enabled row/icon/state/AUTO accent moved to emerald
// so the ON state reads as semantic green. Receipt-action state/persistence/toasts/i18n are unchanged. ---

test('Round 301: PrinterSettingsModal receipt-action rows use the shared POSGlassSwitch (no bespoke warm pill)', () => {
  // The modal imports the shared switch.
  assert.match(printerModalSource, /import \{ LiquidGlassModal, POSGlassSwitch \} from '\.\.\/ui\/pos-glass-components'/);

  // Scope strictly to the receipt-action row renderer.
  const start = printerModalSource.indexOf('const renderReceiptActionSwitchRow');
  assert.notEqual(start, -1, 'renderReceiptActionSwitchRow must exist');
  const end = printerModalSource.indexOf('const renderReceiptActionGrid', start);
  assert.ok(end > start, 'renderReceiptActionGrid must follow the row renderer');
  const row = printerModalSource.slice(start, end);

  // The row renders the shared switch, preserving the accessible name + the exact toggle handler. role +
  // aria-checked are delegated to POSGlassSwitch (guarded by the Round 295 geometry test above).
  assert.match(row, /<POSGlassSwitch/);
  assert.match(row, /checked=\{enabled\}/);
  assert.match(row, /onChange=\{\(\) => handleReceiptActionToggle\(key\)\}/);
  assert.match(row, /aria-label=\{`\$\{label\}: \$\{stateLabel\}`\}/);

  // The bespoke pill switch is gone: no h-8 w-14 track, no yellow/amber ON, no translate-x-6 knob.
  assert.doesNotMatch(row, /h-8 w-14/);
  assert.doesNotMatch(row, /bg-yellow|border-yellow|shadow-yellow|from-yellow|to-yellow/);
  assert.doesNotMatch(row, /bg-amber|text-amber|border-amber/);
  assert.doesNotMatch(row, /translate-x-6/);

  // Round 301 correction (Codex review): the WHOLE row is tappable again for touchscreen UX. The row is a
  // clickable <div> (NOT a button -> no nested buttons) that toggles once on tap, with cursor/active
  // feedback...
  assert.match(row, /<div\s+key=\{key\}\s+onClick=\{\(\) => handleReceiptActionToggle\(key\)\}/);
  assert.match(row, /cursor-pointer/);
  assert.match(row, /active:scale-\[0\.99\]/);
  assert.doesNotMatch(row, /<button/);
  // ...and POSGlassSwitch is wrapped in a stopPropagation span, so a tap on the switch toggles exactly once
  // through POSGlassSwitch.onChange and does NOT also bubble to the row onClick (no double toggle).
  assert.match(row, /<span onClick=\{\(event\) => event\.stopPropagation\(\)\}>\s*<POSGlassSwitch/);

  // Enabled state reads as semantic green in BOTH themes: a pale, dark-text surface in light mode and
  // the existing translucent emerald treatment in dark mode.
  assert.match(
    row,
    /border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400\/30 dark:bg-emerald-500\/10 dark:text-emerald-100/,
  );
  assert.match(row, /text-emerald-600 dark:text-emerald-300/);

  // Touch-first: no hover utilities, no native title tooltip in the row.
  assert.doesNotMatch(row, /hover:/);
  assert.doesNotMatch(row, /\btitle=/);
});

test('Round 306: PrinterSettingsModal receipt actions keep cards, labels and dividers readable in light and dark themes', () => {
  const rowStart = printerModalSource.indexOf('const renderReceiptActionSwitchRow');
  assert.notEqual(rowStart, -1, 'renderReceiptActionSwitchRow must exist');
  const rowEnd = printerModalSource.indexOf('const renderReceiptActionGrid', rowStart);
  assert.ok(rowEnd > rowStart, 'renderReceiptActionGrid must follow the row renderer');
  const row = printerModalSource.slice(rowStart, rowEnd);

  // Enabled and disabled cards each own a real light surface/text palette plus an explicit dark variant.
  // Mutating either branch back to white-on-translucent-white must break this regression guard.
  assert.match(
    row,
    /border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400\/30 dark:bg-emerald-500\/10 dark:text-emerald-100/,
  );
  assert.match(
    row,
    /border-slate-200 bg-slate-50\/80 text-slate-800 dark:border-white\/10 dark:bg-slate-900\/60 dark:text-slate-100/,
  );
  assert.match(row, /text-emerald-950 dark:text-emerald-100/);
  assert.match(row, /text-slate-900 dark:text-slate-100/);
  assert.match(row, /text-emerald-700 dark:text-emerald-300/);
  assert.match(row, /text-slate-600 dark:text-slate-400/);
  assert.match(row, /focus-within:ring-2 focus-within:ring-emerald-500\/60 dark:focus-within:ring-emerald-300\/60/);
  assert.doesNotMatch(row, /(?<!dark:)text-white(?:\/\d+)?/);
  assert.doesNotMatch(row, /(?<!dark:)border-white(?:\/\d+)?/);

  // The shared section header and the "new triggers" separator were also white-only in the screenshot.
  const headerStart = printerModalSource.indexOf('const renderSectionHeader');
  const headerEnd = printerModalSource.indexOf('const renderReceiptActionSwitchRow', headerStart);
  const header = printerModalSource.slice(headerStart, headerEnd);
  assert.match(header, /bg-slate-100\/80[^"']*dark:bg-white\/5/);
  assert.match(header, /text-slate-900 dark:text-white\/90/);
  assert.match(header, /text-slate-500 dark:text-white\/50/);
  assert.match(header, /focus-visible:ring-2/);

  const actionsStart = printerModalSource.indexOf('{/* Automatic Receipt Actions');
  const actionsEnd = printerModalSource.indexOf('// Render discovery view', actionsStart);
  assert.ok(actionsEnd > actionsStart, 'receipt action list section must precede discovery view');
  const actions = printerModalSource.slice(actionsStart, actionsEnd);
  assert.match(actions, /border-slate-300 dark:border-white\/10/);
  assert.match(actions, /text-slate-600 dark:text-slate-400/);
});

// Round 305, updated for the managed queue: the hook-driven Settings surface
// keeps the established touch-first palette while adding semantic live controls.
test('Round 305: PrintQueuePanel is touch-first and on-palette (no hover, no sky/blue, 44px actions, hidden rail)', () => {
  const panel = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'printing', 'PrintQueuePanel.tsx'),
    'utf8',
  );

  // (1) No pointer-only hover affordances anywhere on a touchscreen POS.
  assert.doesNotMatch(panel, /hover:/);
  assert.doesNotMatch(panel, /:hover/);
  assert.doesNotMatch(panel, /group-hover:/);
  assert.doesNotMatch(panel, /dark:hover:/);

  // (2) No off-theme sky/blue/indigo/violet/cyan/purple tokens. The printer/queue accent is POS yellow.
  assert.doesNotMatch(panel, /\b(?:bg|text|border|from|to|ring)-(?:sky|blue|indigo|violet|cyan|purple)-/);
  assert.match(panel, /text-yellow-600 dark:text-yellow-300/);
  assert.doesNotMatch(panel, /(?:amber|orange)-\d+/);

  // Light theme owns explicit readable text/surfaces; dark variants are additive rather than white-only.
  assert.match(panel, /bg-white\/80[^"']*text-slate-800/);
  assert.match(panel, /text-slate-700[^"']*dark:text-slate-100/);
  assert.doesNotMatch(panel, /text-white\/(?:35|45|55|60|80|90)/);

  // (3) Round 305 follow-up: the action cluster is a DELIBERATE EQUAL-WIDTH grid, not content-sized chips.
  // The container is full-width stacked cards on narrow widths (grid-cols-1 w-full) and a compact
  // fixed-width column on desktop (md:w-48); there is no flex-wrap chip row that could go ragged in Greek.
  assert.match(
    panel,
    /grid w-full shrink-0 grid-cols-1 gap-2 md:w-56/,
    'the top action cluster must be an equal-width grid (full-width on mobile, fixed column on desktop)',
  );

  // The three top action buttons fill their grid cell (w-full -> identical width in every language), are
  // centered >=44px touch targets with the Settings rounded-2xl family, and keep active: pressed feedback
  // + their disabled states.
  for (const marker of [
    'onClick={() => void queue.refresh()}',
    'onClick={handleQueuePauseToggle}',
    "onClick={() => setConfirmation({ kind: 'bulk' })}",
  ]) {
    const btn = sliceButton(panel, marker);
    assert.match(btn, /\bw-full\b/, `${marker} must be w-full so the grid track sets an equal width`);
    assert.match(btn, /min-h-\[44px\]/, `${marker} must be a >=44px touch target`);
    assert.match(btn, /inline-flex/, `${marker} must be inline-flex`);
    assert.match(btn, /items-center/, `${marker} must vertically center its content`);
    assert.match(btn, /justify-center/, `${marker} must horizontally center its content`);
    assert.match(btn, /rounded-2xl/, `${marker} must use the Settings rounded-2xl family`);
    assert.match(btn, /active:bg-/, `${marker} must give active pressed feedback (not hover)`);
    assert.match(btn, /disabled:bg-slate-100/, `${marker} must preserve a clear disabled surface`);
    assert.match(btn, /disabled:text-slate-500/, `${marker} must preserve readable disabled text`);
  }

  // (4) The queue list overflow region keeps its max-height + scrolling but hides the native rail.
  assert.match(panel, /max-h-96[^"']*overflow-y-auto[^"']*scrollbar-hide/);

  // (5) Semantic colour contract: destructive cancel stays red, retry stays emerald, both with active
  // feedback and readable light/dark variants.
  for (const marker of [
    "onClick={() => setConfirmation({ kind: 'bulk' })}",
    'onClick={() => handleCancelJob(job.id)}',
  ]) {
    const destructive = sliceButton(panel, marker);
    assert.match(destructive, /border-rose-300/, `${marker} must expose a readable light rose border`);
    assert.match(destructive, /bg-rose-50/, `${marker} must expose a readable light rose fill`);
    assert.match(destructive, /text-rose-700/, `${marker} must expose readable light rose text`);
    assert.match(destructive, /dark:active:bg-rose-500\/20/, `${marker} must give dark rose active feedback`);
  }
  const retryRow = sliceButton(panel, 'onClick={() => handleRetryJob(job.id)}');
  assert.match(retryRow, /border-emerald-300/);
  assert.match(retryRow, /bg-emerald-50/);
  assert.match(retryRow, /text-emerald-700/);
  assert.match(retryRow, /dark:active:bg-emerald-500\/20/);

  // The component delegates all loading and mutations to the typed queue hook.
  assert.match(panel, /usePrintQueue\(\{ limit, offset: 0 \}\)/);
  assert.doesNotMatch(panel, /getBridge\(|setInterval\(|clearInterval\(/);
  assert.match(panel, /settings\.printQueue\.empty/);
});

test('Round 357: PrintQueuePanel hides technical job and printer identifiers from staff-facing rows', () => {
  const panel = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'printing', 'PrintQueuePanel.tsx'),
    'utf8',
  );

  assert.match(panel, /UUID_IN_TEXT/);
  assert.match(panel, /OWNERSHIP_MARKER_IN_TEXT/);
  assert.match(panel, /LONG_TECHNICAL_TOKEN_IN_TEXT/);
  assert.match(panel, /operatorSafeDetail/);
  assert.match(panel, /settings\.printQueue\.issue\.genericAttention/);
  assert.doesNotMatch(panel, /settings\.printQueue\.issue\.needsAttention/);
  assert.match(panel, /settings\.printQueue\.entityType\.\$\{normalizeKey\(job\.entityType\)\}/);

  // The normal row no longer renders raw entityId or printerProfileId text. Those values may still be
  // used as bridge/API inputs, but they are not visible metadata in the queue table.
  assert.doesNotMatch(panel, /\{job\.entityId\}/);
  assert.doesNotMatch(panel, />\s*\{job\.printerProfileId\}\s*</);
  assert.doesNotMatch(panel, /\{job\.lastError\}/);
  assert.doesNotMatch(panel, /pausedPrinterProfileIds\.join\(', '\)/);
  assert.doesNotMatch(panel, /spoolJobId|ownershipMarker|nativeStatusBits|documentEnvelope|payload/);
});

test('Greek settings test print reports only a validated managed-queue enqueue', () => {
  const start = printerModalSource.indexOf('const handleGreekTestPrint = async (printerId: string) => {');
  assert.notEqual(start, -1, 'Greek test-print handler must exist');
  const end = printerModalSource.indexOf('// Get diagnostics', start);
  assert.ok(end > start, 'diagnostics handler must follow the Greek test-print handler');
  const handler = printerModalSource.slice(start, end);

  // The old command name stays behind the typed bridge, but success is now
  // accepted only through the exact managed WizardPrintResponse contract.
  assert.match(handler, /api\?\.printerTestGreekDirect\?\.\(printerId\)/);
  assert.match(handler, /parseWizardEnqueueResponse\('encoding', result\)/);
  assert.match(handler, /if \(parsed\.ok\)/);
  assert.match(
    handler,
    /settings\.printer\.greekTestPrintQueued[\s\S]*?Greek test print queued/,
    'the operator must be told only that the managed sample was queued',
  );

  // Queue acceptance is not paper success or transport completion. Legacy
  // direct-dispatch evidence must never appear in this staff-facing message.
  assert.doesNotMatch(
    handler,
    /latencyMs|bytesRequested|bytesWritten|escposCodePage|resolvedTransport|greekTestPrintDispatched|greekTestPrintSuccess|paper/i,
  );

  // Malformed, rejected, and success-without-queued responses fail closed.
  // Backend details remain diagnostic-only and never become toast copy.
  assert.match(handler, /settings\.printer\.testPrintFailed/);
  assert.doesNotMatch(handler, /result\?\.error|result\.error|e\.message/);

  // Preserve the existing busy-state lifecycle around the IPC request.
  assert.match(handler, /setLoading\(true\)/);
  assert.match(handler, /finally \{\s*setLoading\(false\)\s*\}/);
});

test('Greek managed test-print queued copy is complete and translated in every POS locale', () => {
  const key = 'settings.printer.greekTestPrintQueued';
  const locales = ['en', 'el', 'de', 'fr', 'it'] as const;
  const values = Object.fromEntries(locales.map((locale) => [locale, getKey(loadLocale(locale), key)]));

  for (const locale of locales) {
    const value = values[locale];
    assert.equal(typeof value, 'string', `${locale} missing ${key}`);
    assert.ok((value as string).trim().length > 0, `${locale} has blank ${key}`);
    assert.doesNotMatch(value as string, /\[NEEDS TRANSLATION\]/, `${locale} has placeholder ${key}`);
  }

  for (const locale of ['el', 'de', 'fr', 'it'] as const) {
    assert.notEqual(values[locale], values.en, `${locale} ${key} must not leak English copy`);
  }
  assert.match(values.el as string, /[\u0370-\u03FF]/, `el ${key} must contain real Greek`);
});
