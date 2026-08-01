import { RealtimeClient } from '@supabase/realtime-js'
import type { RealtimeChannel } from '@supabase/supabase-js'

import type { RealtimeAuthClient } from './RealtimeAuthService'

type RemovalResult = Awaited<ReturnType<RealtimeClient['removeChannel']>>

export interface TerminalRealtimeClient {
  channel: RealtimeClient['channel']
  removeChannel(channel: RealtimeChannel): Promise<RemovalResult>
  isTopicRetiring(topic: string): boolean
}

export interface TerminalRealtimeSession {
  client: TerminalRealtimeClient
  authClient: RealtimeAuthClient
}

function normalizeTopic(topic: string): string {
  return topic.replace(/^realtime:/i, '')
}

/**
 * Creates a Realtime-only client whose authorization source is exclusively the
 * short-lived POS terminal token kept in this closure. It deliberately exposes
 * no Supabase Auth, REST, Storage, or Functions surface.
 */
export function createTerminalRealtimeSession(
  supabaseUrl: string,
  supabaseAnonKey: string,
): TerminalRealtimeSession {
  let terminalToken: string | null = null
  const realtimeUrl = new URL('realtime/v1', supabaseUrl)
  realtimeUrl.protocol = realtimeUrl.protocol.replace('http', 'ws')
  const realtime = new RealtimeClient(realtimeUrl.href, {
    params: {
      apikey: supabaseAnonKey,
      eventsPerSecond: 15,
    },
    accessToken: async () => terminalToken,
  })
  const retirements = new Map<string, Promise<RemovalResult>>()
  const internalRealtime = realtime as unknown as {
    _remove(channelToRemove: RealtimeChannel): void
  }
  const forceRemoveChannel = (channel: RealtimeChannel) => {
    channel.teardown()
    internalRealtime._remove(channel)
  }

  const removeChannel = (channel: RealtimeChannel): Promise<RemovalResult> => {
    const topic = normalizeTopic(channel.topic)
    const existing = retirements.get(topic)
    if (existing) return existing

    let removal: Promise<RemovalResult>
    try {
      removal = Promise.resolve(realtime.removeChannel(channel)).then(
        (status) => {
          if (status !== 'ok') {
            forceRemoveChannel(channel)
          }
          return status
        },
        () => {
          forceRemoveChannel(channel)
          return 'error'
        },
      )
    } catch {
      forceRemoveChannel(channel)
      removal = Promise.resolve('error')
    }

    let tracked!: Promise<RemovalResult>
    tracked = removal.finally(() => {
      if (retirements.get(topic) === tracked) {
        retirements.delete(topic)
      }
    })
    retirements.set(topic, tracked)
    return tracked
  }

  const client: TerminalRealtimeClient = {
    channel: realtime.channel.bind(realtime),
    removeChannel,
    isTopicRetiring: (topic) => retirements.has(normalizeTopic(topic)),
  }

  const authClient: RealtimeAuthClient = {
    realtime: {
      setAuth: async (token) => {
        terminalToken = token
        if (token === null) {
          // Clear the SDK's cached JWT before any channel retirement can wait
          // on a leave timeout. Joined channels must stop carrying the old
          // terminal identity immediately during logout or credential rotation.
          await realtime.setAuth()
          await Promise.allSettled([...retirements.values()])
          await Promise.all(
            realtime.getChannels().map((channel) => removeChannel(channel)),
          )
          await Promise.allSettled([...retirements.values()])
          await realtime.disconnect()
          return
        }
        // Pin the exact terminal JWT so channel joins and resubscriptions keep
        // the same POS identity instead of re-entering callback auth mode.
        await realtime.setAuth(token)
      },
    },
  }

  return { client, authClient }
}
