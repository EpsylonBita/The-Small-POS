import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// UI audit wave 7 (founder-approved 30/10/2026): settings and dialogs are solid and calm.
// No translucent fills, no glass blur, one yellow primary, a real red for delete, and
// every settings form asks before unsaved changes are dropped.
const rendererRoot = path.join(process.cwd(), 'src', 'renderer');
const read = (...parts: string[]) => readFileSync(path.join(rendererRoot, ...parts), 'utf8');

test('modals are neutral glass (founder 30/10) over opaque controls; glass never carries a colour', () => {
  const css = read('styles', 'glassmorphism.css');
  // Controls: opaque in both themes.
  for (const token of ['--modal-surface', '--modal-surface-elevated', '--modal-surface-subtle', '--modal-border', '--modal-border-strong', '--modal-control-bg', '--modal-control-bg-active']) {
    const values = [...css.matchAll(new RegExp(`${token}: ([^;]+);`, 'g'))].map(m => m[1].trim());
    assert.ok(values.length >= 2, `${token} is defined for light and dark`);
    for (const value of values) assert.match(value, /^#[0-9a-f]{6}$/i, `${token} must be an opaque colour, got ${value}`);
  }
  // Glass: white, black or zinc frost only, never a hue. Founder 01/11: a window's panel in dark is the zinc-800
  // frost (39, 39, 42), a step lighter than the window, so it reads raised on black.
  for (const token of ['--modal-glass', '--modal-glass-border', '--modal-glass-card', '--modal-glass-card-border', '--modal-glass-line', '--modal-backdrop']) {
    const values = [...css.matchAll(new RegExp(`${token}: ([^;]+);`, 'g'))].map(m => m[1].trim());
    assert.ok(values.length >= 2, `${token} is defined for light and dark`);
    for (const value of values) assert.match(value, /^rgba\((?:255, 255, 255|0, 0, 0|9, 9, 11|24, 24, 27|39, 39, 42), 0?\.\d+\)$/, `${token} must be a neutral frost, got ${value}`);
  }
  const shell = css.slice(css.indexOf('.liquid-glass-modal-shell {\n  position: relative;'), css.indexOf('/* Hide scrollbar while keeping scroll functional */'));
  assert.ok(shell.length > 100, 'found the modal shell rule');
  assert.match(shell, /background: var\(--modal-glass\);/);
  assert.match(shell, /backdrop-filter: blur\(40px\) saturate\(1\.15\);/);
  assert.match(shell, /border-radius: 16px;/);
  const backdrop = css.slice(css.indexOf('.liquid-glass-modal-backdrop {'), css.indexOf('.dark .liquid-glass-modal-backdrop {'));
  assert.match(backdrop, /backdrop-filter: blur\(24px\);/);
  // Inside a modal the kit's cards are frosted too; its buttons (choice cards included) stay solid and raised
  // (founder 01/11: the depth comes from the shadow, never from glass), and the segmented well stays sunken.
  assert.match(css, /:is\(\.liquid-glass-modal-shell, \.pos-glass-panel\) :is\(\.pos-group, \.pos-card, \.pos-checks, \.pos-choice-row:not\(\.is-selected\)\) \{ border-color: var\(--modal-glass-card-border\); background: var\(--modal-glass-card\); \}/);
  assert.match(css, /\.pos-choice-card \{[^}]*border: 1px solid transparent;[^}]*background: var\(--pos-s-raised\);[^}]*box-shadow: var\(--pos-s-depth\);/);
  const button = css.slice(css.indexOf('.liquid-glass-modal-button {'), css.indexOf('.liquid-glass-modal-button:active {'));
  assert.doesNotMatch(button, /backdrop-filter/);
  // Founder 01/11: raised — the kit's raised surface and soft shadow, no dark outline.
  assert.match(button, /background: var\(--pos-s-raised\);\s*border: 1px solid transparent;/);
  assert.match(button, /box-shadow: var\(--pos-s-depth\);/);
});

test('modal buttons: solid yellow primary, neutral secondary, red-text danger', () => {
  const ds = read('styles', 'designSystem.ts');
  assert.match(ds, /variant === 'primary'\s*\?\s*'pos-modal-primary'\s*:\s*variant === 'danger'\s*\?\s*'pos-modal-danger'/);
  assert.doesNotMatch(ds, /bg-yellow-400\/20/);
  const css = read('styles', 'glassmorphism.css');
  assert.match(css, /\.liquid-glass-modal-button\.pos-modal-primary \{ border-color: var\(--pos-s-yellow\); background: var\(--pos-s-yellow\); box-shadow: var\(--pos-s-depth-yellow\); color: var\(--pos-s-yellow-fg\); \}/);
  assert.match(css, /\.liquid-glass-modal-button\.pos-modal-danger \{ color: var\(--pos-s-bad\); \}/);
  // State tones are opaque in dark too (no /10 washes).
  const tones = ds.slice(ds.indexOf('export const liquidGlassModalTone'), ds.indexOf('return tones[tone];'));
  assert.doesNotMatch(tones, /\/\d{1,2}\b/);
});

