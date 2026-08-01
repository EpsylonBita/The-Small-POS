import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  channel: vi.fn(),
  removeChannel: vi.fn(),
  isTopicRetiring: vi.fn(),
  posApiGet: vi.fn(),
  posApiPost: vi.fn(),
}))

vi.mock('../../utils/api-helpers', () => ({
  posApiGet: mocks.posApiGet,
  posApiPost: mocks.posApiPost,
}))

import {
  reportCallerIdReceipt,
  subscribeToCallerIdEvents as subscribeToCallerIdEventsWithClient,
} from '../CallerIdRealtimeService'

const realtimeClient = {
  channel: mocks.channel,
  removeChannel: mocks.removeChannel,
  isTopicRetiring: mocks.isTopicRetiring,
} as Parameters<typeof subscribeToCallerIdEventsWithClient>[0]

function subscribeToCallerIdEvents(
  organizationId: string,
  terminalId: string,
  onEvent: Parameters<typeof subscribeToCallerIdEventsWithClient>[3],
  isIdentityCurrent: () => boolean = () => true,
) {
  return subscribeToCallerIdEventsWithClient(
    realtimeClient,
    organizationId,
    terminalId,
    onEvent,
    isIdentityCurrent,
  )
}

type BroadcastHandler = (message: { payload?: unknown }) => void
type StatusHandler = (status: string, error?: Error) => void

function makeChannel(
  topic: string,
  handlers: Map<string, BroadcastHandler>,
  statuses: Map<string, StatusHandler>,
) {
  const channel = {
    on: vi.fn(
      (
        _kind: string,
        filter: { event: string },
        handler: BroadcastHandler,
      ) => {
        handlers.set(topic, handler)
        expect(filter).toEqual({ event: 'caller_id' })
        return channel
      },
    ),
    subscribe: vi.fn((handler: StatusHandler) => {
      statuses.set(topic, handler)
      return channel
    }),
  }
  return channel
}

