[CmdletBinding()]
param(
  [string]$HelperPath
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($HelperPath)) {
  $HelperPath = Join-Path $PSScriptRoot '..\src-tauri\caller-id-firewall.ps1'
}
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path $HelperPath),
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
  throw "Firewall helper has parser errors: $($parseErrors -join '; ')"
}

function Import-HelperFunction {
  param([Parameter(Mandatory = $true)][string]$Name)

  $functionAst = $ast.Find(
    {
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $Name
    },
    $true
  )
  if ($null -eq $functionAst) {
    throw "Required helper function is missing: $Name"
  }
  $definition = $functionAst.Extent.Text -replace (
    '^\s*function\s+' + [regex]::Escape($Name)
  ), "function global:$Name"
  Invoke-Expression $definition
}

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)]$Actual,
    [Parameter(Mandatory = $true)][string]$Message
  )

  if ($Expected -ne $Actual) {
    throw "$Message (expected=$Expected actual=$Actual)"
  }
}

Import-HelperFunction -Name 'Test-AllowsCallerIdUdp5060'
Import-HelperFunction -Name 'Test-ValueSetContains'
Import-HelperFunction -Name 'Test-ValueSetIsEmptyOrAny'
Import-HelperFunction -Name 'Test-ValueSetEquals'
Import-HelperFunction -Name 'Test-MigrationReplacementDoesNotBroadenRule'
Import-HelperFunction -Name 'Get-InstallerOwnedRuleConfigurationIssue'
Import-HelperFunction -Name 'Test-InstallerOwnedRuleExact'

# The production function consumes NetSecurity pipeline objects. This mock
# preserves scalar and String[] shapes so Windows API representation changes
# cannot silently break migration consent detection.
function Get-NetFirewallPortFilter {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)]$Rule)

  process { $Rule.PortFilter }
}

function Get-NetFirewallAddressFilter {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)]$Rule)
  process { $Rule.AddressFilter }
}

function Get-NetFirewallInterfaceFilter {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)]$Rule)
  process { $Rule.InterfaceFilter }
}

function Get-NetFirewallInterfaceTypeFilter {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)]$Rule)
  process { $Rule.InterfaceTypeFilter }
}

function Get-NetFirewallSecurityFilter {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)]$Rule)
  process { $Rule.SecurityFilter }
}

function Get-NetFirewallServiceFilter {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)]$Rule)
  process { $Rule.ServiceFilter }
}

function Get-NetFirewallApplicationFilter {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)]$Rule)
  process { $Rule.ApplicationFilter }
}

$portCases = @(
  @{ Name = 'Any scalar'; Protocol = 'Any'; LocalPort = 'Any'; RemotePort = 'Any'; DynamicTarget = 'Any'; Expected = $true },
  @{ Name = 'UDP exact scalar'; Protocol = 'UDP'; LocalPort = '5060'; RemotePort = 'Any'; DynamicTarget = 'Any'; Expected = $true },
  @{ Name = 'UDP exact array'; Protocol = @('UDP'); LocalPort = @('443', '5060'); RemotePort = @('Any'); DynamicTarget = 'Any'; Expected = $true },
  @{ Name = 'UDP containing range'; Protocol = '17'; LocalPort = @('5000-5100'); RemotePort = 'Any'; DynamicTarget = 'Any'; Expected = $true },
  @{ Name = 'UDP different port'; Protocol = 'UDP'; LocalPort = @('5061'); RemotePort = 'Any'; DynamicTarget = 'Any'; Expected = $false },
  @{ Name = 'TCP exact port'; Protocol = 'TCP'; LocalPort = @('5060'); RemotePort = 'Any'; DynamicTarget = 'Any'; Expected = $false },
  @{ Name = 'remote port constrained'; Protocol = 'UDP'; LocalPort = '5060'; RemotePort = '5062'; DynamicTarget = 'Any'; Expected = $false },
  @{ Name = 'dynamic target constrained'; Protocol = 'UDP'; LocalPort = '5060'; RemotePort = 'Any'; DynamicTarget = 'ProximityApps'; Expected = $false }
)

foreach ($case in $portCases) {
  $rule = [pscustomobject]@{
    PortFilter = [pscustomobject]@{
      Protocol = $case.Protocol
      LocalPort = $case.LocalPort
      RemotePort = $case.RemotePort
      DynamicTarget = $case.DynamicTarget
    }
  }
  $actual = Test-AllowsCallerIdUdp5060 -Rule $rule
  Assert-Equal -Expected $case.Expected -Actual $actual -Message $case.Name
}

