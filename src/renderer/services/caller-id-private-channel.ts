import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

export const CALLER_ID_PRIVATE_CHANNEL_BOUNDARY = true

export interface CallerIdReceivingLine {
  readonly id: string
  readonly name: string
}

interface CallerIdReceivingLineWire {
  id: string
  name: string
  topic: string
}

type CallerIdChannelClient = Pick<SupabaseClient, 'channel'>

const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const LINE_TOPIC_PATTERN = new RegExp(`^callerid:line:${UUID_PATTERN}$`, 'i')
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, 'i')
const topics = new WeakMap<CallerIdReceivingLine, string>()

export function parseCallerIdReceivingLine(
  value: unknown,
): CallerIdReceivingLine | null {
  if (!value || typeof value !== 'object') return null
  const wire = value as CallerIdReceivingLineWire
  const topic = wire.topic
  const line = { id: wire.id, name: wire.name }
  if (
    !UUID_REGEX.test(line.id) ||
    typeof line.name !== 'string' ||
    line.name.length === 0 ||
    !LINE_TOPIC_PATTERN.test(topic) ||
    topic.toLowerCase() !== `callerid:line:${line.id}`.toLowerCase()
  ) {
    return null
  }

  topics.set(line, topic)
  return line
}

export function createCallerIdPrivateChannel(
  client: CallerIdChannelClient,
  line: CallerIdReceivingLine,
): RealtimeChannel {
  const topic = topics.get(line)
  if (!topic) {
    throw new Error('Caller ID line did not pass the private channel boundary')
  }
  return client.channel(topic, {
    config: { private: true, broadcast: { self: false } },
  })
}
