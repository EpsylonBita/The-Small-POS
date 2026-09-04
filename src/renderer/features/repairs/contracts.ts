/**
 * Renderer mirror of the frozen Rust repair IPC surface.
 *
 * Top-level command inputs and all snapshots use camelCase because the Rust
 * structs declare `rename_all = "camelCase"`. The nested `RepairCommand`
 * payload deliberately remains snake_case because that enum is the canonical
 * replay envelope shared with the server.
 */

export const REPAIR_STATUSES = [
  'received',
  'diagnosing',
  'waiting_customer_approval',
  'approved',
  'waiting_parts',
  'repairing',
  'quality_check',
  'ready',
  'delivered',
  'cancelled',
  'unrepairable',
] as const

export type RepairStatus = (typeof REPAIR_STATUSES)[number]
export type RepairPriority = 'low' | 'normal' | 'high' | 'urgent'
export type RepairIntakeMode = 'standard' | 'quick_service'
export type RepairLineType = 'part' | 'labour' | 'charge'
export type RepairPartState = 'planned' | 'consumed' | 'reversed'
export const REPAIR_SYNC_STATES = [
  'synced',
  'queued',
  'conflict',
  'needs_refetch',
] as const
export type RepairSyncState = (typeof REPAIR_SYNC_STATES)[number]
export const REPAIR_CUSTOMER_NOTIFICATION_STATES = [
  'queued_after_sync',
  'server_event_pending',
  'not_requested',
] as const
export type RepairCustomerNotificationState =
  (typeof REPAIR_CUSTOMER_NOTIFICATION_STATES)[number]
export type RepairAttachmentType =
  | 'intake'
  | 'diagnostic'
  | 'repair'
  | 'quality_check'
  | 'handover'
  | 'other'
export const REPAIR_ATTACHMENT_RETENTION_STATES = [
  'active',
  'legal_hold',
  'pending_deletion',
  'deleted',
] as const
export type RepairAttachmentRetentionState =
  (typeof REPAIR_ATTACHMENT_RETENTION_STATES)[number]
export type RepairPrintKind = 'repair_intake' | 'repair_label'
export type RepairConflictResolution = 'accept_server' | 'rebase'

export interface RepairPaginationSnapshot {
  count: number
  limit: number
  offset: number
}

export interface RepairDeviceSnapshot {
  id: string
  label: string | null
  deviceType: string
  manufacturer: string | null
  model: string | null
  variant: string | null
  storageCapacity: string | null
  color: string | null
  serialMasked: string | null
  imeiMasked: string | null
  createdAt: string
  updatedAt: string
}

export interface RepairCustomerSnapshot {
  id: string
  displayName: string
}

export interface RepairListItemSnapshot {
  id: string
  displayNumber: string
  aliases: string[]
  status: RepairStatus
  priority: RepairPriority
  intakeMode: RepairIntakeMode
  safeDeviceLabel: string | null
  dueAt: string | null
  readyAt: string | null
  authoritativeVersion: number
  optimisticVersion: number
  syncState: RepairSyncState
  createdAt: string
  updatedAt: string
}

export interface RepairListInput {
  staffSessionId: string
  status: RepairStatus | null
  search: string | null
  limit: number
  offset: number
}

export interface RepairListSnapshot {
  scopeToken: string
  source: 'authoritative_cache' | 'local_cache'
  repairs: RepairListItemSnapshot[]
  pagination: RepairPaginationSnapshot
}

export interface RepairWorkspaceInput {
  staffSessionId: string
  repairId: string
}

export interface RepairSettingsInput {
  staffSessionId: string
}

export interface RepairCustomerSearchInput {
  staffSessionId: string
  search: string
  limit: number
  offset: number
}

export interface RepairCustomerDevicesInput {
  staffSessionId: string
  customerId: string
}

export interface RepairCreateCustomerDeviceInput {
  staffSessionId: string
  customerId: string
  deviceId: string
  label: string | null
  deviceType: string
  manufacturer: string | null
  model: string | null
  variant: string | null
  storageCapacity: string | null
  color: string | null
}

export interface RepairCustomerSearchSnapshot {
  scopeToken: string
  customers: RepairCustomerSnapshot[]
  pagination: RepairPaginationSnapshot
}

export interface RepairCustomerDevicesSnapshot {
  scopeToken: string
  devices: RepairDeviceSnapshot[]
}

