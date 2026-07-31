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
        callerNumber: '+302101234567',
        presentation: 'allowed',
        occurredAt: '2026-07-27T10:00:00.000Z',
      },
    })

    expect(onEvent).not.toHaveBeenCalled()
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
