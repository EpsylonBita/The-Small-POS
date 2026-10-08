import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaymentTerminalsSection } from '../PaymentTerminalsSection'
import { TerminalConfigModal } from '../TerminalConfigModal'

const mocks = vi.hoisted(() => ({
  getDevices: vi.fn(), getAllStatuses: vi.fn(), updateDevice: vi.fn(), connectDevice: vi.fn(),
  addDevice: vi.fn(), disconnectDevice: vi.fn(), getDeviceAdmission: vi.fn(),
  success: vi.fn(), error: vi.fn(),
}))
vi.mock('../../../../lib', () => ({
  getBridge: () => ({ ecr: mocks }), onEvent: vi.fn(), offEvent: vi.fn(),
}))
vi.mock('react-hot-toast', () => ({ toast: { success: mocks.success, error: mocks.error } }))
vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: unknown) => typeof fallback === 'string'
    ? fallback : (fallback as { defaultValue?: string } | undefined)?.defaultValue ?? key
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

const admissionAnswer = (cardAdmitted: boolean) => ({
  success: true,
  cardTerminal: { admitted: cardAdmitted, fetchedAt: '2026-10-08T09:00:00Z' },
  cashRegister: { admitted: false, fetchedAt: '2026-10-08T09:00:00Z', mode: 'fiscal_device', status: 'pending' },
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getDevices.mockResolvedValue([serialDevice])
  mocks.getAllStatuses.mockResolvedValue({})
  mocks.updateDevice.mockResolvedValue({ success: true, device: serialDevice })
  mocks.connectDevice.mockResolvedValue({ success: true })
  mocks.getDeviceAdmission.mockResolvedValue(admissionAnswer(true))
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

  // Founder rule 08/10/2026. Incident: a fiscal register "Rbs Elio CR" saved as an
  // enabled payment_terminal (no payment plugin) refused manual card and manual returns.
  const incident = {
    id: 'ecr-rbs', name: 'Rbs Elio CR', deviceType: 'payment_terminal', brand: 'generic',
    connectionType: 'network' as const, connectionDetails: { ip: '192.168.1.169', port: 9101 },
    protocol: 'generic', enabled: true, isDefault: true, settings: {}, admitted: false,
  }

  it('keeps a fiscal register saved as a card terminal visible with its plugin state, and lets it be disabled', async () => {
    mocks.getDeviceAdmission.mockResolvedValue(admissionAnswer(false))
    mocks.getDevices.mockResolvedValue({ success: true, devices: [incident] })
    mocks.updateDevice.mockResolvedValue({ success: true, device: { ...incident, enabled: false } })
    render(<PaymentTerminalsSection onBack={vi.fn()} />)
    await screen.findByText('Rbs Elio CR')
    expect(mocks.getDeviceAdmission).toHaveBeenCalledWith({ refresh: true })
    expect(await screen.findByText(/Needs its plugin: card terminals stay inactive/)).toBeVisible()
    expect(screen.getByText(/looks like a fiscal cash register \(RBS \/ ELIO\)/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(mocks.updateDevice).toHaveBeenCalledExactlyOnceWith('ecr-rbs', { enabled: false }))
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Device disabled'))
    expect(screen.getByText('Disabled')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
  })

  it('refuses to save an RBS / ELIO device from the card terminal form', async () => {
    const onSave = vi.fn()
    const onOpenCashRegisterSetup = vi.fn()
    render(<TerminalConfigModal isOpen onClose={vi.fn()} onSave={onSave} device={incident}
      onOpenCashRegisterSetup={onOpenCashRegisterSetup} />)
    expect(screen.getByRole('radio', { name: 'Fiscal Cash Register' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Payment Terminal' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/not a card terminal/)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.submit(document.getElementById('terminal-config-form')!)
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Cash Register' }))
    expect(onOpenCashRegisterSetup).toHaveBeenCalledOnce()
  })

  it('requires an explicit device type for a new terminal and blocks an RBS name typed in', () => {
    const onSave = vi.fn()
    render(<TerminalConfigModal isOpen onClose={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByPlaceholderText('e.g., Main Terminal'), { target: { value: 'Counter' } })
    fireEvent.change(screen.getByPlaceholderText('COM3'), { target: { value: 'COM4' } })
    expect(screen.getByText(/Choose the device type/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Payment Terminal' }))
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
    fireEvent.change(screen.getByPlaceholderText('e.g., Main Terminal'), { target: { value: 'RBS ELIO' } })
    expect(screen.getByRole('radio', { name: 'Fiscal Cash Register' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  it('refuses adding an enabled card terminal before native while no payment plugin is admitted', async () => {
    mocks.getDeviceAdmission.mockResolvedValue(admissionAnswer(false))
    mocks.addDevice.mockResolvedValue({ success: true, device: { ...serialDevice, id: 'terminal-2', enabled: false } })
    render(<PaymentTerminalsSection onBack={vi.fn()} />)
    await screen.findByText(serialDevice.name)
    fireEvent.click(screen.getByRole('button', { name: 'Add Terminal' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Payment Terminal' }))
    fireEvent.change(screen.getByPlaceholderText('e.g., Main Terminal'), { target: { value: 'Second terminal' } })
    fireEvent.change(screen.getByPlaceholderText('COM3'), { target: { value: 'COM5' } })
    expect(await screen.findByText(/This card terminal cannot be enabled/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringMatching(/needs an active, configured payment plugin/)))
    expect(mocks.addDevice).not.toHaveBeenCalled()
    // Saving it disabled stays possible (inert until the plugin is set up).
    fireEvent.click(screen.getAllByRole('checkbox').at(-1)!)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(mocks.addDevice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      deviceType: 'payment_terminal', enabled: false, name: 'Second terminal',
    })))
  })

  it('shows the localized refusal when native answers DEVICE_NOT_ADMITTED, and does not resend an unchanged enabled flag or type', async () => {
    mocks.updateDevice.mockResolvedValue({ success: false, code: 'DEVICE_NOT_ADMITTED', deviceType: 'payment_terminal', error: 'Device type payment_terminal is not admitted' })
    render(<PaymentTerminalsSection onBack={vi.fn()} />)
    await screen.findByText(serialDevice.name)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByPlaceholderText('e.g., Main Terminal'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringMatching(/This card terminal cannot be enabled/)))
    expect(mocks.updateDevice.mock.calls[0][1]).not.toHaveProperty('enabled')
    expect(mocks.updateDevice.mock.calls[0][1]).not.toHaveProperty('deviceType')
    expect(mocks.updateDevice.mock.calls[0][1]).toMatchObject({ name: 'Renamed' })
  })
})
