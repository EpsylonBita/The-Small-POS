import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  RealtimeClient: vi.fn(),
  setAuth: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
  getChannels: vi.fn(),
  disconnect: vi.fn(),
  removeLocalChannel: vi.fn(),
}))

vi.mock('@supabase/realtime-js', () => ({
  RealtimeClient: mocks.RealtimeClient,
}))

import { createTerminalRealtimeSession } from '../terminal-realtime-client'

describe('createTerminalRealtimeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setAuth.mockResolvedValue(undefined)
    mocks.removeChannel.mockResolvedValue('ok')
    mocks.getChannels.mockReturnValue([])
    mocks.disconnect.mockResolvedValue('ok')
    mocks.RealtimeClient.mockImplementation(function () {
      return {
        setAuth: mocks.setAuth,
        channel: mocks.channel,
        removeChannel: mocks.removeChannel,
        getChannels: mocks.getChannels,
        disconnect: mocks.disconnect,
        _remove: mocks.removeLocalChannel,
      }
    })
  })

  it('uses a standalone client with an isolated in-memory token provider', async () => {
    const session = createTerminalRealtimeSession(
      'https://project.example.com',
      'anon-key',
    )

    expect(mocks.RealtimeClient).toHaveBeenCalledWith(
      'wss://project.example.com/realtime/v1',
      expect.objectContaining({
        params: {
          apikey: 'anon-key',
          eventsPerSecond: 15,
        },
        accessToken: expect.any(Function),
      }),
    )
    const options = mocks.RealtimeClient.mock.calls[0]?.[1] as {
      accessToken?: () => Promise<string | null>
    }
    await expect(options.accessToken?.()).resolves.toBeNull()

    await session.authClient.realtime.setAuth('terminal-jwt')

    await expect(options.accessToken?.()).resolves.toBe('terminal-jwt')
    expect(mocks.setAuth).toHaveBeenCalledWith()
  })

  it('disconnects terminal channels and clears to real null auth', async () => {
    const session = createTerminalRealtimeSession(
      'https://project.example.com',
      'anon-key',
    )
    const options = mocks.RealtimeClient.mock.calls[0]?.[1] as {
      accessToken?: () => Promise<string | null>
    }

    await session.authClient.realtime.setAuth('terminal-jwt')
    await session.authClient.realtime.setAuth(null)

    await expect(options.accessToken?.()).resolves.toBeNull()
    expect(mocks.getChannels).toHaveBeenCalled()
    expect(mocks.disconnect).toHaveBeenCalled()
    expect(mocks.setAuth).toHaveBeenLastCalledWith()
  })

  it('clears the SDK token before waiting for deferred channel retirement', async () => {
    let finishRemoval!: (status: 'ok') => void
    const removal = new Promise<'ok'>((resolve) => {
      finishRemoval = resolve
    })
    const channel = {
      topic: 'realtime:callerid:line:line-1',
      teardown: vi.fn(),
    }
    mocks.removeChannel.mockReturnValueOnce(removal)
    const session = createTerminalRealtimeSession(
      'https://project.example.com',
      'anon-key',
    )

    await session.authClient.realtime.setAuth('terminal-jwt')
    void session.client.removeChannel(channel as never)
    const clear = session.authClient.realtime.setAuth(null)
    await Promise.resolve()

    expect(mocks.setAuth).toHaveBeenCalledTimes(2)
    expect(mocks.disconnect).not.toHaveBeenCalled()

    finishRemoval('ok')
    await clear
    expect(mocks.disconnect).toHaveBeenCalled()
  })

  it('keeps a session-level topic barrier until failed removal is forced locally', async () => {
    let finishRemoval!: (status: 'error') => void
    const removal = new Promise<'error'>((resolve) => {
      finishRemoval = resolve
    })
    const channel = {
      topic: 'realtime:callerid:line:line-1',
      teardown: vi.fn(),
    }
    mocks.removeChannel.mockReturnValueOnce(removal)
    const session = createTerminalRealtimeSession(
      'https://project.example.com',
      'anon-key',
    )

    const retirement = session.client.removeChannel(channel as never)
    expect(session.client.isTopicRetiring('callerid:line:line-1')).toBe(true)

    finishRemoval('error')
    await retirement

    expect(channel.teardown).toHaveBeenCalled()
    expect(mocks.removeLocalChannel).toHaveBeenCalledWith(channel)
    expect(session.client.isTopicRetiring('callerid:line:line-1')).toBe(false)
  })
})
