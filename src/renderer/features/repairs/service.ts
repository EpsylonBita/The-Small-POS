import { getBridge } from '../../../lib/ipc-adapter'

import type {
  RepairAttachmentsSnapshot,
  RepairBridge,
  RepairCommandSnapshot,
  RepairConflictResolutionSnapshot,
  RepairConflictsSnapshot,
  RepairCreateCustomerDeviceInput,
  RepairCustomerDevicesInput,
  RepairCustomerDevicesSnapshot,
  RepairCustomerSearchInput,
  RepairCustomerSearchSnapshot,
  RepairExecuteCommandInput,
  RepairEnqueuePrintInput,
  RepairEnqueuePrintSnapshot,
  RepairListAttachmentsInput,
  RepairListInput,
  RepairListSnapshot,
  RepairOpenAttachmentInput,
  RepairOpenAttachmentSnapshot,
  RepairPrintInput,
  RepairPrintSnapshot,
  RepairResolveConflictInput,
  RepairSettingsSnapshot,
  RepairStageAttachmentInput,
  RepairStageAttachmentSnapshot,
  RepairWorkspaceInput,
  RepairWorkspaceSnapshot,
} from './contracts'

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type RepairListQuery = Omit<RepairListInput, 'staffSessionId'>
export type RepairCustomerSearchQuery = Omit<RepairCustomerSearchInput, 'staffSessionId'>
export type RepairCreateCustomerDeviceRequest = Omit<RepairCreateCustomerDeviceInput, 'staffSessionId'>
export type RepairExecuteCommandRequest = Omit<RepairExecuteCommandInput, 'staffSessionId'>
export type RepairStageAttachmentRequest = Omit<RepairStageAttachmentInput, 'staffSessionId'>
export type RepairOpenAttachmentRequest = Omit<RepairOpenAttachmentInput, 'staffSessionId'>
export type RepairResolveConflictRequest = Omit<RepairResolveConflictInput, 'staffSessionId'>
export type RepairEnqueuePrintRequest = Omit<RepairEnqueuePrintInput, 'staffSessionId'>

export interface RepairServiceBridge {
  staffAuth: {
    getSession(): Promise<unknown>
  }
  repairs: RepairBridge
}

export interface RepairServicePort {
  list(input: RepairListQuery): Promise<RepairListSnapshot>
  workspace(repairId: string): Promise<RepairWorkspaceSnapshot>
  settings(): Promise<RepairSettingsSnapshot>
  searchCustomers(input: RepairCustomerSearchQuery): Promise<RepairCustomerSearchSnapshot>
  customerDevices(customerId: string): Promise<RepairCustomerDevicesSnapshot>
  createCustomerDevice(input: RepairCreateCustomerDeviceRequest): Promise<RepairCustomerDevicesSnapshot>
  executeCommand(input: RepairExecuteCommandRequest): Promise<RepairCommandSnapshot>
  stageAttachment(input: RepairStageAttachmentRequest): Promise<RepairStageAttachmentSnapshot>
  listAttachments(repairId: string): Promise<RepairAttachmentsSnapshot>
  openAttachment(input: RepairOpenAttachmentRequest): Promise<RepairOpenAttachmentSnapshot>
  listConflicts(): Promise<RepairConflictsSnapshot>
  resolveConflict(input: RepairResolveConflictRequest): Promise<RepairConflictResolutionSnapshot>
  printProjection(repairId: string, kind: RepairPrintInput['kind']): Promise<RepairPrintSnapshot>
  enqueuePrint(input: RepairEnqueuePrintRequest): Promise<RepairEnqueuePrintSnapshot>
}

