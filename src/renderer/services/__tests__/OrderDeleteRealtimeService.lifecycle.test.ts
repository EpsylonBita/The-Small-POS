import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../../../shared/supabase', () => ({
  supabase: {
    channel: mocks.channel,
    removeChannel: mocks.removeChannel,
  },
}))

import { subscribeToAdminOrderDeletedEvents } from '../OrderDeleteRealtimeService'

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

  const unsubscribe = subscribeToAdminOrderDeletedEvents({
    terminalId: 'terminal-1',
    organizationId: 'org-1',
    branchId: 'branch-1',
  })

  return { broadcastHandler, statusHandler, channel, unsubscribe }
}

describe('OrderDeleteRealtimeService lifecycle', () => {
  beforeEach(() => {
    mocks.deleteOrder.mockResolvedValue({ success: true })
    mocks.removeChannel.mockResolvedValue(undefined)
  })

  it('deletes a valid targeted order while the authenticated subscription is active', async () => {
    const { broadcastHandler } = subscribeWithCapturedBroadcast()

    await broadcastHandler({ payload: validDeletePayload('order-active') })

    expect(mocks.deleteOrder).toHaveBeenCalledOnce()
    expect(mocks.deleteOrder).toHaveBeenCalledWith('order-active')
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
