import type {
  RepairAttachmentPolicySnapshot,
  RepairCommand,
  RepairIntakeMode,
  RepairStatus,
} from './contracts'

export const REPAIR_OFFLINE_COMMANDS = [
  'create_intake',
  'add_note',
  'assign_repair',
  'update_diagnosis',
  'plan_line',
  'transition_status',
] as const

export const REPAIR_OFFLINE_TRANSITION_STATUSES = [
  'diagnosing',
  'waiting_customer_approval',
  'waiting_parts',
  'repairing',
  'quality_check',
  'ready',
] as const satisfies readonly RepairStatus[]

const offlineCommands = new Set<string>(REPAIR_OFFLINE_COMMANDS)
const offlineTransitionStatuses = new Set<string>(REPAIR_OFFLINE_TRANSITION_STATUSES)
const repairCommands = new Set<string>([
  'create_intake',
  'reopen_repair',
  'add_note',
  'assign_repair',
  'update_diagnosis',
  'plan_line',
  'consume_nonstock_part',
  'reverse_nonstock_part',
  'consume_repair_part',
  'reverse_repair_part',
  'create_estimate',
  'record_approval',
  'transition_status',
  'transfer_branch',
])
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

/** Unknown commands are deliberately online-only. */
export function isRepairCommandOfflineAllowed(command: RepairCommand | unknown): boolean {
  const envelope = recordOf(command)
  const commandName = envelope?.command
  if (typeof commandName !== 'string' || !offlineCommands.has(commandName)) return false

  const payload = recordOf(envelope?.payload)
  if (!payload) return false

  if (commandName === 'update_diagnosis') return payload.draft === true
  if (commandName === 'transition_status') {
    return typeof payload.target_status === 'string'
      && offlineTransitionStatuses.has(payload.target_status)
  }
  return true
}

export type RepairConnectivity = 'online' | 'offline' | 'unknown'

export type RepairMutationPolicyCode =
  | 'REPAIR_CONNECTIVITY_UNKNOWN'
  | 'REPAIR_CAPABILITY_REQUIRED'
  | 'REPAIR_ACTIVE_SHIFT_REQUIRED'
  | 'REPAIR_COMMAND_UNKNOWN'
  | 'REPAIR_COMMAND_ONLINE_REQUIRED'

export interface RepairMutationPolicyInput {
  connectivity: RepairConnectivity
  command: RepairCommand | unknown
  hasCapability: boolean | null | undefined
  hasActiveShift: boolean | null | undefined
}

export function evaluateRepairMutationPolicy(
  input: RepairMutationPolicyInput,
): { allowed: true } | { allowed: false; code: RepairMutationPolicyCode } {
  if (input.connectivity !== 'online' && input.connectivity !== 'offline') {
    return { allowed: false, code: 'REPAIR_CONNECTIVITY_UNKNOWN' }
  }
  if (input.hasCapability !== true) {
    return { allowed: false, code: 'REPAIR_CAPABILITY_REQUIRED' }
  }
  if (input.hasActiveShift !== true) {
    return { allowed: false, code: 'REPAIR_ACTIVE_SHIFT_REQUIRED' }
  }

  const envelope = recordOf(input.command)
  const commandName = envelope?.command
  if (typeof commandName !== 'string' || !repairCommands.has(commandName)) {
    return { allowed: false, code: 'REPAIR_COMMAND_UNKNOWN' }
  }
  if (input.connectivity === 'offline' && !isRepairCommandOfflineAllowed(input.command)) {
    return { allowed: false, code: 'REPAIR_COMMAND_ONLINE_REQUIRED' }
  }
  return { allowed: true }
}

export interface RepairIntakePolicyInput {
  intakeMode: RepairIntakeMode
  isAnonymous: boolean
  customerId: string | null
  customerDeviceId: string | null
}

