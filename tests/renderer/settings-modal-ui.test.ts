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
  assert.match(source, /<span className="pos-rail-item__label">\{sectionLabels\[id\]\}<\/span>/);
  assert.equal((source.match(/scrollbar-thin/g) ?? []).length, 2);
  assert.doesNotMatch(source, /scrollbar-hide/);
  assert.match(source, /contentClassName="overflow-hidden! p-4! sm:p-5!"/);
  // The old workbench shell identifiers are gone.
  assert.doesNotMatch(source, /data-settings-workbench/);
  assert.doesNotMatch(source, /settings-workbench/);
  assert.doesNotMatch(source, /w-56 shrink-0/);
  assert.doesNotMatch(source, /line-clamp-2/);
});


test('ConnectionSettingsModal exposes nine settings sections in three groups via the hub left rail', () => {
  // UI audit wave 7B: one rail of nine plain rows; the section ids and groups live in settings-sections.ts.
  const sections = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'settings', 'settings-sections.ts'), 'utf8');
  assert.match(source, /const settingsNavGroups = buildSettingsNavGroups\(isMainTerminal\)/);
  assert.match(sections, /\{ id: 'register', items: \['status', 'platforms'\] \}/);
  assert.match(sections, /items: \(\['printing', 'payments', 'hardware', 'waiter_devices'\] as SettingsSectionId\[\]\)\.filter\(/);
  assert.match(sections, /\(id\) => id !== 'waiter_devices' \|\| isMainTerminal/);
  assert.match(sections, /\{ id: 'appearance', items: \['terminal', 'security', 'database'\] \}/);

  // A left-rail row selects its section via openSection -> setActiveSettingsSection, marked aria-current.
  assert.match(source, /const openSection = \(section: SettingsSectionId\) => \{/);
  assert.match(source, /setActiveSettingsSection\(section\)/);
  assert.match(source, /onClick=\{\(\) => openSection\(id\)\}/);
  assert.match(source, /aria-current=\{isActive \? 'page' : undefined\}/);

  // Each section body renders directly, gated by the active section; its title is the rail label.
  for (const section of ['status', 'platforms', 'terminal', 'security', 'database', 'hardware', 'printing', 'payments', 'waiter_devices']) {
    assert.match(source, new RegExp(`activeSettingsSection === '${section}'`), `section ${section} must render conditionally`);
    assert.match(source, new RegExp(`${section}: t\\('settings\\.settingsHub\\.nav\\.${section}'`), `${section} needs a rail label`);
  }
  assert.match(source, /<h3 className="pos-pane-title">\{sectionLabels\[activeSettingsSection\]\}<\/h3>/);
  // This register, Connection and Info are one section now.
  assert.doesNotMatch(source, /activeSettingsSection === '(admin|connection|about)'/);
  // The rail rows have no second line.
  assert.doesNotMatch(source, /sectionMeta|\.detail\}/);

  // The removed per-section visibility booleans / handler are gone.
  assert.doesNotMatch(source, /handleSettingsSectionSelect/);
  assert.doesNotMatch(source, /setShowConnectionSettings\(true\)/);
  assert.doesNotMatch(source, /setShowPinSettings\(true\)/);
});


test('Settings left-rail icons are neutral line icons without decorative tiles', () => {
  const navStart = source.indexOf('const settingsNav: Array<{ id: SettingsSectionId; icon: React.ReactNode }>');
  assert.notEqual(navStart, -1, 'settingsNav must exist');
  const navEnd = source.indexOf('const settingsNavGroups', navStart);
  assert.notEqual(navEnd, -1, 'settingsNavGroups must follow settingsNav');
  const navBlock = source.slice(navStart, navEnd);

  // UI audit wave 7B: the open row's fill and bar are the only accent; icons are neutral.
  const iconCount = (navBlock.match(/className="pos-rail-item__icon" aria-hidden="true"/g) ?? []).length;
  assert.equal(iconCount, 9, `all nine Settings nav icons use the neutral rail icon class (found ${iconCount})`);
  assert.doesNotMatch(navBlock, /text-yellow|text-black/);

  const navRenderStart = source.indexOf('aria-current={isActive');
  const navRenderEnd = source.indexOf('</button>', navRenderStart);
  const navRender = source.slice(navRenderStart, navRenderEnd);
  assert.match(navRender, /\{navItem\?\.icon\}/);
  assert.doesNotMatch(navRender, /h-9 w-9|bg-yellow-400 text-black|ring-yellow-500/);
});

