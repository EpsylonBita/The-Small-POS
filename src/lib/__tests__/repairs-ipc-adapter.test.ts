import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter'

type RepairBridgeForTest = Record<string, (input: Record<string, unknown>) => Promise<unknown>>

describe('repairs Tauri IPC adapter', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue({ scopeToken: 'scope-a' })
  })

  it('uses the bounded repair commands with one named input argument', async () => {
    const repairs = (new TauriBridge() as unknown as { repairs: RepairBridgeForTest }).repairs
    const cases = [
      ['list', 'repairs_list'],
      ['workspace', 'repairs_workspace'],
      ['settings', 'repairs_settings'],
      ['moneyRequest', 'repairs_money_request'],
      ['searchCustomers', 'repairs_search_customers'],
      ['customerDevices', 'repairs_customer_devices'],
      ['createCustomerDevice', 'repairs_create_customer_device'],
      ['executeCommand', 'repairs_execute_command'],
      ['stageAttachment', 'repairs_stage_attachment'],
      ['listAttachments', 'repairs_list_attachments'],
      ['openAttachment', 'repairs_open_attachment'],
      ['listConflicts', 'repairs_list_conflicts'],
      ['resolveConflict', 'repairs_resolve_conflict'],
      ['printProjection', 'repairs_print_projection'],
      ['enqueuePrint', 'repairs_enqueue_print'],
    ] as const

    for (const [method, command] of cases) {
      const input = { staffSessionId: '11111111-1111-4111-8111-111111111111' }
      await repairs[method](input)
      expect(mocks.invoke).toHaveBeenLastCalledWith(command, { input })
      expect(mocks.invoke).not.toHaveBeenLastCalledWith(command, { arg0: input })
    }
  })

  it('publishes every frozen repair command in CHANNEL_MAP', () => {
    expect(Object.fromEntries(
      Object.entries(CHANNEL_MAP).filter(([channel]) => channel.startsWith('repairs:')),
    )).toEqual({
      'repairs:list': 'repairs.list',
      'repairs:workspace': 'repairs.workspace',
      'repairs:settings': 'repairs.settings',
      'repairs:money-request': 'repairs.moneyRequest',
      'repairs:search-customers': 'repairs.searchCustomers',
      'repairs:customer-devices': 'repairs.customerDevices',
      'repairs:create-customer-device': 'repairs.createCustomerDevice',
      'repairs:execute-command': 'repairs.executeCommand',
      'repairs:stage-attachment': 'repairs.stageAttachment',
      'repairs:list-attachments': 'repairs.listAttachments',
      'repairs:open-attachment': 'repairs.openAttachment',
      'repairs:list-conflicts': 'repairs.listConflicts',
      'repairs:resolve-conflict': 'repairs.resolveConflict',
      'repairs:print-projection': 'repairs.printProjection',
      'repairs:enqueue-print': 'repairs.enqueuePrint',
    })
  })
})
