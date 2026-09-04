import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { TauriBridge } from '../ipc-adapter'

const sessionId = '11111111-1111-4111-8111-111111111111'
const customerId = '22222222-2222-4222-8222-222222222222'
const repairId = '33333333-3333-4333-8333-333333333333'
const messageId = '44444444-4444-4444-8444-444444444444'

describe('Customer Messaging native IPC transport', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue({})
  })

  it('carries the exact minimal send payload and stable operation key', async () => {
    const bridge = new TauriBridge()
    await bridge.customerMessaging.send({
      staffSessionId: sessionId,
      customerId,
      repairId,
      repairVersion: 7,
      idempotencyKey: `repair-ready:${repairId}:v7`,
    })
    expect(mocks.invoke).toHaveBeenCalledWith('customer_messaging_request', { input: {
      staffSessionId: sessionId,
      path: '/api/pos/customer-messaging/messages/send',
      method: 'POST',
      body: {
        customer_id: customerId,
        repair_id: repairId,
        repair_version: 7,
        idempotency_key: `repair-ready:${repairId}:v7`,
      },
    } })
  })

  it('does not drop retry operation idempotency at the native boundary', async () => {
    const bridge = new TauriBridge()
    await bridge.customerMessaging.retry({
      staffSessionId: sessionId,
      messageId,
      idempotencyKey: 'retry-stable-operation',
    })
    expect(mocks.invoke).toHaveBeenCalledWith('customer_messaging_request', { input: expect.objectContaining({
      body: { idempotency_key: 'retry-stable-operation' },
    }) })
  })

  it('posts the exact transactional preference contract to the fixed POS route', async () => {
    const bridge = new TauriBridge()
    await bridge.customerMessaging.preference({
      staffSessionId: sessionId,
      customerId,
      decision: 'allow',
      channel: 'whatsapp',
      connectionId: sessionId,
    })
    expect(mocks.invoke).toHaveBeenCalledWith('customer_messaging_request', { input: {
      staffSessionId: sessionId,
      path: '/api/pos/customer-messaging',
      method: 'POST',
      body: {
        customer_id: customerId,
        decision: 'allow',
        channel: 'whatsapp',
        connection_id: sessionId,
        purpose: 'transactional',
      },
    } })
  })
})
