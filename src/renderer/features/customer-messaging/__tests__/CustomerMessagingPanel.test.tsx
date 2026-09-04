import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  preference: vi.fn(),
  send: vi.fn(),
  retry: vi.fn(),
  link: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: { count?: number; number?: number }) =>
    `${key}${values?.count ?? values?.number ?? ''}` }),
}))
vi.mock('../service', () => ({
  customerMessagingService: mocks,
}))

import { CustomerMessagingPanel } from '../CustomerMessagingPanel'

const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222'
const REPAIR_ID = '33333333-3333-4333-8333-333333333333'
const WHATSAPP_CONNECTION_ID = '77777777-7777-4777-8777-777777777777'

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    customerId: CUSTOMER_ID,
    operationalLocked: false,
    lockReason: null,
    permissions: { read: true, link: true, send: false, retry: false },
    preference: { decision: 'no_preference', channel: null },
    channels: [],
    preferenceTargets: [
      { connectionId: null, channel: 'sms', provider: null },
      { connectionId: WHATSAPP_CONNECTION_ID, channel: 'whatsapp', provider: 'whatsapp_cloud' },
    ],
    linkTargets: [],
    messages: [],
    pagination: { nextCursor: null, hasMore: false },
    ...overrides,
  }
}

function renderPanel(online = true) {
  return render(<CustomerMessagingPanel customerId={CUSTOMER_ID}
    repairId={REPAIR_ID} repairVersion={2}
    repairNumber="R-100" customerName="Customer" deviceLabel="Phone" online={online} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.preference.mockResolvedValue({})
})
afterEach(cleanup)