export interface RepairCapabilitiesSnapshot {
  read: boolean
  create: boolean
  update: boolean
  assign: boolean
  approve: boolean
  overrideApproval: boolean
  planParts: boolean
  consumeParts: boolean
  transfer: boolean
  cancel: boolean
  manageAttachments: boolean
  collectPayments: boolean
  refundPayments: boolean
  fiscalize: boolean
  overrideDeliveryBalance: boolean
}

export interface RepairAttachmentPolicySnapshot {
  maxBytes: number
  allowedMimeTypes: string[]
}

export interface RepairSettingsProjection {
  source: string
  numberPrefix: string
  currency: string
  quickServiceEnabled: boolean
  defaultPriority: RepairPriority
  defaultSlaHours: number | null
  readyCollectionDays: number
  deliveryBalancePolicy: string
  repairDepositSupported: boolean
  attachmentPolicy: RepairAttachmentPolicySnapshot
  updatedAt: string | null
}

export interface RepairSettingsSnapshot {
  scopeToken: string
  source: 'authoritative_cache' | 'local_cache'
  settings: RepairSettingsProjection
  capabilities: RepairCapabilitiesSnapshot
}

export interface RepairWorkspaceHeaderSnapshot {
  id: string
  displayNumber: string
  status: RepairStatus
  priority: RepairPriority
  title: string | null
  intakeMode: RepairIntakeMode
  isAnonymous: boolean
  assignedStaffId: string | null
  dueAt: string | null
  completedAt: string | null
  deliveredAt: string | null
  version: number
  createdAt: string
  updatedAt: string
  customerId: string | null
  customerDeviceId: string | null
  intakeNotes: string | null
  diagnosis: string | null
  currency: string
  reopenedFromRepairId: string | null
}

export interface RepairLineSnapshot {
  id: string
  lineType: RepairLineType
  nameSnapshot: string
  skuSnapshot: string | null
  description: string | null
  quantity: number
  unitPriceSnapshot: number
  vatRateSnapshot: number
  retailProductId: string | null
  retailVariantId: string | null
  serviceId: string | null
  partState: RepairPartState | null
  displayOrder: number
  aggregateVersion: number
  createdAt: string
  updatedAt: string
}

export interface RepairTimelineEventSnapshot {
  id: string
  aggregateVersion: number
  eventType: string
  repairLineId: string | null
  movementId: string | null
  occurredAt: string
  createdAt: string
}

export interface RepairEstimateSnapshot {
  id: string
  version: number
  supersedesEstimateId: string | null
  currency: string
  subtotalAmount: number
  discountAmount: number
  taxAmount: number
  totalAmount: number
  validUntil: string | null
  note: string | null
  aggregateVersion: number
  issuedAt: string
  createdAt: string
}

export interface RepairEstimateLineSnapshot {
  id: string
  estimateId: string
  estimateVersion: number
  repairLineId: string | null
  lineType: RepairLineType
  description: string
  quantity: number
  unitPrice: number
  taxRate: number
  subtotalAmount: number
  taxAmount: number
  totalAmount: number
  displayOrder: number
  aggregateVersion: number
  createdAt: string
}

export interface RepairApprovalSnapshot {
  id: string
  estimateId: string | null
  estimateVersion: number | null
  decision: 'accepted' | 'rejected'
  decisionSource: string
  currency: string
  approvedTotalAmount: number
  note: string | null
  decidedAt: string
  aggregateVersion: number
  createdAt: string
}

export interface RepairPendingChangeSnapshot {
  kind: string
  occurredAt: string
}

export interface RepairWorkspaceSnapshot {
  scopeToken: string
  source: 'authoritative_cache' | 'authoritative_with_local_changes' | 'local_offline'
  repair: RepairWorkspaceHeaderSnapshot
  aliases: string[]
  customer: RepairCustomerSnapshot | null
  device: RepairDeviceSnapshot | null
  lines: RepairLineSnapshot[]
  timeline: RepairTimelineEventSnapshot[]
  estimates: RepairEstimateSnapshot[]
  estimateLines: RepairEstimateLineSnapshot[]
  approvals: RepairApprovalSnapshot[]
  capabilities: RepairCapabilitiesSnapshot
  allowedTransitions: RepairStatus[]
  pendingChanges: RepairPendingChangeSnapshot[]
  syncState: RepairSyncState
  needsRefetch: boolean
}

