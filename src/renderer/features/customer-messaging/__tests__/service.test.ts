import { describe, expect, it, vi } from 'vitest'
import { CustomerMessagingService } from '../service'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222'

describe('CustomerMessagingService', () => {
  it('injects only the validated live staff-session UUID into the typed bridge', async () => {
    const history = vi.fn().mockResolvedValue({
      customerId: CUSTOMER_ID, operationalLocked: true, lockReason: 'CUSTOMER_MESSAGING_ENTITLEMENT_EXPIRED',
      permissions: { read: true, link: false, send: false, retry: false },
      preference: { decision: 'allow', channel: 'sms' }, channels: [], preferenceTargets: [], linkTargets: [], messages: [],
      pagination: { nextCursor: null, hasMore: false },
    })
    const service = new CustomerMessagingService({
      staffAuth: { getSession: vi.fn().mockResolvedValue({ sessionId: SESSION_ID, apiKey: 'must-not-cross' }) },
      customerMessaging: { history, preference: vi.fn(), send: vi.fn(), retry: vi.fn(), link: vi.fn() },
    })

    await service.history(CUSTOMER_ID)

    expect(history).toHaveBeenCalledWith({ staffSessionId: SESSION_ID, customerId: CUSTOMER_ID, limit: 25 })
    expect(JSON.stringify(history.mock.calls)).not.toContain('apiKey')
  })

  it('fails before native IPC when the session identifier is not a UUID', async () => {
    const history = vi.fn()
    const service = new CustomerMessagingService({
      staffAuth: { getSession: vi.fn().mockResolvedValue({ sessionId: 'attacker-session' }) },
      customerMessaging: { history, preference: vi.fn(), send: vi.fn(), retry: vi.fn(), link: vi.fn() },
    })
    await expect(service.history(CUSTOMER_ID)).rejects.toThrow('CUSTOMER_MESSAGING_STAFF_SESSION_REQUIRED')
    expect(history).not.toHaveBeenCalled()
  })

  it('accepts only validated Telegram provider links', async () => {
    const link = vi.fn().mockResolvedValue({
      sessionId: CUSTOMER_ID,
      deepLink: 'https://t.me/example_bot?start=safe-token',
      expiresAt: '2026-08-19T08:30:00.000Z',
    })
    const service = new CustomerMessagingService({
      staffAuth: { getSession: vi.fn().mockResolvedValue({ sessionId: SESSION_ID }) },
      customerMessaging: { history: vi.fn(), preference: vi.fn(), send: vi.fn(), retry: vi.fn(), link },
    })
    await expect(service.link({ customerId: CUSTOMER_ID, connectionId: SESSION_ID })).resolves.toMatchObject({
      deepLink: 'https://t.me/example_bot?start=safe-token',
    })
  })

  it('rejects a Viber URI because runtime Viber linking is not supported', async () => {
    const service = new CustomerMessagingService({
      staffAuth: { getSession: vi.fn().mockResolvedValue({ sessionId: SESSION_ID }) },
      customerMessaging: {
        history: vi.fn(), preference: vi.fn(), send: vi.fn(), retry: vi.fn(),
        link: vi.fn().mockResolvedValue({
          sessionId: CUSTOMER_ID,
          deepLink: 'viber://pa?chatURI=unsupported',
          expiresAt: '2026-08-19T08:30:00.000Z',
        }),
      },
    })
    await expect(service.link({ customerId: CUSTOMER_ID, connectionId: SESSION_ID }))
      .rejects.toThrow('CUSTOMER_MESSAGING_RESPONSE_INVALID')
  })

  it('writes and validates one explicit transactional preference with the live staff session', async () => {
    const preference = vi.fn().mockResolvedValue({
      preference: {
        id: '33333333-3333-4333-8333-333333333333',
        decision: 'allow',
        channel: 'whatsapp',
        version: 1,
        effectiveAt: '2026-08-31T10:00:00.000Z',
      },
      identity: { action: 'provisioned', channel: 'whatsapp' },
    })
    const service = new CustomerMessagingService({
      staffAuth: { getSession: vi.fn().mockResolvedValue({ sessionId: SESSION_ID }) },
      customerMessaging: { history: vi.fn(), preference, send: vi.fn(), retry: vi.fn(), link: vi.fn() },
    })

    await service.preference({
      customerId: CUSTOMER_ID,
      decision: 'allow',
      channel: 'whatsapp',
      connectionId: SESSION_ID,
    })

    expect(preference).toHaveBeenCalledWith({
      staffSessionId: SESSION_ID,
      customerId: CUSTOMER_ID,
      decision: 'allow',
      channel: 'whatsapp',
      connectionId: SESSION_ID,
    })
  })
})