// UI audit wave 7Ε: section bodies use the kit group heads; the rail already carries each section's icon,
// so no coloured header icons (the old yellow sectionHeader helper is gone).
test('Wave 7Ε: Settings detail groups have plain kit heads, no coloured header icons', () => {
  assert.doesNotMatch(source, /const sectionHeader = |sectionHeader\(/);
  assert.doesNotMatch(source, /text-yellow-600 dark:text-yellow-300|text-emerald-600 dark:text-emerald-300/);
  for (const marker of ['id="settings-section-security" className="pos-group"', 'data-settings-appearance className="pos-group"', 'data-settings-language className="pos-group"', 'data-session-timeout-card className="pos-group"', 'data-database-safe-fixes className="pos-group"', 'data-database-danger-zone className="group pos-group"']) {
    assert.ok(source.includes(marker), marker);
  }
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
  // UI audit wave 7Γ: the logo lives in «Εμφάνιση απόδειξης», a window stacked over the wizard,
  // so the wizard keeps its step and draft.
  assert.match(openLogoHandler, /setReceiptLookOpen\(true\)/);
  assert.doesNotMatch(openLogoHandler, /resetForm\(|setViewMode\(/, 'opening logo settings must keep the wizard as it is');

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
  // Wave 7B: the section's title is the rail label; its help line is the pane intro.
  assert.match(source, /t\('settings\.peripherals\.helpText'/);
  assert.match(source, /t\('settings\.peripherals\.saveButton'/);
});


test('Wave 7B: the 24 permission and area chips are gone; one sentence says who manages them', () => {
  // Founder-approved 30/10/2026: «Φεύγουν τα 8 + 16 τσιπ· μένει μία πρόταση».
  assert.doesNotMatch(source, /enabledFeatureLabels|enabledModuleNames|OVERVIEW_CHIP_LIMIT|showAllModules/);
  assert.doesNotMatch(source, /data-register-allowed-actions|data-register-active-areas|data-register-summary-tile/);
  assert.match(adminOverviewSection(source), /t\('settings\.workflow\.capabilitiesHelp'/);
});

// Round 194 (Settings "This register" overview redesign, live QA): the admin section used to be a dense
// grid where register id, dashboard URL, allowed-action pills, active-area pills and sync all had
// near-equal visual weight. It is redesigned into an operator-friendly overview -- a plain-language
// status card, large summary tiles (register type / sync / PIN), calm allowed-actions + active-areas
// (a count badge plus the individual localized labels inline, no wall of pills), and a QUIET technical
// details area for register id + dashboard address. Behaviour/data are preserved.
function adminOverviewSection(text: string): string {
  // UI audit wave 7B: the This register overview is the first group of Status & connection.
  const start = text.indexOf('id="settings-status-register"');
  assert.notEqual(start, -1, 'the status section must open with the This register group');
  const end = text.indexOf('id="settings-section-connection"', start);
  assert.notEqual(end, -1, 'the account group must follow the This register group');
  return text.slice(start, end);
}

function statusSection(text: string): string {
  const start = text.indexOf('id="settings-section-status"');
  assert.notEqual(start, -1, 'the status section must exist');
  const end = text.indexOf("activeSettingsSection === 'security'", start);
  assert.notEqual(end, -1, 'the PIN section must follow the status section');
  return text.slice(start, end);
}


test('Wave 7B: Status & connection merges This register, Connection and Info', () => {
  const status = statusSection(source);
  const register = adminOverviewSection(source);

  // This register: the terminal type, one sync status with one Sync now, and the staff PIN.
  assert.match(register, /title=\{resolvedTerminalTypeLabel\}/);
  assert.match(register, /data-register-status-card/);
  assert.match(register, /\{syncStatusTitle\}/);
  assert.match(register, /\{syncStatusHelp\}/);
  assert.match(register, /<StatusLine tone=\{syncStatusTone\}>\{syncHealthLabel\}<\/StatusLine>/);
  assert.match(register, /data-register-sync-action\s+onClick=\{handleManualPolicySync\}/);
  assert.match(register, /t\('sync\.syncNow', 'Sync now'\)/);
  // Exactly one Sync now in the whole of Settings (the Connection duplicate is gone).
  assert.equal((source.match(/data-register-sync-action/g) || []).length, 1, 'expected exactly one Sync action');
  assert.equal((source.match(/onClick=\{handleManualPolicySync\}/g) || []).length, 1, 'no duplicate Sync button');
  assert.match(register, /t\('settings\.status\.staffPin'/);
  assert.match(register, /<StatusLine tone=\{pinResetRequired \? 'warn' : 'ok'\}>/);
  for (const key of ['pinResetShort', 'pinOkShort']) assert.match(register, new RegExp(`t\\('settings\\.deviceSetup\\.overview\\.${key}'`));
  for (const key of ['pinResetRequired', 'pinResetClear']) assert.match(register, new RegExp(`t\\('settings\\.deviceSetup\\.${key}'`));

  // Link to your account: the code, Paste and Save; technician fields only in development builds.
  const account = status.slice(status.indexOf('id="settings-section-connection"'), status.indexOf('id="settings-status-version"'));
  assert.match(account, /<textarea\s+id="settings-connection-code"/);
  assert.match(account, /onClick=\{handlePasteBoth\}/);
  assert.match(account, /data-connection-primary-action\s+onClick=\{handleSaveConnection\}\s+className=\{solidButton\('primary', 'md'\)/);
  assert.match(account, /\{allowManualCredentials && \(\s*<TechDisclosure title=\{t\('settings\.printer\.forTechnicians'/);
  const technicians = account.slice(account.indexOf('{allowManualCredentials && ('));
  for (const field of ['setTerminalId', 'setAdminDashboardUrl', 'setApiKey', 'onClick={handleTest}']) {
    assert.ok(technicians.includes(field), `${field} belongs to the technicians disclosure`);
    assert.ok(account.indexOf(field) > account.indexOf('{allowManualCredentials && ('), `${field} is never outside it`);
  }

  // The version at the bottom; build details behind their own disclosure.
  const version = status.slice(status.indexOf('id="settings-status-version"'));
  assert.match(version, /t\('updates\.available\.version'/);
  assert.match(version, /onClick=\{onCheckForUpdates\}/);
  assert.match(version, /<TechDisclosure title=\{t\('settings\.status\.deviceDetails'/);
  assert.match(version, /onClick=\{handleCopyAboutInfo\}/);
  assert.match(source, /activeSettingsSection !== 'status' \|\| aboutData/);
  assert.ok(status.indexOf('id="settings-status-register"') < status.indexOf('id="settings-section-connection"'));
  assert.ok(status.indexOf('id="settings-section-connection"') < status.indexOf('id="settings-status-version"'));

  // Touchscreen: no native title tooltip + no hover utilities in the section.
  assert.doesNotMatch(status, /<(?:button|div|span|label|textarea|input|p)\b[^>]*\stitle=/);
  assert.doesNotMatch(status, /hover:/);
  assert.doesNotMatch(status, /group-hover:/);
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
  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
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
  assert.doesNotMatch(admin, /<(?:button|div|span|label|p)\b[^>]*\stitle=/);

  // The overview still has exactly one sync action; the raw ids stay out of it.
  assert.equal((admin.match(/data-register-sync-action/g) || []).length, 1, 'exactly one sync action');
  assert.doesNotMatch(admin, /terminalId|adminDashboardUrl|apiKey/);

  // Locale guard: the obsolete deviceSetup overview technicalDetails keys are absent in every POS locale, so a
  // rebuilt renderer bundle no longer carries the "Technical details" / "For support" strings.
  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
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
  assert.match(summary, /min-h-touch(?![\w.-])/);
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
  // UI audit wave 7A2: safe repairs are the neutral kit button, destructive tools red text on it.
  assert.match(source, /const DB_REPAIR_BTN_MD = solidButton\('secondary', 'md'\);/);
  assert.match(source, /const DB_DANGER_BTN_MD = solidButton\('danger', 'md'\);/);

  // Touch-first: no hover-only utilities, no native title tooltip anywhere in the data section.
  assert.doesNotMatch(db, /hover:/);
  assert.doesNotMatch(db, /\btitle=/);

  // New/updated zone copy localized in every POS locale (Greek not English, no raw-key leak).
  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
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
  assert.notEqual(start, -1, 'the account group must exist');
  const end = text.indexOf('id="settings-status-version"', start);
  assert.notEqual(end, -1, 'the version group must follow the account group');
  return text.slice(start, end);
}


test('Round 195 / wave 7B: the connection code has Paste and one yellow Save; Sync and Test are not repeated here', () => {
  const connection = connectionSection(source);
  assert.match(connection, /data-connection-action-bar className="flex flex-wrap gap-3"/);
  const bar = connection.slice(connection.indexOf('data-connection-action-bar'), connection.indexOf('{allowManualCredentials && ('));
  assert.match(bar, /onClick=\{handlePasteBoth\}[\s\S]*?className=\{solidButton\('secondary', 'md'\)\}/);
  assert.match(bar, /onClick=\{handleSaveConnection\}\s+className=\{solidButton\('primary', 'md'\) \+ \(savedPulse === 'connection' \? ' pos-saved' : ''\)\}/);
  assert.match(bar, /t\('modals\.connectionSettings\.save'\)/);
  assert.doesNotMatch(bar, /handleManualPolicySync|handleTest|SAVE_BTN_MD|liquidGlassModalButton/);
  // Touchscreen: no native title tooltip / hover utilities anywhere in the connection group.
  assert.doesNotMatch(connection, /<(?:button|div|span|label|textarea|input)\b[^>]*\stitle=/);
  assert.doesNotMatch(connection, /hover:/);
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

test('Screen & Sound delegates working preferences with no second navigation', () => {
  const terminal = terminalSection(source);
  assert.match(terminal, /<SettingsRuntimePreferences\s+soundExtras=\{\(/);
  // UI audit wave 7B: the platform order sound and the efood mute live with the other sounds.
  assert.match(terminal, /<PlatformNotificationSoundSettings \/>/);
  assert.match(terminal, /\{efoodPartner\.efoodControllable && \(/);
  assert.match(terminal, /onChange=\{\(muted: boolean\) => efoodPartner\.updateSettings\(\{ muted \}\)\}/);
  // Founder rule (one navigation per screen): the settings rail is the only way between sections.
  assert.doesNotMatch(terminal, /onOpenPrinterSettings|onOpenSecurity|openSection\(/);
  assert.doesNotMatch(terminal, /terminal-screen-timeout|terminal-touch-sensitivity|terminal-display-brightness|terminal-receipt-autoprint-label/);
  assert.doesNotMatch(terminal, /setScreenTimeoutMinutes|setTouchSensitivity|setDisplayBrightness|setReceiptAutoPrint/);
  assert.doesNotMatch(terminal, /<(?:button|div|span|label|p|section)\b[^>]*\stitle=|hover:|group-hover:/);
});

// Round 227 (history): the Settings switch was redesigned into a premium green/neutral glass switch.
// Round 295 superseded the local implementation: ConnectionSettingsModal no longer defines its own switch
// track class -- every switch renders the shared POSGlassSwitch (geometry pinned in Round 295 below). This
// test now guards that migration so the local class cannot creep back in.
test('Round 227/295: ConnectionSettingsModal switches use the shared POSGlassSwitch (no local track class)', () => {
  // The local switch-track class + the old label/peer-checkbox wrapper are gone.
  assert.doesNotMatch(source, /const switchTrackClass =/);
  assert.doesNotMatch(source, /sr-only peer/);
  assert.doesNotMatch(source, /<label className="relative inline-flex min-h-touch items-center justify-center cursor-pointer">/);

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
  // The card names Screen & Sound in its text; the rail, not a second button, gets there.
  assert.doesNotMatch(card, /openSection\(/);
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
  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
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
  // tooltip), still sourced from the per-language translation key. Audit 30/10: each button shows
  // the language in its own name (endonym) instead of a two-letter code.
  for (const { name } of LANGUAGE_BUTTONS) {
    assert.match(
      source,
      new RegExp(`aria: 'settings\\.display\\.lang${name}'`),
      `${name} button aria-label must use the settings.display.lang${name} key`,
    );
  }
  assert.match(source, /ariaLabel: t\(aria\)/);
  const endonyms = { el: 'Ελληνικά', en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano', sq: 'Shqip' };
  for (const [code, name] of Object.entries(endonyms)) {
    assert.match(source, new RegExp(`\\{ code: '${code}', name: '${name}'`), `${code} must show its own name`);
  }
  // The layout change must not have touched the language-switch behavior or save toast.
  assert.match(source, /onChange=\{\(code\) => void handleLanguageChange\(code\)\}/);
  assert.match(source, /await setLanguage\(language\)/);
  assert.match(source, /toast\.success\(t\('modals\.connectionSettings\.languageSaved'\)\)/);
  // Portal/blur behavior preserved: the modal still renders through LiquidGlassModal.
  assert.match(source, /<LiquidGlassModal/);
});

test('settings.display.lang* names exist and never leak the raw key in any POS locale', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
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
];

// UI audit wave 7: theme and language are the shared SegmentedControl (role="radio" buttons with
// their visible label; languages also carry lang= and the translated aria-label).
function sliceSegmented(text: string, ariaMarker: string): string {
  const start = text.indexOf(`<SegmentedControl\n            ariaLabel={t('${ariaMarker}')}`);
  assert.notEqual(start, -1, `expected a SegmentedControl for ${ariaMarker}`);
  const end = text.indexOf('\n          />', start);
  return text.slice(start, end + 13);
}

test('ConnectionSettingsModal paste/theme/language controls use aria-label, not native title tooltips', () => {
  for (const { name, marker, aria } of NO_TOOLTIP_CONTROLS) {
    const block = sliceButton(source, marker);
    assert.doesNotMatch(block, /\btitle=/, `${name} button must not carry a native title tooltip`);
    assert.ok(block.includes(aria), `${name} button must expose its accessible name via ${aria}`);
  }
  const theme = sliceSegmented(source, 'modals.connectionSettings.theme');
  assert.doesNotMatch(theme, /\btitle=/);
  assert.match(theme, /onChange=\{\(value\) => handleSaveTheme\(value\)\}/);
  assert.match(theme, /\{t\('modals\.connectionSettings\.light'\)\}/);
  const language = sliceSegmented(source, 'modals.connectionSettings.language');
  assert.doesNotMatch(language, /\btitle=/);
  assert.match(language, /lang: code, ariaLabel: t\(aria\)/);
  const kit = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'settings', 'SettingsKit.tsx'), 'utf8');
  assert.match(kit, /aria-label=\{option\.ariaLabel\}\s+lang=\{option\.lang\}/);
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
  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
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

test('Round 241 / wave 7Δ: the Add/Edit fiscal device form is the shared glass window above Settings', () => {
  // Wave 7Δ: the form is a LiquidGlassModal like every other window. It inherits the Settings layer
  // (cashier-recovery z 2147483100), so it opens above Settings; the old body portal at z-20050 sat
  // under that layer and could not be seen (live CDP, 31/10).
  assert.match(cashRegisterSource, /import \{ LiquidGlassModal, POSGlassSwitch \} from '\.\.\/ui\/pos-glass-components'/);
  assert.match(
    cashRegisterSource,
    /const renderFormModal = \(\) => \(\s*<LiquidGlassModal\s+isOpen=\{viewMode === 'add' \|\| viewMode === 'edit'\}\s+onClose=\{closeForm\}/,
  );
  assert.doesNotMatch(cashRegisterSource, /renderModalPortal|fixed inset-0 z-\d+|pos-glass-scrim/);
  // Actions stay reachable in the window footer; the body scrolls inside the window.
  assert.match(cashRegisterSource, /footer=\{\s*<div className="px-8 py-4 border-t pos-glass-footer">/);
  assert.match(cashRegisterSource, /<div className="space-y-3 \[&_\.liquid-glass-modal-input\]:w-full" data-cash-register-form>/);

  // The list stays mounted under the window; the form is never returned inline.
  assert.match(cashRegisterSource, /\{renderListView\(\)\}\s*\{renderFormModal\(\)\}/);
  assert.doesNotMatch(cashRegisterSource, /return renderFormView\(\)/);

  // ×, backdrop and Escape close it through LiquidGlassModal (topmost only, close-only: never saves);
  // no second document-level Escape listener.
  assert.match(cashRegisterSource, /const closeForm = useCallback\(/);
  assert.doesNotMatch(cashRegisterSource, /event\.key !== 'Escape'/);
});

test('Round 241 / wave 7A2: fiscal submodal Cancel is neutral, Add/Save and the list CTA are the yellow kit primary', () => {
  assert.match(cashRegisterSource, /onClick=\{closeForm\}\s*className=\{solidButton\('secondary', 'md'\)\}/);
  const saveStart = cashRegisterSource.indexOf('onClick={handleSave}');
  const saveBtn = cashRegisterSource.slice(saveStart, cashRegisterSource.indexOf('</button>', saveStart));
  assert.ok(saveStart >= 0, 'save button must exist');
  assert.match(saveBtn, /className=\{solidButton\('primary', 'md'\)\}/);
  const addStart = cashRegisterSource.indexOf('onClick={handleAdd}');
  const addBtn = cashRegisterSource.slice(addStart, cashRegisterSource.indexOf('</button>', addStart));
  assert.ok(addStart >= 0, 'add CTA must exist');
  assert.match(addBtn, /className=\{solidButton\('primary', 'sm'\)\}/);
  for (const btn of [saveBtn, addBtn]) assert.doesNotMatch(btn, /bg-emerald|bg-green|bg-red/);
});

test('Round 241: fiscal device icon actions use aria-labels, never native title tooltips', () => {
  // No native title attribute remains anywhere in the section (touch POS rule), and no hover styles.
  // (Wave 7Δ: kit components such as ConfirmDialog and SettingsRow take a `title` prop for their
  // heading; only a title attribute on a DOM element is a native tooltip.)
  assert.doesNotMatch(cashRegisterSource, /<[a-z][a-z0-9]*\b[^<>]*[^a-zA-Z]title=/);
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
  // Wave 7Δ: the form's × is the shared LiquidGlassModal close (44 px), so the section has none of its own.
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
  // No native tooltip on a DOM element (kit components such as TechDisclosure take a title prop).
  assert.doesNotMatch(callerIdSource, /<[a-z][a-z0-9]*[^<>]*[^a-zA-Z]title=/);
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
    /onClick=\{handleRefresh\}[\s\S]*?liquid-glass-modal-button[\s\S]*?min-h-touch(?![\w.-])[\s\S]*?items-center justify-center/,
  );
  assert.doesNotMatch(callerIdSource, /handleSaveAndActivate|handleDisable|handleTest/);
});

test('server-managed CallerId labels exist in every locale and Greek copy is translated', () => {
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
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
  // Left-rail group label is a normal-case muted label (kit class), not uppercase.
  assert.match(source, /<div className="pos-rail-group">\{navGroupLabels\[group\.id\]\}<\/div>/);
  const railCss = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'styles', 'glassmorphism.css'), 'utf8');
  assert.match(railCss, /\.pos-rail-group \{[^}]*font-size: 13px;[^}]*\}/);
  assert.doesNotMatch(railCss.slice(railCss.indexOf('.pos-rail-group')), /^\.pos-rail[^{]*\{[^}]*text-transform: uppercase/m);
  assert.doesNotMatch(source, /text-\[11px\] font-semibold uppercase tracking-wider/);

  // The This-Register overview eyebrow labels are normal case -- no uppercase / letter-spaced shouting
  // anywhere in the admin overview slice.
  const admin = adminOverviewSection(source);
  assert.doesNotMatch(admin, /uppercase/, 'admin overview labels must not be uppercase');
  assert.doesNotMatch(admin, /tracking-wide/, 'admin overview labels must not be letter-spaced shouted');

  // Audit 30/10: the danger "Cannot be undone" badges are sentence case too (12px, AA on the red tint).
  assert.match(source, /px-2 py-0\.5 text-xs font-semibold text-red-800 dark:text-red-300/);
  assert.doesNotMatch(source, /font-semibold uppercase tracking-wide text-red-600/);
});

test('Configuration health drives status copy and tone without initiating sync', () => {
  assert.match(source, /const syncHealth = resolveTerminalConfigHealth\(runtimeSyncHealth\)/);
  assert.match(source, /const isSyncHealthy = syncHealth\.isHealthy/);
  assert.match(source, /const syncStatusTone = \(\{ success: 'ok', warning: 'warn', danger: 'bad', neutral: 'idle' \}[\s\S]*?\[syncHealth\.tone\]/);
  const admin = adminOverviewSection(source);
  assert.match(admin, /\{syncStatusTitle\}/);
  assert.match(admin, /\{syncStatusHelp\}/);
  const healthStart = source.indexOf('const syncHealth =');
  const healthEnd = source.indexOf('const sectionLabels', healthStart);
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
  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
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

test('Round 288 / audit 30/10: the raster preview scrolls without a scrollbar and nothing covers the image', () => {
  // The preview viewport container still hides its own (outer) scrollbar via the shared utility.
  assert.match(printerModalSource, /overflow-auto scrollbar-hide p-3/);

  // The generated raster PNG is exactly the printable width, with right-aligned amounts in its last
  // pixel column. The former white right-edge mask hid them ("7," for "7,00"); the image now sits on
  // white paper padding and no overlay may cover it.
  assert.match(printerModalSource, /alt=\{t\('settings\.printer\.livePreview', 'Live Preview'\) as string\}/);
  assert.match(printerModalSource, /<div className="rounded-md bg-white px-2 py-3 shadow-sm">\s*<img/);
  assert.doesNotMatch(printerModalSource, /pointer-events-none absolute inset-y-0 right-0 w-4/);
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
  assert.doesNotMatch(cashRegisterSource, /peer-checked:bg-linear-to-b/);

  // All three switches are the shared component, and it is imported.
  assert.match(cashRegisterSource, /import \{ LiquidGlassModal, POSGlassSwitch \} from '\.\.\/ui\/pos-glass-components'/);
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


test('Round 293 / wave 7B: Paste and Save are the same kit size and touch height', () => {
  const connection = connectionSection(source);
  const bar = connection.slice(connection.indexOf('data-connection-action-bar'), connection.indexOf('{allowManualCredentials && ('));
  assert.equal((bar.match(/solidButton\('(?:primary|secondary)', 'md'\)/g) || []).length, 2);
  const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'styles', 'glassmorphism.css'), 'utf8');
  assert.match(css, /\.pos-solid-btn--md \{ min-height: 48px;/);
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
  assert.match(body, /min-h-touch min-w-touch(?![\w.-])[\s\S]*?bg-transparent/);

  // EXACT visible geometry: 58x34 pill, 28px (h-7 w-7) white knob, 3px inset, 24px travel.
  assert.match(body, /h-\[34px\] w-\[58px\] shrink-0 rounded-full/);
  assert.match(body, /absolute top-\[3px\] inset-s-\[3px\] h-7 w-7 rounded-full bg-white/);
  assert.match(body, /translate-x-\[24px\] rtl:translate-x-\[-24px\]/);
  assert.match(body, /translate-x-0/);

  // UI audit wave 7, founder 30/10: ON = solid brand yellow, OFF = opaque grey,
  // no glass, gradient or glow in either theme.
  assert.match(body, /'border-yellow-500 bg-yellow-400 dark:border-yellow-400 dark:bg-yellow-400'/);
  assert.match(body, /'border-zinc-500 bg-zinc-100 dark:border-zinc-500 dark:bg-zinc-800'/);
  assert.doesNotMatch(body, /backdrop-blur|shadow-green|shadow-yellow|from-yellow|to-yellow|bg-white\/10/);

  // Amber keyboard-focus ring + active tap; no hover utilities.
  assert.match(body, /group-focus-visible:ring-2 group-focus-visible:ring-amber-700 dark:group-focus-visible:ring-amber-300/);
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
  // Wave 7Γ: the switch names the action; its checked state says on or off.
  assert.match(row, /aria-label=\{label\}/);

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
  // UI audit wave 7Γ: the row is neutral in both states; the yellow switch carries the state.
  assert.match(row, /className="pos-choice-card pos-choice-card--row min-h-17 cursor-pointer/);
  assert.doesNotMatch(row, /emerald|bg-green/);

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

  // UI audit wave 7Γ: one neutral kit card in both states, theme-aware text tokens; the yellow
  // switch carries the state. Mutating it back to white-on-translucent-white must break this guard.
  assert.match(row, /className="pos-choice-card pos-choice-card--row min-h-17/);
  assert.match(row, /block whitespace-normal wrap-break-word text-sm font-semibold leading-tight liquid-glass-modal-text/);
  // Wave 7Γ: one line per action; the yellow switch says on or off, so no status line repeats it.
  assert.doesNotMatch(row, /stateLabel/);
  assert.doesNotMatch(row, /^\s*AUTO\s*$/m);
  assert.doesNotMatch(row, /\buppercase\b/);
  assert.match(row, /focus-within:ring-2 focus-within:ring-zinc-900 dark:focus-within:ring-zinc-50/);
  assert.doesNotMatch(row, /(?<!dark:)text-white(?:\/\d+)?/);
  assert.doesNotMatch(row, /(?<!dark:)border-white(?:\/\d+)?/);

  // The shared section header and the "new triggers" separator were also white-only in the screenshot.
  const headerStart = printerModalSource.indexOf('const renderSectionHeader');
  const headerEnd = printerModalSource.indexOf('const renderReceiptActionSwitchRow', headerStart);
  const header = printerModalSource.slice(headerStart, headerEnd);
  assert.match(header, /bg-slate-100[^"']*dark:bg-zinc-800/);
  assert.match(header, /text-sm font-semibold text-slate-900 dark:text-white\/90/);
  assert.doesNotMatch(header, /uppercase/);
  assert.match(header, /text-slate-500 dark:text-white\/60/);
  assert.match(header, /aria-expanded=/);
  assert.match(header, /focus-visible:ring-2/);

  // Audit 30/10: the actions are grouped under readable headings with an "N of 12 on" summary,
  // collapsed by default, instead of one list split by a "new triggers" divider.
  // UI audit wave 7Γ: the «Receipts» group shows "N of 12 on" with «Change»; the switches open
  // in their own window, grouped by moment of the day.
  assert.match(printerModalSource, /settings\.printer\.receiptActions\.activeCount/);
  const actionsStart = printerModalSource.indexOf('// Automatic printing: grouped by moment of the day');
  const actionsEnd = printerModalSource.indexOf('// Render add/edit form', actionsStart);
  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart, 'receipt action editor must precede the form view');
  const actions = printerModalSource.slice(actionsStart, actionsEnd);
  assert.match(actions, /settings\.printer\.autoPrintHelp/);
  assert.match(actions, /text-sm font-semibold liquid-glass-modal-text">\{t\(group\.labelKey, group\.label\)\}/);
  assert.doesNotMatch(actions, /newTriggersLabel|uppercase/);
});

// Round 305, updated for the managed queue: the hook-driven Settings surface
// keeps the established touch-first palette while adding semantic live controls.
test('Round 305 / wave 7A2: PrintQueuePanel is touch-first and solid (kit buttons, one row per job, hidden rail)', () => {
  const panel = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'printing', 'PrintQueuePanel.tsx'),
    'utf8',
  );

  // (1) No pointer-only hover affordances anywhere on a touchscreen POS.
  assert.doesNotMatch(panel, /hover:|:hover|group-hover:|dark:hover:/);

  // (2) No off-theme tokens and no tinted fills: the panel is one solid kit group.
  assert.doesNotMatch(panel, /\b(?:bg|text|border|from|to|ring)-(?:sky|blue|indigo|violet|cyan|purple)-/);
  assert.doesNotMatch(panel, /\b(?:bg|border)-(?:yellow|amber|emerald|rose|red|green|slate)-\d/);
  assert.match(panel, /className="pos-group"/);

  // (3) Every action is a kit button (>= 44 px): Retry/Reprint/Resume neutral, Cancel red text.
  for (const marker of [
    'onClick={() => handleRetryJob(job.id)}',
    "onClick={() => setConfirmation({\n                          kind: 'reprint',",
  ]) {
    const start = panel.indexOf(marker.replace('\\n', '\n'));
    assert.ok(start >= 0, `${marker} must exist`);
    assert.match(panel.slice(start, panel.indexOf('</button>', start)), /className=\{solidButton\('secondary', 'sm'\)\}/);
  }
  const cancelJob = panel.slice(panel.indexOf('onClick={() => handleCancelJob(job.id)}'));
  assert.match(cancelJob.slice(0, cancelJob.indexOf('</button>')), /className=\{solidButton\('danger', 'sm'\)\}/);

  // (4) The whole-queue controls live under "Settings for technicians"; the list refreshes itself.
  const technicians = panel.slice(panel.indexOf('<TechDisclosure'), panel.indexOf('</TechDisclosure>'));
  assert.match(technicians, /onClick=\{handleQueuePauseToggle\}[\s\S]*?className=\{solidButton\('secondary', 'md'\)\}/);
  assert.match(technicians, /onClick=\{\(\) => setConfirmation\(\{ kind: 'bulk' \}\)\}[\s\S]*?className=\{solidButton\('danger', 'md'\)\}/);
  assert.doesNotMatch(panel.slice(0, panel.indexOf('<TechDisclosure')), /setConfirmation\(\{ kind: 'bulk' \}\)/);

  // (5) The queue list keeps its height cap and scrolling, with the native rail hidden (kit CSS).
  assert.match(panel, /className="pos-queue__list"/);
  const css = readFileSync(path.join(projectRoot, 'src', 'renderer', 'styles', 'glassmorphism.css'), 'utf8');
  assert.match(css, /\.pos-queue__list \{[^}]*max-height: 24rem;[^}]*overflow-y: auto;[^}]*scrollbar-width: none;/);

  // The component delegates all loading and mutations to the typed queue hook.
  assert.match(panel, /usePrintQueue\(jobFilter === 'failed' \? \{ limit, offset: 0, status: 'failed' \} : \{ limit, offset: 0 \}\)/);
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
  const locales = ['en', 'el', 'de', 'fr', 'it', 'sq'] as const;
  const values = Object.fromEntries(locales.map((locale) => [locale, getKey(loadLocale(locale), key)]));

  for (const locale of locales) {
    const value = values[locale];
    assert.equal(typeof value, 'string', `${locale} missing ${key}`);
    assert.ok((value as string).trim().length > 0, `${locale} has blank ${key}`);
    assert.doesNotMatch(value as string, /\[NEEDS TRANSLATION\]/, `${locale} has placeholder ${key}`);
  }

  for (const locale of ['el', 'de', 'fr', 'it', 'sq'] as const) {
    assert.notEqual(values[locale], values.en, `${locale} ${key} must not leak English copy`);
  }
  assert.match(values.el as string, /[\u0370-\u03FF]/, `el ${key} must contain real Greek`);
});

// UI audit wave 7B (part 2): one title per section — the rail label at the top of the pane.
// Inner titles that repeated it are gone; their help text stays.
test('Wave 7B: each Settings section has one title, the rail label', () => {
  const settingsDir = path.join(projectRoot, 'src', 'renderer', 'components', 'settings');
  const platforms = readFileSync(path.join(settingsDir, 'PlatformsSection.tsx'), 'utf8');
  const waiters = readFileSync(path.join(settingsDir, 'WaiterDevicesSection.tsx'), 'utf8');
  assert.match(source, /<h3 className="pos-pane-title">\{sectionLabels\[activeSettingsSection\]\}<\/h3>/);
  assert.doesNotMatch(source, /t\('settings\.database\.management'/);
  assert.doesNotMatch(source, /t\('settings\.peripherals\.title'/);
  assert.match(source, /hardware: t\('settings\.peripherals\.helpText'/);
  assert.doesNotMatch(platforms, /t\('settings\.platforms\.title'/);
  assert.match(platforms, /t\(\s*'settings\.platforms\.helpText'/);
  assert.doesNotMatch(waiters, /t\('settings\.waiterDevices\.title'/);
  assert.match(waiters, /t\(\s*'settings\.waiterDevices\.helpText'/);
});

// UI audit wave 7Γ (part 2): bold text and the logo are terminal-wide, so they live in
// «Εμφάνιση απόδειξης», a window stacked over the list or the wizard — not in one printer's form.
test('Wave 7Γ: the receipt look is its own stacked window; the printer form no longer carries it', () => {
  const formStart = printerModalSource.indexOf('const renderFormView = () => {');
  const formEnd = printerModalSource.indexOf('// Render diagnostics view', formStart);
  const form = printerModalSource.slice(formStart, formEnd);
  assert.ok(formStart >= 0 && formEnd > formStart, 'found the printer form');
  assert.doesNotMatch(form, /printer-basics-bold|printer-basics-logo/);

  const look = printerModalSource.slice(printerModalSource.indexOf('const renderReceiptLookView'), printerModalSource.indexOf('// Automatic printing: grouped by moment of the day'));
  assert.match(look, /aria-labelledby="receipt-look-bold"[\s\S]*?handleBodyBoldnessChange\(checked \? 3 : 1\)/);
  assert.match(look, /aria-labelledby="receipt-look-logo" checked=\{logoEnabled\} onChange=\{setLogoEnabled\}/);
  assert.match(look, /<DirtyFooter\s+visible=\{logoSettingsChanged\(\)\}/);
  assert.match(look, /onCancel=\{restoreLogoDraft\}/);

  // Stacked over whatever is open (Escape closes only the top window), in both modes.
  assert.match(printerModalSource, /const receiptLookWindow = \(\s*<LiquidGlassModal\s+isOpen=\{isOpen && receiptLookOpen\}\s+onClose=\{\(\) => \{ restoreLogoDraft\(\); setReceiptLookOpen\(false\) \}\}/);
  assert.equal((printerModalSource.match(/\{receiptLookWindow\}/g) || []).length, 2, 'embedded and window modes both render it');
  assert.doesNotMatch(printerModalSource, /'receiptLook'/);
});

// UI audit wave 7Δ (part 1): card machines and the cash register are one Settings section; the
// register's delete confirmation is the shared dialog, so it sits above the Settings window.
test('Wave 7Δ: Cards & cash register shows both devices in the pane; the register jump stays there', () => {
  const payments = source.slice(source.indexOf("{activeSettingsSection === 'payments' && ("), source.indexOf("{activeSettingsSection === 'waiter_devices'"));
  assert.ok(payments.length > 0, 'found the payments section');
  assert.match(payments, /<PaymentTerminalsSection\s+embedded\s+onOpenCashRegisterSetup=\{\(\) => \{[\s\S]*?setCashRegisterSetupIntent\(\{ mode: 'rbs_network', token: Date\.now\(\) \}\)\s*\}\}\s*\/>\s*<CashRegisterSection setupIntent=\{cashRegisterSetupIntent\} \/>/);
  assert.doesNotMatch(source, /showPaymentTerminalsSection|setShowPaymentTerminalsSection/);
  assert.doesNotMatch(payments, /setActiveSettingsSection\(/);
  assert.equal((source.match(/<CashRegisterSection /g) || []).length, 1, 'the register renders only under Cards & cash register');
  assert.match(source, /payments: t\('settings\.settingsHub\.intro\.payments'/);

  const embed = paymentTerminalsSectionSource.slice(paymentTerminalsSectionSource.indexOf('  if (embedded) {'), paymentTerminalsSectionSource.indexOf('  return (\n    <div className="space-y-4">'));
  assert.match(embed, /<section className="pos-group" data-payment-terminals-embedded>/);
  assert.match(embed, /<StatusLine tone=\{isOnline \? 'ok' : 'bad'\}>/);
  assert.match(embed, /className="pos-icon-btn"/);
  assert.doesNotMatch(embed, /MiniStatCard|onBack|ArrowLeft|emerald|green-/);
  assert.match(embed, /\{terminalModals\}/);
});

test('Wave 7Δ: the cash register deletes through the shared ConfirmDialog with light-safe colours', () => {
  assert.match(cashRegisterSource, /import \{ ConfirmDialog \} from '\.\.\/ui\/ConfirmDialog'/);
  assert.match(cashRegisterSource, /<ConfirmDialog\s+isOpen=\{Boolean\(deleteConfirmId\)\}\s+onClose=\{\(\) => setDeleteConfirmId\(null\)\}/);
  assert.match(cashRegisterSource, /variant="error"/);
  assert.doesNotMatch(cashRegisterSource, /z-100|bg-gray-900|text-gray-300|text-gray-400|bg-amber-50 dark:bg-amber-950 text-amber-400/);
  // Same kit shape as «Μηχανές καρτών»: an always-open group, the auto fiscal print as a kit row,
  // notices from the kit, no amber decoration.
  assert.match(cashRegisterSource, /<section className="pos-group" data-cash-register-group>/);
  assert.doesNotMatch(cashRegisterSource, /showDevices|ChevronDown/);
  assert.match(cashRegisterSource, /<SettingsRow[\s\S]{0,200}?title=\{t\('settings\.peripherals\.cashRegister\.fiscalPrintLabel'/);
  assert.match(cashRegisterSource, /role="status" className="pos-notice pos-notice--warn pos-notice--row"/);
  assert.doesNotMatch(cashRegisterSource, /text-amber-(200|400)|bg-amber-50/);

  const discovery = readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'ecr', 'TerminalDiscoveryModal.tsx'), 'utf8');
  const compact = readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'ecr', 'TerminalCardCompact.tsx'), 'utf8');
  for (const [name, text] of [['TerminalDiscoveryModal', discovery], ['TerminalCardCompact', compact]] as const) {
    assert.doesNotMatch(text, /(?<!dark:|dark:active:)(?:bg|border|text)-gray-[4-9]00/, `${name} has no dark-only gray outside dark:`);
  }
});

test('Wave 7Δ: the logo copy says what it does in plain words, in every locale', () => {
  assert.doesNotMatch(printerModalSource, /logoSourceCustomActive|logoSourceFallbackActive|settings\.printer\.useOrgLogo/);
  assert.match(printerModalSource, /help=\{t\('settings\.printer\.logoOnReceiptHelp'/);
  assert.match(printerModalSource, /t\('settings\.printer\.logoFallbackPlain'/);
  const el = JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', 'el.json'), 'utf8'));
  assert.equal(el.settings.printer.logoOnReceiptHelp, 'Τυπώνει το λογότυπο της επιχείρησης στην κορυφή της απόδειξης.');
  for (const lang of ['el', 'en', 'de', 'fr', 'it', 'sq']) {
    const p = JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', `${lang}.json`), 'utf8')).settings.printer;
    for (const key of ['logoOnReceiptHelp', 'logoFileChosenPlain', 'logoFallbackPlain', 'useBusinessLogo']) {
      assert.ok(typeof p[key] === 'string' && p[key].length > 0, `${lang} has settings.printer.${key}`);
      assert.doesNotMatch(p[key], /fallback|εφεδρικ|terminal|τερματικ/i, `${lang} ${key} is plain`);
    }
  }
});

// UI audit wave 7Δ (part 2): devices, Caller ID and waiter phones in kit form; one Save each.
test('Wave 7Δ2: each device is a kit group with one status line; technician fields in the shared disclosure', () => {
  const hardware = source.slice(source.indexOf("{activeSettingsSection === 'hardware' && ("), source.indexOf("{activeSettingsSection === 'payments' && ("));
  assert.ok(hardware.length > 0, 'found the devices section');
  for (const card of ['scale', 'display', 'scanner', 'loyalty']) {
    assert.match(hardware, new RegExp(`<section data-device-card="${card}" className="pos-group">`));
  }
  assert.equal((hardware.match(/<TechDisclosure title=\{t\('settings\.printer\.forTechnicians'/g) || []).length, 3);
  assert.doesNotMatch(hardware, /<details|liquidGlassModalTone|rounded-2xl border liquid-glass-modal-border/);
  assert.match(source, /const deviceStatusLine = \(connected: boolean, enabled: boolean\) => \{[\s\S]*?<StatusLine tone=\{tone\}>/);
  assert.match(source, /className=\{solidButton\(connected \? 'danger' : 'primary', 'md'\) \+ ' self-start'\}/);
  // Unsaved device changes: the kit footer (Save / Cancel back to what is saved), labelled in every language.
  assert.match(hardware, /<DirtyFooter\s+visible=\{hardwareDirty\}[\s\S]*?onSave=\{\(\) => void saveHardwareSettings\(\)\}\s+onCancel=\{restoreHardwareDraft\}/);
  assert.match(source, /const restoreHardwareDraft = \(\) => \{\s*if \(!hardwareBaseline\) return\s*const saved = JSON\.parse\(hardwareBaseline\)/);
});

test('Wave 7Δ2: Caller ID is a kit group with a status line and readable step labels', () => {
  assert.match(callerIdSource, /<section className="pos-group" data-device-card="caller-id">/);
  assert.match(callerIdSource, /<StatusLine tone=\{localStatusError \? 'bad' : statusTone\(status\)\}>/);
  assert.doesNotMatch(callerIdSource, /uppercase|tracking-wide|text-\[11px\]|text-amber-600/);
});

test('Wave 7Δ2: waiter phones save together from one footer with the same payload', () => {
  const waiters = readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'settings', 'WaiterDevicesSection.tsx'), 'utf8');
  assert.doesNotMatch(waiters, /handleSave\(device\)|savingTerminalId|liquidGlassModalButton|opacity-50/);
  assert.match(waiters, /<DirtyFooter\s+visible=\{draftsDirty\}[\s\S]*?onSave=\{\(\) => void handleSaveAll\(\)\}\s+onCancel=\{resetDrafts\}/);
  assert.match(waiters, /quietRefreshBlockedRef\.current = draftsDirty \|\| saving/);
  assert.match(waiters, /\{ enabled_features: nextFeatures \}/);
  assert.match(waiters, /<section key=\{device\.terminalId\} className="pos-group"/);
  assert.match(waiters, /<StatusLine tone=\{device\.online \? 'ok' : 'idle'\}>/);
});

test('Wave 7Δ2: automatic fiscal printing shows only once a register exists', () => {
  assert.match(cashRegisterSource, /\{devices\.length > 0 && \(\s*<SettingsRow[\s\S]{0,200}?fiscalPrintLabel/);
});

test('Wave 7Δ2: the devices and waiter footers are labelled in every locale (no English in Greek)', () => {
  const GREEK = /[\u0370-\u03FF]/;
  for (const lang of ['el', 'en', 'de', 'fr', 'it', 'sq']) {
    const messages = JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', `${lang}.json`), 'utf8'));
    // settings.workflow.pendingChanges lives in the settings-workflow overlay.
    const overlay = JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', 'overlays', `${lang}.settings-workflow.json`), 'utf8'));
    for (const value of [overlay.settings.workflow.pendingChanges, messages.settings.waiterDevices.unsavedNote, messages.settings.waiterDevices.savedMany]) {
      assert.ok(typeof value === 'string' && value.length > 0, `${lang} footer label`);
      if (lang === 'el') assert.match(value, GREEK);
    }
  }
});

// UI audit wave 7Δ2b: Caller ID without the store entitlement is calm; stop listening is not a primary.
test('Wave 7Δ2b: Caller ID reads the entitlement code from the JSON body and keeps raw text in support details', () => {
  assert.match(callerIdSource, /export const CALLER_ID_ENTITLEMENT_REQUIRED = 'CALLER_ID_ENTITLEMENT_REQUIRED'/);
  assert.match(callerIdSource, /JSON\.parse\(message\.slice\(start\)\)[\s\S]{0,120}typeof body\.code === 'string'/);
  assert.match(callerIdSource, /if \(notEntitled\) \{[\s\S]*?<StatusLine tone="idle">[\s\S]*?notEntitledPlain[\s\S]*?\{supportDisclosure\}/);
  // Raw server / listener texts appear only inside the support disclosure.
  assert.doesNotMatch(callerIdSource, /<p className="text-xs">\{serverError\}<\/p>|\{status\.error \|\||Refresh to check again\.'\)\} \{localStatusError\}/);
  const lan = readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'settings', 'CafeLanSettings.tsx'), 'utf8');
  assert.match(lan, /className=\{solidButton\('secondary', 'sm'\)\} onClick=\{\(\) => void run\(async \(\) => \{\s*await getBridge\(\)\.invoke\(status\.running \? 'lan_transport_stop' : 'lan_transport_start'\)/);
  assert.equal((lan.match(/solidButton\('primary'/g) || []).length, 1, 'the pairing code is the one primary');
});

// UI audit wave 7Ε: platforms, display & sound, PIN, backups in kit form.
test('Wave 7Ε: platforms are kit groups with one status line and kit buttons', () => {
  const platforms = readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'settings', 'PlatformsSection.tsx'), 'utf8');
  assert.match(platforms, /className="pos-group"\s+data-platform=\{platform\.plugin_id\}/);
  assert.match(platforms, /<StatusLine tone=\{statusTone\(platform\.open\)\}>/);
  assert.doesNotMatch(platforms, /liquidGlassModalButton|text-amber-700|text-green-700|bg-red-50|rounded-2xl border liquid-glass-modal-border/);
  assert.match(platforms, /onClick=\{\(\) => void loadPlatforms\(\{ refresh: true \}\)\}/);
});

test('Wave 7Ε: the order alert sound list uses kit radio rows, not the native blue radio', () => {
  const sound = readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'settings', 'PlatformNotificationSoundSettings.tsx'), 'utf8');
  assert.match(sound, /className=\{`pos-choice-row\$\{isSelected \? ' is-selected' : ''\}`\}/);
  assert.match(sound, /className="pos-radio"\s+type="radio"/);
  const css = readFileSync(path.join(projectRoot, 'src', 'renderer', 'styles', 'glassmorphism.css'), 'utf8');
  assert.match(css, /\.pos-radio \{ appearance: none;/);
  assert.match(css, /\.pos-radio:checked \{ border-color: var\(--pos-s-fg\); background: var\(--pos-s-bar\);/);
  const prefs = readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'settings', 'SettingsRuntimePreferences.tsx'), 'utf8');
  assert.doesNotMatch(prefs, /pos-card p-4|text-red-600/);
});

test('Wave 7Ε: backups read in sentence case; the danger tools are neutral with red text only', () => {
  const recovery = readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'recovery', 'RecoveryPanel.tsx'), 'utf8');
  assert.doesNotMatch(recovery, /uppercase|tracking-wide|text-\[11px\]|amber-200|bg-amber-50/);
  assert.match(recovery, /<section className="pos-group" data-recovery-panel>/);
  const db = source.slice(source.indexOf("{activeSettingsSection === 'database' && ("), source.indexOf("{activeSettingsSection === 'hardware' && ("));
  assert.doesNotMatch(db, /bg-red-50|border-red-300|border-2/);
  assert.match(db, /<details data-database-danger-zone className="group pos-group">/);
  assert.match(db, /font-semibold text-red-700 dark:text-red-300/);
});