export interface RepairEstimateLineCommandInput {
  id: string
  repair_line_id: string | null
  line_type: RepairLineType
  description: string
  quantity: string
  unit_price: string
  tax_rate: string
  display_order: number
}

export type RepairCommand =
  | { command: 'create_intake'; payload: {
      intake_mode: RepairIntakeMode
      is_anonymous: boolean
      customer_id: string | null
      customer_device_id: string | null
      priority: RepairPriority
      currency: string
      title: string | null
      intake_notes: string | null
      due_at: string | null
    } }
  | { command: 'reopen_repair'; payload: { source_repair_id: string } }
  | { command: 'add_note'; payload: { note: string; visibility: 'internal' | 'customer' } }
  | { command: 'assign_repair'; payload: { assigned_staff_id: string | null } }
  | { command: 'update_diagnosis'; payload: { diagnosis: string | null; draft: boolean } }
  | { command: 'plan_line'; payload: {
      line_id: string
      line_type: RepairLineType
      name_snapshot: string
      sku_snapshot: string | null
      description: string | null
      quantity: string
      unit_cost_snapshot: string | null
      unit_price_snapshot: string
      vat_rate_snapshot: string
      retail_product_id: string | null
      retail_variant_id: string | null
      service_id: string | null
      display_order: number
    } }
  | { command: 'consume_nonstock_part'; payload: { line_id: string } }
  | { command: 'reverse_nonstock_part'; payload: { line_id: string; reason: string } }
  | { command: 'consume_repair_part'; payload: { line_id: string } }
  | { command: 'reverse_repair_part'; payload: { line_id: string; original_movement_id: string } }
  | { command: 'create_estimate'; payload: {
      estimate_id: string
      currency: string
      discount_amount: string
      valid_until: string | null
      note: string | null
      lines: RepairEstimateLineCommandInput[]
    } }
  | { command: 'record_approval'; payload: {
      approval_id: string
      estimate_id: string | null
      decision: 'accepted' | 'rejected'
      decision_source: 'in_person' | 'phone' | 'external_message' | 'not_required'
      reason: string | null
    } }
  | { command: 'transition_status'; payload: {
      target_status: RepairStatus
      reason: string | null
      remain_consumed: boolean
    } }
  | { command: 'transfer_branch'; payload: { destination_branch_id: string } }

export interface RepairExecuteCommandInput {
  staffSessionId: string
  operationId: string
  repairId: string
  expectedVersion: number
  occurredAt: string
  command: RepairCommand
}

export interface RepairConflictSnapshot {
  conflictId: string
  repairId: string
  expectedVersion: number
  currentVersion: number
  displayNumber: string | null
  status: RepairStatus
  updatedAt: string
  allowedTransitions: RepairStatus[]
  createdAt: string
}

export type RepairCommandSnapshot =
  | {
      kind: 'applied'
      scopeToken: string
      repairId: string
      displayNumber: string | null
      status: RepairStatus
      version: number
      queuedForSync: boolean
      customerNotificationState: RepairCustomerNotificationState
    }
  | {
      kind: 'conflict'
      scopeToken: string
      conflict: RepairConflictSnapshot
    }

export interface RepairStageAttachmentInput {
  staffSessionId: string
  attachmentId: string
  operationId: string
  repairId: string
  expectedVersion: number
  occurredAt: string
  attachmentType: RepairAttachmentType
  filename: string
  caption: string | null
  mimeType: string
  bytes: number[]
}

export interface RepairStageAttachmentSnapshot {
  scopeToken: string
  repairId: string
  attachmentId: string
  optimisticVersion: number
  queuedForSync: boolean
}

export interface RepairListAttachmentsInput {
  staffSessionId: string
  repairId: string
}

export interface RepairAttachmentSnapshot {
  id: string
  attachmentType: RepairAttachmentType
  retentionState: RepairAttachmentRetentionState
  mimeType: string
  byteSize: number
  createdAt: string
}

export interface RepairAttachmentsSnapshot {
  scopeToken: string
  repairId: string
  attachments: RepairAttachmentSnapshot[]
}

export interface RepairOpenAttachmentInput {
  staffSessionId: string
  repairId: string
  attachmentId: string
}

export interface RepairOpenAttachmentSnapshot {
  scopeToken: string
  attachmentId: string
  opened: true
}

export interface RepairListConflictsInput {
  staffSessionId: string
}

