import type {
  CustomerMessagingManualSendResponse,
  CustomerMessagingPosWorkspace,
  CustomerMessagingRetryResponse,
} from '../../../shared/types/customer-messaging'

export interface CustomerMessagingHistoryInput {
  staffSessionId: string
  customerId: string
  before?: string
  limit: number
}

export interface CustomerMessagingSendInput {
  staffSessionId: string
  customerId: string
  repairId: string
  repairVersion: number
  idempotencyKey: string
}

export interface CustomerMessagingRetryInput {
  staffSessionId: string
  messageId: string
  idempotencyKey: string
}

export interface CustomerMessagingLinkInput {
  staffSessionId: string
  customerId: string
  connectionId: string
  expiresInSeconds?: number
}

export interface CustomerMessagingLinkResponse {
  sessionId: string
  deepLink: string
  expiresAt: string
}

export interface CustomerMessagingPreferenceInput {
  staffSessionId: string
  customerId: string
  decision: 'allow' | 'deny' | 'no_preference'
  channel: 'sms' | 'whatsapp' | null
  connectionId: string | null
}

export interface CustomerMessagingPreferenceResponse {
  preference: {
    id: string
    decision: 'allow' | 'deny' | 'no_preference'
    channel: 'sms' | 'whatsapp' | 'telegram' | 'viber' | null
    version: number
    effectiveAt: string
  }
  identity: {
    action: 'provisioned' | 'revoked' | 'unchanged' | 'not_applicable'
    channel: 'sms' | 'whatsapp' | 'telegram' | 'viber' | null
  }
}

export interface CustomerMessagingBridge {
  history(input: CustomerMessagingHistoryInput): Promise<CustomerMessagingPosWorkspace>
  preference(input: CustomerMessagingPreferenceInput): Promise<CustomerMessagingPreferenceResponse>
  send(input: CustomerMessagingSendInput): Promise<CustomerMessagingManualSendResponse>
  retry(input: CustomerMessagingRetryInput): Promise<CustomerMessagingRetryResponse>
  link(input: CustomerMessagingLinkInput): Promise<CustomerMessagingLinkResponse>
}
