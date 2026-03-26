import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { posApiGet } from '../../utils/api-helpers'
import { useTheme } from '../../contexts/theme-context'
import { useI18n } from '../../contexts/i18n-context'
import { Wifi, Lock, Palette, Globe, ChevronDown, Sun, Moon, Monitor, Database, Printer, Eye, EyeOff, Clipboard, Timer, CreditCard, Cable, Settings, Info, Copy, Check } from 'lucide-react'
import { inputBase, liquidGlassModalButton } from '../../styles/designSystem';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import PrinterSettingsModal from './PrinterSettingsModal';
import CashRegisterSection, { type CashRegisterSetupIntent } from '../peripherals/CashRegisterSection';
import CallerIdSection from '../peripherals/CallerIdSection';
import { PaymentTerminalsSection } from '../ecr/PaymentTerminalsSection';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useHardwareManager } from '../../hooks/useHardwareManager';
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import { useFeatures } from '../../hooks/useFeatures';
import { useModules } from '../../contexts/module-context';
import RecoveryPanel from '../recovery/RecoveryPanel';
import PrintQueuePanel from '../printing/PrintQueuePanel';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
  updateTerminalCredentialCache,
} from '../../services/terminal-credentials';
import { getBridge, type DiagnosticsAboutInfo } from '../../../lib';
import {
  decodeConnectionString,
  looksLikeRawApiKey,
  normalizeAdminDashboardUrl,
} from '../../utils/connection-code';
import { getErrorMessage } from '../../utils/privileged-actions';

interface Props {
  isOpen: boolean
  onClose: () => void
  initialSection?: 'recovery' | null
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

const parseNumberSetting = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const parseStringSetting = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && value.trim()) return value
  return fallback
}

const getNestedSetting = (
  source: Record<string, any>,
  category: string,
  key: string
): unknown => {
  const categoryValue = source?.[category]
  if (categoryValue && typeof categoryValue === 'object' && !Array.isArray(categoryValue)) {
    return categoryValue[key]
  }

  return source?.[`${category}.${key}`]
}

