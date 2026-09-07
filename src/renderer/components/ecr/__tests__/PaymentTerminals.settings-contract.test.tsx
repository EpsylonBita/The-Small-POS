import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaymentTerminalsSection } from '../PaymentTerminalsSection'
import { TerminalConfigModal } from '../TerminalConfigModal'

const mocks = vi.hoisted(() => ({
  getDevices: vi.fn(), getAllStatuses: vi.fn(), updateDevice: vi.fn(), connectDevice: vi.fn(),
  success: vi.fn(), error: vi.fn(),
}))
vi.mock('../../../../lib', () => ({
  getBridge: () => ({ ecr: mocks }), onEvent: vi.fn(), offEvent: vi.fn(),
}))
vi.mock('react-hot-toast', () => ({ toast: { success: mocks.success, error: mocks.error } }))
vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key
  return { useTranslation: () => ({ t }) }
})
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, title, children, footer }: any) => isOpen
    ? <div role="dialog" aria-label={title}>{children}{footer}</div> : null,
  POSGlassSwitch: ({ checked, onChange }: any) => <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />,
}))
vi.mock('../TerminalDiscoveryModal', () => ({ TerminalDiscoveryModal: () => null }))

const serialDevice = {
  id: 'terminal-1', name: 'Counter terminal', deviceType: 'payment_terminal',
  connectionType: 'serial_usb' as const, connectionDetails: { port: 'COM3', baudRate: 9600 },
  protocol: 'zvt' as const, enabled: true, isDefault: false, settings: {},
}
const bluetoothDevice = {
  ...serialDevice, connectionType: 'bluetooth' as const,
  connectionDetails: { address: 'AA:BB:CC:DD:EE:FF', channel: 1 },
}

beforeEach(() => {
  mocks.getDevices.mockResolvedValue([serialDevice])
  mocks.getAllStatuses.mockResolvedValue({})
  mocks.updateDevice.mockResolvedValue({ success: true, device: serialDevice })
  mocks.connectDevice.mockResolvedValue({ success: true })
})
afterEach(cleanup)

describe('payment terminal settings contract', () => {
  it('keeps existing Bluetooth configuration visible but blocks saving, including form submission', () => {
    const onSave = vi.fn()
    render(<TerminalConfigModal isOpen onClose={vi.fn()} onSave={onSave} device={bluetoothDevice} />)
    expect(screen.getByRole('option', { name: /Bluetooth/ })).toBeDisabled()
    expect(screen.getByText(/Bluetooth.*not available/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.submit(document.getElementById('terminal-config-form')!)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('allows converting an existing Bluetooth terminal to a supported network connection', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<TerminalConfigModal isOpen onClose={vi.fn()} onSave={onSave} device={bluetoothDevice} />)
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'network' } })
    fireEvent.change(screen.getByPlaceholderText('192.168.1.100'), { target: { value: '192.168.1.9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      connectionType: 'network', protocol: 'zvt',
      connectionDetails: { type: 'network', ip: '192.168.1.9', port: 20007 },
    })))
  })

  it('does not attempt a hardware connection for a saved Bluetooth terminal', async () => {
    mocks.getDevices.mockResolvedValue([bluetoothDevice])
    render(<PaymentTerminalsSection />)
    await screen.findByText(serialDevice.name)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    expect(screen.getByText(/Bluetooth.*not available/i)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(mocks.connectDevice).not.toHaveBeenCalled()
  })

  it('reports refresh failure without a success toast and permits a successful retry', async () => {
    render(<PaymentTerminalsSection />)
    await screen.findByText(serialDevice.name)
    mocks.getDevices.mockRejectedValueOnce(new Error('Local device read failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Failed to load payment terminals'))
    expect(mocks.success).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh connection status' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Terminals refreshed'))
  })

  it('preserves the edit form on a native save failure and closes after a successful retry', async () => {
    render(<PaymentTerminalsSection />)
    await screen.findByText(serialDevice.name)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByPlaceholderText('e.g., Main Terminal'), { target: { value: 'Updated terminal' } })
    mocks.updateDevice.mockResolvedValueOnce({ success: false, error: 'Device not found' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.updateDevice).toHaveBeenCalledOnce())
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Device not found'))
    expect(screen.getByRole('dialog', { name: 'Edit Payment Terminal' })).toBeVisible()
    expect(screen.getByPlaceholderText('e.g., Main Terminal')).toHaveValue('Updated terminal')
    expect(mocks.success).not.toHaveBeenCalled()
    mocks.updateDevice.mockResolvedValueOnce({ success: true, device: { ...serialDevice, name: 'Updated terminal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('Updated terminal')).toBeVisible()
  })
})
