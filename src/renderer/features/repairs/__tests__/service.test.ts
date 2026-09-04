import { describe, expect, it, vi } from 'vitest'

import type {
  RepairBridge,
  RepairExecuteCommandInput,
  RepairEnqueuePrintInput,
  RepairOpenAttachmentInput,
  RepairStageAttachmentInput,
} from '../contracts'
import { RepairService, type RepairServiceBridge } from '../service'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const REPAIR_ID = '22222222-2222-4222-8222-222222222222'
const OPERATION_ID = '33333333-3333-4333-8333-333333333333'
const ATTACHMENT_ID = '44444444-4444-4444-8444-444444444444'

function bridgeWith(
  repairs: Partial<Record<keyof RepairBridge, ReturnType<typeof vi.fn>>>,
  session: unknown = { sessionId: SESSION_ID },
): RepairServiceBridge {
  return {
    staffAuth: { getSession: vi.fn().mockResolvedValue(session) },
    repairs: repairs as unknown as RepairBridge,
  }
}

describe('RepairService secure native boundary', () => {
  it('injects the current secure staff session into command envelopes', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      kind: 'applied',
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      displayNumber: 'R-OFF-ABCD-000001',
      status: 'diagnosing',
      version: 1,
      queuedForSync: true,
      customerNotificationState: 'not_requested',
    })
    const service = new RepairService(bridgeWith({ executeCommand }))

    await service.executeCommand({
      operationId: OPERATION_ID,
      repairId: REPAIR_ID,
      expectedVersion: 0,
      occurredAt: '2026-08-27T08:00:00.000Z',
      command: {
        command: 'update_diagnosis',
        payload: { diagnosis: 'Draft finding', draft: true },
      },
    })

    expect(executeCommand).toHaveBeenCalledWith({
      staffSessionId: SESSION_ID,
      operationId: OPERATION_ID,
      repairId: REPAIR_ID,
      expectedVersion: 0,
      occurredAt: '2026-08-27T08:00:00.000Z',
      command: {
        command: 'update_diagnosis',
        payload: { diagnosis: 'Draft finding', draft: true },
      },
    } satisfies RepairExecuteCommandInput)
  })

  it('copies only the frozen attachment fields and drops hostile transport context', async () => {
    const stageAttachment = vi.fn().mockResolvedValue({
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      attachmentId: ATTACHMENT_ID,
      optimisticVersion: 2,
      queuedForSync: true,
    })
    const service = new RepairService(bridgeWith({ stageAttachment }))
    const callerInput = {
      attachmentId: ATTACHMENT_ID,
      operationId: OPERATION_ID,
      repairId: REPAIR_ID,
      expectedVersion: 1,
      occurredAt: '2026-08-27T08:00:00.000Z',
      attachmentType: 'intake' as const,
      filename: 'device.jpg',
      caption: null,
      mimeType: 'image/jpeg',
      bytes: [1, 2, 3],
      staffSessionId: 'attacker-session',
      organizationId: 'attacker-org',
      terminalId: 'attacker-terminal',
      credential: 'secret',
      url: 'https://attacker.invalid',
      path: '../../secret',
      headers: { authorization: 'secret' },
      method: 'DELETE',
    }

    await service.stageAttachment(callerInput)

    expect(stageAttachment).toHaveBeenCalledWith({
      staffSessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      operationId: OPERATION_ID,
      repairId: REPAIR_ID,
      expectedVersion: 1,
      occurredAt: '2026-08-27T08:00:00.000Z',
      attachmentType: 'intake',
      filename: 'device.jpg',
      caption: null,
      mimeType: 'image/jpeg',
      bytes: [1, 2, 3],
    } satisfies RepairStageAttachmentInput)
  })

  it('opens an attachment through the native fixed-route boundary only', async () => {
    const openAttachment = vi.fn().mockResolvedValue({
      scopeToken: 'scope-a',
      attachmentId: ATTACHMENT_ID,
      opened: true,
    })
    const service = new RepairService(bridgeWith({ openAttachment }))

    await service.openAttachment({
      repairId: REPAIR_ID,
      attachmentId: ATTACHMENT_ID,
      url: 'https://attacker.invalid',
      path: '../../secret',
      mimeType: 'text/html',
    } as never)

    expect(openAttachment).toHaveBeenCalledWith({
      staffSessionId: SESSION_ID,
      repairId: REPAIR_ID,
      attachmentId: ATTACHMENT_ID,
    } satisfies RepairOpenAttachmentInput)
  })

  it('queues repair printing without accepting a renderer-authored projection', async () => {
    const enqueuePrint = vi.fn().mockResolvedValue({
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      kind: 'repair_intake',
      jobId: '55555555-5555-4555-8555-555555555555',
      queued: true,
    })
    const service = new RepairService(bridgeWith({ enqueuePrint }))
    await service.enqueuePrint({
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      kind: 'repair_intake',
      projection: { repairId: 'renderer-controlled' },
      diagnosis: 'must not cross',
      amount: 123,
    } as never)

    expect(enqueuePrint).toHaveBeenCalledWith({
      staffSessionId: SESSION_ID,
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      kind: 'repair_intake',
    } satisfies RepairEnqueuePrintInput)
  })

  it.each([null, {}, { sessionId: '' }, { sessionId: 'not-a-uuid' }])(
    'fails closed when secure staff session is invalid: %j',
    async (session) => {
      const list = vi.fn()
      const service = new RepairService(bridgeWith({ list }, session))

      await expect(
        service.list({ status: null, search: null, limit: 20, offset: 0 }),
      ).rejects.toThrow('REPAIR_STAFF_SESSION_REQUIRED')
      expect(list).not.toHaveBeenCalled()
    },
  )
})