const ConnectionSettingsModal: React.FC<Props> = ({ isOpen, onClose, initialSection = null }) => {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { language: currentLanguage, setLanguage } = useI18n()
  const bridge = getBridge()
  const allowManualCredentials = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV)
  const { features, terminalType, ownerTerminalId, posOperatingMode } = useFeatures()
  const { enabledModules } = useModules()
  const [connectionCode, setConnectionCode] = useState('')
  const [terminalId, setTerminalId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [adminDashboardUrl, setAdminDashboardUrl] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [showConnectionSettings, setShowConnectionSettings] = useState(false)
  const [showPinSettings, setShowPinSettings] = useState(false)
  const [editingPin, setEditingPin] = useState(false)
  const [showPrinterSettingsModal, setShowPrinterSettingsModal] = useState(false)
  const [printerSettingsInitialMode, setPrinterSettingsInitialMode] = useState<'quick' | 'expert'>('quick')
  const [printerSettingsAutoStartWizard, setPrinterSettingsAutoStartWizard] = useState(false)
  const [showPaymentTerminalsSection, setShowPaymentTerminalsSection] = useState(false)
  const [cashRegisterSetupIntent, setCashRegisterSetupIntent] = useState<CashRegisterSetupIntent | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [showDatabaseSettings, setShowDatabaseSettings] = useState(false)
  const [showClearOperationalConfirm, setShowClearOperationalConfirm] = useState(false)
  const [isClearingOperational, setIsClearingOperational] = useState(false)
  const [showTerminalPreferences, setShowTerminalPreferences] = useState(false)

  // Factory reset confirmation dialogs
  const [showFactoryResetWarning, setShowFactoryResetWarning] = useState(false)
  const [showFactoryResetFinal, setShowFactoryResetFinal] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  // Session timeout settings
  const [showSecuritySettings, setShowSecuritySettings] = useState(false)
  const [sessionTimeoutEnabled, setSessionTimeoutEnabled] = useState(false)
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState('15')
  const [ghostModeFeatureEnabled, setGhostModeFeatureEnabled] = useState(false)
  const [screenTimeoutMinutes, setScreenTimeoutMinutes] = useState('5')
  const [touchSensitivity, setTouchSensitivity] = useState('medium')
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [receiptAutoPrint, setReceiptAutoPrint] = useState(true)
  const [displayBrightness, setDisplayBrightness] = useState('80')
  const [pinResetRequired, setPinResetRequired] = useState(false)
  const [runtimeTerminalId, setRuntimeTerminalId] = useState('')
  const [runtimeAdminUrl, setRuntimeAdminUrl] = useState('')
  const [runtimeSyncHealth, setRuntimeSyncHealth] = useState('offline')

  const [showPeripheralsSettings, setShowPeripheralsSettings] = useState(false)
  const [showAboutInfo, setShowAboutInfo] = useState(false)
  const [aboutData, setAboutData] = useState<DiagnosticsAboutInfo | null>(null)
  const [aboutCopied, setAboutCopied] = useState(false)
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
  const { runWithPrivilegedConfirmation, confirmationModal } =
    usePrivilegedActionConfirmation()

  const { status: hardwareStatus } = useHardwareManager()

  useEffect(() => {
    if (!isOpen) return
    setConnectionCode('')
    const lsTerminal = getCachedTerminalCredentials().terminalId || ''
    setTerminalId(lsTerminal)
    setApiKey('')
    setAdminDashboardUrl(normalizeAdminDashboardUrl(localStorage.getItem('admin_dashboard_url') || ''))
    setPin('')
    void refreshTerminalCredentialCache().then((resolved) => {
      if (resolved.terminalId) setTerminalId(resolved.terminalId)
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
            await bridge.terminalConfig.syncFromAdmin()
          } catch (nativeSyncError) {
            console.warn('[ConnectionSettings] Native admin terminal sync failed (non-fatal):', nativeSyncError)
          }

          const resolvedCreds = await refreshTerminalCredentialCache()
          const resolvedTerminalId = (resolvedCreds.terminalId || '').trim()
          const storedAdminUrl = normalizeAdminDashboardUrl(
            (
              (await bridge.settings.getAdminUrl()) ||
              localStorage.getItem('admin_dashboard_url') ||
              ''
            ).toString()
          )

          if (resolvedTerminalId && storedAdminUrl) {
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
        const enabled = await bridge.settings.get('system', 'session_timeout_enabled')
        const minutes = await bridge.settings.get('system', 'session_timeout_minutes')
        const enabledNormalized = parseBooleanSetting(enabled)
        const minutesParsed = Number(minutes)
        setGhostModeFeatureEnabled(parseBooleanSetting(ghostFeature))
        setSessionTimeoutEnabled(enabledNormalized)
        setSessionTimeoutMinutes(String(Number.isFinite(minutesParsed) && minutesParsed > 0 ? minutesParsed : 15))
      } catch (e) {
        console.warn('Failed to load security settings:', e)
      }
    }
    const loadLocalTerminalSettings = async () => {
      try {
        const [localSettings, runtimeConfig] = await Promise.all([
          bridge.settings.getLocal(),
          bridge.terminalConfig.getFullConfig().catch(() => null),
        ])

        const settingsMap = (localSettings && typeof localSettings === 'object')
          ? localSettings as Record<string, any>
          : {}
        const runtime = (runtimeConfig && typeof runtimeConfig === 'object')
          ? runtimeConfig as Record<string, any>
          : {}

        setRuntimeTerminalId(parseStringSetting(runtime.terminal_id, parseStringSetting(settingsMap?.terminal?.terminal_id, '')))
        setRuntimeAdminUrl(parseStringSetting(runtime.admin_dashboard_url, parseStringSetting(settingsMap?.terminal?.admin_dashboard_url, '')))
        setRuntimeSyncHealth(parseStringSetting(runtime.sync_health, 'offline'))

        setDisplayBrightness(String(parseNumberSetting(
          getNestedSetting(settingsMap, 'ui', 'display_brightness') ?? getNestedSetting(settingsMap, 'terminal', 'display_brightness'),
          80
        )))
        setScreenTimeoutMinutes(String(parseNumberSetting(
          getNestedSetting(settingsMap, 'ui', 'screen_timeout') ?? getNestedSetting(settingsMap, 'terminal', 'screen_timeout'),
          5
        )))
        setTouchSensitivity(parseStringSetting(
          getNestedSetting(settingsMap, 'ui', 'touch_sensitivity') ?? getNestedSetting(settingsMap, 'terminal', 'touch_sensitivity'),
          'medium'
        ))
        setAudioEnabled(parseBooleanSetting(
          getNestedSetting(settingsMap, 'ui', 'audio_enabled') ?? getNestedSetting(settingsMap, 'terminal', 'audio_enabled')
        ))
        setReceiptAutoPrint(parseBooleanSetting(
          getNestedSetting(settingsMap, 'ui', 'receipt_auto_print') ?? getNestedSetting(settingsMap, 'terminal', 'receipt_auto_print')
        ))
        setPinResetRequired(parseBooleanSetting(
          getNestedSetting(settingsMap, 'terminal', 'pin_reset_required')
        ))

        setScaleEnabled(parseBooleanSetting(
          getNestedSetting(settingsMap, 'scale', 'enabled') ?? getNestedSetting(settingsMap, 'hardware', 'scale_enabled')
        ))
        setScalePort(parseStringSetting(
          getNestedSetting(settingsMap, 'scale', 'port') ?? getNestedSetting(settingsMap, 'hardware', 'scale_port'),
          'COM3'
        ))
        setScaleBaudRate(String(parseNumberSetting(
          getNestedSetting(settingsMap, 'scale', 'baud_rate') ?? getNestedSetting(settingsMap, 'hardware', 'scale_baud_rate'),
          9600
        )))
        setScaleProtocol(parseStringSetting(
          getNestedSetting(settingsMap, 'scale', 'protocol') ?? getNestedSetting(settingsMap, 'hardware', 'scale_protocol'),
          'generic'
        ))

        setDisplayEnabled(parseBooleanSetting(
          getNestedSetting(settingsMap, 'display', 'enabled') ?? getNestedSetting(settingsMap, 'hardware', 'customer_display_enabled')
        ))
        setDisplayConnectionType(parseStringSetting(
          getNestedSetting(settingsMap, 'display', 'connection_type') ?? getNestedSetting(settingsMap, 'hardware', 'display_connection_type'),
          'serial'
        ))
        setDisplayPort(parseStringSetting(
          getNestedSetting(settingsMap, 'display', 'port') ?? getNestedSetting(settingsMap, 'hardware', 'display_port'),
          'COM4'
        ))
        setDisplayBaudRate(String(parseNumberSetting(
          getNestedSetting(settingsMap, 'display', 'baud_rate') ?? getNestedSetting(settingsMap, 'hardware', 'display_baud_rate'),
          9600
        )))
        setDisplayTcpPort(String(parseNumberSetting(
          getNestedSetting(settingsMap, 'display', 'tcp_port') ?? getNestedSetting(settingsMap, 'hardware', 'display_tcp_port'),
          9100
        )))

        setScannerEnabled(parseBooleanSetting(
          getNestedSetting(settingsMap, 'scanner', 'enabled') ?? getNestedSetting(settingsMap, 'hardware', 'barcode_scanner_enabled')
        ))
        setScannerPort(parseStringSetting(
          getNestedSetting(settingsMap, 'scanner', 'port') ?? getNestedSetting(settingsMap, 'hardware', 'barcode_scanner_port'),
          'COM2'
        ))
        setScannerBaudRate(String(parseNumberSetting(
          getNestedSetting(settingsMap, 'scanner', 'baud_rate') ?? getNestedSetting(settingsMap, 'hardware', 'scanner_baud_rate'),
          9600
        )))

        setCardReaderEnabled(parseBooleanSetting(
          getNestedSetting(settingsMap, 'peripherals', 'card_reader_enabled') ?? getNestedSetting(settingsMap, 'hardware', 'card_reader_enabled')
        ))
        setLoyaltyEnabled(parseBooleanSetting(
          getNestedSetting(settingsMap, 'peripherals', 'loyalty_card_reader') ?? getNestedSetting(settingsMap, 'hardware', 'loyalty_card_reader')
        ))
      } catch (error) {
        console.warn('[ConnectionSettings] Failed to load local terminal settings:', error)
      }
    }

    void loadSecuritySettings()
    void loadLocalTerminalSettings()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    if (initialSection === 'recovery') {
      setShowDatabaseSettings(true)
    }
  }, [initialSection, isOpen])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const maybeOpenPrinterQuickSetup = async () => {
      try {
        const result: any = await bridge.printer.getAll()
        const printers = Array.isArray(result)
          ? result
          : Array.isArray(result?.printers)
            ? result.printers
            : []
        const hasReceiptPrinter = printers.some((printer: any) => {
          const enabled = printer?.enabled !== false
          const role = typeof printer?.role === 'string' ? printer.role : 'receipt'
          return enabled && role === 'receipt'
        })
        if (!hasReceiptPrinter && !cancelled) {
          setPrinterSettingsInitialMode('quick')
          setPrinterSettingsAutoStartWizard(true)
          setShowPrinterSettingsModal(true)
        }
      } catch (error) {
        console.warn('[ConnectionSettings] failed to evaluate receipt printer onboarding state', error)
      }
    }
    void maybeOpenPrinterQuickSetup()
    return () => {
      cancelled = true
    }
  }, [bridge.printer, isOpen])

  // Lazy-load about info when the About section is expanded
  useEffect(() => {
    if (!showAboutInfo || aboutData) return
    bridge.diagnostics
      .getAbout()
      .then((data) => setAboutData(data))
      .catch((err: unknown) => console.error('Failed to load about info:', err))
  }, [showAboutInfo, aboutData, bridge.diagnostics])

  const handleCopyAboutInfo = async () => {
    if (!aboutData) return
    const text = [
      `The Small POS v${aboutData.version}`,
      `Build: ${aboutData.buildTimestamp}`,
      `Git SHA: ${aboutData.gitSha}`,
      `Platform: ${aboutData.platform} (${aboutData.arch})`,
      `Rust: ${aboutData.rustVersion}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setAboutCopied(true)
      setTimeout(() => setAboutCopied(false), 2000)
    } catch { /* fallback */ }
  }

  const handleSaveConnection = async () => {
    let nextTerminalId = terminalId.trim()
    let nextApiKey = apiKey.trim()
    let nextAdminDashboardUrl = normalizeAdminDashboardUrl(adminDashboardUrl)
    let nextSupabaseUrl: string | undefined
    let nextSupabaseAnonKey: string | undefined

    const trimmedConnectionCode = connectionCode.trim()
    if (trimmedConnectionCode) {
      const decoded = decodeConnectionString(trimmedConnectionCode)
      if (!decoded) {
        if (looksLikeRawApiKey(trimmedConnectionCode)) {
          toast.error(t('onboarding.rawApiKeyDetected'))
        } else {
          toast.error(t('onboarding.invalidConnectionString'))
        }
        return
      }

      nextTerminalId = decoded.terminalId.trim()
      nextApiKey = decoded.apiKey.trim()
      nextAdminDashboardUrl = normalizeAdminDashboardUrl(decoded.adminUrl)
      nextSupabaseUrl = decoded.supabaseUrl
      nextSupabaseAnonKey = decoded.supabaseAnonKey

      setTerminalId(nextTerminalId)
      setAdminDashboardUrl(nextAdminDashboardUrl)
      if (allowManualCredentials) {
        setApiKey(nextApiKey)
      }
    } else if (!allowManualCredentials) {
      toast.error(t('onboarding.validationError', { defaultValue: 'Please enter the connection string' }))
      return
    }

    if (!nextTerminalId || !nextApiKey) {
      toast.error(t('modals.connectionSettings.enterBoth'))
      return
    }

    const normalizedAdminDashboardUrl = normalizeAdminDashboardUrl(nextAdminDashboardUrl)
    if (!normalizedAdminDashboardUrl) {
      toast.error(t('modals.connectionSettings.enterAdminUrl', { defaultValue: 'Enter a valid Admin Dashboard URL' }))
      return
    }

    // Check if terminal ID or API key changed
    const oldTerminalId = getCachedTerminalCredentials().terminalId
    const oldAdminDashboardUrl = normalizeAdminDashboardUrl(localStorage.getItem('admin_dashboard_url') || '')
    const hasChanged = oldTerminalId !== nextTerminalId
    const hasAdminUrlChanged = oldAdminDashboardUrl !== normalizedAdminDashboardUrl

    try {
      console.log('[ConnectionSettings] Updating terminal credentials...')
      localStorage.removeItem('activeShift')
      localStorage.removeItem('staff')

      await bridge.settings.updateTerminalCredentials({
        terminalId: nextTerminalId,
        apiKey: nextApiKey,
        adminUrl: normalizedAdminDashboardUrl,
        adminDashboardUrl: normalizedAdminDashboardUrl,
        supabaseUrl: nextSupabaseUrl,
        supabaseAnonKey: nextSupabaseAnonKey,
      })
      const syncResult = await bridge.terminalConfig.syncFromAdmin()
      const runtimeConfig = syncResult?.data?.config

      localStorage.setItem('admin_dashboard_url', normalizedAdminDashboardUrl)
      updateTerminalCredentialCache({
        terminalId: runtimeConfig?.terminal_id || nextTerminalId,
        branchId:
          runtimeConfig?.branch_id ||
          (await bridge.terminalConfig.getBranchId().catch(() => '')),
        organizationId:
          runtimeConfig?.organization_id ||
          (await bridge.terminalConfig.getOrganizationId().catch(() => '')),
      })

      toast.success(
        hasChanged || hasAdminUrlChanged
          ? t('modals.connectionSettings.connectionSaved') + ' - Syncing data...'
          : t('modals.connectionSettings.connectionSaved')
      )
    } catch (e: any) {
      console.warn('Failed to update credentials or trigger sync:', e)
      toast.error(e?.message || t('modals.connectionSettings.networkError'))
    }
  }

  const handleManualPolicySync = async () => {
    try {
      const syncResult: any = await bridge.terminalConfig.syncFromAdmin()
      const runtimeConfig = syncResult?.data?.config || syncResult?.config || {}
      setRuntimeTerminalId(parseStringSetting(runtimeConfig?.terminal_id, runtimeTerminalId))
      setRuntimeAdminUrl(parseStringSetting(runtimeConfig?.admin_dashboard_url, runtimeAdminUrl))
      setRuntimeSyncHealth(parseStringSetting(runtimeConfig?.sync_health, runtimeSyncHealth))

      const localSettings = await bridge.settings.getLocal()
      const settingsMap = (localSettings && typeof localSettings === 'object')
        ? localSettings as Record<string, any>
        : {}
      setPinResetRequired(parseBooleanSetting(getNestedSetting(settingsMap, 'terminal', 'pin_reset_required')))

      toast.success(t('settings.connection.policySynced', 'Admin policy synced'))
    } catch (error: any) {
      console.error('[ConnectionSettings] Failed to sync admin policy:', error)
      toast.error(error?.message || t('settings.connection.policySyncFailed', 'Failed to sync admin policy'))
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
    setPinResetRequired(false)
    setEditingPin(false)
  }

  const handleSaveTerminalPreferences = async () => {
    const timeoutMinutes = parseInt(screenTimeoutMinutes, 10)
    const brightnessValue = parseInt(displayBrightness, 10)

    if (Number.isNaN(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) {
      toast.error(t('settings.terminal.invalidTimeout', 'Screen timeout must be between 1 and 120 minutes'))
      return
    }

    if (Number.isNaN(brightnessValue) || brightnessValue < 10 || brightnessValue > 100) {
      toast.error(t('settings.terminal.invalidBrightness', 'Brightness must be between 10 and 100'))
      return
    }

    try {
      await bridge.settings.updateLocal({
        settingType: 'ui',
        settings: {
          display_brightness: brightnessValue,
          screen_timeout: timeoutMinutes,
          touch_sensitivity: touchSensitivity,
          audio_enabled: audioEnabled,
          receipt_auto_print: receiptAutoPrint,
        }
      })
      toast.success(t('settings.terminal.saved', 'Terminal preferences saved'))
    } catch (error) {
      console.error('[ConnectionSettings] Failed to save terminal preferences:', error)
      toast.error(t('settings.terminal.saveFailed', 'Failed to save terminal preferences'))
    }
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
      const trimmedClipboard = clipboardText.trim()
      const decoded = decodeConnectionString(trimmedClipboard)
      if (decoded) {
        setConnectionCode(trimmedClipboard)
        setTerminalId(decoded.terminalId)
        setAdminDashboardUrl(normalizeAdminDashboardUrl(decoded.adminUrl))
        if (allowManualCredentials) {
          setApiKey(decoded.apiKey)
        }
        toast.success(t('onboarding.connectionString'))
        return
      }

      if (!allowManualCredentials) {
        if (looksLikeRawApiKey(trimmedClipboard)) {
          toast.error(t('onboarding.rawApiKeyDetected'))
        } else {
          toast.error(t('onboarding.invalidConnectionString'))
        }
        return
      }

      // DEV-only fallback: "Terminal ID: terminal-xxx\nAPI Key: yyy" or just two lines
      const lines = trimmedClipboard.split('\n').map(line => line.trim()).filter(line => line)
      let foundTerminalId = ''
      let foundApiKey = ''

      for (const line of lines) {
        if (line.toLowerCase().includes('terminal id:')) {
          foundTerminalId = line.split(':').slice(1).join(':').trim()
        } else if (line.toLowerCase().includes('api key:')) {
          foundApiKey = line.split(':').slice(1).join(':').trim()
        } else if (!foundTerminalId && line.startsWith('terminal-')) {
          foundTerminalId = line
        } else if (!foundApiKey && foundTerminalId && line.length > 10) {
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
    if (!allowManualCredentials) {
      toast.error(t('onboarding.connectionStringHelp'))
      return
    }
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
      const result = await runWithPrivilegedConfirmation({
        scope: 'system_control',
        action: () => bridge.settings.factoryReset(),
        title: t('settings.database.factoryResetPinTitle', 'Confirm factory reset'),
        subtitle: t(
          'settings.database.factoryResetPinSubtitle',
          'Enter the admin PIN to continue with the factory reset.'
        ),
      })

      if (result?.success) {
        // Clear all localStorage
        localStorage.clear()

        setShowFactoryResetFinal(false)
        toast.success(t('settings.database.resetSuccess') || 'Factory reset complete. App will restart...')

        // Restart the app to go back to onboarding
        setTimeout(async () => {
          try {
            await runWithPrivilegedConfirmation({
              scope: 'system_control',
              action: () => bridge.app.restart(),
              title: t('settings.database.restartPinTitle', 'Confirm restart'),
              subtitle: t(
                'settings.database.restartPinSubtitle',
                'Enter the admin PIN to restart the POS.'
              ),
            })
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
      toast.error(
        getErrorMessage(e, t('settings.database.clearFailed'))
      )
    } finally {
      setIsResetting(false)
    }
  }

  const enabledFeatureLabels = Object.entries({
    'Order creation': features.orderCreation,
    'Order editing': features.orderModification,
    'Cash payments': features.cashPayments,
    'Card payments': features.cardPayments,
    Discounts: features.discounts,
    Refunds: features.refunds,
    Reports: features.reports,
    Settings: features.settings,
    'Ghost mode': ghostModeFeatureEnabled,
  })
    .filter(([, enabled]) => enabled)
    .map(([label]) => label)

  const enabledModuleNames = enabledModules.map((module) => module.module.name)

  return (
    <>
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.connectionSettings.title')}
      size="md"
      className="!max-w-2xl"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      {showPaymentTerminalsSection ? (
        <PaymentTerminalsSection
          onBack={() => setShowPaymentTerminalsSection(false)}
          onOpenCashRegisterSetup={() => {
            setShowPaymentTerminalsSection(false)
            setShowPeripheralsSettings(true)
            setCashRegisterSetupIntent({
              mode: 'rbs_network',
              token: Date.now(),
            })
          }}
        />
      ) : (
      <div className="space-y-4">
        <div className="rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-emerald-500/10 dark:bg-emerald-500/10 px-4 py-4 transition-all">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Settings className="w-5 h-5 text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                <div>
                  <span className="font-medium block liquid-glass-modal-text">
                    {t('settings.managedByAdmin.title', 'Managed by Admin')}
                  </span>
                  <span className="text-xs liquid-glass-modal-text-muted">
                    {t('settings.managedByAdmin.helpText', 'Admin controls access policy. This terminal controls hardware and local behavior.')}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border liquid-glass-modal-border bg-white/5 px-3 py-2">
                  <div className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted">Terminal unit</div>
                  <div className="mt-1 liquid-glass-modal-text">
                    {terminalType === 'mobile_waiter' ? 'Mobile Terminal' : 'Main Terminal'}
                    {ownerTerminalId ? ` • Owner ${ownerTerminalId}` : ''}
                  </div>
                  <div className="text-xs liquid-glass-modal-text-muted mt-1">
                    {posOperatingMode || 'legacy_branch_shared'}
                  </div>
                </div>
                <div className="rounded-lg border liquid-glass-modal-border bg-white/5 px-3 py-2">
                  <div className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted">Connection</div>
                  <div className="mt-1 liquid-glass-modal-text break-all">{runtimeTerminalId || terminalId || 'Unassigned terminal'}</div>
                  <div className="text-xs liquid-glass-modal-text-muted mt-1 break-all">
                    {runtimeAdminUrl || adminDashboardUrl || 'No admin URL'}
                  </div>
                  <div className="text-xs liquid-glass-modal-text-muted mt-1">
                    Sync: {runtimeSyncHealth}
                  </div>
                </div>
                <div className="rounded-lg border liquid-glass-modal-border bg-white/5 px-3 py-2 md:col-span-2">
                  <div className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted">Enabled features</div>
                  <div className="mt-1 liquid-glass-modal-text">
                    {enabledFeatureLabels.length ? enabledFeatureLabels.join(', ') : 'No remote features enabled'}
                  </div>
                </div>
                <div className="rounded-lg border liquid-glass-modal-border bg-white/5 px-3 py-2 md:col-span-2">
                  <div className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted">Enabled modules</div>
                  <div className="mt-1 liquid-glass-modal-text">
                    {enabledModuleNames.length ? enabledModuleNames.join(', ') : 'Core modules only'}
                  </div>
                  <div className="text-xs liquid-glass-modal-text-muted mt-1">
                    {pinResetRequired
                      ? 'Admin requires a new local PIN on next login.'
                      : 'No remote PIN reset request pending.'}
                  </div>
                </div>
              </div>
            </div>
            <button
              onClick={handleManualPolicySync}
              className={liquidGlassModalButton('secondary', 'md')}
            >
              {t('settings.managedByAdmin.syncNow', 'Sync Policy')}
            </button>
          </div>
        </div>

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
                <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>
                  {t('onboarding.connectionString', { defaultValue: 'Connection Code' })}
                </label>
                <p className="text-xs liquid-glass-modal-text-muted mb-3">
                  {t('onboarding.connectionStringHelp', {
                    defaultValue: 'Paste the connection code from Admin Dashboard (Branches → POS → Regenerate credentials).',
                  })}
                </p>
                <textarea
                  value={connectionCode}
                  onChange={e => setConnectionCode(e.target.value)}
                  className="liquid-glass-modal-input min-h-[90px] font-mono text-xs"
                  placeholder={t('onboarding.connectionStringPlaceholder', { defaultValue: 'Paste connection code here...' })}
                />
              </div>
              {allowManualCredentials && (
                <>
                  <div>
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
                </>
              )}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handlePasteBoth}
                  title={t('modals.connectionSettings.pasteBothTooltip')}
                  className={liquidGlassModalButton('secondary', 'md') + ' flex items-center gap-2'}
                >
                  <Clipboard className="w-4 h-4" />
                  {t('modals.connectionSettings.pasteBoth')}
                </button>
                {allowManualCredentials && (
                  <button onClick={handleTest} className={liquidGlassModalButton('secondary', 'md')}>
                    {t('modals.connectionSettings.test')}
                  </button>
                )}
                <button onClick={handleManualPolicySync} className={liquidGlassModalButton('secondary', 'md')}>
                  {t('settings.connection.syncPolicy', 'Sync Policy')}
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
                <span className="font-medium block">{t('modals.connectionSettings.pinSetup', 'Local PIN')}</span>
                <span className={`text-xs liquid-glass-modal-text-muted`}>
                  {pinResetRequired
                    ? t('settings.security.pinResetRequired', 'Admin requires a new PIN before next login')
                    : pin && !editingPin
                      ? '••••'
                      : t('settings.security.pinHelp', 'Local staff authentication')}
                </span>
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
              <button
                onClick={() => {
                  setLanguage('de')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm ${currentLanguage === 'de'
                  ? 'bg-blue-500/30 border-2 border-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.5)] text-blue-300'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20 text-gray-400'
                  }`}
                title={t('settings.display.langGerman')}
              >
                DE
              </button>
              <button
                onClick={() => {
                  setLanguage('fr')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm ${currentLanguage === 'fr'
                  ? 'bg-blue-500/30 border-2 border-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.5)] text-blue-300'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20 text-gray-400'
                  }`}
                title={t('settings.display.langFrench')}
              >
                FR
              </button>
              <button
                onClick={() => {
                  setLanguage('it')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm ${currentLanguage === 'it'
                  ? 'bg-blue-500/30 border-2 border-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.5)] text-blue-300'
                  : 'bg-white/10 border border-gray-600 hover:bg-white/20 text-gray-400'
                  }`}
                title={t('settings.display.langItalian')}
              >
                IT
              </button>
            </div>
          </div>
        </div>

        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showTerminalPreferences ? 'bg-white/10 dark:bg-gray-800/20' : ''}`}>
          <button
            onClick={() => setShowTerminalPreferences(!showTerminalPreferences)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Monitor className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]" />
              <div className="text-left">
                <span className="font-medium block">{t('settings.terminal.title', 'Terminal')}</span>
                <span className="text-xs liquid-glass-modal-text-muted">
                  {t('settings.terminal.helpText', 'Local UX and operator preferences for this device')}
                </span>
              </div>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showTerminalPreferences ? 'rotate-180' : ''}`} />
          </button>

          {showTerminalPreferences && (
            <div className={`px-4 pb-4 space-y-4 border-t liquid-glass-modal-border pt-4`}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>
                    {t('settings.terminal.screenTimeout', 'Screen timeout (minutes)')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={screenTimeoutMinutes}
                    onChange={e => setScreenTimeoutMinutes(e.target.value)}
                    className="liquid-glass-modal-input"
                  />
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>
                    {t('settings.terminal.touchSensitivity', 'Touch sensitivity')}
                  </label>
                  <select
                    value={touchSensitivity}
                    onChange={e => setTouchSensitivity(e.target.value)}
                    className="liquid-glass-modal-input"
                  >
                    <option value="low">{t('settings.terminal.touchLow', 'Low')}</option>
                    <option value="medium">{t('settings.terminal.touchMedium', 'Medium')}</option>
                    <option value="high">{t('settings.terminal.touchHigh', 'High')}</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className={`block text-xs font-medium mb-2 liquid-glass-modal-text-muted`}>
                    {t('settings.terminal.displayBrightness', 'Display brightness')}
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={10}
                      max={100}
                      step={5}
                      value={displayBrightness}
                      onChange={e => setDisplayBrightness(e.target.value)}
                      className="flex-1"
                    />
                    <div className="w-16 text-right text-sm liquid-glass-modal-text">{displayBrightness}%</div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="flex items-center justify-between rounded-lg border liquid-glass-modal-border bg-white/5 px-3 py-3">
                  <div>
                    <div className="font-medium liquid-glass-modal-text">{t('settings.terminal.audioEnabled', 'Audio enabled')}</div>
                    <div className="text-xs liquid-glass-modal-text-muted">{t('settings.terminal.audioHelp', 'Play UI sounds on this device')}</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={audioEnabled} onChange={(e) => setAudioEnabled(e.target.checked)} className="sr-only peer" />
                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </label>
                </div>
                <div className="flex items-center justify-between rounded-lg border liquid-glass-modal-border bg-white/5 px-3 py-3">
                  <div>
                    <div className="font-medium liquid-glass-modal-text">{t('settings.terminal.receiptAutoPrint', 'Auto-print receipts')}</div>
                    <div className="text-xs liquid-glass-modal-text-muted">{t('settings.terminal.receiptAutoPrintHelp', 'Automatically print after successful checkout')}</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={receiptAutoPrint} onChange={(e) => setReceiptAutoPrint(e.target.checked)} className="sr-only peer" />
                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </label>
                </div>
              </div>

              <div className="pt-2 border-t liquid-glass-modal-border">
                <button
                  onClick={handleSaveTerminalPreferences}
                  className={liquidGlassModalButton('primary', 'md')}
                >
                  {t('settings.terminal.saveButton', 'Save Terminal Preferences')}
                </button>
              </div>
            </div>
          )}
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
                            'Use manual item code X with price 1 to arm ghost mode for the current cart only.'
                          )
                        : t(
                            'modals.connectionSettings.ghostModeDisabledByAdmin',
                            'Enable Ghost Mode for this terminal in Admin Dashboard first.'
                          ) + (terminalId?.trim() ? ` (${terminalId.trim()})` : '')}
                    </span>
                  </div>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                    ghostModeFeatureEnabled
                      ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-200'
                      : 'bg-black/10 text-black/50 dark:bg-white/10 dark:text-white/50'
                  }`}
                >
                  {ghostModeFeatureEnabled
                    ? t('modals.connectionSettings.available', 'Available')
                    : t('modals.connectionSettings.unavailable', 'Unavailable')}
                </span>
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
                <RecoveryPanel />

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

        {/* Hardware Settings */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showPeripheralsSettings ? 'bg-white/10 dark:bg-gray-800/20' : ''}`}>
          <button
            onClick={() => setShowPeripheralsSettings(!showPeripheralsSettings)}
            className={`w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text`}
          >
            <div className="flex items-center gap-3">
              <Cable className="w-5 h-5 text-cyan-400 drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]" />
              <div className="text-left">
                <span className="font-medium block">{t('settings.hardware.title', 'Hardware')}</span>
                <span className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.hardware.helpText', 'Configure local hardware devices for this POS')}</span>
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
                          } catch (e) { console.error('Scale action failed:', e); toast.error(t('settings.peripherals.actionFailed', 'Action failed')) }
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
                          } catch (e) { console.error('Display action failed:', e); toast.error(t('settings.peripherals.actionFailed', 'Action failed')) }
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
                          } catch (e) { console.error('Scanner action failed:', e); toast.error(t('settings.peripherals.actionFailed', 'Action failed')) }
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
              <CashRegisterSection setupIntent={cashRegisterSetupIntent} />

              <div className="border-t liquid-glass-modal-border" />

              {/* --- Caller ID / VoIP --- */}
              <CallerIdSection />

              {/* Save Peripherals Button */}
              <div className="pt-2 border-t liquid-glass-modal-border">
                <button
                  onClick={async () => {
                    try {
                      await Promise.all([
                        bridge.settings.updateLocal({
                          settingType: 'scale',
                          settings: {
                            enabled: scaleEnabled,
                            port: scalePort,
                            baud_rate: Number(scaleBaudRate),
                            protocol: scaleProtocol,
                          }
                        }),
                        bridge.settings.updateLocal({
                          settingType: 'display',
                          settings: {
                            enabled: displayEnabled,
                            connection_type: displayConnectionType,
                            port: displayPort,
                            baud_rate: Number(displayBaudRate),
                            tcp_port: displayConnectionType === 'network' ? Number(displayTcpPort) : null,
                          }
                        }),
                        bridge.settings.updateLocal({
                          settingType: 'scanner',
                          settings: {
                            enabled: scannerEnabled,
                            port: scannerPort,
                            baud_rate: Number(scannerBaudRate),
                          }
                        }),
                        bridge.settings.updateLocal({
                          settingType: 'peripherals',
                          settings: {
                            card_reader_enabled: cardReaderEnabled,
                            loyalty_card_reader: loyaltyEnabled,
                          }
                        }),
                      ])
                      toast.success(t('settings.hardware.saved', 'Hardware settings saved'))
                    } catch (e) {
                      console.error('Failed to save hardware settings:', e)
                      toast.error(t('settings.hardware.saveFailed', 'Failed to save hardware settings'))
                    }
                  }}
                  className={liquidGlassModalButton('primary', 'md')}
                >
                  {t('settings.hardware.saveButton', 'Save Hardware')}
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
              onClick={() => {
                setPrinterSettingsInitialMode('quick')
                setPrinterSettingsAutoStartWizard(false)
                setShowPrinterSettingsModal(true)
              }}
              className={liquidGlassModalButton('primary', 'md')}
            >
              {t('settings.printer.configureButton')}
            </button>
          </div>
        </div>

        <PrintQueuePanel />

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

        {/* About Section */}
        <div className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${showAboutInfo ? 'bg-white/10 dark:bg-gray-800/20' : ''}`}>
          <button
            onClick={() => setShowAboutInfo(!showAboutInfo)}
            className="w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text"
          >
            <div className="flex items-center gap-3">
              <Info className="w-5 h-5 text-blue-400 drop-shadow-[0_0_8px_rgba(59,130,246,0.6)]" />
              <div className="text-left">
                <span className="font-medium block">{t('modals.connectionSettings.about', 'About')}</span>
                <span className="text-xs liquid-glass-modal-text-muted">
                  {aboutData ? `v${aboutData.version}` : t('modals.connectionSettings.aboutSubtitle', 'Version info')}
                </span>
              </div>
            </div>
            <ChevronDown className={`w-5 h-5 transition-transform ${showAboutInfo ? 'rotate-180' : ''}`} />
          </button>

          {showAboutInfo && (
            <div className="px-4 pb-4 space-y-1 border-t liquid-glass-modal-border pt-4">
              {aboutData ? (
                <>
                  {[
                    { label: t('settings.about.version', 'Version'), value: `v${aboutData.version}` },
                    { label: t('settings.about.buildDate', 'Build Date'), value: aboutData.buildTimestamp },
                    { label: t('settings.about.gitSha', 'Git SHA'), value: aboutData.gitSha },
                    { label: t('settings.about.platform', 'Platform'), value: `${aboutData.platform} (${aboutData.arch})` },
                    { label: t('settings.about.rust', 'Rust'), value: aboutData.rustVersion },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between items-center py-2 border-b border-white/5 last:border-b-0">
                      <span className="text-sm liquid-glass-modal-text-muted">{label}</span>
                      <span className="text-sm font-mono liquid-glass-modal-text">{value}</span>
                    </div>
                  ))}
                  <div className="pt-3 flex justify-center">
                    <button
                      onClick={handleCopyAboutInfo}
                      className={liquidGlassModalButton('secondary', 'md')}
                    >
                      <span className="inline-flex items-center gap-2">
                        {aboutCopied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                        {aboutCopied ? t('settings.about.copied', 'Copied!') : t('settings.about.copyInfo', 'Copy Info')}
                      </span>
                    </button>
                  </div>
                </>
              ) : (
                <div className="py-4 text-center">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500 mx-auto" />
                </div>
              )}
            </div>
          )}
        </div>

    </LiquidGlassModal>

    {/* Sub-modals rendered outside LiquidGlassModal for independent viewport positioning */}
    {showPrinterSettingsModal && (
      <PrinterSettingsModal
        isOpen={showPrinterSettingsModal}
        initialMode={printerSettingsInitialMode}
        autoStartWizard={printerSettingsAutoStartWizard}
        onClose={() => {
          setShowPrinterSettingsModal(false)
          setPrinterSettingsAutoStartWizard(false)
        }}
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
      message={t('settings.database.confirmClearOperationalMessage', 'This action cannot be undone. A local recovery snapshot will be created first, then all operational data will be permanently deleted.')}
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
      message={t('settings.database.factoryResetWarningMessage', 'This will create a local recovery snapshot first and then restore the POS terminal to factory settings.')}
      variant="warning"
      confirmText={t('common.actions.continue', 'Continue')}
      cancelText={t('common.actions.cancel', 'Cancel')}
      details={
        <ul className="list-disc list-inside space-y-1 text-white/70">
          <li>{t('settings.database.factoryResetItem.orders', 'A local recovery snapshot will be created before data is cleared')}</li>
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
      message={t('settings.database.factoryResetFinalMessage', 'This is your last chance to cancel before the POS creates a recovery snapshot and resets the terminal.')}
      variant="error"
      confirmText={t('settings.database.factoryResetConfirmButton', 'Reset')}
      cancelText={t('common.actions.cancel', 'Cancel')}
      isLoading={isResetting}
      requireCheckbox={t('settings.database.factoryResetCheckbox', 'I understand that a local recovery snapshot will be created, all data will be cleared, and the app will restart')}
      details={
        <div className="text-red-300 font-medium">
          {t('settings.database.factoryResetFinalWarning', 'The POS will create a local recovery snapshot, clear terminal data, and restart.')}
        </div>
      }
    />
    {confirmationModal}
    </>
  )
}

export default ConnectionSettingsModal
