const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/renderer/components/modals/ConnectionSettingsModal.tsx'), 'utf8');

const missing = `modals.connectionSettings.about
modals.connectionSettings.aboutSubtitle
modals.connectionSettings.adminDashboardUrl
modals.connectionSettings.adminDashboardUrlPlaceholder
modals.connectionSettings.available
modals.connectionSettings.enterAdminUrl
modals.connectionSettings.ghostMode
modals.connectionSettings.ghostModeDisabledByAdmin
modals.connectionSettings.ghostModeHelp
modals.connectionSettings.pinSaveError
modals.connectionSettings.unavailable
settings.about.buildDate
settings.about.copied
settings.about.copyInfo
settings.about.gitSha
settings.about.platform
settings.about.rust
settings.about.version
settings.connection.policySyncFailed
settings.connection.policySynced
settings.database.allOrdersClearFailed
settings.database.allOrdersCleared
settings.database.clearAllOrdersButton
settings.database.clearAllOrdersHelp
settings.database.clearAllOrdersLabel
settings.database.factoryResetPinSubtitle
settings.database.factoryResetPinTitle
settings.peripherals.actionFailed
settings.security.pinResetRequired
settings.settingsHub.subtitle
settings.settingsHub.syncNow
settings.settingsHub.viewDetails
settings.terminal.audioEnabled
settings.terminal.audioHelp
settings.terminal.displayBrightness
settings.terminal.invalidBrightness
settings.terminal.invalidTimeout
settings.terminal.receiptAutoPrint
settings.terminal.receiptAutoPrintHelp
settings.terminal.saveButton
settings.terminal.saveFailed
settings.terminal.saved
settings.terminal.screenTimeout
settings.terminal.touchHigh
settings.terminal.touchLow
settings.terminal.touchMedium
settings.terminal.touchSensitivity`.split('\n');

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const out = {};
for (const key of missing) {
  let val = null;
  const q = "['\"`]";
  const re1 = new RegExp('t\\(\\s*' + q + esc(key) + q + '\\s*,\\s*' + q + '([^\'"`]*)' + q);
  let m = re1.exec(src);
  if (m) val = m[1];
  if (val === null) {
    const re2 = new RegExp('t\\(\\s*' + q + esc(key) + q + '\\s*,\\s*\\{[^}]*defaultValue:\\s*' + q + '([^\'"`]*)' + q);
    m = re2.exec(src);
    if (m) val = m[1];
  }
  out[key] = val;
  console.log(key + '  =>  ' + (val === null ? '((NO DEFAULT FOUND))' : JSON.stringify(val)));
}
fs.writeFileSync(path.join(__dirname, '_defaults.json'), JSON.stringify(out, null, 2));
