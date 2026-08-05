[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'MigrateLegacyPublic', 'Status', 'Remove')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('\.exe$')]
  [string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
$ruleName = 'TheSmallPOS-CallerID-PrivateLAN'
$ruleDisplayName = 'The Small POS Caller ID (Private LAN)'
$privateRuleCreated = $false
$failureExitCode = 10

function Get-LocalInboundRulesForExecutable {
  try {
    $applicationFilters = @(
      Get-NetFirewallApplicationFilter -Program $ExecutablePath -PolicyStore ActiveStore -ErrorAction Stop
    )
  } catch {
    # NetSecurity reports an absent exact application filter as an error. That
    # one result means "no rules"; every provider/CIM failure remains fatal.
    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_AppPath*') {
      return @()
    }
    throw
  }

  if ($applicationFilters.Count -eq 0) {
    return @()
  }

  @(
    $applicationFilters |
      Get-NetFirewallRule -ErrorAction Stop |
      Where-Object {
        $_.Direction -eq 'Inbound' -and
        $_.PolicyStoreSourceType -eq 'Local'
      }
  )
}

function Test-PublicBearingProfile {
  param([Parameter(Mandatory = $true)]$Rule)

  $profile = $Rule.Profile.ToString()
  $profile -eq 'Any' -or $profile -match '(^|,\s*)Public($|,\s*)'
}

function Test-AllowsCallerIdUdp5060 {
  param([Parameter(Mandatory = $true)]$Rule)

  $portFilters = @($Rule | Get-NetFirewallPortFilter -ErrorAction Stop)
  foreach ($portFilter in $portFilters) {
    $allowsUdp = @(
      @($portFilter.Protocol) |
        Where-Object { $_.ToString() -in @('Any', 'UDP', '17') }
    ).Count -gt 0
    $allowsPort = $false
    foreach ($portValue in @($portFilter.LocalPort)) {
      foreach ($portEntry in $portValue.ToString().Split(',')) {
        $portEntry = $portEntry.Trim()
        if ($portEntry -eq 'Any' -or $portEntry -eq '5060') {
          $allowsPort = $true
          break
        }
        if ($portEntry -match '^(\d+)\s*-\s*(\d+)$') {
          $rangeStart = [int]$Matches[1]
          $rangeEnd = [int]$Matches[2]
          if ($rangeStart -le 5060 -and $rangeEnd -ge 5060) {
            $allowsPort = $true
            break
          }
        }
      }
      if ($allowsPort) { break }
    }
    $allowsAnyRemotePort = Test-ValueSetContains `
      -Value $portFilter.RemotePort `
      -AllowedValues @('Any')
    $hasNoDynamicTarget = Test-ValueSetContains `
      -Value $portFilter.DynamicTarget `
      -AllowedValues @('Any')
    if ($allowsUdp -and $allowsPort -and $allowsAnyRemotePort -and $hasNoDynamicTarget) {
      return $true
    }
  }

  return $false
}

function Test-ValueSetContains {
  param(
    $Value,
    [Parameter(Mandatory = $true)][string[]]$AllowedValues
  )

  foreach ($valueEntry in @($Value)) {
    if ($null -eq $valueEntry) { continue }
    foreach ($part in $valueEntry.ToString().Split(',')) {
      if ($part.Trim() -in $AllowedValues) {
        return $true
      }
    }
  }
  return $false
}

function Test-ValueSetIsEmptyOrAny {
  param($Value)

  $sawValue = $false
  foreach ($valueEntry in @($Value)) {
    if ($null -eq $valueEntry) { continue }
    foreach ($part in $valueEntry.ToString().Split(',')) {
      $part = $part.Trim()
      if ($part.Length -eq 0) { continue }
      $sawValue = $true
      if ($part -ne 'Any') { return $false }
    }
  }
  return (-not $sawValue) -or (Test-ValueSetContains -Value $Value -AllowedValues @('Any'))
}

function Test-ValueSetEquals {
  param(
    $Value,
    [Parameter(Mandatory = $true)][string[]]$ExpectedValues
  )

  $actualValues = @(
    foreach ($valueEntry in @($Value)) {
      if ($null -eq $valueEntry) { continue }
      foreach ($part in $valueEntry.ToString().Split(',')) {
        $trimmed = $part.Trim()
        if ($trimmed.Length -gt 0) { $trimmed }
      }
    }
  )

  if ($actualValues.Count -ne $ExpectedValues.Count) { return $false }
  foreach ($expectedValue in $ExpectedValues) {
    if ($expectedValue -notin $actualValues) { return $false }
  }
  return $true
}