test('the shared switch is opaque: "on" is solid brand yellow (founder 30/10), no green glass', () => {
  const glass = read('components', 'ui', 'pos-glass-components.tsx');
  const sw = glass.slice(glass.indexOf('export const POSGlassSwitch'), glass.indexOf("POSGlassSwitch.displayName"));
  assert.match(sw, /'border-yellow-500 bg-yellow-400 dark:border-yellow-400 dark:bg-yellow-400'/);
  assert.doesNotMatch(sw, /shadow-yellow|from-yellow|to-yellow/);
  // The open-section bar in the Settings rail is the same bright yellow in both themes.
  const css = read('styles', 'glassmorphism.css');
  assert.equal((css.match(/--pos-s-bar: #facc15;/g) ?? []).length, 2);
  assert.doesNotMatch(sw, /backdrop-blur|bg-green-500|bg-white\/10|bg-gray-200\/80/);
});

test('the solid settings kit carries the approved rules', () => {
  const css = read('styles', 'glassmorphism.css');
  const kit = css.slice(css.indexOf('Solid settings kit (UI audit wave 7'));
  assert.match(kit, /\.pos-solid-btn--md \{ min-height: 48px;/);
  assert.match(kit, /\.pos-solid-btn--sm \{ min-height: 44px;/);
  assert.match(kit, /\.pos-seg__opt \{[^}]*min-height: 44px;/);
  assert.match(kit, /\.pos-seg__opt\.is-selected \{ background: var\(--pos-s-sel-bg\);/);
  assert.match(kit, /\.pos-check \{[^}]*min-height: 48px;/);
  assert.doesNotMatch(kit.replace(/\/\*[\s\S]*?\*\//g, ''), /rgba\(|backdrop-filter|:hover|box-shadow: 0 0/);
});

test('every settings form asks before its unsaved changes are dropped', () => {
  const shell = read('components', 'modals', 'ConnectionSettingsModal.tsx');
  assert.match(shell, /<SettingsDirtyProvider report=\{dirtyRegistry\.report\}>/);
  assert.match(shell, /const connectionDirty = connectionCode\.trim\(\) !== '' && connectionCode !== savedConnectionCode/);
  assert.match(shell, /const pinDirty = editingPin && \(pin !== '' \|\| confirmPin !== ''\)/);
  assert.match(shell, /if \(hardwareDirty \|\| otherDirty\) \{/);
  assert.match(shell, /if \(section !== activeSettingsSection && dirtyRegistry\.anyDirty\) \{/);
  assert.match(shell, /settings\.workflow\.unsavedAnyHelp/);
  assert.match(read('components', 'settings', 'WaiterDevicesSection.tsx'), /useReportSettingsDirty\('waiter-devices', draftsDirty\)/);
  assert.match(read('components', 'settings', 'EfoodWeeklyScheduleEditor.tsx'), /useReportSettingsDirty\('efood-schedule', dirty\)/);
  for (const lng of ['el', 'en', 'de', 'fr', 'it', 'sq']) {
    const locale = JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${lng}.json`), 'utf8'));
    assert.equal(typeof locale.settings.workflow.unsavedAnyHelp, 'string', `${lng} unsavedAnyHelp`);
    assert.equal(typeof locale.ecr.actions.delete, 'string', `${lng} ecr.actions.delete`);
    assert.equal(typeof locale.settings.peripherals.cashRegister.confirmDeleteTitle, 'string', `${lng} cash register delete title`);
  }
});

// Founder 30/10 (live till, Screen & Sound): the selected theme, language and rail item were
// still a yellow wash. Settings carries no translucent yellow/amber fill, border or gradient.
test('settings has no translucent yellow or amber washes', () => {
  const translucent = /\b(?:bg|border|from|via|to)-(?:yellow|amber)-\d{2,3}\/\d{1,3}\b/g;
  const files: Array<[string, string]> = [['ConnectionSettingsModal.tsx', read('components', 'modals', 'ConnectionSettingsModal.tsx')]];
  const settingsDir = path.join(rendererRoot, 'components', 'settings');
  for (const name of readdirSync(settingsDir)) {
    if (/\.tsx?$/.test(name)) files.push([name, readFileSync(path.join(settingsDir, name), 'utf8')]);
  }
  for (const [name, text] of files) {
    assert.deepEqual(text.match(translucent) ?? [], [], `${name} must use solid surfaces (SettingsKit / pos-* classes)`);
  }
  const shell = files[0][1];
  // Theme, language and the display connection are the shared solid segmented control.
  assert.match(shell, /<SegmentedControl\s+ariaLabel=\{t\('modals\.connectionSettings\.theme'\)\}/);
  assert.match(shell, /<SegmentedControl\s+ariaLabel=\{t\('modals\.connectionSettings\.language'\)\}/);
  assert.match(shell, /ariaLabel=\{t\('settings\.peripherals\.display\.connectionPlain'/);
  // The open rail item is a solid fill with a bar, not a tint (wave 7B: plain 48 px rows).
  assert.match(shell, /className=\{'pos-rail-item' \+ \(isActive \? ' is-active' : ''\)\}/);
  const css = read('styles', 'glassmorphism.css');
  assert.match(css, /\.pos-rail-item \{[^}]*min-height: 48px;[^}]*background: transparent;/);
  assert.match(css, /\.pos-rail-item\.is-active \{ background: var\(--modal-control-bg-active\); font-weight: 650; \}/);
  assert.match(css, /\.pos-rail-item\.is-active::before \{[^}]*width: 4px;[^}]*background: var\(--pos-s-bar\); \}/);
  assert.match(css, /\.pos-notice--warn \{ border-color: var\(--pos-s-warn\); background: var\(--pos-s-warn-bg\); \}/);
});

// Wave 7B: what the new shell renders is fully solid — no translucent fill or border of any colour
// (white and black included), no glass blur. Later waves add their converted files here.
const ANY_TRANSLUCENT = /\b(?:bg|border|from|via|to|ring)-(?:white|black|[a-z]+-\d{2,3})\/\d{1,3}\b|backdrop-blur/g;
const FULLY_SOLID_SETTINGS_FILES: string[][] = [
  ['components', 'settings', 'SettingsKit.tsx'],
  ['components', 'settings', 'settings-sections.ts'],
  ['components', 'settings', 'CafeLanSettings.tsx'],
  ['components', 'settings', 'PlatformNotificationSoundSettings.tsx'],
  ['components', 'settings', 'SettingsRuntimePreferences.tsx'],
];

test('the settings shell and the parts it moved are fully solid', () => {
  for (const parts of FULLY_SOLID_SETTINGS_FILES) {
    assert.deepEqual(read(...parts).match(ANY_TRANSLUCENT) ?? [], [], `${parts[parts.length - 1]} must stay solid`);
  }
  const shell = read('components', 'modals', 'ConnectionSettingsModal.tsx');
  const rail = shell.slice(shell.indexOf('{settingsNavGroups.map((group) => ('), shell.indexOf('</nav>'));
  assert.ok(rail.length > 200, 'found the rail');
  assert.deepEqual(rail.match(ANY_TRANSLUCENT) ?? [], [], 'the rail must stay solid');
  const status = shell.slice(shell.indexOf('id="settings-section-status"'), shell.indexOf("activeSettingsSection === 'security'"));
  assert.ok(status.length > 2000, 'found the status section');
  assert.deepEqual(status.match(ANY_TRANSLUCENT) ?? [], [], 'Status & connection must stay solid');
});

// Wave 7A2 (founder 30/10: «εδώ συνεχίζει το ίδιο» in the print queue): everything Settings renders
// is solid. The guard walks ConnectionSettingsModal's component imports, so a child added later is
// covered too: no translucent fill/border/ring/gradient/shadow of any colour, no glass blur, no
// rgba glow, and no coloured fill on a button (yellow primary, neutral secondary, red-text danger).
function settingsComponentClosure(): string[] {
  const componentsRoot = path.join(rendererRoot, 'components');
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
      const base = path.resolve(path.dirname(file), m[1]);
      const next = [`${base}.tsx`, path.join(base, 'index.tsx')].find((candidate) => {
        try { readFileSync(candidate); return true; } catch { return false; }
      });
      if (next && next.startsWith(componentsRoot) && !/__tests__|\.test\./.test(next)) visit(next);
    }
  };
  visit(path.join(componentsRoot, 'modals', 'ConnectionSettingsModal.tsx'));
  return [...seen];
}

test('nothing that Settings renders is translucent, glassy or a coloured button', () => {
  const closure = settingsComponentClosure();
  assert.ok(closure.length >= 20, `found the Settings component tree (${closure.length} files)`);
  const translucent = /\b(?:bg|border|from|via|to|ring|divide|outline|shadow)-(?:white|black|[a-z]+-\d{2,3})\/(?:\d{1,3}|\[[0-9.]+\])|backdrop-blur|(?:shadow|drop-shadow)-\[[^\]]*rgba|liquid-glass-modal-(?:warning|success|primary|danger|info|error)\b/g;
  const colouredButton = /<button\b(?:[^>{]|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*?\bbg-(?:red|rose|green|emerald|amber|yellow|orange|lime|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink)-\d{2,3}\b/g;
  for (const file of closure) {
    const src = readFileSync(file, 'utf8');
    const name = path.relative(rendererRoot, file);
    assert.deepEqual(src.match(translucent) ?? [], [], `${name} must stay solid`);
    assert.deepEqual((src.match(colouredButton) ?? []).map((tag) => tag.slice(0, 80)), [], `${name}: buttons use the kit (no coloured fills)`);
  }
  // The print queue: one row per job, whole-queue controls only for technicians, no Refresh button.
  const queue = read('components', 'printing', 'PrintQueuePanel.tsx');
  assert.match(queue, /<TechDisclosure title=\{label\('settings\.printer\.forTechnicians'/);
  const technicians = queue.slice(queue.indexOf('<TechDisclosure'), queue.indexOf('</TechDisclosure>'));
  assert.match(technicians, /onClick=\{handleQueuePauseToggle\}/);
  assert.match(technicians, /onClick=\{\(\) => setConfirmation\(\{ kind: 'bulk' \}\)\}/);
  assert.equal((queue.match(/setConfirmation\(\{ kind: 'bulk' \}\)/g) ?? []).length, 1, 'cancel-all lives only under technicians');
  assert.doesNotMatch(queue, /uppercase|tracking-\[/);
  assert.match(queue, /className="pos-job"/);
});

// ---------------------------------------------------------------------------------------------
// Wave ΣΤ (founder 31/10/2026, «Ναι, ξεκίνα»): the rest of the desktop POS loses its translucent
// colours. Ratchet: every swept area has zero coloured translucent utility classes (bg / border /
// ring / divide / outline / gradient stops / shadow / text with a hue and an /alpha, or an arbitrary
// coloured rgba shadow or fill), except the explicit allowlist below, each with a reason.
// Token map (shared with the Android session): pale washes -> bg-(--pos-s-surface-2), lines ->
// border-(--pos-s-border), notices -> the pos-s warn / bad / ok tints, strong hues stay solid.
const COLOURED_TRANSLUCENT = /(?:^|[\s"'`{])((?:[a-z0-9-]+:)*(?:bg|border(?:-[trblxy])?|ring|ring-offset|divide(?:-[xy])?|outline|from|via|to|shadow|text|fill|stroke)-(?!(?:white|black|gray|slate|zinc|neutral|stone)-)([a-z]+)-\d{2,3}\/(?:\d{1,3}|\[[^\]]+\]))/g;
const ARBITRARY_COLOURED = /(?:shadow|bg|drop-shadow)-\[[^\]]*rgba?\(\s*(\d+)[\s,_]+(\d+)[\s,_]+(\d+)[^\]]*\]/g;
// Wave ΣΤ2: an arbitrary hex with an alpha (`border-[#facc15]/45`) is the same wash in another spelling.
const HEX_ALPHA = /(?:[a-z0-9-]+:)*(?:bg|border(?:-[trblxy])?|ring|ring-offset|divide(?:-[xy])?|outline|from|via|to|shadow|text|fill|stroke)-\[#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\]\/\d{1,3}/g;
const INLINE_RGBA = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0?\.\d+)\s*\)/g;
const hexChannels = (hex: string): number[] =>
  hex.length === 3 ? hex.split('').map(c => parseInt(c + c, 16)) : [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
const SWEPT_AREAS: Record<string, string[]> = {
  'ΣΤ1 primitives, shell, sync': [
    'components/ui/UnsettledPaymentBlockersPanel.tsx', 'components/ui/ErrorAlert.tsx', 'components/ui/ProgressStepper.tsx',
    'components/ui/ContentContainer.tsx', 'components/ui/VarianceBadge.tsx', 'components/ui/UnsavedChargedPaymentBanner.tsx',
    'components/ui/PlatformHeldPaymentNotice.tsx', 'components/ui/FloatingActionButton.tsx', 'components/auth/PINLoginModal.tsx',
    'styles/designSystem.ts', 'components/AppWindowFrame.tsx', 'components/NavigationSidebar.tsx',
    'components/RefactoredMainLayout.tsx', 'components/GlobalCashierGate.tsx', 'components/support/HealthSupportEntryPoint.tsx',
    'App.tsx', 'components/SyncStatusIndicator.tsx',
  ],
  'ΣΤ2 orders': [
    'components/menu/MenuCart.tsx', 'components/modals/OrderDetailsModal.tsx', 'pages/OrdersPage.tsx',
    'components/modals/CustomerSearchModal.tsx', 'components/OrderDashboard.tsx',
    'components/order/OrderApprovalPanel.tsx', 'components/order/OrderCard.tsx', 'pages/KitchenDisplayPage.tsx',
    'components/delivery/DeliveryValidationComponent.tsx', 'components/menu/MenuItemModal.tsx',
    'pages/CustomerDisplayPage.tsx', 'components/modals/CustomerOrderHistoryModal.tsx', 'utils/orderStatus.ts',
    'pages/MenuManagementPage.tsx', 'components/menu/MenuItemCard.tsx',
    'components/menu/OfflineDeliveryZonePicker.tsx', 'components/CustomerInfoForm.tsx',
    'components/dashboards/ProductDashboard.tsx', 'components/modals/AddCustomerModal.tsx',
    'components/modals/EditOrderItemsModal.tsx', 'components/modals/ProductCatalogModal.tsx',
    'pages/DeliveryValidationTestPage.tsx', 'components/menu/MenuCategoryTabs.tsx', 'components/OrderTabsBar.tsx',
    'components/forms/AddressSelectionCard.tsx', 'components/menu/ComboCard.tsx',
    'components/procurement/PurchaseOrdersTab.tsx', 'pages/DeliveryPage.tsx',
    'components/modals/AddNewAddressModal.tsx', 'components/OrderFlow.tsx', 'components/OrderSyncRouteIndicator.tsx',
    'components/menu/ComboChoiceModal.tsx', 'components/delivery/ZoneValidationAlert.tsx',
    'components/modals/OrderCancellationModal.tsx', 'components/order/KitchenStageBadge.tsx',
    'components/order/OrderRoutingBadge.tsx', 'pages/DeliveryZonesPage.tsx', 'pages/NewOrderPage.tsx',
    'components/forms/OrderTypeSelector.tsx', 'components/modals/EditCustomerInfoModal.tsx',
    'components/modals/MenuModal.tsx', 'components/forms/CustomerDetailsForm.tsx', 'components/menu/MenuItemGrid.tsx',
    'components/modals/EditAddressModal.tsx', 'components/notices/MissedPlatformOrdersNoticeManager.tsx',
    'features/customer-messaging/CustomerMessagingPanel.tsx', 'pages/MenuPage.tsx', 'components/BulkActionsBar.tsx',
  ],
  // Tables keep opaque neutral tiles with small status indicators (.claude/rules/pos-parity.md).
  'ΣΤ3 tables': [
    'components/tables/TablesDashboard.tsx', 'components/tables/TableCheckManagerModal.tsx',
    'pages/verticals/hotel/RoomsView.tsx', 'components/tables/TableSelector.tsx', 'components/tables/ReservationForm.tsx',
    'components/tables/TableReleaseOwedModal.tsx', 'components/tables/ReservationInfoPanel.tsx', 'pages/TablesPage.tsx',
    'components/recovery/TableAttemptRecoveryNotice.tsx', 'components/tables/TableFloorPlanModal.tsx',
    'components/tables/TableWorkspace.tsx', 'components/tables/table-workspace.css',
  ],
  // Floating checkout actions stay opaque (.claude/rules/pos-parity.md).
  'ΣΤ4 payments': [
    'components/modals/RefundVoidModal.tsx', 'components/modals/PaymentModal.tsx',
    'components/modals/EditPaymentMethodModal.tsx', 'components/modals/EditSettlementDeltaModal.tsx',
    'components/modals/SplitPaymentModal.tsx', 'components/modals/TipModal.tsx', 'components/modals/StaffShiftGiftClose.tsx',
    'pages/PaymentTerminalsPage.tsx', 'components/modals/LoyaltyRedeemModal.tsx', 'pages/LoyaltyPage.tsx',
    'components/modals/SinglePaymentCollectionModal.tsx', 'components/modals/EditOrderRefundSettlementModal.tsx',
    'components/ecr/TerminalCard.tsx', 'components/modals/RefundAttributionFields.tsx', 'pages/GiftCardFundingPanel.tsx',
    'pages/GiftCardsPage.tsx', 'components/ecr/PaymentDialog.tsx', 'components/modals/StaffShiftCheckoutFooterActions.tsx',
    'components/modals/staff-shift-checkout-footer.css',
  ],
  'ΣΤ5 shift, Z, cash drawer': [
    'components/modals/StaffShiftModal.tsx', 'components/modals/ZReportModal.tsx',
    'components/modals/ZReportExportDialog.tsx', 'components/modals/staff-shift/CloseWithoutHandoverPanel.tsx',
    'components/integrations/MyDataCashierDiscovery.tsx',
  ],
  'ΣΤ6 back-office and printing': [
    'pages/SuppliersPage.tsx', 'components/modals/ExpenseModal.tsx', 'components/recovery/RecoveryCenterPanel.tsx',
    'pages/verticals/salon/AppointmentsView.tsx', 'pages/verticals/hotel/HousekeepingView.tsx',
    'components/FinancialSyncPanel.tsx', 'pages/verticals/restaurant/ReservationsView.tsx',
    'components/modals/EditOptionsModal.tsx', 'pages/IntegrationsPage.tsx', 'pages/InventoryPage.tsx',
    'pages/verticals/salon/ServiceCatalogView.tsx', 'components/DriverDiagnostic.tsx',
    'pages/KioskManagementPage.tsx', 'pages/verticals/salon/StaffScheduleView.tsx',
    'components/modals/RoomStayWorkflowModals.tsx', 'pages/CouponsPage.tsx', 'features/repairs/RepairsShell.tsx',
    'pages/UsersPage.tsx', 'features/repairs/RepairIntakeDialog.tsx', 'pages/OnboardingPage.tsx',
    'components/TerminalTypeIndicator.tsx', 'features/repairs/RepairMoneyPanel.tsx', 'pages/LoginPage.tsx',
    'pages/verticals/fast-food/DriveThruView.tsx', 'components/UpdateDialog.tsx',
    'components/modules/TrialModulePrompt.tsx', 'pages/AnalyticsPage.tsx',
    'pages/verticals/hotel/GuestBillingView.tsx', 'components/DashboardCard.tsx',
    'components/callerid/CallerIdMinimizedPanel.tsx', 'components/modules/LockedFeatureScreen.tsx',
    'components/modules/ModuleUpsellCard.tsx', 'components/recovery/SyncRecoveryModal.tsx',
    'features/repairs/RepairsView.tsx', 'features/repairs/RepairWorkspaceActions.tsx', 'types/tables.ts',
    'components/pricing/SimplePricingModal.tsx', 'components/suppliers/CaptureScanSettingsModal.tsx',
    'components/updates/UpdateReadyModal.tsx', 'components/updates/UpdateToast.tsx', 'utils/guest-billing.ts',
    'components/callerid/CallerIdPopup.tsx', 'components/CaptureNotificationManager.tsx',
    'components/forms/FloorPresetPicker.tsx', 'components/integrations/MyDataCapSetupAssistant.tsx',
    'components/modals/DriverAssignmentModal.tsx', 'components/modals/SatelliteHandoverReleasePanel.tsx',
    'components/modals/UpgradePromptModal.tsx', 'components/scanner/ScanDevicePanel.tsx',
    'components/suppliers/CapturePagesPanel.tsx', 'components/suppliers/CaptureQueuePanel.tsx',
    'pages/verticals/salon/StylistPicker.tsx',
  ],
};
// file -> reason. Add an entry only with a reason the founder or coordinator accepted.
const TRANSLUCENT_ALLOWLIST: Record<string, string> = {
  // The table-shape status halo (.table-shape-halo-* strokes at low opacity) was the founder's own
  // choice on 08/10/2026; asked whether Wave ΣΤ removes it, the founder answered «Να μείνει» (31/10/2026).
  // It stays the only entry.
  'components/tables/table-workspace.css': 'founder kept the table status halo (31/10); dda1b53f6 of 08/10',
};
const colouredTranslucentUses = (src: string): string[] => {
  const hits = [...src.matchAll(COLOURED_TRANSLUCENT)].map(m => m[1]);
  for (const m of src.matchAll(ARBITRARY_COLOURED)) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 12) hits.push(m[0]);
  }
  for (const m of src.matchAll(HEX_ALPHA)) {
    const [r, g, b] = hexChannels(m[1]);
    if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 12) hits.push(m[0]);
  }
  // Inline styles and config objects: a coloured rgba with alpha below 1 is the same wash.
  for (const m of src.matchAll(INLINE_RGBA)) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 12) hits.push(m[0]);
  }
  return hits;
};

for (const [area, files] of Object.entries(SWEPT_AREAS)) {
  test(`Wave ${area}: no coloured translucent classes`, () => {
    for (const file of files) {
      const hits = colouredTranslucentUses(read(...file.split('/')));
      if (TRANSLUCENT_ALLOWLIST[file]) continue;
      assert.deepEqual(hits, [], `${file} still has coloured translucent classes`);
    }
  });
}

test('Wave ΣΤ1: shared styles carry no coloured glow or wash', () => {
  const css = read('styles', 'glassmorphism.css');
  // The floating "+" is the founder's pearl (31/10): a frosted white disc whose pastel sheen and iridescent
  // glow turn slowly, in opaque pastels (no coloured rgba), stopped under reduce-motion. The old orb variables
  // and keyframes stay gone.
  assert.doesNotMatch(css, /--pos-fab-|pos-fab-halo-pulse|pos-fab-orb-wobble|\.pos-fab__gradient-layer \{[^}]*background/);
  // A water drop: half see-through white, no outline (border 0), its edge drawn by an inner light.
  assert.match(css, /\.pos-fab \{[^}]*border: 0;[^}]*background: rgba\(255, 255, 255, 0\.3\);[^}]*backdrop-filter: blur\(4px\) saturate\(1\.25\);/);
  // Two colours like ink in water (founder 31/10): a yellow drop and an opposite drop drifting round together.
  assert.match(css, /\.pos-fab-halo::before \{\s*background: radial-gradient\(circle, #facc15[^}]*animation: pos-pearl-ink-a 16s ease-in-out infinite;/);
  assert.match(css, /\.pos-fab-halo::after \{\s*background: radial-gradient\(circle, #18181b[^}]*animation: pos-pearl-ink-b 16s ease-in-out infinite;/);
  assert.match(css, /\.pos-fab__button-layer \{[^}]*animation: pos-pearl-turn 16s linear infinite;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pos-fab-halo::before,[\s\S]*?animation: none !important;/);
  // Tone classes: neutral solid surface, the tone is the colour of the words.
  const tones = css.slice(css.indexOf('/* Liquid glass variant tones (wave ΣΤ1)'), css.indexOf('.liquid-glass-modal-text {'));
  assert.ok(tones.length > 100, 'found the tone classes');
  assert.doesNotMatch(tones, /rgba\(/);
  // Status variables are the kit's solid notice tints.
  for (const name of ['success', 'warning', 'error', 'pending', 'ready']) {
    assert.match(css, new RegExp(String.raw`--pos-status-${name}: var\(--pos-s-(?:ok|warn|bad)-bg\);`));
  }
  const ds = read('styles', 'designSystem.ts');
  const toneBlock = ds.slice(ds.indexOf('export const liquidGlassModalTone'), ds.indexOf('return tones[tone];'));
  assert.doesNotMatch(toneBlock, /bg-(?:emerald|amber|rose|red|green|yellow)-/, 'tones are neutral surfaces with coloured words');
});

test('Wave ΣΤ2: order styles carry no coloured glow or wash', () => {
  const css = read('styles', 'glassmorphism.css');
  const customizer = css.slice(css.indexOf('/* Ingredient price text'), css.indexOf('/* Ensure ingredient grid items have sharp borders */'));
  assert.ok(customizer.length > 100, 'found the item customizer rules');
  assert.doesNotMatch(customizer, /box-shadow: [^;]*rgba\((?!0, 0, 0)/, 'flavour tabs keep a solid fill, no coloured glow');
  assert.doesNotMatch(customizer, /text-shadow: 0 0 \d+px rgba\((?!255, 255, 255|0, 0, 0)/, 'price words have no coloured glow');
  assert.match(customizer, /\.text-green-500 \{\s*color: var\(--pos-s-ok\) !important;/);
  assert.match(customizer, /\.text-red-400 \{\s*color: var\(--pos-s-bad\) !important;/);
  const globals = read('styles', 'globals.css');
  assert.doesNotMatch(globals, /\.customer-search-yellow-input:focus \{[^}]*rgba\(250, 204, 21/);
});

test('Wave ΣΤ4: payment choices are glass cards with depth and the kit focus outline', () => {
  const css = read('styles', 'glassmorphism.css');
  // Founder 01/11 («αν μπορεί να είναι γυαλί και αυτές»): the frosted card token and the panel depth, both themes.
  for (const method of ['cash', 'card', 'split']) {
    assert.match(css, new RegExp(String.raw`\.liquid-glass-modal-shell button\.payment-option-${method} \{\s*border-color: var\(--modal-glass-card-border\) !important;\s*background: var\(--modal-glass-card\) !important;\s*box-shadow: var\(--pos-s-depth-card\);`));
    assert.match(css, new RegExp(String.raw`\.dark \.liquid-glass-modal-shell button\.payment-option-${method} \{\s*border-color: var\(--modal-glass-card-border\) !important;\s*background: var\(--modal-glass-card\) !important;\s*box-shadow: var\(--pos-s-depth-card\);`));
  }
  // The glyphs hide their back shapes through masks, so nothing shows as a box on the glass.
  const icons = read('components', 'icons', 'PaymentMethodIcons.tsx');
  assert.doesNotMatch(icons, /--pay-icon-fill/);
  assert.match(css, /button\.payment-option-split:focus-visible \{\s*outline: 3px solid var\(--pos-s-fg\);/);
  // The floating checkout summary covers the content beneath it: the opaque kit surface in both themes
  // (founder 01/11; it was #ffffff / #18181b).
  const footer = read('components', 'modals', 'staff-shift-checkout-footer.css');
  assert.match(footer, /\.liquid-glass-modal-shell \.staff-checkout-footer-panel \{\s*background: var\(--pos-s-surface\) !important;/);
  assert.doesNotMatch(footer, /staff-checkout-footer-panel \{[^}]*background: rgba?\(/);
});

// Founder 31/10 («ο κρυφός φωτισμός … μου άρεσε»): the warm light behind the navigation rail and the main
// panel came back. It lives in one named block (pos-shell-glow) with exactly two classes; the scan skips only
// that block, and the block may hold nothing else.
const SHELL_GLOW = /\/\* pos-shell-glow:start[\s\S]*?pos-shell-glow:end \*\//;
test('Wave ΣΤ6: the shared stylesheets carry no coloured translucent rgba', () => {
  for (const file of [['styles', 'glassmorphism.css'], ['styles', 'globals.css'], ['components', 'AppWindowFrame.css']]) {
    assert.deepEqual(colouredTranslucentUses(read(...file).replace(SHELL_GLOW, '')), [], `${file.join('/')} still has a coloured wash or glow`);
  }
  const glow = read('styles', 'glassmorphism.css').match(SHELL_GLOW)?.[0] ?? '';
  const selectors = [...glow.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
  assert.deepEqual(selectors, ['.pos-shell-glow-nav', '.dark .pos-shell-glow-nav', '.pos-shell-glow-panel', '.dark .pos-shell-glow-panel']);
  assert.match(read('components', 'NavigationSidebar.tsx'), /pos-shell-glow-nav/);
  assert.match(read('components', 'ui', 'ContentContainer.tsx'), /pos-shell-glow-panel/);
});

// Wave ΣΤ7 (coordinator 31/10, founder rules): in every form the save / confirm action is the yellow
// primary, never a green or emerald fill; a cancel / close is a neutral secondary, red only for the
// destructive ones listed below; a glass modal button takes the kit primary modifier, because Tailwind
// colours on `.liquid-glass-modal-button` lose to the unlayered glass CSS (black text on dark in dark).
const rendererTsx = (): Array<{ rel: string; src: string }> => {
  const out: Array<{ rel: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) out.push({ rel: path.relative(rendererRoot, full).split(path.sep).join('/'), src: readFileSync(full, 'utf8') });
    }
  };
  walk(rendererRoot);
  return out;
};
const buttonBlocks = (src: string): Array<{ block: string; className: string }> =>
  [...src.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => ({
    block: m[0],
    className: (/className=("[^"]*"|\{`[\s\S]*?`\})/.exec(m[0]) || ['', ''])[1],
  }));
const SAVE_LABEL = /t\(\s*['"`][\w.-]*\.(?:save\w*|confirm\w*|create\w*|submit\w*|complete\w*)['"`]/i;
const CANCEL_LABEL = /t\(\s*['"`][\w.-]*\.(?:cancel|close|dismiss)['"`]/i;
// file -> reason: cancel / close buttons that are destructive and keep red words.
const RED_CANCEL_ALLOWLIST: Record<string, string> = {
  'components/AppWindowFrame.tsx': 'the title-bar close button quits the window',
  'components/ecr/PaymentDialog.tsx': 'cancels a card payment that is in progress on the terminal',
};

test('Wave ΣΤ7: save / confirm actions are never green; cancels are neutral unless destructive', () => {
  const green: string[] = [];
  const redCancel: string[] = [];
  const glassTailwindPrimary: string[] = [];
  for (const { rel, src } of rendererTsx()) {
    for (const { block, className } of buttonBlocks(src)) {
      if (SAVE_LABEL.test(block) && /(?:^|[\s'"`{])(?:active:)?bg-(?:green|emerald)-\d00(?![\d/])/.test(className)) green.push(rel);
      if (!SAVE_LABEL.test(block) && CANCEL_LABEL.test(block) && !RED_CANCEL_ALLOWLIST[rel]
        && !/delete|destructive|danger|Trash2/i.test(block)
        && /(?:^|[\s'"`{])(?:text|border|bg)-(?:red|rose)-\d00(?![\d/])/.test(className)) redCancel.push(rel);
      if (/liquid-glass-modal-button/.test(className) && /bg-\(--pos-s-yellow\)|bg-yellow-400/.test(className)) glassTailwindPrimary.push(rel);
    }
  }
  assert.deepEqual(green, [], 'save / confirm buttons must be the yellow primary, not green');
  // Class strings held in variables or maps too: a green / emerald fill with white or black words is a
  // primary action dressed green. Only status icons (not actions) may keep it.
  const GREEN_ACTION_ALLOWLIST: Record<string, string> = {
    'components/auth/PINLoginModal.tsx': 'the round check icon that confirms a saved PIN (an icon, not an action)',
    'components/SyncStatusIndicator.tsx': 'the healthy-sync icon box (a status icon, not an action)',
  };
  const greenLiterals: string[] = [];
  for (const { rel, src } of rendererTsx()) {
    if (GREEN_ACTION_ALLOWLIST[rel]) continue;
    for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\n])*)\1/g)) {
      if (/(?<![a-z:-])bg-(?:green|emerald)-(?:500|600|700|800|900)!?(?![\d/])/.test(m[2]) && /(?<![a-z:-])text-(?:white|black|slate-950)!?(?![\w/-])/.test(m[2])) greenLiterals.push(rel);
    }
  }
  assert.deepEqual(greenLiterals, [], 'no class string fills an action green / emerald (yellow primary instead)');
  assert.deepEqual(redCancel, [], 'cancel / close buttons must be neutral unless destructive (allowlist)');
  assert.deepEqual(glassTailwindPrimary, [], 'a glass modal primary uses .pos-modal-primary, not Tailwind yellow');
});

// Wave ΣΤ8b (coordinator 31/10): the new-order menu modal and the yellow selection leftovers.
const MENU_MODAL_FILES = [
  ['components', 'menu', 'MenuCart.tsx'], ['components', 'menu', 'MenuItemCard.tsx'], ['components', 'menu', 'MenuItemGrid.tsx'],
  ['components', 'menu', 'ComboCard.tsx'], ['components', 'menu', 'ComboChoiceModal.tsx'], ['components', 'menu', 'MenuItemModal.tsx'],
  ['components', 'modals', 'MenuModal.tsx'],
];
const SELECTION_LEFTOVER_FILES = [
  ['components', 'modals', 'ZReportExportDialog.tsx'], ['components', 'ui', 'pos-glass-components.tsx'], ['pages', 'LoyaltyPage.tsx'],
  ['pages', 'verticals', 'hotel', 'GuestBillingView.tsx'], ['pages', 'OnboardingPage.tsx'], ['pages', 'verticals', 'restaurant', 'ReservationsView.tsx'],
  ['pages', 'verticals', 'salon', 'AppointmentsView.tsx'], ['components', 'modals', 'RoomStayWorkflowModals.tsx'],
  ['components', 'forms', 'OrderTypeSelector.tsx'], ['components', 'modals', 'EditPaymentMethodModal.tsx'],
  ['components', 'modals', 'EditOptionsModal.tsx'], ['components', 'modals', 'ExpenseModal.tsx'], ['pages', 'GiftCardFundingPanel.tsx'],
  ['pages', 'KitchenDisplayPage.tsx'], ['pages', 'MenuManagementPage.tsx'], ['pages', 'SuppliersPage.tsx'],
];
// A selected state written in yellow / amber: a fill, a yellow outline or a yellow ring after a condition.
const YELLOW_SELECTED_CLASS = /\?\s*["'`][^"'`]*(?:bg-amber-500 border-amber-400|border-amber-400 bg-amber-500|border-yellow-400 bg-yellow-400|bg-yellow-400 text-black border|bg-yellow-500 text-black font-semibold|border-yellow-400 bg-(?:transparent|\(--pos-s-surface-2\))|ring-2 ring-yellow-400)[^"'`]*["'`]/g;

test('Wave ΣΤ8b: menu modal and leftover selections use the kit selection, never yellow', () => {
  const hits: string[] = [];
  for (const parts of [...MENU_MODAL_FILES, ...SELECTION_LEFTOVER_FILES]) {
    // An action whose variant is 'primary' is the yellow primary, not a selection.
    const src = read(...parts).replace(/variant === 'primary' \? '[^']*'/g, '');
    for (const m of src.matchAll(YELLOW_SELECTED_CLASS)) hits.push(`${parts.join('/')}: ${m[0].slice(0, 80)}`);
  }
  assert.deepEqual(hits, []);
});

test('Wave ΣΤ8b: product cards carry a neutral kit border and a muted description', () => {
  const card = read('components', 'menu', 'MenuItemCard.tsx');
  assert.doesNotMatch(card, /border-\(--pos-s-yellow\)|border-yellow-\d00/);
  // Founder 31/10: a customizable card is the neon card (yellow glow from the edges inward), not a yellow border class.
  assert.match(card, /'pos-neon-card bg-\(--pos-s-surface\) border-\(--pos-s-border\) active:bg-\(--pos-s-surface-2\)'/);
  assert.match(read('styles', 'glassmorphism.css'), /\.pos-neon-card \{ border-color: #facc15 !important; box-shadow: inset 0 0 3px #facc15, inset 0 0 16px #facc15; \}/);
  assert.doesNotMatch(read('components', 'menu', 'MenuItemGrid.tsx'), /'text-yellow-800'/);
  assert.match(card, /line-clamp-2 mb-1\.5 antialiased \$\{\s*'text-\(--pos-s-muted\)'/);
});

test('Wave ΣΤ8b: menu modal text and icons reach AA on light (no light amber-600/700, no yellow-500/600/700 ink)', () => {
  const hits: string[] = [];
  for (const parts of MENU_MODAL_FILES) {
    for (const m of read(...parts).matchAll(/(?<![:\w-])text-(?:amber-(?:600|700)|yellow-(?:500|600|700))\b/g)) hits.push(`${parts.join('/')}: ${m[0]}`);
  }
  assert.deepEqual(hits, []);
});

// Wave ΣΤ8 (coordinator 31/10): a selected menu category / subcategory tab is the kit selection.
test('Wave ΣΤ8: selected menu category tabs use the kit selection, not yellow', () => {
  const tabs = read('components', 'menu', 'MenuCategoryTabs.tsx');
  assert.doesNotMatch(tabs, /bg-yellow-400/);
  assert.equal(tabs.match(/border-\(--pos-s-sel-bg\) bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\)/g)?.length, 4);
  assert.match(tabs, /data-testid="menu-categories"/);
});

// Found in the ΣΤ7 live sweep: the tables view mode (List / 2D) and floor chips were selected in yellow.
test('Wave ΣΤ7: table view mode and floor selection use the kit selection, not yellow', () => {
  const css = read('components', 'tables', 'table-workspace.css');
  const rule = css.match(/\.table-workspace-view-mode button\[aria-pressed='true'\][^{]*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /background:\s*var\(--pos-s-sel-bg\)/);
  assert.match(rule, /color:\s*var\(--pos-s-sel-fg\)/);
  const dashboard = read('components', 'tables', 'TablesDashboard.tsx');
  assert.doesNotMatch(dashboard, /(?:tableViewMode === 'list'|floorPlanModalOpen|filter === status|floorFilter === (?:'all'|floor))\s*\?\s*'bg-yellow-400/);
});

// Founder 31/10: «οι επιλογές κουμπιών παντού πρέπει να είναι κίτρινα αντί για μαύρα». The kit selection
// token is the one source of a selected look, and it is the brand yellow with dark words in both themes.
// Literal yellow classes stay banned above, so every selection keeps following this one token.
test('founder 31/10: the kit selection is yellow in both themes, and no selection is drawn in black', () => {
  const css = read('styles', 'glassmorphism.css');
  const kitBlocks = [...css.matchAll(/(:root|html\.dark) \{([^}]*--pos-s-sel-bg[^}]*)\}/g)];
  assert.deepEqual(kitBlocks.map((m) => m[1]), [':root', 'html.dark'], 'the kit defines the selection once per theme');
  for (const [, , block] of kitBlocks) {
    assert.match(block, /--pos-s-sel-bg: #facc15;/);
    assert.match(block, /--pos-s-sel-fg: #18181b;/);
  }
  assert.match(css, /\.pos-choice-row\.is-selected \{[^}]*border: 2px solid var\(--pos-s-sel-bg\)/);
  assert.match(css, /\.pos-choice-card\.is-selected \{[^}]*border: 2px solid var\(--pos-s-sel-bg\)/);
  // A selected card / line / ring takes the selection colour, never the black fg.
  const black: string[] = [];
  for (const { rel, src } of rendererTsx()) {
    for (const m of src.matchAll(/(?:isSelected|isSelectedLine|chosen|selected\w*\?\.id === \w+\.id|=== option\.staffId)\s*\)?\s*\?\s*(?:\(isDark \? )?['`]([^'`]*)['`]/g)) {
      if (/(?:ring|border)-\(--pos-s-fg\)/.test(m[1])) black.push(`${rel}: ${m[1].slice(0, 80)}`);
    }
  }
  assert.deepEqual(black, []);
});

// Wave ΣΤ1 lesson: a removed CSS block once took the @layer's closing brace with it and the app showed
// only Vite's error overlay. Every shared stylesheet must parse.
test('shared stylesheets parse (balanced blocks)', async () => {
  const postcss = (await import('postcss')).default;
  for (const file of [['styles', 'glassmorphism.css'], ['styles', 'globals.css'], ['components', 'AppWindowFrame.css']]) {
    assert.doesNotThrow(() => postcss.parse(read(...file)), `${file.join('/')} must parse`);
  }
});

// Founder 01/11 («να σέρνεται δεξιά αριστερά αλλά να χάνονται χωρίς να κόβεται»): a sideways row hides its rail,
// pans with a finger, fades only at an edge with more to show, and keeps room for the raised shadows.
test('the kit scroll row: no rail, finger pan, edge fades, room for shadows, installed once', () => {
  const css = read('styles', 'glassmorphism.css');
  assert.match(css, /\.pos-scroll-row \{[^}]*margin-inline: -14px;[^}]*padding: 4px 14px 16px;[^}]*overflow-x: auto;[^}]*scrollbar-width: none;[^}]*touch-action: pan-x;/);
  assert.match(css, /\.pos-scroll-row\[data-fade-start='on'\] \{ --pos-row-fade-start: 48px; \}/);
  assert.match(css, /\.pos-scroll-row\[data-fade-end='on'\] \{ --pos-row-fade-end: 48px; \}/);
  const entry = readFileSync(path.join(process.cwd(), 'src', 'main.tsx'), 'utf8');
  assert.match(entry, /await import\('\.\/renderer\/utils\/scroll-rows'\);\s*installScrollRows\(\);/);
});

