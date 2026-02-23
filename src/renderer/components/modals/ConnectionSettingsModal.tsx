import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { posApiGet } from '../../utils/api-helpers'
import { useTheme } from '../../contexts/theme-context'
import { useI18n } from '../../contexts/i18n-context'
import { Wifi, Lock, Palette, Globe, ChevronDown, Sun, Moon, Monitor, Database, Printer, Eye, EyeOff, Clipboard, Timer, CreditCard, Cable } from 'lucide-react'
import { inputBase, liquidGlassModalButton } from '../../styles/designSystem';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import PrinterSettingsModal from './PrinterSettingsModal';
import CashRegisterSection from '../peripherals/CashRegisterSection';
import { PaymentTerminalsSection } from '../ecr/PaymentTerminalsSection';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useHardwareManager } from '../../hooks/useHardwareManager';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
  updateTerminalCredentialCache,
} from '../../services/terminal-credentials';
import { getBridge } from '../../../lib';

interface Props {
  isOpen: boolean
  onClose: () => void
}

const normalizeAdminDashboardUrl = (rawUrl: string): string => {
  const trimmed = (rawUrl || '').trim()
  if (!trimmed) return ''

  let normalized = trimmed
  if (!/^https?:\/\//i.test(normalized)) {
    const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(normalized)
    normalized = `${isLocalhost ? 'http' : 'https'}://${normalized}`
  }

  try {
    const parsed = new URL(normalized)
    parsed.search = ''
    parsed.hash = ''
    const cleanPath = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/i, '')
    parsed.pathname = cleanPath || '/'
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return normalized.replace(/\/+$/, '').replace(/\/api$/i, '')
  }
}

const parseBooleanSetting = (value: unknown): boolean => {
  if (value === true || value === 1) return true
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return false
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      const unwrapped = trimmed.slice(1, -1).trim().toLowerCase()
      return unwrapped === 'true' || unwrapped === '1' || unwrapped === 'yes' || unwrapped === 'on'
    }
    const normalized = trimmed.toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
  }
  return false
}

const ConnectionSettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { language: currentLanguage, setLanguage } = useI18n()
  const bridge = getBridge()
  const [terminalId, setTerminalId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [adminDashboardUrl, setAdminDashboardUrl] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [showConnectionSettings, setShowConnectionSettings] = useState(false)
  const [showPinSettings, setShowPinSettings] = useState(false)
  const [editingPin, setEditingPin] = useState(false)
  const [showPrinterSettingsModal, setShowPrinterSettingsModal] = useState(false)
  const [showPaymentTerminalsSection, setShowPaymentTerminalsSection] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [showDatabaseSettings, setShowDatabaseSettings] = useState(false)
  const [showClearOperationalConfirm, setShowClearOperationalConfirm] = useState(false)
  const [isClearingOperational, setIsClearingOperational] = useState(false)

  // Factory reset confirmation dialogs
  const [showFactoryResetWarning, setShowFactoryResetWarning] = useState(false)
  const [showFactoryResetFinal, setShowFactoryResetFinal] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  // Session timeout settings
  const [showSecuritySettings, setShowSecuritySettings] = useState(false)
  const [sessionTimeoutEnabled, setSessionTimeoutEnabled] = useState(false)
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState('15')
  const [ghostModeFeatureEnabled, setGhostModeFeatureEnabled] = useState(false)
  const [ghostModeEnabled, setGhostModeEnabled] = useState(false)

  const [showPeripheralsSettings, setShowPeripheralsSettings] = useState(false)
  // Peripheral settings state
  const [scaleEnabled, setScaleEnabled] = useState(false)
  const [scalePort, setScalePort] = useState('COM3')
  const [scaleBaudRate, setScaleBaudRate] = useState('9600')
  const [scaleProtocol, setScaleProtocol] = useState('generic')
  const [displayEnabled, setDisplayEnabled] = useState(false)
  const [displayConnectionType, setDisplayConnectionType] = useState('serial')
  const [displayPort, setDisplayPort] = useState('COM4')
  const [displayBaudRate, setDisplayBaudRate] = useState('9600')
  const [displayTcpPort, setDisplayTcpPort] = useState('9100')
  const [scannerEnabled, setScannerEnabled] = useState(false)
  const [scannerPort, setScannerPort] = useState('COM2')
  const [scannerBaudRate, setScannerBaudRate] = useState('9600')
  const [cardReaderEnabled, setCardReaderEnabled] = useState(false)
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false)

  const { status: hardwareStatus } = useHardwareManager()

  useEffect(() => {
    if (!isOpen) return
    const lsTerminal = getCachedTerminalCredentials().terminalId || ''
    const lsApiKey = getCachedTerminalCredentials().apiKey || ''
    setTerminalId(lsTerminal)
    setApiKey(lsApiKey)
    setAdminDashboardUrl(normalizeAdminDashboardUrl(localStorage.getItem('admin_dashboard_url') || ''))
    setPin('')
    void refreshTerminalCredentialCache().then((resolved) => {
      if (resolved.terminalId) setTerminalId(resolved.terminalId)
      if (resolved.apiKey) setApiKey(resolved.apiKey)
    })

    void (async () => {
      try {
        const stored = await bridge.settings.getAdminUrl()
        const normalized = normalizeAdminDashboardUrl((stored || '').toString())
        if (normalized) {
          setAdminDashboardUrl(normalized)
          localStorage.setItem('admin_dashboard_url', normalized)
        }
      } catch (e) {
        console.warn('[ConnectionSettings] Failed to load admin dashboard URL:', e)
      }
    })()

    // Load session timeout settings from main process
    const loadSecuritySettings = async () => {
      try {
        let remoteGhostFeatureEnabled: boolean | null = null
        try {
          try {
            await bridge.invoke('admin-sync-terminal-config')
          } catch (nativeSyncError) {
            console.warn('[ConnectionSettings] Native admin terminal sync failed (non-fatal):', nativeSyncError)
          }

          const resolvedCreds = await refreshTerminalCredentialCache()
          const resolvedTerminalId = (resolvedCreds.terminalId || '').trim()
          const resolvedApiKey = (resolvedCreds.apiKey || '').trim()
          const storedAdminUrl = normalizeAdminDashboardUrl(
            (
              (await bridge.settings.getAdminUrl()) ||
              localStorage.getItem('admin_dashboard_url') ||
              ''
            ).toString()
          )

          if (resolvedTerminalId && resolvedApiKey && storedAdminUrl) {
            await bridge.settings.updateTerminalCredentials({
              terminalId: resolvedTerminalId,
              apiKey: resolvedApiKey,
              adminUrl: storedAdminUrl,
            })
            const settingsResult = await posApiGet(`/pos/settings/${encodeURIComponent(resolvedTerminalId)}`)
            const payload: any = settingsResult?.data
            const rawRemoteGhostFeature =
              payload?.ghost_mode_feature_enabled ??
              payload?.settings?.terminal?.ghost_mode_feature_enabled ??
              payload?.terminal?.ghost_mode_feature_enabled ??
              payload?.enabled_features?.ghost_mode
            if (rawRemoteGhostFeature !== undefined && rawRemoteGhostFeature !== null) {
              remoteGhostFeatureEnabled = parseBooleanSetting(rawRemoteGhostFeature)
              await bridge.settings.updateLocal({
                settingType: 'terminal',
                settings: { ghost_mode_feature_enabled: remoteGhostFeatureEnabled },
              })
            }
          } else {
            await bridge.terminalConfig.refresh()
          }
        } catch (refreshError) {
          console.warn('[ConnectionSettings] Failed to refresh terminal settings before loading security settings:', refreshError)
        }

        const ghostFeature = remoteGhostFeatureEnabled !== null
          ? remoteGhostFeatureEnabled
          : await bridge.settings.get('terminal', 'ghost_mode_feature_enabled')
        const ghostEnabled = await bridge.settings.get('system', 'ghost_mode_enabled')
        const enabled = await bridge.settings.get('system', 'session_timeout_enabled')
        const minutes = await bridge.settings.get('system', 'session_timeout_minutes')
        const enabledNormalized = parseBooleanSetting(enabled)
        const minutesParsed = Number(minutes)
        setGhostModeFeatureEnabled(parseBooleanSetting(ghostFeature))
        setGhostModeEnabled(parseBooleanSetting(ghostEnabled))
        setSessionTimeoutEnabled(enabledNormalized)
        setSessionTimeoutMinutes(String(Number.isFinite(minutesParsed) && minutesParsed > 0 ? minutesParsed : 15))
      } catch (e) {
        console.warn('Failed to load security settings:', e)
      }
    }
    loadSecuritySettings()
  }, [isOpen])

  const handleSaveConnection = async () => {
    if (!terminalId || !apiKey) {
      toast.error(t('modals.connectionSettings.enterBoth'))
      return
    }

    const normalizedAdminDashboardUrl = normalizeAdminDashboardUrl(adminDashboardUrl)
    if (!normalizedAdminDashboardUrl) {
      toast.error(t('modals.connectionSettings.enterAdminUrl', { defaultValue: 'Enter a valid Admin Dashboard URL' }))
      return
    }

    // Check if terminal ID or API key changed
    const oldTerminalId = getCachedTerminalCredentials().terminalId
    const oldApiKey = getCachedTerminalCredentials().apiKey
    const oldAdminDashboardUrl = normalizeAdminDashboardUrl(localStorage.getItem('admin_dashboard_url') || '')
    const hasChanged = oldTerminalId !== terminalId || oldApiKey !== apiKey
    const hasAdminUrlChanged = oldAdminDashboardUrl !== normalizedAdminDashboardUrl

    localStorage.setItem('admin_dashboard_url', normalizedAdminDashboardUrl)
    updateTerminalCredentialCache({ terminalId, apiKey })

    try {
      // Persist under the correct category ('terminal'), not 'pos'
      await bridge.settings.updateLocal({
        settingType: 'terminal',
        settings: {
          terminal_id: terminalId,
          pos_api_key: apiKey,
          admin_dashboard_url: normalizedAdminDashboardUrl,
        }
      })
    } catch (e) {
      console.warn('Failed to persist connection settings to main process:', e)
    }

    // Try to pull branch_id from Admin-provisioned terminal config via main process
    try {
      // Ask main to refresh terminal settings (Supabase -> local cache)
      await bridge.terminalConfig.refresh()
      const bid = await bridge.terminalConfig.getBranchId()
      if (bid) {
        updateTerminalCredentialCache({ branchId: bid })
        try {
          await bridge.settings.updateLocal({
            settingType: 'terminal',
            settings: { branch_id: bid }
          })
        } catch (e) {
          console.warn('Failed to persist branch_id to main process:', e)
        }
      } else {
        console.warn('[ConnectionSettings] Could not resolve branch_id for terminal', terminalId)
      }
    } catch (e) {
      console.warn('[ConnectionSettings] Branch resolution failed:', e)
    }

    // If terminal credentials changed, trigger full sync from Admin Dashboard
    if (hasChanged) {
      try {
        console.log('[ConnectionSettings] Terminal ID or API key changed, clearing shifts and updating credentials...')

        // Clear any active shifts from old terminal
        localStorage.removeItem('activeShift')
        localStorage.removeItem('staff')

        let resolvedAdminDashboardUrl = ''
        try {
          resolvedAdminDashboardUrl =
            ((await bridge.settings.getAdminUrl()) || '').toString()
        } catch (resolveError) {
          console.warn('[ConnectionSettings] Failed to resolve admin dashboard URL before credential update:', resolveError)
        }

        // Update terminal credentials in the sync service
        await bridge.settings.updateTerminalCredentials({
          terminalId,
          apiKey,
          adminUrl: normalizeAdminDashboardUrl(resolvedAdminDashboardUrl) || normalizedAdminDashboardUrl
        })

        toast.success(t('modals.connectionSettings.connectionSaved') + ' - Syncing data...')
      } catch (e) {
        console.warn('Failed to update credentials or trigger sync:', e)
        toast.success(t('modals.connectionSettings.connectionSaved'))
      }
    } else if (hasAdminUrlChanged) {
      toast.success(t('modals.connectionSettings.connectionSaved', { defaultValue: 'Connection settings saved' }))
      console.log('[ConnectionSettings] Admin dashboard URL updated without credential reset:', normalizedAdminDashboardUrl)
    } else {
      toast.success(t('modals.connectionSettings.connectionSaved'))
    }
  }

  const handleSavePin = async () => {
    if (!pin || pin.length < 4) {
      toast.error(t('modals.connectionSettings.pinMinLength'))
      return
    }
    if (pin !== confirmPin) {
      toast.error(t('modals.connectionSettings.pinNoMatch'))
      return
    }
    try {
      await bridge.auth.setupPin({
        staffPin: pin
      })
    } catch (e) {
      console.warn('Failed to persist secure PIN hash to main process:', e)
      toast.error(t('modals.connectionSettings.pinSaveError', { defaultValue: 'Failed to save PIN' }))
      return
    }

    toast.success(t('modals.connectionSettings.pinSaved'))
    setEditingPin(false)
  }

  const handleSaveTheme = (newTheme: 'light' | 'dark' | 'auto') => {
    setTheme(newTheme)
    toast.success(t('modals.connectionSettings.themeUpdated'))
  }

  const handleToggleSessionTimeout = async (enabled: boolean) => {
    try {
      await bridge.settings.updateLocal({
        settingType: 'system',
        settings: { session_timeout_enabled: enabled }
      })
      setSessionTimeoutEnabled(enabled)
      toast.success(enabled
        ? t('modals.connectionSettings.sessionTimeoutEnabled', 'Session timeout enabled')
        : t('modals.connectionSettings.sessionTimeoutDisabled', 'Session timeout disabled'))
    } catch (e) {
      console.error('Failed to toggle session timeout:', e)
      toast.error(t('modals.connectionSettings.sessionTimeoutError', 'Failed to update session timeout'))
    }
  }

  const handleToggleGhostMode = async (enabled: boolean) => {
    try {
      await bridge.settings.updateLocal({
        settingType: 'system',
        settings: { ghost_mode_enabled: enabled }
      })
      setGhostModeEnabled(enabled)
      toast.success(
        enabled
          ? t('modals.connectionSettings.ghostModeEnabled', 'Ghost mode enabled')
          : t('modals.connectionSettings.ghostModeDisabled', 'Ghost mode disabled')
      )
    } catch (e) {
      console.error('Failed to toggle ghost mode:', e)
      toast.error(t('modals.connectionSettings.ghostModeError', 'Failed to update ghost mode'))
    }
  }

  const handleSaveSessionTimeout = async () => {
    const minutes = parseInt(sessionTimeoutMinutes, 10)
    if (isNaN(minutes) || minutes < 1 || minutes > 480) {
      toast.error(t('modals.connectionSettings.sessionTimeoutInvalid', 'Timeout must be 1-480 minutes'))
      return
    }
    try {
      await bridge.settings.updateLocal({
        settingType: 'system',
        settings: { session_timeout_minutes: minutes }
      })
      toast.success(t('modals.connectionSettings.sessionTimeoutSaved', { minutes }) || `Session timeout set to ${minutes} minutes`)
    } catch (e) {
      console.error('Failed to save session timeout:', e)
      toast.error(t('modals.connectionSettings.sessionTimeoutError', 'Failed to save session timeout'))
    }
  }

  const handlePasteBoth = async () => {
    try {
      let clipboardText = ''

      // Best effort: try browser clipboard first
      try {
        clipboardText = await navigator.clipboard.readText()
      } catch (clipboardError: any) {
        console.warn('[Paste Both] Browser clipboard failed, will fall back to manual paste:', clipboardError?.message)
      }

      // If browser clipboard failed or returned empty, try Electron clipboard (if available)
      if (!clipboardText && typeof window !== 'undefined') {
        try {
          clipboardText = await bridge.clipboard.readText()
        } catch (bridgeClipboardError: any) {
          console.warn('[Paste Both] Bridge clipboard failed, will fall back to manual paste:', bridgeClipboardError?.message)
        }
      }

      // Absolute fallback: ask user to paste manually into a prompt
      if (!clipboardText) {
        if (typeof window === 'undefined') {
          toast.error(t('modals.connectionSettings.pasteError'))
          return
        }
        const manual = window.prompt(t('modals.connectionSettings.pastePrompt'))
        if (!manual) {
          // User cancelled
          return
        }
        clipboardText = manual
      }

      // Try to parse the clipboard content
      // Format: "Terminal ID: terminal-xxx\nAPI Key: yyy" or just two lines
      const lines = clipboardText.split('\n').map(line => line.trim()).filter(line => line)

      let foundTerminalId = ''
      let foundApiKey = ''

      // Parse each line
      for (const line of lines) {
        if (line.toLowerCase().includes('terminal id:')) {
          foundTerminalId = line.split(':').slice(1).join(':').trim()
        } else if (line.toLowerCase().includes('api key:')) {
          foundApiKey = line.split(':').slice(1).join(':').trim()
        } else if (!foundTerminalId && line.startsWith('terminal-')) {
          // If it looks like a terminal ID (starts with "terminal-")
          foundTerminalId = line
        } else if (!foundApiKey && foundTerminalId && line.length > 10) {
          // If we already have terminal ID and this looks like an API key
          foundApiKey = line
        }
      }

      if (foundTerminalId && foundApiKey) {
        setTerminalId(foundTerminalId)
        setApiKey(foundApiKey)
        toast.success(t('modals.connectionSettings.pastedBoth'))
      } else if (foundTerminalId || foundApiKey) {
        if (foundTerminalId) setTerminalId(foundTerminalId)
        if (foundApiKey) setApiKey(foundApiKey)
        toast.success(t('modals.connectionSettings.pastedPartial'))
      } else {
        toast.error(t('modals.connectionSettings.pasteFormatError'))
      }
    } catch (e: any) {
      toast.error(e?.message || t('modals.connectionSettings.pasteError'))
    }
  }

  const handleTest = async () => {
    if (!terminalId || !apiKey) {
      toast.error(t('modals.connectionSettings.enterToTest'))
      return
    }
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-terminal-id': terminalId,
        'x-pos-api-key': apiKey,
        'Origin': window.location.origin,
      }
      const result = await posApiGet('/pos/orders?limit=1', { headers })
      if (result.success) {
        toast.success(t('modals.connectionSettings.connected'))
      } else {
        const msg = result.error || `HTTP ${result.status || 'error'}`
        toast.error(t('modals.connectionSettings.connectionFailed', { msg }))
        console.warn('[Connection Test] Failed', { status: result.status, error: result.error })
      }
    } catch (e: any) {
      toast.error(e?.message || t('modals.connectionSettings.networkError'))
    }
  }

  // Opens the first factory reset warning dialog
  const handleClearDatabase = () => {
    setShowFactoryResetWarning(true)
  }

  // Called when user confirms the first warning - shows final confirmation
  const handleFactoryResetWarningConfirm = () => {
    setShowFactoryResetWarning(false)
    setShowFactoryResetFinal(true)
  }

  // Called when user confirms final dialog - performs the actual reset
  const handleFactoryResetFinalConfirm = async () => {
    setIsResetting(true)
    try {
      // Call the factory reset handler in main process
      const result = await bridge.settings.factoryReset()

      if (result?.success) {
        // Clear all localStorage
        localStorage.clear()

        setShowFactoryResetFinal(false)
        toast.success(t('settings.database.resetSuccess') || 'Factory reset complete. App will restart...')

        // Restart the app to go back to onboarding
        setTimeout(async () => {
          try {
            await bridge.app.restart()
          } catch (e) {
            console.error('Failed to restart app, falling back to reload:', e)
            window.location.reload()
          }
        }, 1500)
      } else {
        throw new Error(result?.error || 'Unknown error')
      }
    } catch (e) {
      console.error('Failed to perform factory reset', e)
      toast.error(t('settings.database.clearFailed'))
    } finally {
      setIsResetting(false)
    }
  }

  return (
    <>
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.connectionSettings.title')}
      size="md"
      className="!max-w-lg"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      {showPaymentTerminalsSection ? (
        <PaymentTerminalsSection onBack={() => setShowPaymentTerminalsSection(false)} />
      ) : (
      <div className="space-y-4">
        {/* Connection Settings */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showConnectionSettings ? 'bg-white/10 dark:bg-gray-800/20' : ''
          }`}>
          <button
            onClick={() => setShowConnectionSettings(!showConnectionSettings)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Wifi className="w-5 h-5 text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.6)]" />
              <span className="font-medium">{t('modals.connectionSettings.connectionSettings')}</span>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showConnectionSettings ? 'rotate-180' : ''}`} />
          </button>

          {showConnectionSettings && (
            <div className={`px-4 pb-4 space-y-3 border-t liquid-glass-modal-border`}>
              <div className="pt-3">
                <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.terminalId')}</label>
                <input
                  value={terminalId}
                  onChange={e => setTerminalId(e.target.value)}
                  className="liquid-glass-modal-input"
                  placeholder={t('modals.connectionSettings.terminalPlaceholder')}
                />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>
                  {t('modals.connectionSettings.adminDashboardUrl', { defaultValue: 'Admin Dashboard URL' })}
                </label>
                <input
                  value={adminDashboardUrl}
                  onChange={e => setAdminDashboardUrl(e.target.value)}
                  className="liquid-glass-modal-input"
                  placeholder={t('modals.connectionSettings.adminDashboardUrlPlaceholder', { defaultValue: 'https://admin-dashboard.example.com' })}
                />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.apiKey')}</label>
                <div className="relative">
                  <input
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    type={showApiKey ? 'text' : 'password'}
                    className="liquid-glass-modal-input pr-10"
                    placeholder={t('modals.connectionSettings.apiKeyPlaceholder')}
                  />
                  <button
                    type="button"
                    aria-label={showApiKey ? t('common.hide') : t('common.show')}
                    onClick={() => setShowApiKey(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-white/20 dark:hover:bg-gray-700/40"
                  >
                    {showApiKey ? (
                      <EyeOff className="w-4 h-4 text-gray-400" />
                    ) : (
                      <Eye className="w-4 h-4 text-gray-400" />
                    )}
                  </button>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handlePasteBoth}
                  title={t('modals.connectionSettings.pasteBothTooltip')}
                  className={liquidGlassModalButton('secondary', 'md') + ' flex items-center gap-2'}
                >
                  <Clipboard className="w-4 h-4" />
                  {t('modals.connectionSettings.pasteBoth')}
                </button>
                <button onClick={handleTest} className={liquidGlassModalButton('secondary', 'md')}>
                  {t('modals.connectionSettings.test')}
                </button>
                <button onClick={handleSaveConnection} className={liquidGlassModalButton('primary', 'md')}>
                  {t('modals.connectionSettings.save')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* PIN Settings */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showPinSettings ? 'bg-white/10 dark:bg-gray-800/20' : ''
          }`}>
          <button
            onClick={() => setShowPinSettings(!showPinSettings)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Lock className="w-5 h-5 text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.6)]" />
              <div className="text-left">
                <span className="font-medium block">{t('modals.connectionSettings.pinSetup')}</span>
                {pin && !editingPin && <span className={`text-xs liquid-glass-modal-text-muted`}>••••</span>}
              </div>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showPinSettings ? 'rotate-180' : ''}`} />
          </button>

          {showPinSettings && (
            <div className={`px-4 pb-4 space-y-3 border-t liquid-glass-modal-border`}>
              {!editingPin ? (
                <button
                  onClick={() => setEditingPin(true)}
                  className={liquidGlassModalButton('primary', 'md') + ' mt-3'}
                >
                  {t('modals.connectionSettings.changePin')}
                </button>
              ) : (
                <>
                  <div className="pt-3">
                    <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.newPin')}</label>
                    <input
                      value={pin}
                      onChange={e => setPin(e.target.value.replace(/[^0-9]/g, ''))}
                      type="password"
                      inputMode="numeric"
                      maxLength={6}
                      className="liquid-glass-modal-input"
                      placeholder={t('modals.connectionSettings.enterPin')}
                    />
                  </div>
                  <div>
                    <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.confirmPin')}</label>
                    <input
                      value={confirmPin}
                      onChange={e => setConfirmPin(e.target.value.replace(/[^0-9]/g, ''))}
                      type="password"
                      inputMode="numeric"
                      maxLength={6}
                      className="liquid-glass-modal-input"
                      placeholder={t('modals.connectionSettings.confirmPinPlaceholder')}
                    />
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => setEditingPin(false)}
                      className={liquidGlassModalButton('secondary', 'md')}
                    >
                      {t('modals.connectionSettings.cancel')}
                    </button>
                    <button onClick={handleSavePin} className={liquidGlassModalButton('primary', 'md')}>
                      {t('modals.connectionSettings.savePin')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Theme Switcher */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Palette className="w-5 h-5 text-pink-400 drop-shadow-[0_0_8px_rgba(244,114,182,0.6)]" />
              <span className={`font-medium liquid-glass-modal-text`}>{t('modals.connectionSettings.theme')}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleSaveTheme('light')}
                className={`p-2 rounded-lg transition-all ${theme === 'light'
                  ? 'bg-yellow-500/30 border-2 border-yellow-400 shadow-[0_0_12px_rgba(250,204,21,0.5)]'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20'
                  }`}
                title={t('modals.connectionSettings.light')}
              >
                <Sun className={`w-5 h-5 ${theme === 'light' ? 'text-yellow-300' : 'text-gray-400'}`} />
              </button>
              <button
                onClick={() => handleSaveTheme('dark')}
                className={`p-2 rounded-lg transition-all ${theme === 'dark'
                  ? 'bg-indigo-500/30 border-2 border-indigo-400 shadow-[0_0_12px_rgba(129,140,248,0.5)]'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20'
                  }`}
                title={t('modals.connectionSettings.dark')}
              >
                <Moon className={`w-5 h-5 ${theme === 'dark' ? 'text-indigo-300' : 'text-gray-400'}`} />
              </button>
              <button
                onClick={() => handleSaveTheme('auto')}
                className={`p-2 rounded-lg transition-all ${theme === 'auto'
                  ? 'bg-cyan-500/30 border-2 border-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.5)]'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20'
                  }`}
                title={t('modals.connectionSettings.system')}
              >
                <Monitor className={`w-5 h-5 ${theme === 'auto' ? 'text-cyan-300' : 'text-gray-400'}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Language Switcher */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5 text-blue-400 drop-shadow-[0_0_8px_rgba(96,165,250,0.6)]" />
              <span className={`font-medium liquid-glass-modal-text`}>{t('modals.connectionSettings.language')}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setLanguage('en')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm ${currentLanguage === 'en'
                  ? 'bg-blue-500/30 border-2 border-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.5)] text-blue-300'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20 text-gray-400'
                  }`}
                title={t('settings.display.langEnglish')}
              >
                EN
              </button>
              <button
                onClick={() => {
                  setLanguage('el')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm ${currentLanguage === 'el'
                  ? 'bg-blue-500/30 border-2 border-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.5)] text-blue-300'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20 text-gray-400'
                  }`}
                title={t('settings.display.langGreek')}
              >
                EL
              </button>
            </div>
          </div>
        </div>

        {/* Security Settings - Session Timeout */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showSecuritySettings ? 'bg-white/10 dark:bg-gray-800/20' : ''}`}>
          <button
            onClick={() => setShowSecuritySettings(!showSecuritySettings)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Timer className="w-5 h-5 text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
              <div className="text-left">
                <span className="font-medium block">{t('modals.connectionSettings.security', 'Security')}</span>
                <span className={`text-xs liquid-glass-modal-text-muted`}>
                  {sessionTimeoutEnabled
                    ? t('modals.connectionSettings.sessionTimeoutStatus', { minutes: sessionTimeoutMinutes }) || `Auto-logout after ${sessionTimeoutMinutes} min`
                    : t('modals.connectionSettings.sessionTimeoutOff', 'Session timeout disabled')}
                </span>
              </div>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showSecuritySettings ? 'rotate-180' : ''}`} />
          </button>

          {showSecuritySettings && (
            <div className={`px-4 pb-4 space-y-4 border-t liquid-glass-modal-border pt-4`}>
              {/* Session Timeout Toggle */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="text-left min-w-0">
                    <span className={`font-medium block liquid-glass-modal-text`}>{t('modals.connectionSettings.sessionTimeout', 'Session Timeout')}</span>
                    <span className={`text-xs liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.sessionTimeoutHelp', 'Auto-logout after inactivity')}</span>
                  </div>
                </div>
                {/* Proper iOS-style switch */}
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sessionTimeoutEnabled}
                    onChange={(e) => handleToggleSessionTimeout(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-amber-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
                </label>
              </div>

              <div className="flex items-center justify-between gap-3 pt-3 border-t liquid-glass-modal-border">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="text-left min-w-0">
                    <span className={`font-medium block liquid-glass-modal-text`}>
                      {t('modals.connectionSettings.ghostMode', 'Ghost Mode')}
                    </span>
                    <span className={`text-xs liquid-glass-modal-text-muted`}>
                      {ghostModeFeatureEnabled
                        ? t(
                            'modals.connectionSettings.ghostModeHelp',
                            'Manual-item orders are hidden from POS and bypass payment terminals.'
                          )
                        : t(
                            'modals.connectionSettings.ghostModeDisabledByAdmin',
                            'Enable Ghost Mode for this terminal in Admin Dashboard first.'
                          ) + (terminalId?.trim() ? ` (${terminalId.trim()})` : '')}
                    </span>
                  </div>
                </div>
                <label
                  className={`relative inline-flex items-center ${
                    ghostModeFeatureEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={ghostModeEnabled}
                    onChange={(e) => {
                      if (!ghostModeFeatureEnabled) return
                      void handleToggleGhostMode(e.target.checked)
                    }}
                    disabled={!ghostModeFeatureEnabled}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                </label>
              </div>

              {/* Timeout Duration */}
              <div className="flex items-center justify-between gap-3 pt-3 border-t liquid-glass-modal-border">
                <div className="text-left min-w-0">
                  <span className={`font-medium block liquid-glass-modal-text`}>{t('modals.connectionSettings.timeoutDuration', 'Timeout Duration')}</span>
                  <span className={`text-xs liquid-glass-modal-text-muted`}>{t('modals.connectionSettings.timeoutRange', '1-480 minutes')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={sessionTimeoutMinutes}
                    onChange={e => setSessionTimeoutMinutes(e.target.value)}
                    onBlur={handleSaveSessionTimeout}
                    min={1}
                    max={480}
                    disabled={!sessionTimeoutEnabled}
                    className={`w-20 px-3 py-2 rounded-lg border text-center transition-all ${
                      sessionTimeoutEnabled
                        ? 'bg-white/10 border-gray-500 text-white'
                        : 'bg-gray-800/50 border-gray-700 text-gray-500 cursor-not-allowed'
                    }`}
                  />
                  <span className={`text-sm ${sessionTimeoutEnabled ? 'liquid-glass-modal-text-muted' : 'text-gray-600'}`}>
                    {t('common.minutes', 'min')}
                  </span>
                </div>
              </div>

              {/* Quick presets */}
              {sessionTimeoutEnabled && (
                <div className="flex items-center gap-2 pt-2">
                  <span className="text-xs liquid-glass-modal-text-muted mr-2">{t('common.presets', 'Presets')}:</span>
                  {[5, 15, 30, 60].map((mins) => (
                    <button
                      key={mins}
                      onClick={() => {
                        setSessionTimeoutMinutes(String(mins));
                        // Auto-save after a short delay
                        setTimeout(handleSaveSessionTimeout, 100);
                      }}
                      className={`px-3 py-1 text-sm rounded-lg transition-all ${
                        sessionTimeoutMinutes === String(mins)
                          ? 'bg-amber-500/30 border border-amber-400 text-amber-300'
                          : 'bg-white/10 border border-gray-600 text-gray-300 hover:bg-white/20'
                      }`}
                    >
                      {mins}m
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Database Management */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showDatabaseSettings ? 'bg-white/10 dark:bg-gray-800/20' : ''}`}>
          <button
            onClick={() => setShowDatabaseSettings(!showDatabaseSettings)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Database className="w-5 h-5 text-orange-400 drop-shadow-[0_0_8px_rgba(251,146,60,0.6)]" />
              <div className="text-left">
                <span className="font-medium block">{t('settings.database.management', 'Database Management')}</span>
              </div>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showDatabaseSettings ? 'rotate-180' : ''}`} />
          </button>

          {showDatabaseSettings && (
            <div className={`px-4 pb-4 space-y-3 border-t liquid-glass-modal-border pt-4`}>
              <div className="flex flex-col gap-3">
                {/* Clear Sync Queue - Less destructive */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.clearSyncQueueLabel', 'Clear Sync Queue')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.clearSyncQueueHelp', 'Clears stuck sync items without deleting data')}</span>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const result = await bridge.sync.clearAll() as any
                        if (result?.success) {
                          toast.success(t('settings.database.syncQueueCleared', { count: result.cleared }))
                        } else {
                          toast.error(result?.error || t('settings.database.syncQueueClearFailed'))
                        }
                      } catch (e) {
                        console.error('Failed to clear sync queue:', e)
                        toast.error(t('settings.database.syncQueueClearFailed'))
                      }
                    }}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-orange-600/30 border-2 border-orange-500 hover:bg-orange-600/50 text-orange-300 shadow-[0_0_12px_rgba(251,146,60,0.5)]`}
                  >
                    {t('settings.database.clearSyncButton')}
                  </button>
                </div>

                {/* Clear Old Orders - Medium destructive */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t liquid-glass-modal-border">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.clearOldOrdersLabel', 'Clear Old Orders')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.clearOldOrdersHelp', 'Removes orphaned orders from previous days')}</span>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const result = await bridge.sync.clearOldOrders() as any
                        if (result?.success) {
                          toast.success(t('settings.database.oldOrdersCleared', { count: result.cleared }) || `Cleared ${result.cleared} old orders`)
                        } else {
                          toast.error(result?.error || t('settings.database.oldOrdersClearFailed', 'Failed to clear old orders'))
                        }
                      } catch (e) {
                        console.error('Failed to clear old orders:', e)
                        toast.error(t('settings.database.oldOrdersClearFailed', 'Failed to clear old orders'))
                      }
                    }}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-yellow-600/30 border-2 border-yellow-500 hover:bg-yellow-600/50 text-yellow-300 shadow-[0_0_12px_rgba(250,204,21,0.5)]`}
                  >
                    {t('settings.database.clearOldOrdersButton', 'Clear')}
                  </button>
                </div>

                {/* Clear All Orders - Higher destructive */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t liquid-glass-modal-border">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.clearAllOrdersLabel', 'Clear All Orders')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.clearAllOrdersHelp', 'Removes all orders including today\'s')}</span>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const result = await bridge.sync.clearAllOrders() as any
                        if (result?.success) {
                          toast.success(t('settings.database.allOrdersCleared', `Cleared ${result.cleared} orders`))
                        } else {
                          toast.error(result?.error || t('settings.database.allOrdersClearFailed', 'Failed to clear all orders'))
                        }
                      } catch (e) {
                        console.error('Failed to clear all orders:', e)
                        toast.error(t('settings.database.allOrdersClearFailed', 'Failed to clear all orders'))
                      }
                    }}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-orange-600/30 border-2 border-orange-500 hover:bg-orange-600/50 text-orange-300 shadow-[0_0_12px_rgba(251,146,60,0.5)]`}
                  >
                    {t('settings.database.clearAllOrdersButton', 'Clear')}
                  </button>
                </div>

                {/* Sync Deleted Orders - Cleanup orphaned orders */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t liquid-glass-modal-border">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.syncDeletedOrdersLabel', 'Sync Deleted Orders')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.syncDeletedOrdersHelp', 'Removes orders deleted from admin dashboard')}</span>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const result = await bridge.sync.cleanupDeletedOrders() as any
                        if (result?.success) {
                          toast.success(t('settings.database.deletedOrdersSynced', { count: result.deleted, checked: result.checked }) || `Synced: removed ${result.deleted} deleted orders (checked ${result.checked})`)
                        } else {
                          toast.error(result?.error || t('settings.database.syncDeletedOrdersFailed', 'Failed to sync deleted orders'))
                        }
                      } catch (e) {
                        console.error('Failed to sync deleted orders:', e)
                        toast.error(t('settings.database.syncDeletedOrdersFailed', 'Failed to sync deleted orders'))
                      }
                    }}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-blue-600/30 border-2 border-blue-500 hover:bg-blue-600/50 text-blue-300 shadow-[0_0_12px_rgba(96,165,250,0.5)]`}
                  >
                    {t('settings.database.syncButton', 'Sync')}
                  </button>
                </div>

                {/* Clear All Operational Data - Clears orders, shifts, drawers but keeps settings */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t liquid-glass-modal-border">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.clearOperationalLabel', 'Clear All Operational Data')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.clearOperationalHelp', 'Clears orders, shifts, drawers, payments. Keeps settings.')}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowClearOperationalConfirm(true)}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-amber-600/30 border-2 border-amber-500 hover:bg-amber-600/50 text-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.5)]`}
                  >
                    {t('settings.database.clearOperationalButton', 'Clear')}
                  </button>
                </div>

                {/* Factory Reset - Destructive */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t liquid-glass-modal-border">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-left min-w-0">
                      <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.database.label')}</span>
                      <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.database.helpText')}</span>
                    </div>
                  </div>
                  <button
                    onClick={handleClearDatabase}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg transition-all font-medium text-sm whitespace-nowrap bg-red-600/30 border-2 border-red-500 hover:bg-red-600/50 text-red-300 shadow-[0_0_12px_rgba(239,68,68,0.5)]`}
                  >
                    {t('settings.database.clearButton')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Peripherals Settings */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showPeripheralsSettings ? 'bg-white/10 dark:bg-gray-800/20' : ''}`}>
          <button
            onClick={() => setShowPeripheralsSettings(!showPeripheralsSettings)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Cable className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]" />
              <div className="text-left">
                <span className="font-medium block">{t('settings.peripherals.title', 'Peripherals')}</span>
                <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.peripherals.helpText', 'Configure external hardware devices')}</span>
              </div>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showPeripheralsSettings ? 'rotate-180' : ''}`} />
          </button>

          {showPeripheralsSettings && (
            <div className={`px-4 pb-4 space-y-4 border-t liquid-glass-modal-border pt-4`}>

              {/* --- Weighing Scale --- */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.scale.title', 'Weighing Scale')}</span>
                    {hardwareStatus?.scale?.connected && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                        {t('settings.peripherals.scale.connected', 'Connected')}
                      </span>
                    )}
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={scaleEnabled} onChange={(e) => setScaleEnabled(e.target.checked)} className="sr-only peer" />
                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </label>
                </div>
                {scaleEnabled && (
                  <div className="grid grid-cols-2 gap-3 pl-1">
                    <div>
                      <label className={`block text-xs font-medium mb-1 liquid-glass-modal-text-muted`}>{t('settings.peripherals.scale.port', 'COM Port')}</label>
                      <input value={scalePort} onChange={e => setScalePort(e.target.value)} className="liquid-glass-modal-input" placeholder="COM3" />
                    </div>
                    <div>
                      <label className={`block text-xs font-medium mb-1 liquid-glass-modal-text-muted`}>{t('settings.peripherals.scale.baudRate', 'Baud Rate')}</label>
                      <select value={scaleBaudRate} onChange={e => setScaleBaudRate(e.target.value)} className="liquid-glass-modal-input">
                        <option value="2400">2400</option>
                        <option value="4800">4800</option>
                        <option value="9600">9600</option>
                        <option value="19200">19200</option>
                      </select>
                    </div>
                    <div>
                      <label className={`block text-xs font-medium mb-1 liquid-glass-modal-text-muted`}>{t('settings.peripherals.scale.protocol', 'Protocol')}</label>
                      <select value={scaleProtocol} onChange={e => setScaleProtocol(e.target.value)} className="liquid-glass-modal-input">
                        <option value="generic">{t('settings.peripherals.scale.protocolGeneric', 'Generic')}</option>
                        <option value="toledo">{t('settings.peripherals.scale.protocolToledo', 'Toledo / Mettler-Toledo')}</option>
                        <option value="cas">{t('settings.peripherals.scale.protocolCas', 'CAS')}</option>
                      </select>
                    </div>
                    <div className="flex items-end">
                      <button
                        onClick={async () => {
                          try {
                            if (hardwareStatus?.scale?.connected) {
                              await bridge.invoke('scale_disconnect')
                            } else {
                              await bridge.invoke('scale_connect', { port: scalePort, baud_rate: Number(scaleBaudRate), protocol: scaleProtocol })
                            }
                          } catch (e) { console.error('Scale action failed:', e) }
                        }}
                        className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                          hardwareStatus?.scale?.connected
                            ? 'bg-red-500/20 border border-red-500/50 text-red-300 hover:bg-red-500/30'
                            : 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/30'
                        }`}
                      >
                        {hardwareStatus?.scale?.connected
                          ? t('settings.peripherals.scale.disconnect', 'Disconnect')
                          : t('settings.peripherals.scale.connect', 'Connect')}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t liquid-glass-modal-border" />

              {/* --- Customer Display --- */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.display.title', 'Customer Display')}</span>
                    {hardwareStatus?.customerDisplay?.connected && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                        {t('settings.peripherals.scale.connected', 'Connected')}
                      </span>
                    )}
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={displayEnabled} onChange={(e) => setDisplayEnabled(e.target.checked)} className="sr-only peer" />
                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </label>
                </div>
                {displayEnabled && (
                  <div className="grid grid-cols-2 gap-3 pl-1">
                    <div>
                      <label className={`block text-xs font-medium mb-1 liquid-glass-modal-text-muted`}>{t('settings.peripherals.display.connectionType', 'Connection Type')}</label>
                      <select value={displayConnectionType} onChange={e => setDisplayConnectionType(e.target.value)} className="liquid-glass-modal-input">
                        <option value="serial">{t('settings.peripherals.display.serial', 'Serial (COM)')}</option>
                        <option value="network">{t('settings.peripherals.display.network', 'Network (TCP)')}</option>
                      </select>
                    </div>
                    <div>
                      <label className={`block text-xs font-medium mb-1 liquid-glass-modal-text-muted`}>{t('settings.peripherals.display.portOrIp', 'Port / IP Address')}</label>
                      <input value={displayPort} onChange={e => setDisplayPort(e.target.value)} className="liquid-glass-modal-input" placeholder={displayConnectionType === 'network' ? '192.168.1.100' : 'COM4'} />
                    </div>
                    {displayConnectionType === 'serial' && (
                      <div>
                        <label className={`block text-xs font-medium mb-1 liquid-glass-modal-text-muted`}>{t('settings.peripherals.display.baudRate', 'Baud Rate')}</label>
                        <select value={displayBaudRate} onChange={e => setDisplayBaudRate(e.target.value)} className="liquid-glass-modal-input">
                          <option value="2400">2400</option>
                          <option value="4800">4800</option>
                          <option value="9600">9600</option>
                          <option value="19200">19200</option>
                        </select>
                      </div>
                    )}
                    {displayConnectionType === 'network' && (
                      <div>
                        <label className={`block text-xs font-medium mb-1 liquid-glass-modal-text-muted`}>{t('settings.peripherals.display.tcpPort', 'TCP Port')}</label>
                        <input type="number" value={displayTcpPort} onChange={e => setDisplayTcpPort(e.target.value)} className="liquid-glass-modal-input" placeholder="9100" />
                      </div>
                    )}
                    <div className="flex items-end">
                      <button
                        onClick={async () => {
                          try {
                            if (hardwareStatus?.customerDisplay?.connected) {
                              await bridge.invoke('display_disconnect')
                            } else {
                              await bridge.invoke('display_connect', {
                                connection_type: displayConnectionType,
                                port_or_ip: displayPort,
                                port_number: displayConnectionType === 'network' ? Number(displayTcpPort) : null,
                                baud_rate: displayConnectionType === 'serial' ? Number(displayBaudRate) : null,
                              })
                            }
                          } catch (e) { console.error('Display action failed:', e) }
                        }}
                        className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                          hardwareStatus?.customerDisplay?.connected
                            ? 'bg-red-500/20 border border-red-500/50 text-red-300 hover:bg-red-500/30'
                            : 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/30'
                        }`}
                      >
                        {hardwareStatus?.customerDisplay?.connected
                          ? t('settings.peripherals.scale.disconnect', 'Disconnect')
                          : t('settings.peripherals.scale.connect', 'Connect')}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t liquid-glass-modal-border" />

              {/* --- Serial Barcode Scanner --- */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.scanner.title', 'Serial Barcode Scanner')}</span>
                    {hardwareStatus?.serialScanner?.connected && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                        {t('settings.peripherals.scanner.running', 'Running')}
                      </span>
                    )}
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={scannerEnabled} onChange={(e) => setScannerEnabled(e.target.checked)} className="sr-only peer" />
                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </label>
                </div>
                <p className={`text-xs liquid-glass-modal-text-muted -mt-1`}>{t('settings.peripherals.scanner.keyboardNote', 'Keyboard-wedge scanners work automatically — no configuration needed')}</p>
                {scannerEnabled && (
                  <div className="grid grid-cols-2 gap-3 pl-1">
                    <div>
                      <label className={`block text-xs font-medium mb-1 liquid-glass-modal-text-muted`}>{t('settings.peripherals.scanner.port', 'COM Port')}</label>
                      <input value={scannerPort} onChange={e => setScannerPort(e.target.value)} className="liquid-glass-modal-input" placeholder="COM2" />
                    </div>
                    <div>
                      <label className={`block text-xs font-medium mb-1 liquid-glass-modal-text-muted`}>{t('settings.peripherals.scanner.baudRate', 'Baud Rate')}</label>
                      <select value={scannerBaudRate} onChange={e => setScannerBaudRate(e.target.value)} className="liquid-glass-modal-input">
                        <option value="2400">2400</option>
                        <option value="4800">4800</option>
                        <option value="9600">9600</option>
                        <option value="19200">19200</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <button
                        onClick={async () => {
                          try {
                            if (hardwareStatus?.serialScanner?.connected) {
                              await bridge.invoke('scanner_serial_stop')
                            } else {
                              await bridge.invoke('scanner_serial_start', { port: scannerPort, baud_rate: Number(scannerBaudRate) })
                            }
                          } catch (e) { console.error('Scanner action failed:', e) }
                        }}
                        className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                          hardwareStatus?.serialScanner?.connected
                            ? 'bg-red-500/20 border border-red-500/50 text-red-300 hover:bg-red-500/30'
                            : 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/30'
                        }`}
                      >
                        {hardwareStatus?.serialScanner?.connected
                          ? t('settings.peripherals.scanner.stop', 'Stop')
                          : t('settings.peripherals.scanner.start', 'Start')}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t liquid-glass-modal-border" />

              {/* --- Card Reader (MSR) --- */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.cardReader.title', 'Card Reader (MSR)')}</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={cardReaderEnabled} onChange={(e) => setCardReaderEnabled(e.target.checked)} className="sr-only peer" />
                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </label>
                </div>
                <p className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.peripherals.cardReader.plugAndPlay', 'Magnetic stripe readers work via keyboard input — plug and play')}</p>
              </div>

              <div className="border-t liquid-glass-modal-border" />

              {/* --- Loyalty / NFC Reader --- */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.loyaltyReader.title', 'Loyalty / NFC Reader')}</span>
                    {hardwareStatus?.loyaltyReader?.connected && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                        {t('settings.peripherals.scanner.running', 'Running')}
                      </span>
                    )}
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={loyaltyEnabled} onChange={(e) => setLoyaltyEnabled(e.target.checked)} className="sr-only peer" />
                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </label>
                </div>
                <p className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.peripherals.loyaltyReader.tapNote', 'NFC readers work via keyboard input — tap card to detect')}</p>
              </div>

              <div className="border-t liquid-glass-modal-border" />

              {/* --- Cash Register / Fiscal Printer --- */}
              <CashRegisterSection />

              {/* Save Peripherals Button */}
              <div className="pt-2 border-t liquid-glass-modal-border">
                <button
                  onClick={async () => {
                    try {
                      await bridge.settings.updateLocal({
                        settingType: 'hardware',
                        settings: {
                          scale_enabled: scaleEnabled,
                          scale_port: scalePort,
                          scale_baud_rate: Number(scaleBaudRate),
                          scale_protocol: scaleProtocol,
                          customer_display_enabled: displayEnabled,
                          display_connection_type: displayConnectionType,
                          display_port: displayPort,
                          display_baud_rate: Number(displayBaudRate),
                          display_tcp_port: displayConnectionType === 'network' ? Number(displayTcpPort) : null,
                          barcode_scanner_enabled: scannerEnabled,
                          barcode_scanner_port: scannerPort,
                          scanner_baud_rate: Number(scannerBaudRate),
                          card_reader_enabled: cardReaderEnabled,
                          loyalty_card_reader: loyaltyEnabled,
                        }
                      })
                      toast.success(t('settings.peripherals.saved', 'Peripheral settings saved'))
                    } catch (e) {
                      console.error('Failed to save peripheral settings:', e)
                      toast.error(t('settings.peripherals.saveFailed', 'Failed to save peripheral settings'))
                    }
                  }}
                  className={liquidGlassModalButton('primary', 'md')}
                >
                  {t('common.actions.save', 'Save')}
                </button>
              </div>

            </div>
          )}
        </div>

        {/* Printer Settings trigger */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Printer className="w-5 h-5 text-purple-400 drop-shadow-[0_0_8px_rgba(192,132,252,0.6)]" />
              <div className="text-left">
                <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.printer.label')}</span>
                <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.printer.helpText')}</span>
              </div>
            </div>
            <button
              onClick={() => setShowPrinterSettingsModal(true)}
              className={liquidGlassModalButton('primary', 'md')}
            >
              {t('settings.printer.configureButton')}
            </button>
          </div>
        </div>

        {/* Payment Terminals Settings trigger */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CreditCard className="w-5 h-5 text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
              <div className="text-left">
                <span className={`font-medium block liquid-glass-modal-text`}>{t('settings.paymentTerminals.label', 'Payment Terminals')}</span>
                <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.paymentTerminals.helpText', 'Configure ECR payment devices')}</span>
              </div>
            </div>
            <button
              onClick={() => setShowPaymentTerminalsSection(true)}
              className={liquidGlassModalButton('primary', 'md')}
            >
              {t('settings.paymentTerminals.configureButton', 'Configure')}
            </button>
          </div>
        </div>

      </div>
      )}
    </LiquidGlassModal>

    {/* Sub-modals rendered outside LiquidGlassModal for independent viewport positioning */}
    {showPrinterSettingsModal && (
      <PrinterSettingsModal
        isOpen={showPrinterSettingsModal}
        onClose={() => setShowPrinterSettingsModal(false)}
      />
    )}

    {/* Clear Operational Data Confirmation Dialog */}
    <ConfirmDialog
      isOpen={showClearOperationalConfirm}
      onClose={() => setShowClearOperationalConfirm(false)}
      onConfirm={async () => {
        setIsClearingOperational(true)
        try {
          const result = await bridge.database.clearOperationalData()
          if (result?.success) {
            toast.success(t('settings.database.operationalCleared', 'All operational data cleared successfully'))
            setShowClearOperationalConfirm(false)
          } else {
            toast.error(result?.error || t('settings.database.operationalClearFailed', 'Failed to clear operational data'))
          }
        } catch (e) {
          console.error('Failed to clear operational data:', e)
          toast.error(t('settings.database.operationalClearFailed', 'Failed to clear operational data'))
        } finally {
          setIsClearingOperational(false)
        }
      }}
      title={t('settings.database.confirmClearOperationalTitle', 'Clear Operational Data')}
      message={t('settings.database.confirmClearOperationalMessage', 'This action cannot be undone. All operational data will be permanently deleted.')}
      variant="warning"
      confirmText={t('settings.database.clearOperationalButton', 'Clear')}
      cancelText={t('common.actions.cancel', 'Cancel')}
      isLoading={isClearingOperational}
      requireCheckbox={t('settings.database.confirmClearOperationalCheckbox', 'I understand that this will delete all orders, shifts, drawers, payments, and driver earnings')}
      details={
        <ul className="list-disc list-inside space-y-1 text-white/70">
          <li>{t('settings.database.clearItem.orders', 'All orders')}</li>
          <li>{t('settings.database.clearItem.shifts', 'All staff shifts')}</li>
          <li>{t('settings.database.clearItem.drawers', 'All cash drawer sessions')}</li>
          <li>{t('settings.database.clearItem.payments', 'All payments and expenses')}</li>
          <li>{t('settings.database.clearItem.earnings', 'All driver earnings')}</li>
        </ul>
      }
    />

    {/* Factory Reset Warning Dialog (Step 1) */}
    <ConfirmDialog
      isOpen={showFactoryResetWarning}
      onClose={() => setShowFactoryResetWarning(false)}
      onConfirm={handleFactoryResetWarningConfirm}
      title={t('settings.database.factoryResetWarningTitle', 'Factory Reset Warning')}
      message={t('settings.database.factoryResetWarningMessage', 'This will completely restore the POS terminal to factory settings.')}
      variant="warning"
      confirmText={t('common.actions.continue', 'Continue')}
      cancelText={t('common.actions.cancel', 'Cancel')}
      details={
        <ul className="list-disc list-inside space-y-1 text-white/70">
          <li>{t('settings.database.factoryResetItem.orders', 'All local orders will be deleted')}</li>
          <li>{t('settings.database.factoryResetItem.settings', 'All settings will be cleared')}</li>
          <li>{t('settings.database.factoryResetItem.terminal', 'Terminal configuration will be removed')}</li>
          <li>{t('settings.database.factoryResetItem.reconnect', 'You will need to reconnect with connection string')}</li>
        </ul>
      }
    />

    {/* Factory Reset Final Confirmation Dialog (Step 2) */}
    <ConfirmDialog
      isOpen={showFactoryResetFinal}
      onClose={() => setShowFactoryResetFinal(false)}
      onConfirm={handleFactoryResetFinalConfirm}
      title={t('settings.database.factoryResetFinalTitle', 'Final Confirmation')}
      message={t('settings.database.factoryResetFinalMessage', 'This is your last chance to cancel.')}
      variant="error"
      confirmText={t('settings.database.factoryResetConfirmButton', 'Reset')}
      cancelText={t('common.actions.cancel', 'Cancel')}
      isLoading={isResetting}
      requireCheckbox={t('settings.database.factoryResetCheckbox', 'I understand that all data will be permanently deleted and the app will restart')}
      details={
        <div className="text-red-300 font-medium">
          {t('settings.database.factoryResetFinalWarning', 'All data will be permanently deleted and the app will restart.')}
        </div>
      }
    />
    </>
  )
}

export default ConnectionSettingsModal
