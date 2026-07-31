import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const mocks = vi.hoisted(() => ({
  deleteOrder: vi.fn(),
  removeChannel: vi.fn(),
  channel: vi.fn(),
}))

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    orders: {
      delete: mocks.deleteOrder,
    },
  }),
}))

import { subscribeToAdminOrderDeletedEvents } from '../OrderDeleteRealtimeService'

const realtimeClient = {
  channel: mocks.channel,
  removeChannel: mocks.removeChannel,
} as Parameters<typeof subscribeToAdminOrderDeletedEvents>[0]

type BroadcastHandler = (event: { payload?: unknown }) => Promise<void>
type StatusHandler = (status: string, error?: Error) => void

function validDeletePayload(orderId: string) {
  return {
    orderId,
    organizationId: 'org-1',
    branchId: 'branch-1',
    sourceTerminalId: 'terminal-1',
  }
}

function subscribeWithCapturedBroadcast() {
  let broadcastHandler!: BroadcastHandler
  let statusHandler!: StatusHandler
  const channel = {
    on: vi.fn(
      (
        _kind: string,
        _filter: Record<string, unknown>,
        handler: BroadcastHandler,
      ) => {
        broadcastHandler = handler
        return channel
      },
    ),
    subscribe: vi.fn((handler: StatusHandler) => {
      statusHandler = handler
      return channel
    }),
  }
  mocks.channel.mockReturnValue(channel)

  const unsubscribe = subscribeToAdminOrderDeletedEvents(
    realtimeClient,
    {
      terminalId: 'terminal-1',
      organizationId: 'org-1',
      branchId: 'branch-1',
    },
  )

  return { broadcastHandler, statusHandler, channel, unsubscribe }
}

describe('OrderDeleteRealtimeService lifecycle', () => {
  beforeEach(() => {
    mocks.deleteOrder.mockResolvedValue({ success: true })
    mocks.removeChannel.mockResolvedValue(undefined)
  })

  it('keeps the destructive legacy listener disabled in desktop bootstrap', () => {
    const appSource = readFileSync(
      path.join(process.cwd(), 'src', 'renderer', 'App.tsx'),
      'utf8',
    )

    expect(appSource).not.toContain('subscribeToAdminOrderDeletedEvents')
    expect(appSource).toContain('strict POS sync API')
  })

  it('deletes a valid targeted order while the authenticated subscription is active', async () => {
    const { broadcastHandler } = subscribeWithCapturedBroadcast()

    expect(mocks.channel).toHaveBeenCalledWith('orders:org-1', {
      config: { private: true, broadcast: { self: false } },
    })

    await broadcastHandler({ payload: validDeletePayload('order-active') })

    expect(mocks.deleteOrder).toHaveBeenCalledOnce()
    expect(mocks.deleteOrder).toHaveBeenCalledWith('order-active')
  })

  it('rejects destructive broadcasts without exact organization and branch context', async () => {
    const { broadcastHandler } = subscribeWithCapturedBroadcast()

    await broadcastHandler({
      payload: {
        orderId: 'order-unscoped',
        sourceTerminalId: 'terminal-1',
      },
    })
    await broadcastHandler({
      payload: {
        ...validDeletePayload('order-other-branch'),
        branchId: 'branch-2',
      },
    })

    expect(mocks.deleteOrder).not.toHaveBeenCalled()
  })

  it('ignores a valid broadcast immediately after cleanup while channel removal is pending', async () => {
    const removal = deferred<void>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.removeChannel.mockReturnValue(removal.promise)
    const { broadcastHandler, statusHandler, channel, unsubscribe } =
      subscribeWithCapturedBroadcast()

    unsubscribe()
    await broadcastHandler({ payload: validDeletePayload('order-stale') })
    statusHandler('CHANNEL_ERROR', new Error('stale channel'))

    expect(mocks.deleteOrder).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(mocks.removeChannel).toHaveBeenCalledOnce()
    expect(mocks.removeChannel).toHaveBeenCalledWith(channel)

    removal.resolve()
    await removal.promise
    expect(mocks.deleteOrder).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
