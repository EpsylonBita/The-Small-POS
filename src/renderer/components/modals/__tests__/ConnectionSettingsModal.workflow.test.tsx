import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectionSettingsModal from '../ConnectionSettingsModal'

const mocks = vi.hoisted(() => {
  const bridge = {
    settings: { getAdminUrl: vi.fn(), getLocal: vi.fn() },
    terminalConfig: { getFullConfig: vi.fn(), syncFromAdmin: vi.fn() },
    diagnostics: { getAbout: vi.fn() },
    hardware: { scaleConnect: vi.fn(), scaleDisconnect: vi.fn() },
  }
  return { bridge, success: vi.fn(), error: vi.fn(), refreshHardware: vi.fn(), hardwareStatus: { scale: { connected: false } }, events: new Map<string, Set<(payload: any) => void>>() }
})
vi.mock('../../../../lib', () => ({
  getBridge: () => mocks.bridge,
  onEvent: (event: string, callback: (payload: any) => void) => {
    if (!mocks.events.has(event)) mocks.events.set(event, new Set())
    mocks.events.get(event)!.add(callback)
  },
  offEvent: (event: string, callback: (payload: any) => void) => mocks.events.get(event)?.delete(callback),
}))
vi.mock('react-hot-toast', () => ({ toast: { success: mocks.success, error: mocks.error } }))
vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: any) => typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
  return { useTranslation: () => ({ t }) }
})
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ language: 'en', setLanguage: vi.fn() }) }))
vi.mock('../../../contexts/module-context', () => ({ useModules: () => ({ enabledModules: [] }) }))
vi.mock('../../../hooks/useFeatures', () => ({ useFeatures: () => ({ features: {}, terminalType: 'main', posOperatingMode: 'standalone' }) }))
vi.mock('../../../hooks/useHardwareManager', () => ({ useHardwareManager: () => ({ status: mocks.hardwareStatus, refresh: mocks.refreshHardware, loading: false, error: null }) }))
vi.mock('../../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({ runWithPrivilegedConfirmation: vi.fn(), confirmationModal: null }) }))
vi.mock('../../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: () => ({ terminalId: 'register-1' }),
  refreshTerminalCredentialCache: async () => ({ terminalId: 'register-1' }),
  updateTerminalCredentialCache: vi.fn(),
}))
vi.mock('../../../utils/api-helpers', () => ({ posApiGet: vi.fn() }))
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, title, ariaLabel, header, children, footer }: any) => isOpen ? <div role="dialog" aria-label={title ?? ariaLabel}>{header}{children}{footer}</div> : null,
  POSGlassSwitch: ({ checked, onChange, ...props }: any) => <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} {...props} />,
}))
vi.mock('../../ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, title, message, onClose, onConfirm, confirmText, cancelText }: any) => isOpen
    ? <div role="dialog" aria-label={title}><p>{message}</p><button onClick={onClose}>{cancelText ?? 'Cancel'}</button><button onClick={onConfirm}>{confirmText ?? 'Confirm'}</button></div> : null,
}))
vi.mock('../PrinterSettingsModal', () => ({ default: () => null }))
vi.mock('../../peripherals/CashRegisterSection', () => ({ default: () => null }))
vi.mock('../../peripherals/CallerIdSection', () => ({ default: () => null }))
vi.mock('../../ecr/PaymentTerminalsSection', () => ({ PaymentTerminalsSection: () => null }))
vi.mock('../../settings/WaiterDevicesSection', () => ({ WaiterDevicesSection: () => null }))
vi.mock('../../recovery/RecoveryPanel', () => ({ default: () => null }))
vi.mock('../../printing/PrintQueuePanel', () => ({ default: () => null }))
vi.mock('../../settings/SettingsRuntimePreferences', () => ({
  SettingsRuntimePreferences: ({ onOpenPrinterSettings, onOpenSecurity }: any) => <div data-testid="runtime-preferences">
    <button onClick={onOpenPrinterSettings}>Open receipt settings</button>
    <button onClick={onOpenSecurity}>Open session settings</button>
  </div>,
}))

const pollingConfig = { terminal_id: 'register-1', admin_dashboard_url: 'https://admin.example.test', sync_health: 'polling' }
const statusCard = () => document.querySelector('[data-register-status-card]') as HTMLElement
const syncButton = () => document.querySelector('[data-register-sync-action]') as HTMLButtonElement
function emitConfig(config: typeof pollingConfig) {
  act(() => { mocks.events.get('terminal-config-updated')?.forEach(callback => callback(config)) })
}