function New-MigrationRule {
  param(
    $RemoteAddress = 'Any',
    $LocalAddress = 'Any',
    $InterfaceAlias = 'Any',
    $InterfaceType = 'Any',
    $Authentication = 'NotRequired',
    $RemoteMachine = 'Any',
    $Service = 'Any',
    $Package = '',
    $Owner = '',
    $PolicyAppId = '',
    $PackageFamilyName = '',
    $Platform = @(),
    $RemoteDynamicKeywordAddresses = @(),
    [bool]$LooseSourceMapping = $false
  )

  [pscustomobject]@{
    LooseSourceMapping = $LooseSourceMapping
    LocalOnlyMapping = $false
    Owner = $Owner
    PolicyAppId = $PolicyAppId
    PackageFamilyName = $PackageFamilyName
    Platform = $Platform
    RemoteDynamicKeywordAddresses = $RemoteDynamicKeywordAddresses
    AddressFilter = [pscustomobject]@{
      LocalAddress = $LocalAddress
      RemoteAddress = $RemoteAddress
    }
    InterfaceFilter = [pscustomobject]@{ InterfaceAlias = $InterfaceAlias }
    InterfaceTypeFilter = [pscustomobject]@{ InterfaceType = $InterfaceType }
    SecurityFilter = [pscustomobject]@{
      Authentication = $Authentication
      Encryption = 'NotRequired'
      OverrideBlockRules = $false
      LocalUser = 'Any'
      RemoteUser = 'Any'
      RemoteMachine = $RemoteMachine
    }
    ServiceFilter = [pscustomobject]@{ Service = $Service }
    ApplicationFilter = [pscustomobject]@{
      Program = 'C:\Program Files\The Small POS\the-small-pos.exe'
      Package = $Package
      AppContainer = ''
    }
  }
}

function New-InstallerOwnedRule {
  param(
    $Name = 'TheSmallPOS-CallerID-PrivateLAN',
    $Direction = 'Inbound',
    $Action = 'Allow',
    $Enabled = $true,
    $Profile = 'Private',
    $EdgeTraversalPolicy = 'Block',
    $Protocol = 'UDP',
    $LocalPort = '5060',
    $RemotePort = 'Any',
    $DynamicTarget = 'Any',
    $LocalAddress = 'Any',
    $RemoteAddress = 'LocalSubnet',
    $Program = 'C:\Program Files\The Small POS\the-small-pos.exe'
  )

  $rule = New-MigrationRule -RemoteAddress $RemoteAddress -LocalAddress $LocalAddress
  $rule | Add-Member -NotePropertyName Name -NotePropertyValue $Name
  $rule | Add-Member -NotePropertyName Direction -NotePropertyValue $Direction
  $rule | Add-Member -NotePropertyName Action -NotePropertyValue $Action
  $rule | Add-Member -NotePropertyName Enabled -NotePropertyValue $Enabled
  $rule | Add-Member -NotePropertyName Profile -NotePropertyValue $Profile
  $rule | Add-Member -NotePropertyName EdgeTraversalPolicy -NotePropertyValue $EdgeTraversalPolicy
  $rule | Add-Member -NotePropertyName PortFilter -NotePropertyValue ([pscustomobject]@{
    Protocol = $Protocol
    LocalPort = $LocalPort
    RemotePort = $RemotePort
    DynamicTarget = $DynamicTarget
  })
  $rule.ApplicationFilter.Program = $Program
  $rule
}