describe('CallerIdRealtimeService', () => {
  const now = new Date('2026-07-27T10:00:31.000Z')
  const firstLineId = '10000000-0000-4000-8000-000000000001'
  const secondLineId = '10000000-0000-4000-8000-000000000002'
  const handlers = new Map<string, BroadcastHandler>()
  const statuses = new Map<string, StatusHandler>()

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime())
    handlers.clear()
    statuses.clear()
    mocks.isTopicRetiring.mockReturnValue(false)
    mocks.posApiPost.mockResolvedValue({ success: true })
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        receivingLines: [
          {
            id: firstLineId,
            name: 'Main line',
            topic: `callerid:line:${firstLineId}`,
            version: 1,
          },
          {
            id: secondLineId,
            name: 'Delivery line',
            topic: `callerid:line:${secondLineId}`,
            version: 1,
          },
        ],
      },
    })
    mocks.channel.mockImplementation(
      (topic: string, options: Record<string, unknown>) => {
        expect(options).toEqual({
          config: { private: true, broadcast: { self: false } },
        })
        return makeChannel(topic, handlers, statuses)
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('subscribes only to terminal-selected private line topics', async () => {
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents('org-1', 'terminal-1', onEvent)
    await vi.waitFor(() => expect(mocks.channel).toHaveBeenCalledTimes(2))

    expect(mocks.posApiGet).toHaveBeenCalledWith('/api/pos/caller-id/config')
    expect([...handlers.keys()]).toEqual([
      `callerid:line:${firstLineId}`,
      `callerid:line:${secondLineId}`,
    ])

    unsubscribe()
    expect(mocks.removeChannel).toHaveBeenCalledTimes(2)
  })

  it('waits for a session-level topic retirement from an earlier subscription', async () => {
    vi.useFakeTimers()
    mocks.isTopicRetiring.mockReturnValue(true)
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        receivingLines: [
          {
            id: firstLineId,
            name: 'Main line',
            topic: `callerid:line:${firstLineId}`,
            version: 1,
          },
        ],
      },
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.channel).not.toHaveBeenCalled()

    mocks.isTopicRetiring.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.channel).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('drops an event replayed 31 seconds after it occurred', async () => {
    const onEvent = vi.fn()
    subscribeToCallerIdEvents('org-1', 'terminal-1', onEvent)
    await vi.waitFor(() => expect(handlers.size).toBe(2))

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId: '20000000-0000-4000-8000-000000000001',
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:00.000Z',
      },
    })

    expect(onEvent).not.toHaveBeenCalled()
  })

  it('rejects a Realtime event from a different immutable line version', async () => {
    const onEvent = vi.fn()
    const eventId = '20000000-0000-4000-8000-000000000026'
    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.waitFor(() => expect(handlers.size).toBe(2))

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId,
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 2,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })

    expect(onEvent).not.toHaveBeenCalled()
    expect(mocks.posApiPost).not.toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${eventId}/receipt`,
      expect.anything(),
    )
    unsubscribe()
  })

  it('polls config, ACKs the exact subscribed readiness version, and reconciles lines without restart', async () => {
    vi.useFakeTimers()
    const attemptId = '30000000-0000-4000-8000-000000000001'
    mocks.posApiGet
      .mockResolvedValueOnce({
        success: true,
        data: { receivingLines: [] },
      })
      .mockResolvedValue({
        success: true,
        data: {
          receivingLines: [
            {
              id: firstLineId,
              name: 'Main line',
              topic: `callerid:line:${firstLineId}`,
              version: 7,
              readinessAttempt: {
                attemptId,
                lineVersion: 7,
                expiresAt: new Date(now.getTime() + 10_000).toISOString(),
              },
            },
          ],
        },
      })

    const unsubscribe = subscribeToCallerIdEvents('org-1', 'terminal-1', vi.fn())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.channel).toHaveBeenCalledTimes(1)

    statuses.get(`callerid:line:${firstLineId}`)?.('SUBSCRIBED')
    await Promise.resolve()
    expect(mocks.posApiPost).toHaveBeenCalledWith(
      '/api/pos/caller-id/readiness',
      { attemptId, lineId: firstLineId, lineVersion: 7 },
    )
    unsubscribe()
  })

  it('removes a rejected channel and recreates it after a bounded retry delay', async () => {
    vi.useFakeTimers()
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        receivingLines: [
          {
            id: firstLineId,
            name: 'Main line',
            topic: `callerid:line:${firstLineId}`,
            version: 1,
          },
        ],
      },
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.channel).toHaveBeenCalledTimes(1)
    const rejectedChannel = mocks.channel.mock.results[0]?.value

    statuses
      .get(`callerid:line:${firstLineId}`)
      ?.('CHANNEL_ERROR', new Error('Unauthorized'))
    await vi.advanceTimersByTimeAsync(999)

    expect(mocks.removeChannel).toHaveBeenCalledWith(rejectedChannel)
    expect(mocks.channel).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.channel).toHaveBeenCalledTimes(2)

    unsubscribe()
  })

  it('ACKs readiness through strict event polling after private channel authorization fails', async () => {
    vi.useFakeTimers()
    const attemptId = '30000000-0000-4000-8000-000000000003'
    let eventPolls = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 9,
                readinessAttempt: {
                  attemptId,
                  lineVersion: 9,
                  expiresAt: new Date(now.getTime() + 10_000).toISOString(),
                },
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        eventPolls += 1
        return Promise.resolve(
          eventPolls === 1
            ? { success: false }
            : {
                success: true,
                data: { serverTime: now.toISOString(), events: [] },
              },
        )
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)

    statuses
      .get(`callerid:line:${firstLineId}`)
      ?.('CHANNEL_ERROR', new Error('Unauthorized'))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.posApiGet).toHaveBeenCalledWith('/api/pos/caller-id/events')
    expect(mocks.posApiPost).toHaveBeenCalledWith(
      '/api/pos/caller-id/readiness',
      { attemptId, lineId: firstLineId, lineVersion: 9 },
    )
    unsubscribe()
  })

  it('delivers and receipts a polled event once after private Realtime fails', async () => {
    vi.useFakeTimers()
    const eventId = '20000000-0000-4000-8000-000000000016'
    const event = {
      eventId,
      lineId: firstLineId,
      lineName: 'Main line',
      lineVersion: 1,
      callerNumber: '+302101234567',
      presentation: 'allowed',
      occurredAt: '2026-07-27T10:00:30.000Z',
      deliveryExpiresAt: '2026-07-27T10:01:00.000Z',
    }
    let eventPolls = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        eventPolls += 1
        return Promise.resolve({
          success: true,
          data: {
            serverTime: now.toISOString(),
            events: eventPolls === 1 ? [] : [event],
          },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)
    statuses
      .get(`callerid:line:${firstLineId}`)
      ?.('CHANNEL_ERROR', new Error('Unauthorized'))

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sipCallId: eventId,
        callerNumber: '+302101234567',
        lineId: firstLineId,
      }),
    )
    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)
    expect(mocks.posApiPost).toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${eventId}/receipt`,
      { status: 'received' },
    )

    unsubscribe()
  })

  it.each([
    [
      'malformed',
      {
        serverTime: 'not-an-iso-timestamp',
        events: [],
      },
    ],
    [
      'expired',
      {
        serverTime: now.toISOString(),
        events: [
          {
            eventId: '20000000-0000-4000-8000-000000000017',
            lineId: firstLineId,
            lineName: 'Main line',
            lineVersion: 10,
            callerNumber: '+302101234567',
            presentation: 'allowed',
            occurredAt: '2026-07-27T10:00:29.000Z',
            deliveryExpiresAt: '2026-07-27T10:00:30.000Z',
          },
        ],
      },
    ],
  ])(
    'does not ACK readiness for a successful but %s event polling payload',
    async (_case, pollingData) => {
      vi.useFakeTimers()
      const attemptId = '30000000-0000-4000-8000-000000000004'
      mocks.posApiGet.mockImplementation((path: string) => {
        if (path === '/api/pos/caller-id/config') {
          return Promise.resolve({
            success: true,
            data: {
              receivingLines: [
                {
                  id: firstLineId,
                  name: 'Main line',
                  topic: `callerid:line:${firstLineId}`,
                  version: 10,
                  readinessAttempt: {
                    attemptId,
                    lineVersion: 10,
                    expiresAt: new Date(now.getTime() + 10_000).toISOString(),
                  },
                },
              ],
            },
          })
        }
        if (path === '/api/pos/caller-id/events') {
          return Promise.resolve({ success: true, data: pollingData })
        }
        return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
      })

      const unsubscribe = subscribeToCallerIdEvents(
        'org-1',
        'terminal-1',
        vi.fn(),
      )
      await vi.advanceTimersByTimeAsync(0)
      statuses
        .get(`callerid:line:${firstLineId}`)
        ?.('CHANNEL_ERROR', new Error('Unauthorized'))
      await vi.advanceTimersByTimeAsync(1_000)

      expect(mocks.posApiGet).toHaveBeenCalledWith('/api/pos/caller-id/events')
      expect(mocks.posApiPost).not.toHaveBeenCalledWith(
        '/api/pos/caller-id/readiness',
        expect.anything(),
      )
      unsubscribe()
    },
  )

  it('does not receipt or deliver a polled event expired at server time', async () => {
    vi.useFakeTimers()
    const eventId = '20000000-0000-4000-8000-000000000018'
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        return Promise.resolve({
          success: true,
          data: {
            serverTime: '2026-07-27T10:00:31.000Z',
            events: [
              {
                eventId,
                lineId: firstLineId,
                lineName: 'Main line',
                lineVersion: 1,
                callerNumber: '+302101234567',
                presentation: 'allowed',
                occurredAt: '2026-07-27T10:00:29.000Z',
                deliveryExpiresAt: '2026-07-27T10:00:30.000Z',
              },
            ],
          },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)
    statuses
      .get(`callerid:line:${firstLineId}`)
      ?.('CHANNEL_ERROR', new Error('Unauthorized'))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.posApiGet).toHaveBeenCalledWith('/api/pos/caller-id/events')
    expect(onEvent).not.toHaveBeenCalled()
    expect(mocks.posApiPost).not.toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${eventId}/receipt`,
      expect.anything(),
    )
    unsubscribe()
  })

  it('does not extend the server remaining delivery TTL when an event poll is delayed', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const eventId = '20000000-0000-4000-8000-000000000019'
    let resolveEventPoll!: (value: {
      success: boolean
      data: {
        serverTime: string
        events: Array<Record<string, unknown>>
      }
    }) => void
    const delayedEventPoll = new Promise<{
      success: boolean
      data: {
        serverTime: string
        events: Array<Record<string, unknown>>
      }
    }>((resolve) => {
      resolveEventPoll = resolve
    })
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') return delayedEventPoll
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)
    statuses
      .get(`callerid:line:${firstLineId}`)
      ?.('CHANNEL_ERROR', new Error('Unauthorized'))

    await vi.advanceTimersByTimeAsync(8_000)
    resolveEventPoll({
      success: true,
      data: {
        serverTime: now.toISOString(),
        events: [
          {
            eventId,
            lineId: firstLineId,
            lineName: 'Main line',
            lineVersion: 1,
            callerNumber: '+302101234567',
            presentation: 'allowed',
            occurredAt: '2026-07-27T10:00:30.000Z',
            deliveryExpiresAt: '2026-07-27T10:00:41.000Z',
          },
        ],
      },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(onEvent).toHaveBeenCalledTimes(1)
    const delivered = onEvent.mock.calls[0]?.[0]
    mocks.posApiPost.mockClear()
    await vi.advanceTimersByTimeAsync(2_001)

    await expect(
      delivered?.reportReceipt?.({ status: 'displayed' }),
    ).resolves.toBe(false)
    expect(mocks.posApiPost).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('throttles fallback polling to one request per intended cadence over 60 seconds', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const eventPollTimes: number[] = []
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        eventPollTimes.push(Date.now())
        return Promise.resolve({
          success: true,
          data: { serverTime: new Date(Date.now()).toISOString(), events: [] },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)
    statuses
      .get(`callerid:line:${firstLineId}`)
      ?.('CHANNEL_ERROR', new Error('Unauthorized'))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(eventPollTimes.length).toBeLessThanOrEqual(61)
    expect(
      eventPollTimes.slice(1).every(
        (startedAt, index) => startedAt - eventPollTimes[index]! >= 1_000,
      ),
    ).toBe(true)
    unsubscribe()
  })

  it('keeps at most one readiness ACK in flight for an attempt', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const attemptId = '30000000-0000-4000-8000-000000000005'
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 11,
                readinessAttempt: {
                  attemptId,
                  lineVersion: 11,
                  expiresAt: new Date(now.getTime() + 70_000).toISOString(),
                },
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        return Promise.resolve({
          success: true,
          data: { serverTime: new Date(Date.now()).toISOString(), events: [] },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    mocks.posApiPost.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/readiness') {
        return new Promise(() => {})
      }
      return Promise.resolve({ success: true })
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)
    statuses.get(`callerid:line:${firstLineId}`)?.('SUBSCRIBED')
    await vi.advanceTimersByTimeAsync(5_000)

    const readinessPosts = mocks.posApiPost.mock.calls.filter(
      ([path]) => path === '/api/pos/caller-id/readiness',
    )
    expect(readinessPosts).toHaveLength(1)
    unsubscribe()
  })

  it('performs one startup catch-up poll even when Realtime subscribes immediately', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const eventId = '20000000-0000-4000-8000-000000000020'
    let eventPolls = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        eventPolls += 1
        return Promise.resolve({
          success: true,
          data: {
            serverTime: now.toISOString(),
            events: [
              {
                eventId,
                lineId: firstLineId,
                lineName: 'Main line',
                lineVersion: 1,
                callerNumber: '+302101234567',
                presentation: 'allowed',
                occurredAt: '2026-07-27T10:00:30.000Z',
                deliveryExpiresAt: '2026-07-27T10:00:50.000Z',
              },
            ],
          },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    mocks.channel.mockImplementationOnce((topic: string) => {
      const channel = {
        on: vi.fn(
          (
            _kind: string,
            _filter: { event: string },
            handler: BroadcastHandler,
          ) => {
            handlers.set(topic, handler)
            return channel
          },
        ),
        subscribe: vi.fn((status: StatusHandler) => {
          statuses.set(topic, status)
          status('SUBSCRIBED')
          return channel
        }),
      }
      return channel
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(eventPolls).toBe(1)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(mocks.posApiPost).toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${eventId}/receipt`,
      { status: 'received' },
    )
    unsubscribe()
  })

  it('keeps startup catch-up active until an asynchronous Realtime subscription is joined', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const eventId = '20000000-0000-4000-8000-000000000027'
    let eventPolls = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        eventPolls += 1
        return Promise.resolve({
          success: true,
          data: {
            serverTime: new Date(Date.now()).toISOString(),
            events:
              eventPolls === 1
                ? []
                : [
                    {
                      eventId,
                      lineId: firstLineId,
                      lineName: 'Main line',
                      lineVersion: 1,
                      callerNumber: '+302101234567',
                      presentation: 'allowed',
                      occurredAt: '2026-07-27T10:00:31.000Z',
                      deliveryExpiresAt: '2026-07-27T10:00:51.000Z',
                    },
                  ],
          },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(eventPolls).toBe(1)

    statuses.get(`callerid:line:${firstLineId}`)?.('SUBSCRIBED')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(eventPolls).toBeGreaterThanOrEqual(2)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(mocks.posApiPost).toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${eventId}/receipt`,
      { status: 'received' },
    )
    unsubscribe()
  })

  it('keeps polling long enough to catch an event committed after its readiness attempt disappears', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const attemptId = '30000000-0000-4000-8000-000000000006'
    const eventId = '20000000-0000-4000-8000-000000000029'
    let configLoads = 0
    let eventPolls = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        configLoads += 1
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
                ...(configLoads === 1
                  ? {
                      readinessAttempt: {
                        attemptId,
                        lineVersion: 1,
                        expiresAt: '2026-07-27T10:00:51.000Z',
                      },
                    }
                  : {}),
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        eventPolls += 1
        return Promise.resolve({
          success: true,
          data: {
            serverTime: new Date(Date.now()).toISOString(),
            events:
              eventPolls === 1
                ? []
                : [
                    {
                      eventId,
                      lineId: firstLineId,
                      lineName: 'Main line',
                      lineVersion: 1,
                      callerNumber: '+302101234567',
                      presentation: 'allowed',
                      occurredAt: '2026-07-27T10:00:32.000Z',
                      deliveryExpiresAt: '2026-07-27T10:01:02.000Z',
                    },
                  ],
          },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    mocks.channel.mockImplementationOnce((topic: string) => {
      const channel = {
        on: vi.fn(
          (
            _kind: string,
            _filter: { event: string },
            handler: BroadcastHandler,
          ) => {
            handlers.set(topic, handler)
            return channel
          },
        ),
        subscribe: vi.fn((status: StatusHandler) => {
          statuses.set(topic, status)
          status('SUBSCRIBED')
          return channel
        }),
      }
      return channel
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(eventPolls).toBe(1)

    await vi.advanceTimersByTimeAsync(2_000)

    expect(configLoads).toBeGreaterThanOrEqual(2)
    expect(eventPolls).toBeGreaterThanOrEqual(2)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sipCallId: eventId, lineId: firstLineId }),
    )
    expect(mocks.posApiPost).toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${eventId}/receipt`,
      { status: 'received' },
    )

    await vi.advanceTimersByTimeAsync(31_000)
    const pollsAfterCatchupWindow = eventPolls
    await vi.advanceTimersByTimeAsync(5_000)
    expect(eventPolls).toBe(pollsAfterCatchupWindow)
    unsubscribe()
  })

  it('retries a displayed receipt after only its readiness attempt disappears', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const attemptId = '30000000-0000-4000-8000-000000000003'
    const eventId = '20000000-0000-4000-8000-000000000028'
    let configLoads = 0
    let eventPolls = 0
    let rejectFirstDisplayed!: (reason?: unknown) => void
    const firstDisplayed = new Promise((_, reject) => {
      rejectFirstDisplayed = reject
    })
    let displayedCalls = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        configLoads += 1
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
                ...(configLoads === 1
                  ? {
                      readinessAttempt: {
                        attemptId,
                        lineVersion: 1,
                        expiresAt: '2026-07-27T10:00:51.000Z',
                      },
                    }
                  : {}),
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        eventPolls += 1
        return Promise.resolve({
          success: true,
          data: {
            serverTime: new Date(Date.now()).toISOString(),
            events:
              eventPolls === 1
                ? [
                    {
                      eventId,
                      lineId: firstLineId,
                      lineName: 'Main line',
                      lineVersion: 1,
                      callerNumber: '+302101234567',
                      presentation: 'allowed',
                      occurredAt: '2026-07-27T10:00:31.000Z',
                      deliveryExpiresAt: '2026-07-27T10:00:51.000Z',
                    },
                  ]
                : [],
          },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    mocks.posApiPost.mockImplementation((path: string, body?: unknown) => {
      if (
        path === `/api/pos/caller-id/events/${eventId}/receipt` &&
        (body as { status?: string } | undefined)?.status === 'displayed'
      ) {
        displayedCalls += 1
        return displayedCalls === 1
          ? firstDisplayed
          : Promise.resolve({ success: true })
      }
      return Promise.resolve({ success: true })
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(onEvent).toHaveBeenCalledTimes(1)
    const displayedReceipt = onEvent.mock.calls[0][0].reportReceipt({
      status: 'displayed',
    })
    expect(displayedCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(configLoads).toBeGreaterThanOrEqual(2)
    rejectFirstDisplayed(new Error('offline'))
    await vi.advanceTimersByTimeAsync(250)

    expect(displayedCalls).toBe(2)
    await expect(displayedReceipt).resolves.toBe(true)
    unsubscribe()
  })

  it('finishes an in-flight fallback catch-up before clearing it after Realtime recovery', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const eventId = '20000000-0000-4000-8000-000000000021'
    let resolveFirstPoll!: (value: {
      success: boolean
      data: { serverTime: string; events: unknown[] }
    }) => void
    const firstPoll = new Promise<{
      success: boolean
      data: { serverTime: string; events: unknown[] }
    }>((resolve) => {
      resolveFirstPoll = resolve
    })
    let eventPolls = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        eventPolls += 1
        if (eventPolls === 1) return firstPoll
        return Promise.resolve({
          success: true,
          data: {
            serverTime: new Date(Date.now()).toISOString(),
            events: [
              {
                eventId,
                lineId: firstLineId,
                lineName: 'Main line',
                lineVersion: 1,
                callerNumber: '+302101234567',
                presentation: 'allowed',
                occurredAt: '2026-07-27T10:00:30.000Z',
                deliveryExpiresAt: '2026-07-27T10:00:50.000Z',
              },
            ],
          },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)
    statuses
      .get(`callerid:line:${firstLineId}`)
      ?.('CHANNEL_ERROR', new Error('Unauthorized'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.channel).toHaveBeenCalledTimes(2)

    statuses.get(`callerid:line:${firstLineId}`)?.('SUBSCRIBED')
    resolveFirstPoll({
      success: true,
      data: { serverTime: new Date(Date.now()).toISOString(), events: [] },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(eventPolls).toBe(2)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(mocks.posApiPost).toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${eventId}/receipt`,
      { status: 'received' },
    )
    unsubscribe()
  })

  it('ignores a locally removed line in a deferred poll without poisoning another valid line', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const firstEventId = '20000000-0000-4000-8000-000000000022'
    const removedEventId = '20000000-0000-4000-8000-000000000023'
    let resolveEventPoll!: (value: {
      success: boolean
      data: { serverTime: string; events: unknown[] }
    }) => void
    const eventPoll = new Promise<{
      success: boolean
      data: { serverTime: string; events: unknown[] }
    }>((resolve) => {
      resolveEventPoll = resolve
    })
    let configLoads = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        configLoads += 1
        return Promise.resolve({
          success: true,
          data: {
            receivingLines:
              configLoads === 1
                ? [
                    {
                      id: firstLineId,
                      name: 'Main line',
                      topic: `callerid:line:${firstLineId}`,
                      version: 1,
                    },
                    {
                      id: secondLineId,
                      name: 'Delivery line',
                      topic: `callerid:line:${secondLineId}`,
                      version: 1,
                    },
                  ]
                : [
                    {
                      id: firstLineId,
                      name: 'Main line',
                      topic: `callerid:line:${firstLineId}`,
                      version: 1,
                    },
                  ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') return eventPoll
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)
    statuses
      .get(`callerid:line:${firstLineId}`)
      ?.('CHANNEL_ERROR', new Error('Unauthorized'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(configLoads).toBeGreaterThanOrEqual(2)

    resolveEventPoll({
      success: true,
      data: {
        serverTime: now.toISOString(),
        events: [
          {
            eventId: firstEventId,
            lineId: firstLineId,
            lineName: 'Main line',
            lineVersion: 1,
            callerNumber: '+302101234567',
            presentation: 'allowed',
            occurredAt: '2026-07-27T10:00:30.000Z',
            deliveryExpiresAt: '2026-07-27T10:00:50.000Z',
          },
          {
            eventId: removedEventId,
            lineId: secondLineId,
            lineName: 'Delivery line',
            lineVersion: 1,
            callerNumber: '+302109876543',
            presentation: 'allowed',
            occurredAt: '2026-07-27T10:00:30.000Z',
            deliveryExpiresAt: '2026-07-27T10:00:50.000Z',
          },
        ],
      },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sipCallId: firstEventId, lineId: firstLineId }),
    )
    expect(mocks.posApiPost).toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${firstEventId}/receipt`,
      { status: 'received' },
    )
    expect(mocks.posApiPost).not.toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${removedEventId}/receipt`,
      expect.anything(),
    )
    unsubscribe()
  })

  it('invalidates Realtime receipt retry ownership when the same line advances version', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const eventId = '20000000-0000-4000-8000-000000000024'
    let configLoads = 0
    let rejectFirstReceipt!: (reason?: unknown) => void
    const firstReceipt = new Promise((_, reject) => {
      rejectFirstReceipt = reject
    })
    let receiptCalls = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        configLoads += 1
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: configLoads === 1 ? 1 : 2,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        return Promise.resolve({
          success: true,
          data: { serverTime: new Date(Date.now()).toISOString(), events: [] },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    mocks.posApiPost.mockImplementation((path: string) => {
      if (path === `/api/pos/caller-id/events/${eventId}/receipt`) {
        receiptCalls += 1
        return receiptCalls === 1
          ? firstReceipt
          : Promise.reject(new Error('offline'))
      }
      return Promise.resolve({ success: true })
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)
    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId,
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })
    expect(receiptCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(configLoads).toBeGreaterThanOrEqual(2)
    rejectFirstReceipt(new Error('offline'))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(receiptCalls).toBe(1)
    unsubscribe()
  })

  it('disposes active channels when identity changes during a stalled config fetch', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    let identityCurrent = true
    let configLoads = 0
    const stalledConfig = new Promise(() => {})
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        configLoads += 1
        if (configLoads > 1) return stalledConfig
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: 1,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') {
        return Promise.resolve({
          success: true,
          data: { serverTime: new Date(Date.now()).toISOString(), events: [] },
        })
      }
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
      () => identityCurrent,
    )
    await vi.advanceTimersByTimeAsync(0)
    const activeChannel = mocks.channel.mock.results[0]?.value

    await vi.advanceTimersByTimeAsync(1_000)
    expect(configLoads).toBe(2)
    identityCurrent = false
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.removeChannel).toHaveBeenCalledWith(activeChannel)
    unsubscribe()
  })

  it('rejects a deferred v1 poll response after the same line advances to v2', async () => {
    vi.mocked(Date.now).mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const eventId = '20000000-0000-4000-8000-000000000025'
    let configLoads = 0
    let resolveEventPoll!: (value: {
      success: boolean
      data: { serverTime: string; events: unknown[] }
    }) => void
    const eventPoll = new Promise<{
      success: boolean
      data: { serverTime: string; events: unknown[] }
    }>((resolve) => {
      resolveEventPoll = resolve
    })
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/api/pos/caller-id/config') {
        configLoads += 1
        return Promise.resolve({
          success: true,
          data: {
            receivingLines: [
              {
                id: firstLineId,
                name: 'Main line',
                topic: `callerid:line:${firstLineId}`,
                version: configLoads === 1 ? 1 : 2,
              },
            ],
          },
        })
      }
      if (path === '/api/pos/caller-id/events') return eventPoll
      return Promise.reject(new Error(`Unexpected POS API path: ${path}`))
    })
    const onEvent = vi.fn()

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.advanceTimersByTimeAsync(0)
    statuses
      .get(`callerid:line:${firstLineId}`)
      ?.('CHANNEL_ERROR', new Error('Unauthorized'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(configLoads).toBeGreaterThanOrEqual(2)

    resolveEventPoll({
      success: true,
      data: {
        serverTime: now.toISOString(),
        events: [
          {
            eventId,
            lineId: firstLineId,
            lineName: 'Main line',
            lineVersion: 1,
            callerNumber: '+302101234567',
            presentation: 'allowed',
            occurredAt: '2026-07-27T10:00:30.000Z',
            deliveryExpiresAt: '2026-07-27T10:00:50.000Z',
          },
        ],
      },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(onEvent).not.toHaveBeenCalled()
    expect(mocks.posApiPost).not.toHaveBeenCalledWith(
      `/api/pos/caller-id/events/${eventId}/receipt`,
      expect.anything(),
    )
    unsubscribe()
  })

  it('waits for asynchronous channel removal before reusing the same topic', async () => {
    vi.useFakeTimers()
    let finishRemoval!: () => void
    const removal = new Promise<void>((resolve) => {
      finishRemoval = resolve
    })
    mocks.removeChannel.mockReturnValueOnce(removal)
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        receivingLines: [
          {
            id: firstLineId,
            name: 'Main line',
            topic: `callerid:line:${firstLineId}`,
            version: 1,
          },
        ],
      },
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)
    statuses.get(`callerid:line:${firstLineId}`)?.('CHANNEL_ERROR')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.channel).toHaveBeenCalledTimes(1)

    finishRemoval()
    await removal
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.channel).toHaveBeenCalledTimes(2)

    unsubscribe()
  })

  it('backs off repeated failures and resets the delay after subscribing', async () => {
    vi.useFakeTimers()
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        receivingLines: [
          {
            id: firstLineId,
            name: 'Main line',
            topic: `callerid:line:${firstLineId}`,
            version: 1,
          },
        ],
      },
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)

    statuses.get(`callerid:line:${firstLineId}`)?.('CHANNEL_ERROR')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.channel).toHaveBeenCalledTimes(2)

    statuses.get(`callerid:line:${firstLineId}`)?.('TIMED_OUT')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(mocks.channel).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.channel).toHaveBeenCalledTimes(3)

    const recoveredStatus = statuses.get(`callerid:line:${firstLineId}`)
    recoveredStatus?.('SUBSCRIBED')
    recoveredStatus?.('CLOSED')
    await vi.advanceTimersByTimeAsync(999)
    expect(mocks.channel).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.channel).toHaveBeenCalledTimes(4)

    unsubscribe()
  })

  it('ACKs readiness when subscribe reports success synchronously', async () => {
    vi.useFakeTimers()
    const attemptId = '30000000-0000-4000-8000-000000000002'
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        receivingLines: [
          {
            id: firstLineId,
            name: 'Main line',
            topic: `callerid:line:${firstLineId}`,
            version: 3,
            readinessAttempt: {
              attemptId,
              lineVersion: 3,
              expiresAt: new Date(now.getTime() + 10_000).toISOString(),
            },
          },
        ],
      },
    })
    mocks.channel.mockImplementationOnce((topic: string) => {
      const channel = {
        on: vi.fn(() => channel),
        subscribe: vi.fn((status: StatusHandler) => {
          statuses.set(topic, status)
          status('SUBSCRIBED')
          return channel
        }),
      }
      return channel
    })

    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.posApiPost).toHaveBeenCalledWith(
      '/api/pos/caller-id/readiness',
      { attemptId, lineId: firstLineId, lineVersion: 3 },
    )
    unsubscribe()
  })

  it('posts received and displayed receipts through the strict endpoint', async () => {
    const eventId = '20000000-0000-4000-8000-000000000001'
    const onEvent = vi.fn()
    const unsubscribe = subscribeToCallerIdEvents('org-1', 'terminal-1', onEvent)
    await vi.waitFor(() => expect(handlers.size).toBe(2))

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId,
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })
    await vi.waitFor(() =>
      expect(mocks.posApiPost).toHaveBeenCalledWith(
        `/api/pos/caller-id/events/${eventId}/receipt`,
        { status: 'received' },
      ),
    )

    await reportCallerIdReceipt(eventId, { status: 'displayed' })
    expect(mocks.posApiPost).toHaveBeenLastCalledWith(
      `/api/pos/caller-id/events/${eventId}/receipt`,
      { status: 'displayed' },
    )
    unsubscribe()
  })

  it('hands a fresh event to UI without waiting for a stalled received receipt', async () => {
    const onEvent = vi.fn()
    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.waitFor(() => expect(handlers.size).toBe(2))
    mocks.posApiPost.mockReturnValue(new Promise(() => {}))

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId: '20000000-0000-4000-8000-000000000014',
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })

    expect(onEvent).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('does not hand off an event that expires immediately before UI callback', async () => {
    const onEvent = vi.fn()
    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      onEvent,
    )
    await vi.waitFor(() => expect(handlers.size).toBe(2))
    mocks.posApiPost.mockImplementation(() => {
      vi.mocked(Date.now).mockReturnValue(
        new Date('2026-07-27T10:01:00.000Z').getTime(),
      )
      return Promise.resolve({ success: true })
    })

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId: '20000000-0000-4000-8000-000000000015',
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onEvent).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('cancels every pending receipt retry when the accepting subscription is unsubscribed', async () => {
    vi.useFakeTimers()
    mocks.posApiPost.mockRejectedValue(new Error('offline'))
    const eventId = '20000000-0000-4000-8000-000000000009'
    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId,
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)

    unsubscribe()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)
  })

  it('cancels every pending receipt retry when the terminal identity changes', async () => {
    vi.useFakeTimers()
    mocks.posApiPost.mockRejectedValue(new Error('offline'))
    const eventId = '20000000-0000-4000-8000-000000000010'
    let identityCurrent = true
    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
      () => identityCurrent,
    )
    await vi.advanceTimersByTimeAsync(0)

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId,
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)

    identityCurrent = false
    await vi.advanceTimersByTimeAsync(2_000)

    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('cancels every pending receipt retry when the organization identity changes', async () => {
    vi.useFakeTimers()
    mocks.posApiPost.mockRejectedValue(new Error('offline'))
    const eventId = '20000000-0000-4000-8000-000000000011'
    let currentIdentity = {
      organizationId: 'org-1',
      terminalId: 'terminal-1',
    }
    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
      () =>
        currentIdentity.organizationId === 'org-1' &&
        currentIdentity.terminalId === 'terminal-1',
    )
    await vi.advanceTimersByTimeAsync(0)

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId,
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)

    currentIdentity = {
      organizationId: 'org-2',
      terminalId: 'terminal-1',
    }
    await vi.advanceTimersByTimeAsync(2_000)

    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('stops later receipt retries after config removes the accepting line', async () => {
    vi.useFakeTimers()
    mocks.posApiPost.mockRejectedValue(new Error('offline'))
    const eventId = '20000000-0000-4000-8000-000000000012'
    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId,
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)

    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: { receivingLines: [] },
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(mocks.posApiPost).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('stops later receipt retries after replacing the accepting line subscription', async () => {
    vi.useFakeTimers()
    mocks.posApiPost.mockRejectedValue(new Error('offline'))
    const eventId = '20000000-0000-4000-8000-000000000013'
    const unsubscribe = subscribeToCallerIdEvents(
      'org-1',
      'terminal-1',
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(0)

    handlers.get(`callerid:line:${firstLineId}`)?.({
      payload: {
        eventId,
        lineId: firstLineId,
        lineName: 'Main line',
        lineVersion: 1,
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:30.000Z',
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)

    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        receivingLines: [
          {
            id: firstLineId,
            name: 'Replacement line',
            topic: `callerid:line:${firstLineId}`,
            version: 2,
          },
        ],
      },
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(mocks.posApiPost).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
