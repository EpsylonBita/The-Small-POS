import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  enable: vi.fn(),
  remove: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback: string) => fallback,
    }),
  }
})

vi.mock('react-hot-toast', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

vi.mock('../../../services/CallerIdService', () => ({
  callerIdGetFirewallStatus: mocks.getStatus,
  callerIdEnableFirewall: mocks.enable,
  callerIdRemoveFirewall: mocks.remove,
}))

import CallerIdNetworkAccessCard from '../CallerIdNetworkAccessCard'

const safeReadyStatus = {
  supported: true,
  configured: true,
  privateNetworkActive: true,
  publicNetworkActive: false,
  networkProfileKnown: true,
  publicRulePresent: false,
  configurationIssue: 'none',
}

describe('CallerIdNetworkAccessCard', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('replaces an unsafe Public rule only after the operator enables access', async () => {
    mocks.getStatus.mockResolvedValue({
      ...safeReadyStatus,
      configured: false,
      privateNetworkActive: false,
      publicNetworkActive: true,
      publicRulePresent: true,
    })
    mocks.enable.mockResolvedValue(safeReadyStatus)

    render(<CallerIdNetworkAccessCard />)

    expect(
      await screen.findByText(/A broad Public-network rule was found/i),
    ).toBeInTheDocument()
    const accessSwitch = screen.getByRole('switch', {
      name: 'Private network access',
    })
    expect(accessSwitch).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(accessSwitch)

    await waitFor(() => expect(mocks.enable).toHaveBeenCalledTimes(1))
    expect(mocks.remove).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(accessSwitch).toHaveAttribute('aria-checked', 'true'),
    )
    expect(
      screen.getByText('Ready for Caller ID devices on this private local network.'),
    ).toBeInTheDocument()
  })

  it('does not claim readiness while Windows classifies the active LAN as Public', async () => {
    mocks.getStatus.mockResolvedValue({
      ...safeReadyStatus,
      privateNetworkActive: false,
      publicNetworkActive: true,
    })

    render(<CallerIdNetworkAccessCard />)

    expect(
      await screen.findByText(/Windows calls this network Public/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^Ready$/i)).not.toBeInTheDocument()
    expect(screen.getByText('Rule installed')).toBeInTheDocument()
  })

  it('explains when the operator cancels the Windows administrator prompt', async () => {
    mocks.getStatus.mockResolvedValue({
      ...safeReadyStatus,
      configured: false,
      privateNetworkActive: false,
    })
    mocks.enable.mockRejectedValue(
      new Error('CALLER_ID_FIREWALL_UAC_CANCELLED'),
    )

    render(<CallerIdNetworkAccessCard />)
    const accessSwitch = await screen.findByRole('switch', {
      name: 'Private network access',
    })
    await waitFor(() => expect(accessSwitch).not.toBeDisabled())

    fireEvent.click(accessSwitch)

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Windows administrator approval was cancelled',
      ),
    )
    expect(accessSwitch).toHaveAttribute('aria-checked', 'false')
  })

  it('does not announce success when the elevated helper leaves no usable rule', async () => {
    mocks.getStatus.mockResolvedValue({
      ...safeReadyStatus,
      configured: false,
      privateNetworkActive: false,
      configurationIssue: 'rule_missing',
    })
    mocks.enable.mockRejectedValue(
      new Error('CALLER_ID_FIREWALL_RULE_NOT_READY:rule_missing'),
    )

    render(<CallerIdNetworkAccessCard />)
    const accessSwitch = await screen.findByRole('switch', {
      name: 'Private network access',
    })
    await waitFor(() => expect(accessSwitch).not.toBeDisabled())

    fireEvent.click(accessSwitch)

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Windows approved the request, but the safe Caller ID rule was not installed. Try once more; if it repeats, report the reason shown here.',
      ),
    )
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('shows that a malformed existing rule needs repair instead of calling it permission off', async () => {
    mocks.getStatus.mockResolvedValue({
      ...safeReadyStatus,
      configured: false,
      privateNetworkActive: false,
      configurationIssue: 'rule_scope_mismatch',
    })

    render(<CallerIdNetworkAccessCard />)

    expect(
      await screen.findByText(/existing Caller ID rule is not safe or complete/i),
    ).toBeInTheDocument()
    expect(screen.getByText('Repair needed')).toBeInTheDocument()
  })
})