function Test-MigrationReplacementDoesNotBroadenRule {
  param(
    [Parameter(Mandatory = $true)]$Rule,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath
  )

  if ($Rule.LooseSourceMapping.ToString() -ne 'False' -or
      $Rule.LocalOnlyMapping.ToString() -ne 'False' -or
      -not (Test-ValueSetIsEmptyOrAny -Value $Rule.Owner) -or
      -not (Test-ValueSetIsEmptyOrAny -Value $Rule.PolicyAppId) -or
      -not (Test-ValueSetIsEmptyOrAny -Value $Rule.PackageFamilyName) -or
      -not (Test-ValueSetIsEmptyOrAny -Value $Rule.Platform) -or
      -not (Test-ValueSetIsEmptyOrAny -Value $Rule.RemoteDynamicKeywordAddresses)) {
    return $false
  }

  $addressFilters = @($Rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
  if ($addressFilters.Count -eq 0) { return $false }
  foreach ($filter in $addressFilters) {
    if (-not (Test-ValueSetContains -Value $filter.LocalAddress -AllowedValues @('Any')) -or
        -not (Test-ValueSetContains -Value $filter.RemoteAddress -AllowedValues @('Any', 'LocalSubnet'))) {
      return $false
    }
  }

  $interfaceFilters = @($Rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
  if ($interfaceFilters.Count -eq 0) { return $false }
  foreach ($filter in $interfaceFilters) {
    if (-not (Test-ValueSetContains -Value $filter.InterfaceAlias -AllowedValues @('Any'))) {
      return $false
    }
  }

  $interfaceTypeFilters = @($Rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop)
  if ($interfaceTypeFilters.Count -eq 0) { return $false }
  foreach ($filter in $interfaceTypeFilters) {
    if (-not (Test-ValueSetContains -Value $filter.InterfaceType -AllowedValues @('Any'))) {
      return $false
    }
  }

  $securityFilters = @($Rule | Get-NetFirewallSecurityFilter -ErrorAction Stop)
  if ($securityFilters.Count -eq 0) { return $false }
  foreach ($filter in $securityFilters) {
    if ($filter.Authentication.ToString() -ne 'NotRequired' -or
        $filter.Encryption.ToString() -ne 'NotRequired' -or
        $filter.OverrideBlockRules.ToString() -ne 'False' -or
        -not (Test-ValueSetContains -Value $filter.LocalUser -AllowedValues @('Any')) -or
        -not (Test-ValueSetContains -Value $filter.RemoteUser -AllowedValues @('Any')) -or
        -not (Test-ValueSetContains -Value $filter.RemoteMachine -AllowedValues @('Any'))) {
      return $false
    }
  }

  $serviceFilters = @($Rule | Get-NetFirewallServiceFilter -ErrorAction Stop)
  if ($serviceFilters.Count -eq 0) { return $false }
  foreach ($filter in $serviceFilters) {
    if (-not (Test-ValueSetContains -Value $filter.Service -AllowedValues @('Any'))) {
      return $false
    }
  }

  $applicationFilters = @($Rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
  if ($applicationFilters.Count -eq 0) { return $false }
  foreach ($filter in $applicationFilters) {
    if ($filter.Program -ne $ExpectedExecutablePath -or
        -not (Test-ValueSetIsEmptyOrAny -Value $filter.Package) -or
        -not (Test-ValueSetIsEmptyOrAny -Value $filter.AppContainer)) {
      return $false
    }
  }

  return $true
}

function Test-InstallerOwnedRuleExact {
  param(
    [Parameter(Mandatory = $true)]$Rule,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath
  )

  (Get-InstallerOwnedRuleConfigurationIssue `
    -Rules @($Rule) `
    -ExpectedExecutablePath $ExpectedExecutablePath) -eq 'none'
}

function Get-InstallerOwnedRuleConfigurationIssue {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Rules,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath
  )

  if ($Rules.Count -eq 0) { return 'rule_missing' }
  if ($Rules.Count -ne 1) { return 'rule_count_mismatch' }

  $Rule = $Rules[0]

  if ($Rule.Name -ne 'TheSmallPOS-CallerID-PrivateLAN' -or
      $Rule.Direction.ToString() -ne 'Inbound' -or
      $Rule.Action.ToString() -ne 'Allow' -or
      $Rule.Enabled.ToString() -ne 'True') {
    return 'rule_identity_mismatch'
  }
  if ($Rule.Profile.ToString() -ne 'Private') {
    return 'rule_profile_mismatch'
  }
  if ($Rule.EdgeTraversalPolicy.ToString() -ne 'Block') {
    return 'rule_edge_mismatch'
  }

  $portFilters = @($Rule | Get-NetFirewallPortFilter -ErrorAction Stop)
  if ($portFilters.Count -ne 1) { return 'rule_transport_mismatch' }
  $portFilter = $portFilters[0]
  $protocolIsUdp =
    (Test-ValueSetEquals -Value $portFilter.Protocol -ExpectedValues @('UDP')) -or
    (Test-ValueSetEquals -Value $portFilter.Protocol -ExpectedValues @('17'))
  if (-not $protocolIsUdp -or
      -not (Test-ValueSetEquals -Value $portFilter.LocalPort -ExpectedValues @('5060')) -or
      -not (Test-ValueSetEquals -Value $portFilter.RemotePort -ExpectedValues @('Any')) -or
      -not (Test-ValueSetEquals -Value $portFilter.DynamicTarget -ExpectedValues @('Any'))) {
    return 'rule_transport_mismatch'
  }

  $addressFilters = @($Rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
  if ($addressFilters.Count -ne 1 -or
      -not (Test-ValueSetEquals -Value $addressFilters[0].LocalAddress -ExpectedValues @('Any')) -or
      -not (Test-ValueSetEquals -Value $addressFilters[0].RemoteAddress -ExpectedValues @('LocalSubnet'))) {
    return 'rule_scope_mismatch'
  }

  $applicationFilters = @($Rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
  if ($applicationFilters.Count -ne 1 -or
      $applicationFilters[0].Program -ne $ExpectedExecutablePath) {
    return 'rule_program_mismatch'
  }

  if (-not (Test-MigrationReplacementDoesNotBroadenRule `
      -Rule $Rule `
      -ExpectedExecutablePath $ExpectedExecutablePath)) {
    return 'rule_constraints_mismatch'
  }

  return 'none'
}

function Get-LocalPublicAllowRulesForExecutable {
  param([switch]$ActiveOnly)

  @(
    Get-LocalInboundRulesForExecutable |
      Where-Object {
        $_.Action -eq 'Allow' -and
        (Test-PublicBearingProfile -Rule $_) -and
        (-not $ActiveOnly -or $_.Enabled.ToString() -eq 'True')
      }
  )
}

function Get-ActiveLocalPublicCallerIdAllows {
  @(
    Get-LocalPublicAllowRulesForExecutable -ActiveOnly |
      Where-Object {
        (Test-AllowsCallerIdUdp5060 -Rule $_) -and
        (Test-MigrationReplacementDoesNotBroadenRule -Rule $_ -ExpectedExecutablePath $ExecutablePath)
      }
  )
}

function Remove-InstallerOwnedRule {
  @(
    Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop |
      Where-Object { $_.Name -eq $ruleName }
  ) | Remove-NetFirewallRule -ErrorAction Stop | Out-Null
}

try {
  $ExecutablePath = [System.IO.Path]::GetFullPath($ExecutablePath)
  if (-not [System.IO.File]::Exists($ExecutablePath)) {
    throw "The installed POS executable does not exist: $ExecutablePath"
  }

  if ($Action -eq 'Status') {
    $ownedRules = @(
      Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop |
        Where-Object { $_.Name -eq $ruleName }
    )
    $configurationIssue = Get-InstallerOwnedRuleConfigurationIssue `
      -Rules $ownedRules `
      -ExpectedExecutablePath $ExecutablePath
    $configured = $configurationIssue -eq 'none'
    $publicRulePresent = @(
      Get-LocalPublicAllowRulesForExecutable -ActiveOnly
    ).Count -gt 0

    $privateNetworkActive = $false
    $publicNetworkActive = $false
    $networkProfileKnown = $false
    try {
      $connectedProfiles = @(
        Get-NetConnectionProfile -ErrorAction Stop |
          Where-Object {
            $_.IPv4Connectivity.ToString() -ne 'Disconnected' -or
            $_.IPv6Connectivity.ToString() -ne 'Disconnected'
          }
      )
      if ($connectedProfiles.Count -gt 0) {
        $networkProfileKnown = $true
        $privateNetworkActive = @(
          $connectedProfiles | Where-Object { $_.NetworkCategory.ToString() -eq 'Private' }
        ).Count -gt 0
        $publicNetworkActive = @(
          $connectedProfiles | Where-Object { $_.NetworkCategory.ToString() -eq 'Public' }
        ).Count -gt 0
      }
    } catch {
      # The firewall grant can still be verified when Windows cannot report a
      # connection profile. Keep the profile state explicitly unknown.
      $networkProfileKnown = $false
    }

    [ordered]@{
      supported = $true
      configured = [bool]$configured
      privateNetworkActive = [bool]$privateNetworkActive
      publicNetworkActive = [bool]$publicNetworkActive
      networkProfileKnown = [bool]$networkProfileKnown
      publicRulePresent = [bool]$publicRulePresent
      configurationIssue = $configurationIssue
    } | ConvertTo-Json -Compress
    exit 0
  }

  if ($Action -eq 'Remove') {
    $failureExitCode = 22
    Remove-InstallerOwnedRule
    Write-Output 'Caller ID Private-network firewall access removed.'
    exit 0
  }

  if ($Action -eq 'MigrateLegacyPublic') {
    $failureExitCode = 20
    $activeLegacyPublicAllows = @(
      Get-ActiveLocalPublicCallerIdAllows
    )
    if ($activeLegacyPublicAllows.Count -eq 0) {
      Write-Output 'Caller ID firewall migration skipped: no prior compatible local Public grant exists.'
      exit 0
    }
  }

  # Preserve explicit Block and disabled rules. Once an active UDP-compatible
  # Allow proves prior consent, remove every active Public/Any Allow for this
  # exact executable before adding the narrower Private Caller ID rule.
  $failureExitCode = 20
  $legacyPublicAllows = @(
    Get-LocalPublicAllowRulesForExecutable -ActiveOnly
  )
  $failureExitCode = 21
  if ($legacyPublicAllows.Count -gt 0) {
    $legacyPublicAllows | Remove-NetFirewallRule -ErrorAction Stop | Out-Null
  }
  $failureExitCode = 22
  Remove-InstallerOwnedRule

  $failureExitCode = 23
  New-NetFirewallRule -Name $ruleName -DisplayName $ruleDisplayName -Description 'Allows the local Grandstream Caller ID pilot to reach The Small POS.' -Direction Inbound -Action Allow -Program $ExecutablePath -Protocol UDP -LocalPort 5060 -Profile Private -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block -Enabled True -PolicyStore PersistentStore -ErrorAction Stop | Out-Null
  $privateRuleCreated = $true

  $failureExitCode = 24
  $remainingActivePublicAllows = @(
    Get-LocalPublicAllowRulesForExecutable -ActiveOnly
  )
  if ($remainingActivePublicAllows.Count -gt 0) {
    throw 'One or more local Public inbound rules still grant access to The Small POS.'
  }

  $failureExitCode = 25
  $installedRules = @(
    Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop |
      Where-Object { $_.Name -eq $ruleName }
  )
  $installedRuleIssue = Get-InstallerOwnedRuleConfigurationIssue `
    -Rules $installedRules `
    -ExpectedExecutablePath $ExecutablePath
  if ($installedRuleIssue -ne 'none') {
    throw "The installed Private Caller ID rule did not pass its post-check: $installedRuleIssue"
  }

  Write-Output 'Caller ID firewall configured for Private local-network UDP 5060 only.'
  exit 0
} catch {
  $failureMessage = $_.Exception.Message
  if ($privateRuleCreated) {
    try {
      Remove-InstallerOwnedRule
    } catch {
      Write-Warning "Caller ID firewall rollback also failed: $($_.Exception.Message)"
    }
  }
  # `$ErrorActionPreference = 'Stop'` makes Write-Error terminating, which
  # would skip the explicit stage exit below and collapse every failure to 1.
  # Write directly to stderr so the native caller keeps the actionable code.
  [Console]::Error.WriteLine("Caller ID firewall setup failed: $failureMessage")
  exit $failureExitCode
}