export type RepairIntakePolicyCode =
  | 'REPAIR_SETTINGS_REQUIRED'
  | 'REPAIR_QUICK_SERVICE_DISABLED'
  | 'REPAIR_STANDARD_ANONYMOUS_FORBIDDEN'
  | 'REPAIR_STANDARD_CUSTOMER_REQUIRED'
  | 'REPAIR_STANDARD_DEVICE_REQUIRED'
  | 'REPAIR_ANONYMOUS_REFERENCES_FORBIDDEN'
  | 'REPAIR_QUICK_SERVICE_CUSTOMER_REQUIRED'
  | 'REPAIR_CUSTOMER_REFERENCE_INVALID'
  | 'REPAIR_DEVICE_REFERENCE_INVALID'

export type RepairPolicyResult<TCode extends string> =
  | { ok: true }
  | { ok: false; code: TCode }

function isCanonicalUuid(value: string | null): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value)
}

export function validateRepairIntakePolicy(
  input: RepairIntakePolicyInput,
  settings: Pick<{ quickServiceEnabled: boolean }, 'quickServiceEnabled'> | null,
): RepairPolicyResult<RepairIntakePolicyCode> {
  if (input.intakeMode === 'standard') {
    if (input.isAnonymous) return { ok: false, code: 'REPAIR_STANDARD_ANONYMOUS_FORBIDDEN' }
    if (input.customerId === null) return { ok: false, code: 'REPAIR_STANDARD_CUSTOMER_REQUIRED' }
    if (!isCanonicalUuid(input.customerId)) return { ok: false, code: 'REPAIR_CUSTOMER_REFERENCE_INVALID' }
    if (input.customerDeviceId === null) return { ok: false, code: 'REPAIR_STANDARD_DEVICE_REQUIRED' }
    if (!isCanonicalUuid(input.customerDeviceId)) return { ok: false, code: 'REPAIR_DEVICE_REFERENCE_INVALID' }
    return { ok: true }
  }

  if (!settings) return { ok: false, code: 'REPAIR_SETTINGS_REQUIRED' }
  if (!settings.quickServiceEnabled) return { ok: false, code: 'REPAIR_QUICK_SERVICE_DISABLED' }

  if (input.isAnonymous) {
    return input.customerId === null && input.customerDeviceId === null
      ? { ok: true }
      : { ok: false, code: 'REPAIR_ANONYMOUS_REFERENCES_FORBIDDEN' }
  }

  if (input.customerId === null) {
    return { ok: false, code: 'REPAIR_QUICK_SERVICE_CUSTOMER_REQUIRED' }
  }
  if (!isCanonicalUuid(input.customerId)) {
    return { ok: false, code: 'REPAIR_CUSTOMER_REFERENCE_INVALID' }
  }
  if (input.customerDeviceId !== null && !isCanonicalUuid(input.customerDeviceId)) {
    return { ok: false, code: 'REPAIR_DEVICE_REFERENCE_INVALID' }
  }
  return { ok: true }
}

export interface RepairAttachmentPolicyInput {
  mimeType: string
  byteSize: number
}

export type RepairAttachmentPolicyCode =
  | 'REPAIR_ATTACHMENT_POLICY_REQUIRED'
  | 'REPAIR_ATTACHMENT_POLICY_INVALID'
  | 'REPAIR_ATTACHMENT_EMPTY'
  | 'REPAIR_ATTACHMENT_TOO_LARGE'
  | 'REPAIR_ATTACHMENT_MIME_NOT_ALLOWED'

export function validateRepairAttachmentPolicy(
  input: RepairAttachmentPolicyInput,
  policy: RepairAttachmentPolicySnapshot | null,
): RepairPolicyResult<RepairAttachmentPolicyCode> {
  if (!policy) return { ok: false, code: 'REPAIR_ATTACHMENT_POLICY_REQUIRED' }
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0 || policy.allowedMimeTypes.length === 0) {
    return { ok: false, code: 'REPAIR_ATTACHMENT_POLICY_INVALID' }
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
    return { ok: false, code: 'REPAIR_ATTACHMENT_EMPTY' }
  }
  if (input.byteSize > policy.maxBytes) {
    return { ok: false, code: 'REPAIR_ATTACHMENT_TOO_LARGE' }
  }
  if (!policy.allowedMimeTypes.includes(input.mimeType)) {
    return { ok: false, code: 'REPAIR_ATTACHMENT_MIME_NOT_ALLOWED' }
  }
  return { ok: true }
}