describe('CustomerMessagingPanel attempt history', () => {
  it('renders the bounded attempt count and safe failure trail', async () => {
    mocks.history.mockResolvedValue({
      customerId: '22222222-2222-4222-8222-222222222222',
      operationalLocked: true,
      lockReason: 'CUSTOMER_MESSAGING_ENTITLEMENT_EXPIRED',
      permissions: { read: true, link: false, send: false, retry: false },
      preference: { decision: 'allow', channel: 'sms' },
      channels: [], preferenceTargets: [], linkTargets: [], pagination: { nextCursor: null, hasMore: false },
      messages: [{
        id: '44444444-4444-4444-8444-444444444444', eventType: 'repair.ready',
        purpose: 'transactional', channel: 'sms', displayLabel: '***1234',
        status: 'failed', attemptCount: 1, retryEligible: false,
        safeReasonCode: 'PROVIDER_UNAVAILABLE',
        createdAt: '2026-08-30T10:00:00.000Z', updatedAt: '2026-08-30T10:01:00.000Z',
        attempts: [{ number: 1, provider: 'twilio', status: 'failed',
          safeReasonCode: 'PROVIDER_UNAVAILABLE', createdAt: '2026-08-30T10:01:00.000Z' }],
      }],
    })
    render(<CustomerMessagingPanel customerId="22222222-2222-4222-8222-222222222222"
      repairId="33333333-3333-4333-8333-333333333333" repairVersion={2}
      repairNumber="R-100" customerName="Customer" deviceLabel="Phone" online />)

    expect(await screen.findByText('customerMessaging.attemptCount1')).toBeInTheDocument()
    expect(screen.getByText('customerMessaging.attempt1')).toBeInTheDocument()
    expect(screen.getAllByText('PROVIDER_UNAVAILABLE')).toHaveLength(2)
    expect(screen.getByText(/twilio/)).toHaveTextContent('2026-08-30T10:01:00.000Z')
  })

  it('offers linking only for an available target and renders Viber as unavailable', async () => {
    mocks.history.mockResolvedValue({
      customerId: '22222222-2222-4222-8222-222222222222',
      operationalLocked: false,
      lockReason: null,
      permissions: { read: true, link: true, send: false, retry: false },
      preference: { decision: 'no_preference', channel: null },
      channels: [],
      preferenceTargets: [],
      linkTargets: [{
        connectionId: '55555555-5555-4555-8555-555555555555',
        channel: 'telegram',
        provider: 'telegram_bot',
        linkingStatus: 'available',
      }, {
        connectionId: '66666666-6666-4666-8666-666666666666',
        channel: 'viber',
        provider: 'viber_bot',
        linkingStatus: 'customer_linking_unavailable',
      }],
      messages: [],
      pagination: { nextCursor: null, hasMore: false },
    })
    render(<CustomerMessagingPanel customerId="22222222-2222-4222-8222-222222222222"
      repairId="33333333-3333-4333-8333-333333333333" repairVersion={2}
      repairNumber="R-100" customerName="Customer" deviceLabel="Phone" online />)

    expect(await screen.findByRole('button', { name: 'customerMessaging.link' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'customerMessaging.linkingUnavailable' })).toBeDisabled()
  })

  it('records an explicit all-channel no-preference decision and reloads the workspace', async () => {
    mocks.history.mockResolvedValue(workspace())
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'customerMessaging.preferenceNoPreference' }))

    await waitFor(() => expect(mocks.preference).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID,
      decision: 'no_preference',
      channel: null,
      connectionId: null,
    }))
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2))
  })

  it('uses the exact advertised WhatsApp connection target', async () => {
    mocks.history.mockResolvedValue(workspace())
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'customerMessaging.preferenceWhatsApp' }))

    await waitFor(() => expect(mocks.preference).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID,
      decision: 'allow',
      channel: 'whatsapp',
      connectionId: WHATSAPP_CONNECTION_ID,
    }))
  })

  it('offers explicit deny and SMS controls from the safe preference projection', async () => {
    mocks.history.mockResolvedValue(workspace())
    renderPanel()

    expect(await screen.findByRole('button', { name: 'customerMessaging.preferenceDeny' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'customerMessaging.preferenceSms' }))
    await waitFor(() => expect(mocks.preference).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID,
      decision: 'allow',
      channel: 'sms',
      connectionId: null,
    }))
  })

  it('does not expose preference mutations while operationally locked', async () => {
    mocks.history.mockResolvedValue(workspace({ operationalLocked: true }))
    renderPanel()

    expect(await screen.findByText('customerMessaging.readOnly')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'customerMessaging.preferenceSms' })).not.toBeInTheDocument()
    expect(mocks.preference).not.toHaveBeenCalled()
  })

  it('does not load or mutate preferences while offline', () => {
    renderPanel(false)

    expect(screen.getByText('customerMessaging.onlineOnly')).toBeInTheDocument()
    expect(mocks.history).not.toHaveBeenCalled()
    expect(mocks.preference).not.toHaveBeenCalled()
  })

  it('never projects stale history after the selected customer changes', async () => {
    const nextCustomerId = '88888888-8888-4888-8888-888888888888'
    let resolveOld: ((value: ReturnType<typeof workspace>) => void) | undefined
    let resolveNext: ((value: ReturnType<typeof workspace>) => void) | undefined
    mocks.history.mockImplementation((customerId: string) => new Promise((resolve) => {
      if (customerId === CUSTOMER_ID) resolveOld = resolve
      else resolveNext = resolve
    }))
    const view = renderPanel()
    await waitFor(() => expect(mocks.history).toHaveBeenCalledWith(CUSTOMER_ID))

    view.rerender(<CustomerMessagingPanel customerId={nextCustomerId}
      repairId={REPAIR_ID} repairVersion={2}
      repairNumber="R-100" customerName="Next" deviceLabel="Phone" online />)
    await waitFor(() => expect(mocks.history).toHaveBeenCalledWith(nextCustomerId))
    await act(async () => resolveNext?.(workspace({
      customerId: nextCustomerId,
      channels: [{ channel: 'sms', displayLabel: 'NEXT-CHANNEL' }],
    })))
    expect(await screen.findByText('NEXT-CHANNEL')).toBeInTheDocument()

    await act(async () => resolveOld?.(workspace({
      channels: [{ channel: 'sms', displayLabel: 'STALE-CHANNEL' }],
    })))
    expect(screen.queryByText('STALE-CHANNEL')).not.toBeInTheDocument()
    expect(screen.getByText('NEXT-CHANNEL')).toBeInTheDocument()
  })

  it('allows only one preference write while the first click is in flight', async () => {
    let resolvePreference: (() => void) | undefined
    mocks.history.mockResolvedValue(workspace())
    mocks.preference.mockImplementation(() => new Promise<void>((resolve) => {
      resolvePreference = resolve
    }))
    renderPanel()

    const button = await screen.findByRole('button', { name: 'customerMessaging.preferenceNoPreference' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.preference).toHaveBeenCalledTimes(1)

    await act(async () => resolvePreference?.())
  })
})
