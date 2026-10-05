import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getInterTerminalStatus, onEvent, offEvent } = vi.hoisted(() => ({
  getInterTerminalStatus: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}))

vi.mock('../../../lib', () => ({
  getBridge: () => ({ sync: { getInterTerminalStatus } }),
  onEvent,
  offEvent,
}))

vi.mock('react-i18next', () => {
  const labels: Record<string, string> = {
    'sync.routing.directCloud': 'Direct to Cloud',
    'sync.routing.viaParent': 'Via Main POS',
    'sync.dashboard.notAvailable': 'Not available',
  }
  return { useTranslation: () => ({ t: (key: string) => labels[key] || key }) }
})

import { OrderSyncRouteIndicator } from '../OrderSyncRouteIndicator'

const cloudStatus = {
  parentInfo: { terminalId: 'parent-uuid', name: 'Parent POS' },
  isParentReachable: false,
  isCloudReachable: true,
  routingMode: 'direct_cloud',
}

describe('OrderSyncRouteIndicator: truthful cloud transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getInterTerminalStatus.mockResolvedValue(cloudStatus)
  })

  afterEach(cleanup)

  const emitNetwork = async (isOnline: boolean) => {
    const callback = onEvent.mock.calls.find(([name]) => name === 'network:status')?.[1]
    expect(callback).toBeTypeOf('function')
    await act(async () => { callback({ isOnline }) })
  }

  it('labels the condensed indicator with the actual cloud route', async () => {
    render(<OrderSyncRouteIndicator condensed />)
    expect(await screen.findByRole('img', { name: 'Direct to Cloud' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Via Main POS' })).not.toBeInTheDocument()
  })

  it('keeps parent business metadata without claiming a parent transport', async () => {
    render(<OrderSyncRouteIndicator />)
    expect(await screen.findByText('Direct to Cloud')).toBeInTheDocument()
    expect(screen.getByText('Parent POS')).toBeInTheDocument()
    await emitNetwork(true)
    await emitNetwork(false)
    expect(getInterTerminalStatus).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('Via Main POS')).not.toBeInTheDocument()
  })

  it('preserves the main role after online and offline network notifications', async () => {
    getInterTerminalStatus.mockResolvedValue({ ...cloudStatus, parentInfo: null, routingMode: 'main' })
    const { container } = render(<OrderSyncRouteIndicator />)
    await waitFor(() => expect(getInterTerminalStatus).toHaveBeenCalledTimes(1))
    await emitNetwork(true)
    await emitNetwork(false)
    expect(container).toBeEmptyDOMElement()
  })

  it('rejects an old bridge reply that presents cloud health as a parent connection', async () => {
    getInterTerminalStatus.mockResolvedValue({
      parentInfo: { adminUrl: 'https://cloud.example', host: 'https://cloud.example', name: 'Cloud' },
      isParentReachable: true,
      routingMode: 'via_parent',
    })
    render(<OrderSyncRouteIndicator />)
    expect(await screen.findByText('Direct to Cloud')).toBeInTheDocument()
    expect(screen.queryByText('Via Main POS')).not.toBeInTheDocument()
    expect(screen.queryByText('Cloud')).not.toBeInTheDocument()
  })

  it('does not infer a configured transport from an online network event', async () => {
    getInterTerminalStatus.mockResolvedValue({ ...cloudStatus, routingMode: 'unknown' })
    render(<OrderSyncRouteIndicator condensed />)
    expect(await screen.findByRole('img', { name: 'Not available' })).toBeInTheDocument()
    await emitNetwork(true)
    expect(screen.queryByRole('img', { name: 'Direct to Cloud' })).not.toBeInTheDocument()
  })
})