$migrationCases = @(
  @{ Name = 'ordinary broad app prompt'; Rule = New-MigrationRule; Expected = $true },
  @{ Name = 'existing LocalSubnet scope'; Rule = New-MigrationRule -RemoteAddress 'LocalSubnet'; Expected = $true },
  @{ Name = 'array containing LocalSubnet'; Rule = New-MigrationRule -RemoteAddress @('192.168.1.20', 'LocalSubnet'); Expected = $true },
  @{ Name = 'exact device IP'; Rule = New-MigrationRule -RemoteAddress '192.168.1.20'; Expected = $false },
  @{ Name = 'local address constrained'; Rule = New-MigrationRule -LocalAddress '192.168.1.10'; Expected = $false },
  @{ Name = 'interface alias constrained'; Rule = New-MigrationRule -InterfaceAlias 'Ethernet'; Expected = $false },
  @{ Name = 'interface type constrained'; Rule = New-MigrationRule -InterfaceType 'Wired'; Expected = $false },
  @{ Name = 'authenticated rule'; Rule = New-MigrationRule -Authentication 'Required'; Expected = $false },
  @{ Name = 'machine constrained'; Rule = New-MigrationRule -RemoteMachine 'D:(A;;CC;;;S-1-5-21)'; Expected = $false },
  @{ Name = 'service constrained'; Rule = New-MigrationRule -Service 'SomeService'; Expected = $false },
  @{ Name = 'package constrained'; Rule = New-MigrationRule -Package 'Contoso.App_123'; Expected = $false },
  @{ Name = 'owner constrained'; Rule = New-MigrationRule -Owner 'S-1-5-21-123'; Expected = $false },
  @{ Name = 'policy app constrained'; Rule = New-MigrationRule -PolicyAppId 'ContosoPolicy'; Expected = $false },
  @{ Name = 'package family constrained'; Rule = New-MigrationRule -PackageFamilyName 'Contoso.App_123'; Expected = $false },
  @{ Name = 'platform constrained'; Rule = New-MigrationRule -Platform '10.0.19041'; Expected = $false },
  @{ Name = 'remote dynamic address constrained'; Rule = New-MigrationRule -RemoteDynamicKeywordAddresses 'DNS'; Expected = $false },
  @{ Name = 'loose source mapping'; Rule = New-MigrationRule -LooseSourceMapping $true; Expected = $false }
)

foreach ($case in $migrationCases) {
  $actual = Test-MigrationReplacementDoesNotBroadenRule `
    -Rule $case.Rule `
    -ExpectedExecutablePath 'C:\Program Files\The Small POS\the-small-pos.exe'
  Assert-Equal -Expected $case.Expected -Actual $actual -Message $case.Name
}

$exactRuleCases = @(
  @{ Name = 'exact private Caller ID rule'; Rule = New-InstallerOwnedRule; Expected = $true },
  @{ Name = 'disabled rule'; Rule = New-InstallerOwnedRule -Enabled $false; Expected = $false },
  @{ Name = 'public profile'; Rule = New-InstallerOwnedRule -Profile 'Public'; Expected = $false },
  @{ Name = 'all profiles'; Rule = New-InstallerOwnedRule -Profile 'Any'; Expected = $false },
  @{ Name = 'wrong executable'; Rule = New-InstallerOwnedRule -Program 'C:\Temp\the-small-pos.exe'; Expected = $false },
  @{ Name = 'TCP listener'; Rule = New-InstallerOwnedRule -Protocol 'TCP'; Expected = $false },
  @{ Name = 'broad local port'; Rule = New-InstallerOwnedRule -LocalPort 'Any'; Expected = $false },
  @{ Name = 'internet remote address'; Rule = New-InstallerOwnedRule -RemoteAddress 'Any'; Expected = $false },
  @{ Name = 'edge traversal allowed'; Rule = New-InstallerOwnedRule -EdgeTraversalPolicy 'Allow'; Expected = $false }
)

foreach ($case in $exactRuleCases) {
  $actual = Test-InstallerOwnedRuleExact `
    -Rule $case.Rule `
    -ExpectedExecutablePath 'C:\Program Files\The Small POS\the-small-pos.exe'
  Assert-Equal -Expected $case.Expected -Actual $actual -Message $case.Name
}

$validRuleIssue = Get-InstallerOwnedRuleConfigurationIssue `
  -Rules @(New-InstallerOwnedRule) `
  -ExpectedExecutablePath 'C:\Program Files\The Small POS\the-small-pos.exe'
Assert-Equal -Expected 'none' -Actual $validRuleIssue -Message 'valid rule issue code'

$missingRuleIssue = Get-InstallerOwnedRuleConfigurationIssue `
  -Rules @() `
  -ExpectedExecutablePath 'C:\Program Files\The Small POS\the-small-pos.exe'
Assert-Equal -Expected 'rule_missing' -Actual $missingRuleIssue -Message 'missing rule issue code'

$wrongScopeIssue = Get-InstallerOwnedRuleConfigurationIssue `
  -Rules @(New-InstallerOwnedRule -RemoteAddress 'Any') `
  -ExpectedExecutablePath 'C:\Program Files\The Small POS\the-small-pos.exe'
Assert-Equal -Expected 'rule_scope_mismatch' -Actual $wrongScopeIssue -Message 'scope issue code'

Write-Output "Caller ID firewall behavior tests passed: $($portCases.Count) port cases, $($migrationCases.Count) migration-scope cases, $($exactRuleCases.Count) exact-rule cases."