beforeEach(() => {
  localStorage.clear()
  mocks.events.clear()
  mocks.bridge.settings.getAdminUrl.mockResolvedValue(pollingConfig.admin_dashboard_url)
  mocks.bridge.settings.getLocal.mockResolvedValue({})
  mocks.bridge.terminalConfig.getFullConfig.mockResolvedValue(pollingConfig)
  mocks.bridge.terminalConfig.syncFromAdmin.mockResolvedValue({ success: true, data: { config: pollingConfig } })
  mocks.hardwareStatus = { scale: { connected: false } }
  mocks.refreshHardware.mockResolvedValue(undefined)
  mocks.bridge.hardware.scaleConnect.mockResolvedValue({ success: true })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

describe('ConnectionSettingsModal workflow', () => {
  it('reads the local configuration on open without starting admin sync and shows healthy polling', async () => {
    const onClose = vi.fn()
    render(<ConnectionSettingsModal isOpen onClose={onClose} />)
    await within(statusCard()).findByText('Settings are up to date')
    expect(statusCard().querySelector('.bg-green-500')).not.toBeNull()
    expect(mocks.bridge.terminalConfig.getFullConfig).toHaveBeenCalledOnce()
    expect(mocks.bridge.terminalConfig.syncFromAdmin).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: 'Unsaved device changes' })).not.toBeInTheDocument()
  })

  it('disables repeated manual sync while pending and exposes a failure envelope without success', async () => {
    let resolveSync!: (result: unknown) => void
    mocks.bridge.terminalConfig.syncFromAdmin.mockReturnValueOnce(new Promise(resolve => { resolveSync = resolve }))
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    await within(statusCard()).findByText('Settings are up to date')
    fireEvent.click(syncButton())
    expect(syncButton()).toBeDisabled()
    fireEvent.click(syncButton())
    expect(mocks.bridge.terminalConfig.syncFromAdmin).toHaveBeenCalledOnce()
    await act(async () => { resolveSync({ success: false, error: 'Admin unavailable' }) })
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Admin unavailable'))
    expect(mocks.success).not.toHaveBeenCalled()
    expect(syncButton()).toBeEnabled()
  })

  it('updates the status card from terminal-config-updated and unsubscribes when closed', async () => {
    const { rerender } = render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    await within(statusCard()).findByText('Settings are up to date')
    emitConfig({ ...pollingConfig, sync_health: 'disconnected' })
    expect(within(statusCard()).queryByText('Settings are up to date')).not.toBeInTheDocument()
    expect(statusCard().querySelector('.bg-green-500')).toBeNull()
    emitConfig(pollingConfig)
    expect(within(statusCard()).getByText('Settings are up to date')).toBeVisible()
    expect(mocks.bridge.terminalConfig.syncFromAdmin).not.toHaveBeenCalled()
    rerender(<ConnectionSettingsModal isOpen={false} onClose={vi.fn()} />)
    expect(mocks.events.get('terminal-config-updated')?.size).toBe(0)
  })

  it('delegates Screen & Sound to runtime preferences and links to the actual session rules', async () => {
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    await within(statusCard()).findByText('Settings are up to date')
    fireEvent.click(document.querySelector('[data-settings-section="terminal"]') ?? screen.getByRole('button', { name: /Screen.*Sound/i }))
    expect(screen.getByTestId('runtime-preferences')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Open session settings' }))
    expect(screen.getByText(/30-minute inactivity limit.*2 hours/i)).toBeVisible()
    expect(screen.getByText(/Custom auto-lock timing is not available/i)).toBeVisible()
    expect(document.querySelector('[data-session-timeout-card] input')).toBeNull()
  })

  it('refreshes hardware status after connecting and prevents repeated pending actions', async () => {
    mocks.bridge.settings.getLocal.mockResolvedValue({ scale: { enabled: true, port: 'COM7', baud_rate: 9600, protocol: 'generic' } })
    let resolveConnect!: (result: unknown) => void
    mocks.bridge.hardware.scaleConnect.mockReturnValueOnce(new Promise(resolve => { resolveConnect = resolve }))
    const onClose = vi.fn()
    render(<ConnectionSettingsModal isOpen onClose={onClose} />)
    await within(statusCard()).findByText('Settings are up to date')
    fireEvent.click(screen.getByRole('button', { name: /^Devices\s*Scale, scanner and hardware/i }))
    const connect = screen.getByRole('button', { name: 'Connect' })
    mocks.refreshHardware.mockImplementationOnce(async () => { mocks.hardwareStatus = { scale: { connected: true } } })
    fireEvent.click(connect)
    expect(connect).toBeDisabled()
    fireEvent.click(connect)
    expect(mocks.bridge.hardware.scaleConnect).toHaveBeenCalledOnce()
    expect(mocks.bridge.hardware.scaleConnect).toHaveBeenCalledWith({ port: 'COM7', baud: 9600, protocol: 'generic' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { resolveConnect({ success: true }) })
    await waitFor(() => expect(mocks.refreshHardware).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeEnabled()
  })

  it('shows a rejected hardware result without claiming a successful connection', async () => {
    mocks.bridge.settings.getLocal.mockResolvedValue({ scale: { enabled: true, port: 'COM7' } })
    mocks.bridge.hardware.scaleConnect.mockResolvedValueOnce({ success: false, error: 'COM7 is unavailable' })
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    await within(statusCard()).findByText('Settings are up to date')
    fireEvent.click(screen.getByRole('button', { name: /^Devices\s*Scale, scanner and hardware/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Action failed'))
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.refreshHardware).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument()
  })

  it('retains unsaved device changes until the operator explicitly discards them', async () => {
    mocks.bridge.settings.getLocal.mockResolvedValue({ scale: { enabled: true, port: 'COM7' } })
    const onClose = vi.fn()
    render(<ConnectionSettingsModal isOpen onClose={onClose} />)
    await within(statusCard()).findByText('Settings are up to date')
    fireEvent.click(screen.getByRole('button', { name: /^Devices\s*Scale, scanner and hardware/i }))
    fireEvent.change(screen.getByDisplayValue('COM7'), { target: { value: 'COM9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('dialog', { name: 'Unsaved device changes' })).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('dialog', { name: 'Unsaved device changes' })).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('COM9')).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(mocks.bridge.hardware.scaleConnect).not.toHaveBeenCalled()
  })
})