function isSecureSession(value: unknown): value is { sessionId: string } {
  if (typeof value !== 'object' || value === null) return false
  const sessionId = (value as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && CANONICAL_UUID.test(sessionId)
}

/**
 * Renderer service for the frozen native repair API.
 *
 * Tenant, branch, terminal, credentials and transport details never enter this
 * boundary. Native code derives them from its bound scope; only the current
 * secure staff session is injected here.
 */
export class RepairService implements RepairServicePort {
  constructor(private readonly bridge: RepairServiceBridge = getBridge()) {}

  private async staffSessionId(): Promise<string> {
    const session = await this.bridge.staffAuth.getSession()
    if (!isSecureSession(session)) {
      throw new Error('REPAIR_STAFF_SESSION_REQUIRED')
    }
    return session.sessionId
  }

  async list(input: RepairListQuery): Promise<RepairListSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.list({
      staffSessionId,
      status: input.status,
      search: input.search,
      limit: input.limit,
      offset: input.offset,
    })
  }

  async workspace(repairId: string): Promise<RepairWorkspaceSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.workspace({ staffSessionId, repairId } satisfies RepairWorkspaceInput)
  }

  async settings(): Promise<RepairSettingsSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.settings({ staffSessionId })
  }

  async searchCustomers(input: RepairCustomerSearchQuery): Promise<RepairCustomerSearchSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.searchCustomers({
      staffSessionId,
      search: input.search,
      limit: input.limit,
      offset: input.offset,
    })
  }

  async customerDevices(customerId: string): Promise<RepairCustomerDevicesSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.customerDevices({
      staffSessionId,
      customerId,
    } satisfies RepairCustomerDevicesInput)
  }

  async createCustomerDevice(
    input: RepairCreateCustomerDeviceRequest,
  ): Promise<RepairCustomerDevicesSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.createCustomerDevice({
      staffSessionId,
      customerId: input.customerId,
      deviceId: input.deviceId,
      label: input.label,
      deviceType: input.deviceType,
      manufacturer: input.manufacturer,
      model: input.model,
      variant: input.variant,
      storageCapacity: input.storageCapacity,
      color: input.color,
    })
  }

  async executeCommand(input: RepairExecuteCommandRequest): Promise<RepairCommandSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.executeCommand({
      staffSessionId,
      operationId: input.operationId,
      repairId: input.repairId,
      expectedVersion: input.expectedVersion,
      occurredAt: input.occurredAt,
      command: input.command,
    })
  }

  async stageAttachment(input: RepairStageAttachmentRequest): Promise<RepairStageAttachmentSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.stageAttachment({
      staffSessionId,
      attachmentId: input.attachmentId,
      operationId: input.operationId,
      repairId: input.repairId,
      expectedVersion: input.expectedVersion,
      occurredAt: input.occurredAt,
      attachmentType: input.attachmentType,
      filename: input.filename,
      caption: input.caption,
      mimeType: input.mimeType,
      bytes: input.bytes,
    })
  }

  async listAttachments(repairId: string): Promise<RepairAttachmentsSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.listAttachments({
      staffSessionId,
      repairId,
    } satisfies RepairListAttachmentsInput)
  }

  async openAttachment(input: RepairOpenAttachmentRequest): Promise<RepairOpenAttachmentSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.openAttachment({
      staffSessionId,
      repairId: input.repairId,
      attachmentId: input.attachmentId,
    } satisfies RepairOpenAttachmentInput)
  }

  async listConflicts(): Promise<RepairConflictsSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.listConflicts({ staffSessionId })
  }

  async resolveConflict(
    input: RepairResolveConflictRequest,
  ): Promise<RepairConflictResolutionSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.resolveConflict({
      staffSessionId,
      conflictId: input.conflictId,
      resolution: input.resolution,
    })
  }

  async printProjection(repairId: string, kind: RepairPrintInput['kind']): Promise<RepairPrintSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.printProjection({ staffSessionId, repairId, kind })
  }

  async enqueuePrint(input: RepairEnqueuePrintRequest): Promise<RepairEnqueuePrintSnapshot> {
    const staffSessionId = await this.staffSessionId()
    return this.bridge.repairs.enqueuePrint({
      staffSessionId,
      scopeToken: input.scopeToken,
      repairId: input.repairId,
      kind: input.kind,
    })
  }
}

export const repairService = new RepairService()