export interface RepairConflictsSnapshot {
  scopeToken: string
  conflicts: RepairConflictSnapshot[]
}

export interface RepairResolveConflictInput {
  staffSessionId: string
  conflictId: string
  resolution: RepairConflictResolution
}

export interface RepairConflictResolutionSnapshot {
  scopeToken: string
  repairId: string
  state: 'accepted_server' | 'rebased'
  optimisticVersion: number
  needsRefetch: boolean
}

export interface RepairPrintInput {
  staffSessionId: string
  repairId: string
  kind: RepairPrintKind
}

export interface RepairPrintProjectionSnapshot {
  projectionSource: string
  projectionVersion: number
  projectedAt: string
  repairId: string
  repairNumber: string
  safeDeviceLabel: string
  receivedAt: string
  branchName: string
  customerDisplayName: string | null
  maskedIdentifier: string | null
  dueAt: string | null
  branchContact: string | null
}

export interface RepairPrintSnapshot {
  scopeToken: string
  kind: RepairPrintKind
  projection: RepairPrintProjectionSnapshot
}

export interface RepairEnqueuePrintInput {
  staffSessionId: string
  scopeToken: string
  repairId: string
  kind: RepairPrintKind
}

export interface RepairEnqueuePrintSnapshot {
  scopeToken: string
  repairId: string
  kind: RepairPrintKind
  jobId: string
  queued: true
}

export interface RepairCacheChangedEvent {
  scopeToken: string
  repairId: string | null
  reason: string
}

export interface RepairConflictEvent {
  scopeToken: string
  conflict: RepairConflictSnapshot
}

export interface RepairScopeResetEvent {
  scopeToken: string
  reason: 'module_revoked' | 'identity_rebound'
}

export interface RepairBarcodeScannedEvent {
  barcode: string
  source: 'serial'
  timestamp: string
}

export type RepairMoneyRequest =
  | { action: 'financial_projection'; repair_id: string }
  | {
      action: 'settlement' | 'fiscalize'
      repair_id: string
      operation_id: string
      expected_version: number
      occurred_at: string
    }
  | {
      action: 'payment'
      repair_id: string
      operation_id: string
      expected_version: number
      occurred_at: string
      amount_minor: number
      payment_method: 'cash' | 'card' | 'digital_wallet' | 'other'
      provider_reference?: string
    }
  | {
      action: 'refund'
      repair_id: string
      operation_id: string
      expected_version: number
      occurred_at: string
      payment_id: string
      amount_minor: number
      refund_method: 'cash' | 'card'
      reason: string
    }
  | {
      action: 'delivery'
      repair_id: string
      operation_id: string
      expected_version: number
      occurred_at: string
      reason?: string | null
    }

export interface RepairMoneyRequestInput {
  staffSessionId: string
  request: RepairMoneyRequest
}

export interface RepairBridge {
  list(input: RepairListInput): Promise<RepairListSnapshot>
  workspace(input: RepairWorkspaceInput): Promise<RepairWorkspaceSnapshot>
  settings(input: RepairSettingsInput): Promise<RepairSettingsSnapshot>
  moneyRequest(input: RepairMoneyRequestInput): Promise<unknown>
  searchCustomers(input: RepairCustomerSearchInput): Promise<RepairCustomerSearchSnapshot>
  customerDevices(input: RepairCustomerDevicesInput): Promise<RepairCustomerDevicesSnapshot>
  createCustomerDevice(input: RepairCreateCustomerDeviceInput): Promise<RepairCustomerDevicesSnapshot>
  executeCommand(input: RepairExecuteCommandInput): Promise<RepairCommandSnapshot>
  stageAttachment(input: RepairStageAttachmentInput): Promise<RepairStageAttachmentSnapshot>
  listAttachments(input: RepairListAttachmentsInput): Promise<RepairAttachmentsSnapshot>
  openAttachment(input: RepairOpenAttachmentInput): Promise<RepairOpenAttachmentSnapshot>
  listConflicts(input: RepairListConflictsInput): Promise<RepairConflictsSnapshot>
  resolveConflict(input: RepairResolveConflictInput): Promise<RepairConflictResolutionSnapshot>
  printProjection(input: RepairPrintInput): Promise<RepairPrintSnapshot>
  enqueuePrint(input: RepairEnqueuePrintInput): Promise<RepairEnqueuePrintSnapshot>
}
