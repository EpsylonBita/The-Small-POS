import { z } from 'zod'

import { getBridge } from '../../../lib/ipc-adapter'
import type {
  CustomerMessagingBridge,
  CustomerMessagingHistoryInput,
  CustomerMessagingLinkInput,
  CustomerMessagingPreferenceInput,
  CustomerMessagingRetryInput,
  CustomerMessagingSendInput,
} from './contracts'
import {
  customerMessagingManualSendResponseSchema,
  customerMessagingPosWorkspaceSchema,
  customerMessagingRetryResponseSchema,
} from '../../../shared/types/customer-messaging'

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const customerMessagingPreferenceResponseSchema = z.object({
  preference: z.object({
    id: z.string().uuid(),
    decision: z.enum(['allow', 'deny', 'no_preference']),
    channel: z.enum(['sms', 'whatsapp', 'telegram', 'viber']).nullable(),
    version: z.number().int().positive(),
    effectiveAt: z.string().datetime({ offset: true }),
  }).strict(),
  identity: z.object({
    action: z.enum(['provisioned', 'revoked', 'unchanged', 'not_applicable']),
    channel: z.enum(['sms', 'whatsapp', 'telegram', 'viber']).nullable(),
  }).strict(),
}).strict()

export interface CustomerMessagingServiceBridge {
  staffAuth: { getSession(): Promise<unknown> }
  customerMessaging: CustomerMessagingBridge
}

function sessionIdFrom(value: unknown): string {
  const sessionId = value && typeof value === 'object'
    ? (value as { sessionId?: unknown }).sessionId
    : null
  if (typeof sessionId !== 'string' || !CANONICAL_UUID.test(sessionId)) {
    throw new Error('CUSTOMER_MESSAGING_STAFF_SESSION_REQUIRED')
  }
  return sessionId
}

export class CustomerMessagingService {
  constructor(private readonly bridge: CustomerMessagingServiceBridge = getBridge()) {}

  private async sessionId(): Promise<string> {
    return sessionIdFrom(await this.bridge.staffAuth.getSession())
  }

  async history(customerId: string, before?: string) {
    const result = await this.bridge.customerMessaging.history({
      staffSessionId: await this.sessionId(), customerId, before, limit: 25,
    } satisfies CustomerMessagingHistoryInput)
    return customerMessagingPosWorkspaceSchema.parse(result)
  }

  async send(input: Omit<CustomerMessagingSendInput, 'staffSessionId'>) {
    return customerMessagingManualSendResponseSchema.parse(
      await this.bridge.customerMessaging.send({ ...input, staffSessionId: await this.sessionId() }),
    )
  }

  async preference(input: Omit<CustomerMessagingPreferenceInput, 'staffSessionId'>) {
    return customerMessagingPreferenceResponseSchema.parse(
      await this.bridge.customerMessaging.preference({
        ...input,
        staffSessionId: await this.sessionId(),
      }),
    )
  }

  async retry(input: Omit<CustomerMessagingRetryInput, 'staffSessionId'>) {
    return customerMessagingRetryResponseSchema.parse(
      await this.bridge.customerMessaging.retry({ ...input, staffSessionId: await this.sessionId() }),
    )
  }

  async link(input: Omit<CustomerMessagingLinkInput, 'staffSessionId'>) {
    const result = await this.bridge.customerMessaging.link({ ...input, staffSessionId: await this.sessionId() })
    if (
      !CANONICAL_UUID.test(result.sessionId) ||
      !/^https:\/\/t\.me\/[^\s]{1,1000}$/.test(result.deepLink) ||
      !Number.isFinite(Date.parse(result.expiresAt))
    ) throw new Error('CUSTOMER_MESSAGING_RESPONSE_INVALID')
    return result
  }
}

export const customerMessagingService = new CustomerMessagingService()
