import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))
vi.mock('../../../utils/api-helpers', () => ({ posApiGet: mocks.get, posApiPut: mocks.put }))
vi.mock('react-hot-toast', () => ({ toast: { success: mocks.success, error: mocks.error } }))
vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: any) => typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
  return { useTranslation: () => ({ t }), initReactI18next: { type: '3rdParty', init: () => {} } }
})
vi.mock('../../../utils/format', () => ({ formatDate: (date: Date) => date.toISOString() }))
vi.mock('../../ui/pos-glass-components', () => ({
  POSGlassSwitch: ({ checked, onChange, disabled, ...props }: any) =>
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} {...props} />,
}))

import { WaiterDevicesSection } from '../WaiterDevicesSection'

const phone = (terminalId: string, name: string, enabledFeatures: Record<string, boolean>) => ({
  terminalId, name, shortCode: null, location: null, isActive: true, online: true, lastSeenAt: null,
  enabledFeatures, enabledModules: null, activeStaff: [],
})
const phones = [
  phone('w-1', 'Phone A', { order_creation: true, table_management: true, payment_processing: false, refunds: false, discounts: true }),
  phone('w-2', 'Phone B', { order_creation: true, table_management: false, payment_processing: true, cash_payments: false, card_payments: true, refunds: false }),
]
const switchFor = (terminalId: string, key: string) =>
  document.querySelector(`[aria-labelledby="waiter-device-${terminalId}-${key}-label"]`) as HTMLButtonElement
const footer = () => document.querySelector('[data-dirty-footer]')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockResolvedValue({ success: true, data: { success: true, data: { devices: phones } } })
  mocks.put.mockImplementation(async (_url: string, body: { enabled_features: Record<string, boolean> }) =>
    ({ success: true, data: { success: true, data: { enabled_features: body.enabled_features } } }))
})
afterEach(cleanup)

describe('WaiterDevicesSection: one Save for every changed phone (wave 7Δ2)', () => {
  it('has no per-phone Save; one footer saves every changed phone with the same payload as before', async () => {
    render(<WaiterDevicesSection />)
    await screen.findByText('Phone A')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(footer()).toBeNull()

    fireEvent.click(switchFor('w-1', 'payment_processing')) // OFF -> ON with no previous method: both on
    fireEvent.click(switchFor('w-2', 'refunds'))
    expect(footer()).not.toBeNull()
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2))
    expect(mocks.put).toHaveBeenNthCalledWith(1, '/api/pos/terminals/waiter-devices/w-1', {
      enabled_features: { order_creation: true, table_management: true, payment_processing: true, refunds: false, discounts: true, cash_payments: true, card_payments: true },
    })
    // Unmanaged keys and the cash/card mix are kept when payments did not change.
    expect(mocks.put).toHaveBeenNthCalledWith(2, '/api/pos/terminals/waiter-devices/w-2', {
      enabled_features: { order_creation: true, table_management: false, payment_processing: true, cash_payments: false, card_payments: true, refunds: true },
    })
    await waitFor(() => expect(footer()).toBeNull())
    expect(mocks.success).toHaveBeenCalledOnce()
    expect(mocks.success).toHaveBeenCalledWith('Waiter phones updated')
    expect(switchFor('w-2', 'refunds')).toHaveAttribute('aria-checked', 'true')
  })

  it('Cancel puts every phone back to what is saved and sends nothing', async () => {
    render(<WaiterDevicesSection />)
    await screen.findByText('Phone A')
    fireEvent.click(switchFor('w-1', 'order_creation'))
    fireEvent.click(switchFor('w-2', 'table_management'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(footer()).toBeNull()
    expect(switchFor('w-1', 'order_creation')).toHaveAttribute('aria-checked', 'true')
    expect(switchFor('w-2', 'table_management')).toHaveAttribute('aria-checked', 'false')
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it('keeps a phone that failed changed (footer stays) and saves the others', async () => {
    mocks.put.mockImplementationOnce(async () => ({ success: false, error: 'Admin unavailable' }))
    render(<WaiterDevicesSection />)
    await screen.findByText('Phone A')
    fireEvent.click(switchFor('w-1', 'refunds'))
    fireEvent.click(switchFor('w-2', 'refunds'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Admin unavailable'))
    expect(mocks.success).toHaveBeenCalledWith('Waiter device updated')
    expect(footer()).not.toBeNull()
    expect(switchFor('w-1', 'refunds')).toHaveAttribute('aria-checked', 'true')
  })

  it('stops at the main-terminal-only refusal and shows it', async () => {
    mocks.put.mockImplementationOnce(async () => ({ success: false, data: { success: false, code: 'WAITER_MGMT_MAIN_ONLY' } }))
    render(<WaiterDevicesSection />)
    await screen.findByText('Phone A')
    fireEvent.click(switchFor('w-1', 'refunds'))
    fireEvent.click(switchFor('w-2', 'refunds'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Only the main terminal can manage waiter devices.')).toBeVisible()
    expect(mocks.put).toHaveBeenCalledOnce()
    expect(mocks.success).not.toHaveBeenCalled()
  })
})
