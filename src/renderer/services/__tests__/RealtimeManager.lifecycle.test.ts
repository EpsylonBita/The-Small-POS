import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DesktopRealtimeManager } from '../RealtimeManager'

describe('DesktopRealtimeManager lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('does not add more channels after an in-flight connection is disconnected', async () => {
    let manager!: DesktopRealtimeManager
    let firstSubscription = true

    const client = {
      channel: vi.fn(() => {
        const channel = {
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn(() => {
            if (firstSubscription) {
              firstSubscription = false
              manager.disconnect()
            }
            return channel
          }),
        }
        return channel
      }),
      removeChannel: vi.fn(),
    }

    manager = new DesktopRealtimeManager({
      supabaseUrl: 'https://realtime.invalid',
      supabaseKey: 'anon-key',
      organizationId: 'org-1',
      onOrderChange: vi.fn(),
      onConfigChange: vi.fn(),
      onModuleChange: vi.fn(),
      client: client as any,
    })

    await manager.connect()

    expect(client.channel).toHaveBeenCalledTimes(1)
    expect(client.removeChannel).toHaveBeenCalledTimes(1)
    expect(manager.getConnectionStatus()).toBe('disconnected')
  })
})
