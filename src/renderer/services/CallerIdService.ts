/**
 * CallerIdService — native listener state plus the server-managed FXO projection.
 */
import { getBridge } from '../../lib'
import { posApiGet } from '../utils/api-helpers'

export type CallerIdMode = 'authenticated_sip' | 'pbx_ip_trust_legacy'
export type CallerIdTransport = 'udp' | 'tcp'
export type CallerIdStatusReason =
  | 'auth_failed'
  | 'timeout'
  | 'unsupported_provider'
  | 'port_in_use'
  | 'invalid_config'
  | 'network_error'
  | 'unknown'

export type CallerIdRejectionStage =
  | 'sip_invite'
  | 'record_encoding'
  | 'record_empty'
  | 'record_oversized'
  | 'record_nul'
  | 'record_non_ascii'
  | 'record_utf8'
  | 'record_control'
  | 'record_terminal_lf'
  | 'record_terminal_crlf'
  | 'record_terminal_cr'
  | 'record_internal_control'
  | 'record_embedded_lf'
  | 'record_embedded_cr'
  | 'record_tab'
  | 'record_other_control'
  | 'syslog_priority'
  | 'device_envelope'
  | 'mac_address'
  | 'firmware'
  | 'component_level'
  | 'uptime'
  | 'caller_id_event'
  | 'caller_number'
  | 'unknown'

export interface CallerIdConfig {
  mode: CallerIdMode
  transport: CallerIdTransport
  sipServer: string
  sipPort: number
  sipUsername: string
  authUsername?: string | null
  outboundProxy?: string | null
  providerPresetId?: string | null
  listenPort: number
  enabled: boolean
  hasPassword?: boolean
  password?: string
}

export interface CallerIdStatus {
  status: 'stopped' | 'listening' | 'registering' | 'error'
  error?: string
  reason?: CallerIdStatusReason
  registered: boolean
  callsDetected: number
  /** Privacy-safe native intake counters; no caller number or packet body is exposed. */
  udpPacketsReceived?: number
  trustedPacketsReceived?: number
  callerIdCandidates?: number
  rejectedCandidates?: number
  lastRejectionStage?: CallerIdRejectionStage
}

export interface CallerIdTestResult {
  success: boolean
  message: string
  reasonCode?: CallerIdStatusReason
}

export interface CallerIdFirewallStatus {
  supported: boolean
  configured: boolean
  privateNetworkActive: boolean
  publicNetworkActive: boolean
  networkProfileKnown: boolean
  publicRulePresent: boolean
  configurationIssue: string
}

export interface CallerIdServerSourceLine {
  id: string
  name: string
  adapterType: string
  sourceId: string
  deviceProfileKey: string
  connectorFamily: string
  sourceChannel: string
  countryCode?: string
  isReceivingTarget: boolean
  trustedDeviceIp: string | null
  listenPort: number | null
}

export interface CallerIdServerReceivingLine {
  id: string
  name: string
  countryCode?: string
}

export interface CallerIdServerConfig {
  enabled: boolean
  minimumClientVersion: string
  ipTrustSourcePolicy: 'blocked' | 'founder_pilot'
  sourceLines: CallerIdServerSourceLine[]
  receivingLines: CallerIdServerReceivingLine[]
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const asPort = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535
    ? value
    : null

const asCountryCode = (value: unknown): string | undefined => {
  const normalized = asString(value).toUpperCase()
  return /^[A-Z]{2}$/.test(normalized) ? normalized : undefined
}

/**
 * Loads the terminal-authenticated configuration and deliberately projects only
 * non-secret fields used by the settings UI. API credentials and credential
 * versions are never returned to React state.
 */
export async function callerIdGetServerConfig(): Promise<CallerIdServerConfig> {
  const response = await posApiGet<unknown>('/api/pos/caller-id/config')
  if (!response.success) {
    throw new Error(response.error || 'Failed to load Caller ID configuration')
  }

  const data = asRecord(response.data) ?? {}
  const sourceLines = Array.isArray(data.sourceLines)
    ? data.sourceLines.flatMap((value): CallerIdServerSourceLine[] => {
        const line = asRecord(value)
        if (!line) return []
        const config = asRecord(line.config) ?? {}
        const id = asString(line.id)
        if (!id) return []
        const countryCode = asCountryCode(line.countryCode)

        return [{
          id,
          name: asString(line.name),
          adapterType: asString(line.adapterType),
          sourceId: asString(line.sourceId),
          deviceProfileKey: asString(line.deviceProfileKey),
          connectorFamily: asString(line.connectorFamily),
          sourceChannel: asString(line.sourceChannel),
          ...(countryCode ? { countryCode } : {}),
          isReceivingTarget: line.isReceivingTarget === true,
          trustedDeviceIp: asString(config.trustedDeviceIp) || null,
          listenPort: asPort(config.listenPort),
        }]
      })
    : []

  const receivingLines = Array.isArray(data.receivingLines)
    ? data.receivingLines.flatMap((value): CallerIdServerReceivingLine[] => {
        const line = asRecord(value)
        if (!line) return []
        const id = asString(line.id)
        if (!id) return []
        const countryCode = asCountryCode(line.countryCode)
        return [{
          id,
          name: asString(line.name),
          ...(countryCode ? { countryCode } : {}),
        }]
      })
    : []

  return {
    enabled: data.enabled === true,
    minimumClientVersion: asString(data.minimumClientVersion),
    ipTrustSourcePolicy:
      data.ipTrustSourcePolicy === 'founder_pilot' ? 'founder_pilot' : 'blocked',
    sourceLines,
    receivingLines,
  }
}

const CALLER_ID_REASON_CODES: CallerIdStatusReason[] = [
  'auth_failed',
  'timeout',
  'unsupported_provider',
  'port_in_use',
  'invalid_config',
  'network_error',
  'unknown',
]

const asReasonCode = (value: unknown): CallerIdStatusReason | undefined =>
  typeof value === 'string' && CALLER_ID_REASON_CODES.includes(value as CallerIdStatusReason)
    ? (value as CallerIdStatusReason)
    : undefined

export async function callerIdStart(): Promise<{ status: string }> {
  const bridge = getBridge()
  return bridge.callerid.start()
}

export async function callerIdStop(): Promise<{ status: string }> {
  const bridge = getBridge()
  return bridge.callerid.stop()
}

export async function callerIdGetStatus(): Promise<CallerIdStatus> {
  const bridge = getBridge()
  return bridge.callerid.getStatus()
}

export async function callerIdSaveConfig(
  config: Partial<CallerIdConfig>,
): Promise<{ success: boolean }> {
  const bridge = getBridge()
  return bridge.callerid.saveConfig(config)
}

export async function callerIdGetConfig(): Promise<CallerIdConfig> {
  const bridge = getBridge()
  return bridge.callerid.getConfig()
}

export async function callerIdTestConnection(
  config?: Partial<CallerIdConfig>,
): Promise<CallerIdTestResult> {
  const bridge = getBridge()
  const result = await bridge.callerid.testConnection(config)
  return {
    success: Boolean(result?.success),
    message: typeof result?.message === 'string' ? result.message : '',
    reasonCode: asReasonCode(result?.reasonCode),
  }
}

export async function callerIdGetFirewallStatus(): Promise<CallerIdFirewallStatus> {
  return getBridge().callerid.getFirewallStatus()
}

export async function callerIdEnableFirewall(): Promise<CallerIdFirewallStatus> {
  return getBridge().callerid.enableFirewall()
}

export async function callerIdRemoveFirewall(): Promise<CallerIdFirewallStatus> {
  return getBridge().callerid.removeFirewall()
}
