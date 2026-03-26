/**
 * CallerIdService — IPC bridge for Rust SIP listener commands.
 */
import { getBridge } from '../../lib'

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
}

export interface CallerIdTestResult {
  success: boolean
  message: string
  reasonCode?: CallerIdStatusReason
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
