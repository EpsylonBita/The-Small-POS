import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const posRoot = resolve(scriptDirectory, '..')
const tauriConfig = JSON.parse(
  readFileSync(resolve(posRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
)
const hookSource = readFileSync(
  resolve(posRoot, 'src-tauri', 'nsis-hooks.nsh'),
  'utf8',
)
const firewallHelperPath = resolve(
  posRoot,
  'src-tauri',
  'caller-id-firewall.ps1',
)
const firewallHelperSource = existsSync(firewallHelperPath)
  ? readFileSync(firewallHelperPath, 'utf8')
  : ''
const firewallRuntimeSource = readFileSync(
  resolve(posRoot, 'src-tauri', 'src', 'commands', 'callerid_firewall.rs'),
  'utf8',
)
const ipcAdapterSource = readFileSync(
  resolve(posRoot, 'src', 'lib', 'ipc-adapter.ts'),
  'utf8',
)

const failures = []
const requireContract = (condition, message) => {
  if (!condition) failures.push(message)
}
const macroBody = (name) =>
  new RegExp(`!macro\\s+${name}\\b([\\s\\S]*?)!macroend`, 'i').exec(
    hookSource,
  )?.[1] ?? ''

requireContract(
  tauriConfig.bundle?.windows?.nsis?.installerHooks === './nsis-hooks.nsh',
  'tauri.conf.json must load ./nsis-hooks.nsh',
)
requireContract(
  Array.isArray(tauriConfig.bundle?.resources) &&
    tauriConfig.bundle.resources.includes('caller-id-firewall.ps1'),
  'the Caller ID firewall helper must be bundled for the in-app permission control',
)

const postInstall = macroBody('NSIS_HOOK_POSTINSTALL')
const postInstallMacroIndex = hookSource.search(/!macro\s+NSIS_HOOK_POSTINSTALL\b/i)
const helperDefineMatch =
  /!define\s+CALLER_ID_FIREWALL_HELPER\s+["']\$\{__FILEDIR__\}\\caller-id-firewall\.ps1["']/i.exec(
    hookSource,
  )
const promptIndex = postInstall.search(/MessageBox\s+MB_YESNO/i)
const installActionIndex = postInstall.search(/-Action\s+Install\b/i)
const migrationActionIndex = postInstall.search(
  /-Action\s+MigrateLegacyPublic\b/i,
)
const doneLabelIndex = postInstall.search(/caller_id_firewall_done:/i)

requireContract(postInstall.length > 0, 'NSIS_HOOK_POSTINSTALL is required')
requireContract(
  helperDefineMatch !== null &&
    helperDefineMatch.index < postInstallMacroIndex &&
    /File\s+\/oname=\$PLUGINSDIR\\caller-id-firewall\.ps1\s+["']\$\{CALLER_ID_FIREWALL_HELPER\}["']/i.test(
      postInstall,
    ),
  'the helper path must be captured at hook include time before the macro is expanded',
)
requireContract(
  !/\$\{__FILEDIR__\}/i.test(postInstall),
  '__FILEDIR__ must not be evaluated inside the hook macro call site',
)
requireContract(promptIndex >= 0, 'interactive installs must ask for consent')
requireContract(
  /IDNO\s+caller_id_firewall_done/i.test(postInstall),
  'No must leave firewall settings unchanged',
)
requireContract(
  promptIndex >= 0 && installActionIndex > promptIndex,
  'the interactive Private-network grant must happen only after consent',
)
requireContract(
  /IfSilent\s+caller_id_firewall_update_migration/i.test(postInstall),
  'silent installs must enter the non-interactive migration branch',
)
requireContract(
  /\$PassiveMode\s*(?:==|=)\s*1[\s\S]*?Goto\s+caller_id_firewall_update_migration/i.test(
    postInstall,
  ),
  'passive installs must enter the non-interactive migration branch',
)
requireContract(
  !/\$UpdateMode\s*(?:==|=)\s*1[\s\S]*?Goto\s+caller_id_firewall_update_migration/i.test(
    postInstall.slice(0, promptIndex),
  ),
  'interactive updater installs must reach the explicit Private-network consent prompt',
)
requireContract(
  migrationActionIndex >= 0 && migrationActionIndex < doneLabelIndex,
  'the updater branch must invoke legacy-Public migration before exiting',
)
requireContract(
  /caller_id_firewall_update_migration:[\s\S]*?\$UpdateMode\s*<>\s*1[\s\S]*?Goto\s+caller_id_firewall_done/i.test(
    postInstall,
  ),
  'silent/passive fresh installs must not create a new inbound grant',
)
requireContract(
  !/advfirewall\s+firewall\s+add\s+rule/i.test(postInstall),
  'firewall policy must be centralized in the testable PowerShell helper',
)

requireContract(
  firewallHelperSource.length > 0,
  'caller-id-firewall.ps1 is required',
)
requireContract(
  /ValidateSet\([^)]*['"]Install['"][^)]*['"]MigrateLegacyPublic['"][^)]*['"]Status['"][^)]*['"]Remove['"]/i.test(
    firewallHelperSource,
  ),
  'the helper must expose install, migration, status, and removal actions only',
)
requireContract(
  /function\s+Get-InstallerOwnedRuleConfigurationIssue\b/i.test(firewallHelperSource) &&
    /\$Action\s+-eq\s+['"]Status['"][\s\S]*?Get-InstallerOwnedRuleConfigurationIssue/i.test(
      firewallHelperSource,
    ),
  'runtime status must classify the complete installer-owned rule instead of trusting its name',
)
requireContract(
  /\$Action\s+-eq\s+['"]Remove['"][\s\S]*?Remove-InstallerOwnedRule[\s\S]*?exit\s+0/i.test(
    firewallHelperSource,
  ),
  'runtime removal must delete only the installer-owned rule and stop before install logic',
)
requireContract(
  /Get-NetFirewallApplicationFilter\s+-Program\s+\$ExecutablePath\s+-PolicyStore\s+ActiveStore\s+-ErrorAction\s+Stop/i.test(
    firewallHelperSource,
  ),
  'migration must discover rules for the exact installed executable',
)
requireContract(
  /CmdletizationQuery_NotFound_AppPath[\s\S]*?return\s+@\(\)[\s\S]*?throw/i.test(
    firewallHelperSource,
  ),
  'exact-rule discovery must suppress only the known no-match result and rethrow provider failures',
)
requireContract(
  /PolicyStoreSourceType[\s\S]*?Local/i.test(firewallHelperSource),
  'migration may remove only local rules, never Group Policy rules',
)
requireContract(
  /Direction[\s\S]*?Inbound/i.test(firewallHelperSource) &&
    /Profile[\s\S]*?Public/i.test(firewallHelperSource) &&
    /Profile[\s\S]*?Any/i.test(firewallHelperSource),
  'migration must identify legacy Public and Any-profile inbound rules',
)
requireContract(
  /function\s+Get-LocalPublicAllowRulesForExecutable[\s\S]*?\$_.Action\s+-eq\s+['"]Allow['"][\s\S]*?\$ActiveOnly[\s\S]*?\$_.Enabled\.ToString\(\)\s+-eq\s+['"]True['"]/i.test(
    firewallHelperSource,
  ),
  'silent migration consent must come only from an active Allow rule',
)
requireContract(
  /Get-NetFirewallPortFilter\s+-ErrorAction\s+Stop/i.test(
    firewallHelperSource,
  ) &&
    /Protocol[\s\S]*?(?:Any|UDP)/i.test(firewallHelperSource) &&
    /LocalPort[\s\S]*?(?:Any|5060)/i.test(firewallHelperSource) &&
    /RemotePort[\s\S]*?Any/i.test(firewallHelperSource) &&
    /DynamicTarget[\s\S]*?Any/i.test(firewallHelperSource),
  'migration consent must come from a rule that actually permits Caller ID UDP 5060',
)
requireContract(
  /function\s+Get-ActiveLocalPublicCallerIdAllows[\s\S]*?Get-LocalPublicAllowRulesForExecutable\s+-ActiveOnly[\s\S]*?Test-AllowsCallerIdUdp5060[\s\S]*?Test-MigrationReplacementDoesNotBroadenRule/i.test(
    firewallHelperSource,
  ) &&
    /\$activeLegacyPublicAllows\s*=\s*@\([\s\S]*?Get-ActiveLocalPublicCallerIdAllows/i.test(
      firewallHelperSource,
    ),
  'UDP 5060 compatibility must authorize migration without narrowing Public-rule cleanup',
)
requireContract(
  /function\s+Get-InstallerOwnedRules[\s\S]*?Get-NetFirewallRule\s+-Name\s+\$ruleName\s+-PolicyStore\s+PersistentStore\s+-ErrorAction\s+Stop/i.test(
    firewallHelperSource,
  ),
  'owned-rule reads must be server-side name-filtered, never full-store scans',
)
requireContract(
  /\$preexistingIssue\s+-eq\s+['"]none['"][\s\S]*?Get-LocalPublicAllowRulesForExecutable\s+-ActiveOnly[\s\S]*?already configured/i.test(
    firewallHelperSource,
  ),
  'Install must exit without changes only after the full post-check AND a clean Public scan',
)
for (const filterCommand of [
  'Get-NetFirewallAddressFilter',
  'Get-NetFirewallInterfaceFilter',
  'Get-NetFirewallInterfaceTypeFilter',
  'Get-NetFirewallSecurityFilter',
  'Get-NetFirewallServiceFilter',
]) {
  requireContract(
    new RegExp(`${filterCommand}\\s+-ErrorAction\\s+Stop`, 'i').test(
      firewallHelperSource,
    ),
    `${filterCommand} must participate in fail-closed migration scope checks`,
  )
}
for (const ruleConstraint of [
  'Owner',
  'PolicyAppId',
  'PackageFamilyName',
  'Platform',
  'RemoteDynamicKeywordAddresses',
]) {
  requireContract(
    new RegExp(`Test-ValueSetIsEmptyOrAny\\s+-Value\\s+\\$Rule\\.${ruleConstraint}`, 'i').test(
      firewallHelperSource,
    ),
    `${ruleConstraint} must be unconstrained before silent migration`,
  )
}
requireContract(
  /\$legacyPublicAllows\s*=\s*@\([\s\S]*?Get-LocalPublicAllowRulesForExecutable\s+-ActiveOnly/i.test(
    firewallHelperSource,
  ) &&
    /\$remainingActivePublicAllows\s*=\s*@\([\s\S]*?Get-LocalPublicAllowRulesForExecutable\s+-ActiveOnly/i.test(
      firewallHelperSource,
    ),
  'after consent, cleanup and verification must cover every active Public/Any Allow for the executable',
)
requireContract(
  !/-ErrorAction\s+SilentlyContinue/i.test(firewallHelperSource),
  'firewall discovery and cleanup must not hide NetSecurity failures',
)
requireContract(
  /MigrateLegacyPublic[\s\S]*?Count\s+-eq\s+0[\s\S]*?(?:exit\s+0|return)/i.test(
    firewallHelperSource,
  ),
  'updater migration must be a no-op when no prior Public grant exists',
)
requireContract(
  /if\s*\(\$Action\s+-eq\s+['"]MigrateLegacyPublic['"]\)[\s\S]*?Get-ActiveLocalPublicCallerIdAllows/i.test(
    firewallHelperSource,
  ),
  'strict prior-grant proof must apply to silent migration, not explicit interactive consent',
)
requireContract(
  /Remove-NetFirewallRule/i.test(firewallHelperSource),
  'legacy Public and installer-owned rules must be removed through NetSecurity',
)

const newRule =
  firewallHelperSource
    .split(/\r?\n/u)
    .find((line) => /New-NetFirewallRule/i.test(line)) ?? ''
for (const [token, message] of [
  ['-Direction Inbound', 'the firewall rule must be inbound'],
  ['-Action Allow', 'the firewall rule must be an allow rule'],
  ['-Program $ExecutablePath', 'the rule must target the exact POS executable'],
  ['-Protocol UDP', 'the rule must allow UDP only'],
  ['-LocalPort 5060', 'the founder pilot rule must allow only local UDP port 5060'],
  ['-Profile Private', 'the rule must apply only to the Private profile'],
  ['-RemoteAddress LocalSubnet', 'the rule must accept only local-subnet devices'],
  ['-EdgeTraversalPolicy Block', 'edge traversal must remain blocked'],
]) {
  requireContract(
    newRule.toLowerCase().includes(token.toLowerCase()),
    message,
  )
}
requireContract(
  !/New-NetFirewallRule[^\r\n]*-Profile\s+(?:Public|Any)/i.test(
    firewallHelperSource,
  ),
  'Public or Any-profile allow rules are forbidden',
)
requireContract(
  /Get-NetFirewallApplicationFilter[\s\S]*?Remove-NetFirewallRule[\s\S]*?New-NetFirewallRule/i.test(
    firewallHelperSource,
  ),
  'legacy Public cleanup must complete before the Private grant is added',
)
requireContract(
  /privateRuleCreated[\s\S]*?catch\s*\{[\s\S]*?privateRuleCreated[\s\S]*?Remove-InstallerOwnedRule/i.test(
    firewallHelperSource,
  ),
  'a failed final verification must roll back the newly added Private rule',
)

requireContract(
  /pub\s+async\s+fn\s+callerid_firewall_enable\s*\(\s*app:\s*AppHandle\s*,?\s*\)/i.test(
    firewallRuntimeSource,
  ) &&
    /pub\s+async\s+fn\s+callerid_firewall_remove\s*\(\s*app:\s*AppHandle\s*,?\s*\)/i.test(
      firewallRuntimeSource,
    ),
  'renderer firewall commands must not accept a path, port, profile, or arbitrary action',
)
requireContract(
  /windows::change\(&app,\s*["']Install["']\)/i.test(firewallRuntimeSource) &&
    /windows::change\(&app,\s*["']Remove["']\)/i.test(firewallRuntimeSource),
  'runtime firewall mutations must use fixed native actions',
)
requireContract(
  /ShellExecuteExW/i.test(firewallRuntimeSource) &&
    /OsStr::new\(["']runas["']\)/i.test(firewallRuntimeSource) &&
    /GetExitCodeProcess/i.test(firewallRuntimeSource),
  'runtime firewall mutations must cross UAC and verify the elevated helper exit code',
)
requireContract(
  /BaseDirectory::Resource/i.test(firewallRuntimeSource) &&
    /helper\.parent\(\)\s*!=\s*Some\(resource_dir\.as_path\(\)\)/i.test(
      firewallRuntimeSource,
    ) &&
    /std::env::current_exe\(\)/i.test(firewallRuntimeSource),
  'runtime firewall paths must resolve to the bundled helper and exact running POS executable',
)
requireContract(
  /-EncodedCommand\s+\{encoded\}/i.test(firewallRuntimeSource),
  'elevated PowerShell arguments must use an encoded command instead of interpolated shell arguments',
)
for (const channel of [
  'callerid:firewall-status',
  'callerid:firewall-enable',
  'callerid:firewall-remove',
]) {
  requireContract(
    ipcAdapterSource.includes(`"${channel}"`),
    `${channel} must be exposed through the typed POS bridge`,
  )
}

const postUninstall = macroBody('NSIS_HOOK_POSTUNINSTALL')
const uninstallGuardIndex = postUninstall.search(/\$UpdateMode\s*<>\s*1/i)
const uninstallDeleteIndex = postUninstall.search(
  /advfirewall\s+firewall\s+delete\s+rule[^\r\n]*CALLER_ID_FIREWALL_RULE/i,
)
requireContract(
  uninstallGuardIndex >= 0 && uninstallDeleteIndex > uninstallGuardIndex,
  'real uninstall must remove the installer-owned rule while updater uninstall preserves it',
)
requireContract(
  /\$DeleteAppDataCheckboxState\s*=\s*1/i.test(postUninstall),
  'credential cleanup must remain conditional on deleting app data',
)

if (failures.length > 0) {
  console.error('Windows Caller ID firewall installer contract failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Windows Caller ID firewall installer contract passed.')
