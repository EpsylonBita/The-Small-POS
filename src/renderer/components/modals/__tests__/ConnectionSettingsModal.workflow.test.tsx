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
  const efood = { available: false, efoodControllable: false, settings: { enabled: false, muted: false }, updateSettings: vi.fn() }
  return { bridge, efood, success: vi.fn(), error: vi.fn(), refreshHardware: vi.fn(), hardwareStatus: { scale: { connected: false } }, events: new Map<string, Set<(payload: any) => void>>() }
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
vi.mock('../../peripherals/CashRegisterSection', () => ({ default: ({ setupIntent }: any) => <div data-testid="cash-register" data-setup-mode={setupIntent?.mode ?? ''} data-setup-token={setupIntent?.token ?? ''} /> }))
vi.mock('../../peripherals/CallerIdSection', () => ({ default: () => null }))
vi.mock('../../ecr/PaymentTerminalsSection', () => ({
  PaymentTerminalsSection: ({ embedded, onBack, onOpenCashRegisterSetup }: any) => (
    <div data-testid="card-machines" data-embedded={String(Boolean(embedded))} data-has-back={String(Boolean(onBack))}>
      <button type="button" onClick={onOpenCashRegisterSetup}>Set up the cash register</button>
    </div>
  ),
}))
vi.mock('../../settings/WaiterDevicesSection', () => ({ WaiterDevicesSection: () => <div data-testid="waiter-devices" /> }))
vi.mock('../../settings/CafeLanSettings', () => ({ CafeLanSettings: ({ isMain }: { isMain: boolean }) => <div data-testid="cafe-lan" data-main={String(isMain)} /> }))
vi.mock('../../recovery/RecoveryPanel', () => ({ default: () => null }))
vi.mock('../../printing/PrintQueuePanel', () => ({ default: () => null }))
vi.mock('../../settings/SettingsRuntimePreferences', () => ({
  SettingsRuntimePreferences: ({ soundExtras }: { soundExtras?: React.ReactNode }) => <div data-testid="runtime-preferences">{soundExtras}</div>,
}))
vi.mock('../../../hooks/useEfoodPartner', () => ({ useEfoodPartner: () => mocks.efood }))
vi.mock('../../settings/PlatformNotificationSoundSettings', () => ({ PlatformNotificationSoundSettings: () => <div data-testid="platform-sound" /> }))


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
  mocks.efood.efoodControllable = false
  mocks.efood.settings = { enabled: false, muted: false }
  mocks.efood.updateSettings.mockReset()
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
    expect(statusCard().querySelector('.pos-status--ok')).not.toBeNull()
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
    expect(statusCard().querySelector('.pos-status--ok')).toBeNull()
    emitConfig(pollingConfig)
    expect(within(statusCard()).getByText('Settings are up to date')).toBeVisible()
    expect(mocks.bridge.terminalConfig.syncFromAdmin).not.toHaveBeenCalled()
    rerender(<ConnectionSettingsModal isOpen={false} onClose={vi.fn()} />)
    expect(mocks.events.get('terminal-config-updated')?.size).toBe(0)
  })

  it('delegates Screen & Sound to runtime preferences and shows the actual session rules under PIN & Lock', async () => {
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    await within(statusCard()).findByText('Settings are up to date')
    fireEvent.click(screen.getByRole('button', { name: 'Display & sound' }))
    expect(screen.getByTestId('runtime-preferences')).toBeVisible()
    expect(screen.getByRole('radio', { name: /Automatic \(day \/ night\)/i })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /PIN.*Lock/i }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Scale, display, scanner' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Scale, display, scanner' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Action failed'))
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.refreshHardware).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument()
  })

  it('connects in one step: a changed port is saved before the device connects, and detected ports are suggested', async () => {
    mocks.bridge.settings.getLocal.mockResolvedValue({ scale: { enabled: true, port: 'COM7', baud_rate: 9600, protocol: 'generic' } })
    const calls: string[] = []
    ;(mocks.bridge.settings as any).updateLocal = vi.fn(async (request: { settingType: string }) => {
      calls.push(`save:${request.settingType}`)
      return { success: true }
    })
    ;(mocks.bridge.hardware as any).listSerialPorts = vi.fn(async () => [{ name: 'COM3' }, { name: 'COM9' }])
    mocks.bridge.hardware.scaleConnect.mockImplementationOnce(async (params: { port: string }) => {
      calls.push(`connect:${params.port}`)
      return { success: true }
    })
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    await within(statusCard()).findByText('Settings are up to date')
    fireEvent.click(screen.getByRole('button', { name: 'Scale, display, scanner' }))
    // The test translator does not interpolate; the suggestions themselves are the datalist options.
    expect(await screen.findAllByText(/Found on this computer/)).not.toHaveLength(0)
    expect([...document.querySelectorAll('#settings-serial-port-options option')].map(option => option.getAttribute('value')))
      .toEqual(['COM3', 'COM9'])
    expect(screen.getByDisplayValue('COM7')).toHaveAttribute('list', 'settings-serial-port-options')
    fireEvent.change(screen.getByDisplayValue('COM7'), { target: { value: 'COM9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(calls).toContain('connect:COM9'))
    expect(calls.indexOf('save:scale')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('save:scale')).toBeLessThan(calls.indexOf('connect:COM9'))
    expect(screen.queryByText('Unsaved device changes')).not.toBeInTheDocument()
    delete (mocks.bridge.settings as any).updateLocal
    delete (mocks.bridge.hardware as any).listSerialPorts
  })

  it('retains unsaved device changes until the operator explicitly discards them', async () => {
    mocks.bridge.settings.getLocal.mockResolvedValue({ scale: { enabled: true, port: 'COM7' } })
    const onClose = vi.fn()
    render(<ConnectionSettingsModal isOpen onClose={onClose} />)
    await within(statusCard()).findByText('Settings are up to date')
    fireEvent.click(screen.getByRole('button', { name: 'Scale, display, scanner' }))
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

// UI audit wave 7B (founder-approved 30/10/2026): nine sections, Status & connection, moved sound and LAN.
describe('ConnectionSettingsModal shell (wave 7B)', () => {
  const railLabels = () => Array.from(document.querySelectorAll('nav .pos-rail-item')).map(item => item.textContent?.trim())
  const paneTitle = () => document.querySelector('.pos-pane-title')?.textContent

  it('opens on Status & connection with nine plain rail rows and one Sync now', async () => {
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    await within(statusCard()).findByText('Settings are up to date')
    expect(railLabels()).toEqual([
      'Status & connection', 'Platforms',
      'Printers & receipts', 'Cards & cash register', 'Scale, display, scanner', 'Waiter phones',
      'Display & sound', 'PIN & lock', 'Backups & recovery',
    ])
    expect(paneTitle()).toBe('Status & connection')
    expect(screen.getAllByRole('button', { name: 'Sync now' })).toHaveLength(1)
    expect(screen.getByLabelText('Connection Code')).toBeVisible()
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe('Status & connection')
  })

  it.each([
    ['recovery', 'Backups & recovery'],
    ['printing', 'Printers & receipts'],
    ['connection', 'Status & connection'],
    ['about', 'Status & connection'],
  ] as const)('opens the new place of the %s deep link', async (link, title) => {
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} initialSection={link} />)
    await waitFor(() => expect(paneTitle()).toBe(title))
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe(title)
  })

  it('puts the efood mute with the other sounds, only when efood can be managed here', async () => {
    mocks.efood.efoodControllable = true
    const { unmount } = render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display & sound' }))
    expect(screen.getByTestId('platform-sound')).toBeVisible()
    const mute = screen.getByRole('switch', { name: 'Mute efood sounds' })
    expect(mute).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(mute)
    expect(mocks.efood.updateSettings).toHaveBeenCalledWith({ muted: true })
    unmount()

    mocks.efood.efoodControllable = false
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display & sound' }))
    expect(screen.getByTestId('platform-sound')).toBeVisible()
    expect(screen.queryByRole('switch', { name: 'Mute efood sounds' })).not.toBeInTheDocument()
  })

  it('shows card machines and the cash register together; the register jump stays in the section (wave 7Δ)', async () => {
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    await within(statusCard()).findByText('Settings are up to date')
    fireEvent.click(screen.getByRole('button', { name: 'Scale, display, scanner' }))
    expect(screen.queryByTestId('cash-register')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cards & cash register' }))
    expect(paneTitle()).toBe('Cards & cash register')
    const cards = screen.getByTestId('card-machines')
    expect(cards).toHaveAttribute('data-embedded', 'true')
    expect(cards).toHaveAttribute('data-has-back', 'false')
    const register = screen.getByTestId('cash-register')
    expect(register).toHaveAttribute('data-setup-mode', '')
    // Card machines first, then the register, in the same pane.
    expect(cards.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Set up the cash register' }))
    expect(paneTitle()).toBe('Cards & cash register')
    expect(screen.getByTestId('card-machines')).toBeVisible()
    expect(screen.getByTestId('cash-register')).toHaveAttribute('data-setup-mode', 'rbs_network')
    const firstToken = screen.getByTestId('cash-register').getAttribute('data-setup-token')
    await new Promise(resolve => setTimeout(resolve, 2))
    fireEvent.click(screen.getByRole('button', { name: 'Set up the cash register' }))
    expect(screen.getByTestId('cash-register').getAttribute('data-setup-token')).not.toBe(firstToken)

    // Leaving the section drops the request, so coming back does not reopen the register form.
    fireEvent.click(screen.getByRole('button', { name: 'Display & sound' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cards & cash register' }))
    expect(screen.getByTestId('cash-register')).toHaveAttribute('data-setup-mode', '')
  })

  it('shows LAN pairing with the waiter phones, not under Status & connection', async () => {
    render(<ConnectionSettingsModal isOpen onClose={vi.fn()} />)
    await within(statusCard()).findByText('Settings are up to date')
    expect(screen.queryByTestId('cafe-lan')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Waiter phones' }))
    expect(screen.getByTestId('waiter-devices')).toBeVisible()
    expect(screen.getByTestId('cafe-lan')).toHaveAttribute('data-main', 'true')
  })
})
