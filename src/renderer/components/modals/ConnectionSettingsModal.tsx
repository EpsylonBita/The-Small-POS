import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { posApiGet } from '../../utils/api-helpers'
import { resolveNavigationLabel } from '../../utils/i18nLabels'
import { useTheme } from '../../contexts/theme-context'
import { useI18n } from '../../contexts/i18n-context'
import { Wifi, Lock, Palette, Globe, Sun, Moon, Monitor, Database, Printer, Eye, EyeOff, Clipboard, Timer, CreditCard, Cable, Settings, Info, Copy, Check, Wrench, AlertTriangle, ChevronDown, RefreshCw } from 'lucide-react'
import { inputBase, liquidGlassModalButton } from '../../styles/designSystem';
import { LiquidGlassModal, POSGlassSwitch } from '../ui/pos-glass-components';
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
import {
  getResetStartingMessage,
  startResetAction,
} from '../../utils/reset-actions';

// Semantic form-action buttons (round 158): solid-green Save, soft-red Cancel — sized to
// match liquidGlassModalButton('*','md'). Tap/focus feedback only, no hover. Soft red (not
// solid) so Cancel is not confused with a destructive Delete.
const SAVE_BTN_MD =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-green-500 bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-green-600/30 transition-transform duration-150 active:scale-[0.98] active:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed';
const CANCEL_BTN_MD =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-700 dark:text-red-300 transition-transform duration-150 active:scale-[0.98] active:bg-red-500/20 disabled:opacity-50';
// Round 325: Data/Database section buttons share one touch geometry so safe-repair and danger actions line
// up consistently (44px+, centered icon/text, tap feedback only — no hover). They differ ONLY in semantic
// color: safe repair is calm green ("keeps your data"), danger is red and lives behind a collapsed
// disclosure so it is never openly mixed with normal maintenance.
const DB_ACTION_GEOMETRY =
  'inline-flex min-h-[44px] items-center justify-center flex-shrink-0 px-4 py-2 rounded-xl transition-transform duration-150 active:scale-[0.98] font-medium text-sm whitespace-nowrap';
const DB_REPAIR_BTN_MD = `${DB_ACTION_GEOMETRY} border-2 border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 active:bg-emerald-500/25`;
const DB_DANGER_BTN_MD = `${DB_ACTION_GEOMETRY} border-2 border-red-500 bg-red-600/30 text-red-300 active:bg-red-600/50`;

interface Props {
  isOpen: boolean
  onClose: () => void
  initialSection?: 'recovery' | null
  onCheckForUpdates?: () => void
}

type SettingsSectionId =
  | 'admin'
  | 'connection'
  | 'terminal'
  | 'security'
  | 'database'
  | 'hardware'
  | 'printing'
  | 'payments'
  | 'about'

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

const ConnectionSettingsModal: React.FC<Props> = ({ isOpen, onClose, initialSection = null, onCheckForUpdates }) => {
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
  const [editingPin, setEditingPin] = useState(false)
  const [showPrinterSettingsModal, setShowPrinterSettingsModal] = useState(false)
  const [printerSettingsInitialMode, setPrinterSettingsInitialMode] = useState<'quick' | 'expert'>('quick')
  const [printerSettingsAutoStartWizard, setPrinterSettingsAutoStartWizard] = useState(false)
  const [showPaymentTerminalsSection, setShowPaymentTerminalsSection] = useState(false)
  const [cashRegisterSetupIntent, setCashRegisterSetupIntent] = useState<CashRegisterSetupIntent | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [showClearOperationalConfirm, setShowClearOperationalConfirm] = useState(false)
  const [isClearingOperational, setIsClearingOperational] = useState(false)

  // Factory reset confirmation dialogs
  const [showFactoryResetWarning, setShowFactoryResetWarning] = useState(false)
  const [showFactoryResetFinal, setShowFactoryResetFinal] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  // Session timeout settings
  const [sessionTimeoutEnabled, setSessionTimeoutEnabled] = useState(false)
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState('15')
  const [ghostModeFeatureEnabled, setGhostModeFeatureEnabled] = useState(false)
  const [screenTimeoutMinutes, setScreenTimeoutMinutes] = useState('5')
  const [touchSensitivity, setTouchSensitivity] = useState('medium')
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [receiptAutoPrint, setReceiptAutoPrint] = useState(true)
  const [receiptPrintPromptEnabled, setReceiptPrintPromptEnabled] = useState(false)
  const [displayBrightness, setDisplayBrightness] = useState('80')
  const [pinResetRequired, setPinResetRequired] = useState(false)
  const [runtimeTerminalId, setRuntimeTerminalId] = useState('')
  const [runtimeAdminUrl, setRuntimeAdminUrl] = useState('')
  const [runtimeSyncHealth, setRuntimeSyncHealth] = useState('offline')
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId>('admin')
  // Right detail pane: reset its scroll to the top whenever the active section
  // changes so a new section always starts at its header, instead of inheriting
  // the previous section's scroll offset. useLayoutEffect runs before paint so
  // there is no visible flash of the old scroll position.
  const detailScrollRef = useRef<HTMLDivElement>(null)

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
        setReceiptPrintPromptEnabled(parseBooleanSetting(
          getNestedSetting(settingsMap, 'receipt', 'ask_before_print') ??
          getNestedSetting(settingsMap, 'ui', 'receipt_ask_before_print') ??
          getNestedSetting(settingsMap, 'terminal', 'receipt_ask_before_print')
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
      setActiveSettingsSection('database')
    }
  }, [initialSection, isOpen])

  // Whenever the shown section changes (left-rail openSection, the recovery deep
  // link above, or a programmatic jump into hardware), scroll the right detail
  // pane back to the top so its header/top controls are visible.
  useLayoutEffect(() => {
    detailScrollRef.current?.scrollTo({ top: 0 })
  }, [activeSettingsSection, isOpen])

  // NOTE: Opening Settings must NOT auto-open the printer wizard. Printer setup
  // is reached deliberately from the Printer section's "Configure Printer"
  // button below (quick mode, autoStartWizard=false). A prior effect here
  // auto-launched PrinterSettingsModal on open when no receipt printer existed,
  // which made Settings "get lost" in a submodal; it was removed.

  // Lazy-load about info when the Info section becomes active
  useEffect(() => {
    if (activeSettingsSection !== 'about' || aboutData) return
    bridge.diagnostics
      .getAbout()
      .then((data) => setAboutData(data))
      .catch((err: unknown) => console.error('Failed to load about info:', err))
  }, [activeSettingsSection, aboutData, bridge.diagnostics])

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

  // Navigation: the left rail selects which section is shown. Each section now
  // renders its content directly (no inner accordion), so selecting is all we do.
  const openSection = (section: SettingsSectionId) => {
    setActiveSettingsSection(section)
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
      toast.error(t('settings.deviceSetup.enterDashboardAddress', { defaultValue: 'Enter a valid dashboard address' }))
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
        apiKey: nextApiKey,
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

      toast.success(t('settings.deviceSetup.synced', 'Settings synced'))
    } catch (error: any) {
      console.error('[ConnectionSettings] Failed to sync settings:', error)
      toast.error(error?.message || t('settings.deviceSetup.syncFailed', 'Could not sync settings'))
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

  const handleReceiptPrintPromptToggle = async (enabled: boolean) => {
    const previous = receiptPrintPromptEnabled
    setReceiptPrintPromptEnabled(enabled)
    try {
      await bridge.settings.updateLocal({
        settingType: 'receipt',
        settings: {
          ask_before_print: enabled,
        }
      })
      toast.success(t('settings.printer.receiptPromptSaved', 'Receipt print prompt setting saved'))
    } catch (error) {
      setReceiptPrintPromptEnabled(previous)
      console.error('[ConnectionSettings] Failed to save receipt print prompt setting:', error)
      toast.error(t('settings.printer.receiptPromptSaveFailed', 'Failed to save receipt print prompt setting'))
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

      // If browser clipboard failed or returned empty, try native clipboard via bridge (if available)
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
    let resetStarted = false
    try {
      const result = await runWithPrivilegedConfirmation({
        scope: 'system_control',
        action: () => startResetAction(() => bridge.settings.factoryReset(), t),
        title: t('settings.database.factoryResetPinTitle', 'Confirm factory reset'),
        subtitle: t(
          'settings.database.factoryResetPinSubtitle',
          'Enter the admin PIN to continue with the factory reset.'
        ),
      })

      if (result?.success) {
        resetStarted = true
        // Clear all localStorage
        localStorage.clear()

        setShowFactoryResetFinal(false)
        toast.success(getResetStartingMessage(t))
      } else {
        throw new Error(result?.error || 'Unknown error')
      }
    } catch (e) {
      console.error('Failed to perform factory reset', e)
      toast.error(
        getErrorMessage(e, t('settings.database.clearFailed'))
      )
    } finally {
      if (!resetStarted) {
        setIsResetting(false)
      }
    }
  }

  // Overview chip cap: render the first N localized labels as soft chips, then a calm "+N more"
  // summary chip. No data is dropped from the model -- enabledFeatureLabels / enabledModuleNames keep
  // every entry; this only condenses the on-screen display so staff can scan it (round 222).
  const OVERVIEW_CHIP_LIMIT = 8

  const enabledFeatureLabels = Object.entries({
    [t('settings.features.orderCreation', 'Order creation')]: features.orderCreation,
    [t('settings.features.orderModification', 'Order editing')]: features.orderModification,
    [t('settings.features.cashPayments', 'Cash payments')]: features.cashPayments,
    [t('settings.features.cardPayments', 'Card payments')]: features.cardPayments,
    [t('settings.features.discounts', 'Discounts')]: features.discounts,
    [t('settings.features.refunds', 'Refunds')]: features.refunds,
    [t('settings.features.reports', 'Reports')]: features.reports,
    [t('settings.features.settings', 'Settings')]: features.settings,
    [t('settings.features.ghostMode', 'Ghost mode')]: ghostModeFeatureEnabled,
  })
    .filter(([, enabled]) => enabled)
    .map(([label]) => label)

  const enabledModuleNames = enabledModules.map((module) =>
    resolveNavigationLabel(t, module.module.id, module.module.name),
  )
  const resolvedTerminalTypeLabel =
    terminalType === 'mobile_waiter'
      ? t('settings.terminal.type.mobile_waiter', 'Mobile POS')
      : t('settings.terminal.type.main', 'Main Terminal')
  const managedTerminalSummary = [
    resolvedTerminalTypeLabel,
    ownerTerminalId
      ? t('settings.managedByAdmin.ownerLabel', {
          owner: ownerTerminalId,
          defaultValue: 'Owner {{owner}}',
        })
      : null,
  ]
    .filter(Boolean)
    .join(' - ')
  const syncHealthLabel = t(`settings.managedByAdmin.syncHealth.${runtimeSyncHealth}`, {
    defaultValue: runtimeSyncHealth,
  })
  // Derived sync-health boolean from the runtime value (not a CSS class string): healthy => the
  // existing "set up" status copy + a green dot; otherwise (offline / stale / failed / degraded /
  // disconnected / not_connected / unknown / ...) => a plain warning title/help + a red dot.
  // Visual-only -- this never triggers a sync. The runtime value is normalized (trimmed + lowercased)
  // and matched EXACTLY against the healthy set -- never via substring .includes(), which would wrongly
  // mark "disconnected" / "not connected" as healthy (both contain the substring "connected").
  const HEALTHY_SYNC_STATES = new Set(['healthy', 'online', 'ok', 'synced', 'connected', 'good', 'live'])
  const isSyncHealthy = HEALTHY_SYNC_STATES.has((runtimeSyncHealth || '').trim().toLowerCase())
  const syncToneClass = isSyncHealthy ? 'bg-green-500' : 'bg-red-500'
  // Plain-language title + one-line description for each area. Reused by the
  // right-column row list and by the detail header. 'admin' is surfaced as the
  // left "This register" card rather than a row.
  const sectionMeta: Record<SettingsSectionId, { label: string; detail: string }> = {
    admin: {
      label: t('settings.settingsHub.status.register', 'This register'),
      detail: t('settings.deviceSetup.title', 'Device setup'),
    },
    connection: {
      label: t('settings.settingsHub.sections.connection.label', 'Connection'),
      detail: t('settings.settingsHub.sections.connection.detail', 'Link this POS'),
    },
    terminal: {
      label: t('settings.settingsHub.sections.terminal.label', 'Screen & Sound'),
      detail: t('settings.settingsHub.sections.terminal.detail', 'Display, sound and language'),
    },
    security: {
      label: t('settings.settingsHub.sections.security.label', 'PIN & Lock'),
      detail: t('settings.settingsHub.sections.security.detail', 'Staff PIN and auto lock'),
    },
    database: {
      label: t('settings.settingsHub.sections.database.label', 'Data'),
      detail: t('settings.settingsHub.sections.database.detail', 'Sync and local data'),
    },
    hardware: {
      label: t('settings.settingsHub.sections.hardware.label', 'Devices'),
      detail: t('settings.settingsHub.sections.hardware.detail', 'Scale, scanner and hardware'),
    },
    printing: {
      label: t('settings.settingsHub.sections.printing.label', 'Printer'),
      detail: t('settings.settingsHub.sections.printing.detail', 'Receipt setup'),
    },
    payments: {
      label: t('settings.settingsHub.sections.payments.label', 'Card Machines'),
      detail: t('settings.settingsHub.sections.payments.detail', 'Card payment devices'),
    },
    about: {
      label: t('settings.settingsHub.sections.about.label', 'Info'),
      detail: t('settings.settingsHub.sections.about.detail', 'App version'),
    },
  }

  // Left-rail navigation. One entry per settings area, in the order an operator
  // is most likely to reach for them. The icon chip is solid yellow with black
  // strokes; the active row is highlighted in the render below.
  const settingsNav: Array<{ id: SettingsSectionId; icon: React.ReactNode }> = [
    { id: 'admin', icon: <Settings className="h-5 w-5 text-black" /> },
    { id: 'connection', icon: <Wifi className="h-5 w-5 text-black" /> },
    { id: 'printing', icon: <Printer className="h-5 w-5 text-black" /> },
    { id: 'payments', icon: <CreditCard className="h-5 w-5 text-black" /> },
    { id: 'terminal', icon: <Monitor className="h-5 w-5 text-black" /> },
    { id: 'security', icon: <Lock className="h-5 w-5 text-black" /> },
    { id: 'hardware', icon: <Cable className="h-5 w-5 text-black" /> },
    { id: 'database', icon: <Database className="h-5 w-5 text-black" /> },
    { id: 'about', icon: <Info className="h-5 w-5 text-black" /> },
  ]

  // Grouped left-rail navigation: three calm groups (daily / device / system) instead
  // of nine equal-weight rows, to lower cognitive load. Labels, details, and icons are
  // unchanged (sectionMeta + settingsNav); only the grouping and the small uppercase
  // group headers are new. Group strings come from settings.settingsHub.groups.*.
  const settingsNavGroups: Array<{ id: 'daily' | 'device' | 'system'; items: SettingsSectionId[] }> = [
    { id: 'daily', items: ['admin', 'connection'] },
    { id: 'device', items: ['printing', 'payments', 'hardware', 'terminal'] },
    { id: 'system', items: ['security', 'database', 'about'] },
  ]

  // Calm, non-clickable header for a detail section: a yellow icon chip beside a
  // plain title (and optional one-line help). The section content renders directly
  // beneath it — no accordion toggle, nothing hidden behind a chevron.
  const sectionHeader = (icon: React.ReactNode, title: string, help?: string) => (
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-yellow-400 text-black ring-1 ring-yellow-500/55 shadow-[0_8px_20px_rgba(250,204,21,0.22)]">
        {icon}
      </span>
      <div className="min-w-0">
        <span className="block font-semibold liquid-glass-modal-text">{title}</span>
        {help ? <span className="block text-xs liquid-glass-modal-text-muted">{help}</span> : null}
      </div>
    </div>
  )

  return (
    <>
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel={t('modals.connectionSettings.title')}
      header={
        <div className="liquid-glass-modal-header">
          <div className="min-w-0">
            <h2 className="liquid-glass-modal-title">{t('modals.connectionSettings.title')}</h2>
            <p className="mt-0.5 text-sm liquid-glass-modal-text-muted">
              {t('settings.settingsHub.subtitle', 'Set up and manage this register')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="liquid-glass-modal-close"
            aria-label={t('common.actions.close', 'Close')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      }
      size="full"
      className="!max-w-[min(1180px,96vw)] !max-h-[min(900px,94vh)]"
      contentClassName="!overflow-hidden !p-4 sm:!p-5"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      {showPaymentTerminalsSection ? (
        <PaymentTerminalsSection
          onBack={() => setShowPaymentTerminalsSection(false)}
          onOpenCashRegisterSetup={() => {
            setShowPaymentTerminalsSection(false)
            setActiveSettingsSection('hardware')
            setCashRegisterSetupIntent({
              mode: 'rbs_network',
              token: Date.now(),
            })
          }}
        />
      ) : (
      <div
        data-settings-hub
        className="settings-hub flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          {/* Left column — the settings navigation list. One row per area; the
              active row carries the single yellow accent. */}
          <nav
            aria-label={t('modals.connectionSettings.title')}
            className="min-h-0 space-y-3 overflow-y-auto overflow-x-hidden pr-0 scrollbar-hide lg:pr-1"
          >
            {settingsNavGroups.map((group) => (
              <div key={group.id} className="space-y-1">
                <div className="px-2 pb-1 text-[11px] font-semibold liquid-glass-modal-text-muted">
                  {t(`settings.settingsHub.groups.${group.id}`, group.id)}
                </div>
                {group.items.map((id) => {
                  const isActive = activeSettingsSection === id
                  const navItem = settingsNav.find((entry) => entry.id === id)
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => openSection(id)}
                      aria-current={isActive ? 'page' : undefined}
                      className={
                        'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150 ' +
                        (isActive
                          ? 'border-yellow-400/40 bg-yellow-400/15 liquid-glass-modal-text'
                          : 'liquid-glass-modal-border bg-white/5 liquid-glass-modal-text active:bg-white/10 dark:bg-black/10 dark:active:bg-white/5')
                      }
                    >
                      <span
                        className={
                          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-yellow-400 text-black ring-1 ring-yellow-500/55 shadow-[0_8px_20px_rgba(250,204,21,0.22)]'
                        }
                      >
                        {navItem?.icon}
                      </span>
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-semibold leading-tight">
                          {sectionMeta[id].label}
                        </span>
                        <span className="block break-words text-xs leading-snug liquid-glass-modal-text-muted">
                          {sectionMeta[id].detail}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>

          {/* Right column — the active section body. */}
          <div ref={detailScrollRef} className="min-h-0 space-y-3 overflow-y-auto overflow-x-hidden pr-0 scrollbar-hide lg:pr-1">
        {activeSettingsSection === 'admin' && (
        <div
          id="settings-section-admin"
          data-settings-register-overview
          className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 py-4 space-y-4 transition-all"
        >
          {sectionHeader(
            <Settings className="h-5 w-5 text-black" />,
            t('settings.deviceSetup.title', 'Device setup'),
            t('settings.deviceSetup.help', 'Link this register and see what it can do.'),
          )}

          {/* 1. Plain-language status card with the sync-health tone dot AND the primary Sync
              action. The button lives here (not at the bottom) so the main action is visible in the
              first viewport at 1280x800 without scrolling. */}
          <div
            data-register-status-card
            className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-4 py-3.5 dark:bg-black/10"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border liquid-glass-modal-border bg-white/5 dark:bg-black/10">
                  <span className={`h-2.5 w-2.5 rounded-full ${syncToneClass}`} />
                </span>
                <div className="min-w-0">
                  <div className="font-semibold liquid-glass-modal-text">
                    {isSyncHealthy
                      ? t('settings.deviceSetup.overview.statusTitle', 'This register is set up')
                      : t('settings.deviceSetup.overview.statusTitleWarning', 'Sync needs attention')}
                  </div>
                  <div className="text-xs liquid-glass-modal-text-muted">
                    {isSyncHealthy
                      ? t('settings.deviceSetup.overview.statusHelp', 'Everything this register can do is shown below in plain words.')
                      : t('settings.deviceSetup.overview.statusHelpWarning', 'Run sync to refresh this register before changing devices or payment settings.')}
                  </div>
                  <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs liquid-glass-modal-text-muted">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${syncToneClass}`} />
                    {t('settings.deviceSetup.syncStatus', 'Sync')}: {syncHealthLabel}
                  </div>
                </div>
              </div>
              <button
                data-register-sync-action
                onClick={handleManualPolicySync}
                className={liquidGlassModalButton('primary', 'sm') + ' inline-flex shrink-0 items-center justify-center gap-2'}
              >
                <Wifi className="h-4 w-4 shrink-0" />
                {t('settings.deviceSetup.syncButton', 'Sync settings')}
              </button>
            </div>
          </div>

          {/* 2. Large readable summary tiles: register type, sync state, PIN status. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div
              data-register-summary-tile
              className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-3.5 py-3 dark:bg-black/10"
            >
              <div className="flex items-center gap-2">
                <Monitor className="h-4 w-4 shrink-0 liquid-glass-modal-text-muted" />
                <div className="text-xs font-semibold liquid-glass-modal-text-muted">
                  {t('settings.deviceSetup.overview.registerType', 'Register type')}
                </div>
              </div>
              <div className="mt-1.5 text-base font-semibold liquid-glass-modal-text">{managedTerminalSummary}</div>
            </div>

            <div
              data-register-summary-tile
              className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-3.5 py-3 dark:bg-black/10"
            >
              <div className="flex items-center gap-2">
                <Wifi className="h-4 w-4 shrink-0 liquid-glass-modal-text-muted" />
                <div className="text-xs font-semibold liquid-glass-modal-text-muted">
                  {t('settings.deviceSetup.overview.syncState', 'Sync')}
                </div>
              </div>
              <div className="mt-1.5 inline-flex items-center gap-2 text-base font-semibold liquid-glass-modal-text">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${syncToneClass}`} />
                {syncHealthLabel}
              </div>
            </div>

            <div
              data-register-summary-tile
              className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-3.5 py-3 dark:bg-black/10"
            >
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 shrink-0 liquid-glass-modal-text-muted" />
                <div className="text-xs font-semibold liquid-glass-modal-text-muted">
                  {t('settings.deviceSetup.overview.pinStatus', 'PIN')}
                </div>
              </div>
              <div className="mt-1.5 inline-flex items-center gap-2 text-base font-semibold liquid-glass-modal-text">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${pinResetRequired ? 'bg-yellow-400' : 'bg-green-500'}`} />
                {pinResetRequired
                  ? t('settings.deviceSetup.overview.pinResetShort', 'New PIN needed')
                  : t('settings.deviceSetup.overview.pinOkShort', 'PIN ready')}
              </div>
              <div className="mt-1 text-xs liquid-glass-modal-text-muted">
                {pinResetRequired
                  ? t('settings.deviceSetup.pinResetRequired', 'A new PIN is required at next sign-in.')
                  : t('settings.deviceSetup.pinResetClear', 'No PIN reset pending.')}
              </div>
            </div>
          </div>

          {/* 4. Allowed actions + Active areas — calm, scannable chips: a count badge plus the first
              OVERVIEW_CHIP_LIMIT localized labels as soft rounded chips, then a "+N more" summary chip
              (no unlimited wall of pills, no paragraph dump). enabledModuleNames is still built via
              resolveNavigationLabel; no data is dropped, only the display is condensed. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div
              data-register-allowed-actions
              className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-3.5 py-3 dark:bg-black/10"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4 shrink-0 liquid-glass-modal-text-muted" />
                  <div className="text-xs font-semibold liquid-glass-modal-text-muted">
                    {t('settings.deviceSetup.allowedActions', 'Allowed actions')}
                  </div>
                </div>
                <span className="rounded-full bg-yellow-400/15 px-2 py-0.5 text-xs font-semibold text-yellow-900 dark:text-yellow-200">
                  {enabledFeatureLabels.length}
                </span>
              </div>
              {enabledFeatureLabels.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {enabledFeatureLabels.slice(0, OVERVIEW_CHIP_LIMIT).map((label, index) => (
                    <span
                      key={`${label}-${index}`}
                      className="inline-flex items-center rounded-full border border-yellow-400/30 bg-yellow-400/10 px-2.5 py-1 text-xs font-medium text-yellow-900 dark:text-yellow-100"
                    >
                      {label}
                    </span>
                  ))}
                  {enabledFeatureLabels.length > OVERVIEW_CHIP_LIMIT ? (
                    <span className="inline-flex items-center rounded-full border liquid-glass-modal-border bg-white/5 px-2.5 py-1 text-xs font-semibold liquid-glass-modal-text-muted dark:bg-black/20">
                      {t('settings.deviceSetup.overview.moreCount', '+{{count}} more', {
                        count: enabledFeatureLabels.length - OVERVIEW_CHIP_LIMIT,
                      })}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="mt-1.5 text-sm liquid-glass-modal-text">
                  {t('settings.deviceSetup.noAllowedActions', 'No allowed actions yet')}
                </div>
              )}
            </div>

            <div
              data-register-active-areas
              className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-3.5 py-3 dark:bg-black/10"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 shrink-0 liquid-glass-modal-text-muted" />
                  <div className="text-xs font-semibold liquid-glass-modal-text-muted">
                    {t('settings.deviceSetup.activeAreas', 'Active areas')}
                  </div>
                </div>
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold liquid-glass-modal-text dark:bg-black/20">
                  {enabledModuleNames.length}
                </span>
              </div>
              {enabledModuleNames.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {enabledModuleNames.slice(0, OVERVIEW_CHIP_LIMIT).map((label, index) => (
                    <span
                      key={`${label}-${index}`}
                      className="inline-flex items-center rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-900 dark:text-green-100"
                    >
                      {label}
                    </span>
                  ))}
                  {enabledModuleNames.length > OVERVIEW_CHIP_LIMIT ? (
                    <span className="inline-flex items-center rounded-full border liquid-glass-modal-border bg-white/5 px-2.5 py-1 text-xs font-semibold liquid-glass-modal-text-muted dark:bg-black/20">
                      {t('settings.deviceSetup.overview.moreCount', '+{{count}} more', {
                        count: enabledModuleNames.length - OVERVIEW_CHIP_LIMIT,
                      })}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="mt-1.5 text-sm liquid-glass-modal-text">
                  {t('settings.deviceSetup.coreAreasOnly', 'Core areas only')}
                </div>
              )}
            </div>
          </div>

          {/* Round 347: the raw register ID / dashboard address disclosure is removed entirely. A cashier
              never needs these and they are a raw-ID leak surface; the editable terminal-id / admin-url
              credential fields live in the Connection section. The runtime values stay internal (used only by
              the credential/auth logic), never rendered in this overview. */}
        </div>
        )}

        {/* Connection Settings */}
        {activeSettingsSection === 'connection' && (
        <div id="settings-section-connection" className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 pt-4 pb-5 space-y-2.5 transition-all">
          {sectionHeader(
            <Wifi className="h-5 w-5 text-black" />,
            t('modals.connectionSettings.connectionSettings'),
          )}
          <div>
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('onboarding.connectionString', { defaultValue: 'Connection Code' })}
            </label>
            <p className="text-xs liquid-glass-modal-text-muted mb-2">
              {t('settings.deviceSetup.connectionCodeHelp', { defaultValue: 'Paste the connection code from your dashboard.' })}
            </p>
            <textarea
              value={connectionCode}
              onChange={e => setConnectionCode(e.target.value)}
              className="liquid-glass-modal-input w-full min-h-[72px] font-mono text-xs"
              placeholder={t('onboarding.connectionStringPlaceholder', { defaultValue: 'Paste connection code here...' })}
            />
          </div>
          {allowManualCredentials && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">{t('settings.deviceSetup.registerId', 'Register ID')}</label>
                  <input
                    value={terminalId}
                    onChange={e => setTerminalId(e.target.value)}
                    className="liquid-glass-modal-input w-full"
                    placeholder={t('modals.connectionSettings.terminalPlaceholder')}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                    {t('settings.deviceSetup.dashboardAddress', 'Dashboard address')}
                  </label>
                  <input
                    value={adminDashboardUrl}
                    onChange={e => setAdminDashboardUrl(e.target.value)}
                    className="liquid-glass-modal-input w-full"
                    placeholder={t('settings.deviceSetup.dashboardAddressPlaceholder', { defaultValue: 'https://your-dashboard.example.com' })}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">{t('settings.deviceSetup.posKey', 'POS key')}</label>
                <div className="relative">
                  <input
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    type={showApiKey ? 'text' : 'password'}
                    className="liquid-glass-modal-input w-full pr-12"
                    placeholder={t('modals.connectionSettings.apiKeyPlaceholder')}
                  />
                  <button
                    type="button"
                    aria-label={showApiKey ? t('common.hide') : t('common.show')}
                    onClick={() => setShowApiKey(v => !v)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-lg transition-transform active:scale-95 active:bg-white/15 dark:active:bg-white/10"
                  >
                    {showApiKey ? (
                      <EyeOff className="w-5 h-5 text-gray-400" />
                    ) : (
                      <Eye className="w-5 h-5 text-gray-400" />
                    )}
                  </button>
                </div>
              </div>
            </>
          )}
          {/* Connection actions: balanced secondary group plus primary Save slot. */}
          <div data-connection-action-bar className="flex flex-col gap-3 pt-2">
            <div data-connection-secondary-actions className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <button
                onClick={handlePasteBoth}
                aria-label={t('modals.connectionSettings.pasteBothTooltip')}
                className={liquidGlassModalButton('secondary', 'md') + ' inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 text-center leading-tight'}
              >
                <Clipboard className="w-4 h-4 shrink-0" />
                {t('modals.connectionSettings.pasteBoth')}
              </button>
              {allowManualCredentials && (
                <button
                  onClick={handleTest}
                  className={liquidGlassModalButton('secondary', 'md') + ' inline-flex min-h-[44px] flex-1 items-center justify-center text-center leading-tight'}
                >
                  {t('modals.connectionSettings.test')}
                </button>
              )}
              <button
                onClick={handleManualPolicySync}
                className={liquidGlassModalButton('secondary', 'md') + ' inline-flex min-h-[44px] flex-1 items-center justify-center text-center leading-tight'}
              >
                {t('settings.deviceSetup.syncButton', 'Sync settings')}
              </button>
            </div>
            <div data-connection-primary-action className="flex justify-center">
              <button
                onClick={handleSaveConnection}
                className={SAVE_BTN_MD + ' min-h-[44px] w-full sm:w-auto sm:min-w-[240px]'}
              >
                <Check className="w-4 h-4" />
                {t('modals.connectionSettings.save')}
              </button>
            </div>
          </div>
        </div>
        )}

        {/* PIN Settings */}
        {activeSettingsSection === 'security' && (
        <div id="settings-section-security" className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 py-4 space-y-3 transition-all">
          {sectionHeader(
            <Lock className="h-5 w-5 text-black" />,
            t('modals.connectionSettings.pinSetup', 'Local PIN'),
            pinResetRequired
              ? t('settings.deviceSetup.pinResetRequired', 'A new PIN is required at next sign-in.')
              : pin && !editingPin
                ? '••••'
                : t('settings.security.pinHelp', 'Local staff authentication'),
          )}
          {!editingPin ? (
            <button
              onClick={() => setEditingPin(true)}
              className={liquidGlassModalButton('primary', 'md')}
            >
              {t('modals.connectionSettings.changePin')}
            </button>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium mb-2 liquid-glass-modal-text-muted">{t('modals.connectionSettings.newPin')}</label>
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
                <label className="block text-xs font-medium mb-2 liquid-glass-modal-text-muted">{t('modals.connectionSettings.confirmPin')}</label>
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
                  className={CANCEL_BTN_MD}
                >
                  {t('modals.connectionSettings.cancel')}
                </button>
                <button onClick={handleSavePin} className={SAVE_BTN_MD}>
                  {t('modals.connectionSettings.savePin')}
                </button>
              </div>
            </>
          )}
        </div>
        )}

        {/* Theme Switcher */}
        {activeSettingsSection === 'terminal' && (
        <>
        <div id="settings-section-terminal" className={`rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Palette className="w-5 h-5 text-yellow-500" />
              <span className={`font-medium liquid-glass-modal-text`}>{t('modals.connectionSettings.theme')}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleSaveTheme('light')}
                className={`p-2 rounded-lg transition-all inline-flex items-center justify-center ${theme === 'light'
                  ? 'bg-yellow-500/30 border-2 border-yellow-400 shadow-[0_0_12px_rgba(250,204,21,0.5)]'
                  : 'bg-white/10 border border-gray-600 active:bg-white/20'
                  }`}
                aria-label={t('modals.connectionSettings.light')}
              >
                <Sun className={`w-5 h-5 ${theme === 'light' ? 'text-yellow-300' : 'text-gray-400'}`} />
              </button>
              <button
                onClick={() => handleSaveTheme('dark')}
                className={`p-2 rounded-lg transition-all inline-flex items-center justify-center ${theme === 'dark'
                  ? 'bg-yellow-500/30 border-2 border-yellow-400 shadow-[0_0_12px_rgba(250,204,21,0.5)]'
                  : 'bg-white/10 border border-gray-600 active:bg-white/20'
                  }`}
                aria-label={t('modals.connectionSettings.dark')}
              >
                <Moon className={`w-5 h-5 ${theme === 'dark' ? 'text-yellow-300' : 'text-gray-400'}`} />
              </button>
              <button
                onClick={() => handleSaveTheme('auto')}
                className={`p-2 rounded-lg transition-all inline-flex items-center justify-center ${theme === 'auto'
                  ? 'bg-yellow-400/25 border-2 border-yellow-400 shadow-[0_0_12px_rgba(234,179,8,0.4)]'
                  : 'bg-white/10 border border-gray-600 active:bg-white/20'
                  }`}
                aria-label={t('modals.connectionSettings.system')}
              >
                <Monitor className={`w-5 h-5 ${theme === 'auto' ? 'text-yellow-600 dark:text-yellow-400' : 'text-gray-400'}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Language Switcher */}
        <div className={`rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5 text-yellow-500" />
              <span className={`font-medium liquid-glass-modal-text`}>{t('modals.connectionSettings.language')}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setLanguage('en')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm inline-flex items-center justify-center text-center ${currentLanguage === 'en'
                  ? 'bg-yellow-400/25 border-2 border-yellow-400 text-yellow-900 dark:text-yellow-200'
                  : 'bg-white/10 border border-gray-600 active:bg-white/20 text-gray-400'
                  }`}
                aria-label={t('settings.display.langEnglish')}
              >
                EN
              </button>
              <button
                onClick={() => {
                  setLanguage('el')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm inline-flex items-center justify-center text-center ${currentLanguage === 'el'
                  ? 'bg-yellow-400/25 border-2 border-yellow-400 text-yellow-900 dark:text-yellow-200'
                  : 'bg-white/10 border border-gray-600 active:bg-white/20 text-gray-400'
                  }`}
                aria-label={t('settings.display.langGreek')}
              >
                EL
              </button>
              <button
                onClick={() => {
                  setLanguage('de')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm inline-flex items-center justify-center text-center ${currentLanguage === 'de'
                  ? 'bg-yellow-400/25 border-2 border-yellow-400 text-yellow-900 dark:text-yellow-200'
                  : 'bg-white/10 border border-gray-600 active:bg-white/20 text-gray-400'
                  }`}
                aria-label={t('settings.display.langGerman')}
              >
                DE
              </button>
              <button
                onClick={() => {
                  setLanguage('fr')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm inline-flex items-center justify-center text-center ${currentLanguage === 'fr'
                  ? 'bg-yellow-400/25 border-2 border-yellow-400 text-yellow-900 dark:text-yellow-200'
                  : 'bg-white/10 border border-gray-600 active:bg-white/20 text-gray-400'
                  }`}
                aria-label={t('settings.display.langFrench')}
              >
                FR
              </button>
              <button
                onClick={() => {
                  setLanguage('it')
                  toast.success(t('modals.connectionSettings.languageSaved'))
                }}
                className={`px-3 py-2 rounded-lg transition-all font-medium text-sm inline-flex items-center justify-center text-center ${currentLanguage === 'it'
                  ? 'bg-yellow-400/25 border-2 border-yellow-400 text-yellow-900 dark:text-yellow-200'
                  : 'bg-white/10 border border-gray-600 active:bg-white/20 text-gray-400'
                  }`}
                aria-label={t('settings.display.langItalian')}
              >
                IT
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 py-4 space-y-4 transition-all">
          {sectionHeader(
            <Monitor className="h-5 w-5 text-black" />,
            t('settings.terminal.title', 'Terminal'),
            t('settings.terminal.helpText', 'Local UX and operator preferences for this device'),
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="terminal-screen-timeout" className="block text-xs font-medium mb-2 liquid-glass-modal-text-muted">
                {t('settings.terminal.screenTimeout', 'Screen timeout (minutes)')}
              </label>
              <input
                id="terminal-screen-timeout"
                type="number"
                min={1}
                max={120}
                value={screenTimeoutMinutes}
                onChange={e => setScreenTimeoutMinutes(e.target.value)}
                className="liquid-glass-modal-input"
              />
            </div>
            <div>
              <label htmlFor="terminal-touch-sensitivity" className="block text-xs font-medium mb-2 liquid-glass-modal-text-muted">
                {t('settings.terminal.touchSensitivity', 'Touch sensitivity')}
              </label>
              <select
                id="terminal-touch-sensitivity"
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
              <label htmlFor="terminal-display-brightness" className="block text-xs font-medium mb-2 liquid-glass-modal-text-muted">
                {t('settings.terminal.displayBrightness', 'Display brightness')}
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="terminal-display-brightness"
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={displayBrightness}
                  onChange={e => setDisplayBrightness(e.target.value)}
                  className="flex-1 accent-yellow-500"
                />
                <div className="w-16 text-right text-sm liquid-glass-modal-text">{displayBrightness}%</div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex items-center justify-between rounded-2xl border liquid-glass-modal-border bg-white/5 px-3 py-3">
              <div>
                <div id="terminal-audio-label" className="font-medium liquid-glass-modal-text">{t('settings.terminal.audioEnabled', 'Audio enabled')}</div>
                <div className="text-xs liquid-glass-modal-text-muted">{t('settings.terminal.audioHelp', 'Play UI sounds on this device')}</div>
              </div>
              <POSGlassSwitch aria-labelledby="terminal-audio-label" checked={audioEnabled} onChange={setAudioEnabled} />
            </div>
            <div className="flex items-center justify-between rounded-2xl border liquid-glass-modal-border bg-white/5 px-3 py-3">
              <div>
                <div id="terminal-receipt-autoprint-label" className="font-medium liquid-glass-modal-text">{t('settings.terminal.receiptAutoPrint', 'Auto-print receipts')}</div>
                <div className="text-xs liquid-glass-modal-text-muted">{t('settings.terminal.receiptAutoPrintHelp', 'Automatically print after successful checkout')}</div>
              </div>
              <POSGlassSwitch aria-labelledby="terminal-receipt-autoprint-label" checked={receiptAutoPrint} onChange={setReceiptAutoPrint} />
            </div>
          </div>

          <div className="pt-2 border-t liquid-glass-modal-border">
            <button
              onClick={handleSaveTerminalPreferences}
              className={SAVE_BTN_MD}
            >
              {t('settings.terminal.saveButton', 'Save Terminal Preferences')}
            </button>
          </div>
        </div>
        </>
        )}

        {/* Security Settings - Session Timeout */}
        {activeSettingsSection === 'security' && (
        <div data-session-timeout-card className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 py-4 space-y-4 transition-all">
          {sectionHeader(
            <Timer className="h-5 w-5 text-black" />,
            t('modals.connectionSettings.security', 'Security'),
            sessionTimeoutEnabled
              ? (t('modals.connectionSettings.sessionTimeoutStatus', { minutes: sessionTimeoutMinutes }) || `Auto-logout after ${sessionTimeoutMinutes} min`)
              : t('modals.connectionSettings.sessionTimeoutOff', 'Session timeout disabled'),
          )}

          {/* Session Timeout Toggle */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="text-left min-w-0">
                <span id="session-timeout-label" className="font-medium block liquid-glass-modal-text">{t('modals.connectionSettings.sessionTimeout', 'Session Timeout')}</span>
                <span className="text-xs liquid-glass-modal-text-muted">{t('modals.connectionSettings.sessionTimeoutHelp', 'Auto-logout after inactivity')}</span>
              </div>
            </div>
            <POSGlassSwitch
              aria-labelledby="session-timeout-label"
              checked={sessionTimeoutEnabled}
              onChange={handleToggleSessionTimeout}
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-3 border-t liquid-glass-modal-border">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="text-left min-w-0">
                <span className="font-medium block liquid-glass-modal-text">
                  {t('modals.connectionSettings.ghostMode', 'Ghost Mode')}
                </span>
                <span className="text-xs liquid-glass-modal-text-muted">
                  {ghostModeFeatureEnabled
                    ? t(
                        'modals.connectionSettings.ghostModeHelp',
                        'Use manual item code X with price 1 to arm ghost mode for the current cart only.'
                      )
                    : t(
                        'settings.deviceSetup.ghostModeOff',
                        'Ghost Mode is turned off for this register.'
                      ) + (terminalId?.trim() ? ` (${terminalId.trim()})` : '')}
                </span>
              </div>
            </div>
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                ghostModeFeatureEnabled
                  ? 'bg-yellow-400/15 text-yellow-800 dark:text-yellow-200'
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
              <span id="session-timeout-duration-label" className="font-medium block liquid-glass-modal-text">{t('modals.connectionSettings.timeoutDuration', 'Timeout Duration')}</span>
              <span className="text-xs liquid-glass-modal-text-muted">{t('modals.connectionSettings.timeoutRange', '1-480 minutes')}</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                aria-labelledby="session-timeout-duration-label"
                value={sessionTimeoutMinutes}
                onChange={e => setSessionTimeoutMinutes(e.target.value)}
                onBlur={handleSaveSessionTimeout}
                min={1}
                max={480}
                disabled={!sessionTimeoutEnabled}
                className={`liquid-glass-modal-input w-20 text-center ${
                  sessionTimeoutEnabled ? '' : 'opacity-60 cursor-not-allowed'
                }`}
              />
              <span className="text-sm liquid-glass-modal-text-muted">
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
                  className={`px-3 py-1 text-sm rounded-lg transition-all inline-flex items-center justify-center ${
                    sessionTimeoutMinutes === String(mins)
                      ? 'bg-yellow-500/30 border border-yellow-400 text-yellow-300'
                      : 'bg-white/10 border border-gray-600 text-gray-300 active:bg-white/20'
                  }`}
                >
                  {mins}m
                </button>
              ))}
            </div>
          )}
        </div>
        )}

        {/* Database Management */}
        {activeSettingsSection === 'database' && (
        <div id="settings-section-database" className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 py-4 space-y-4 transition-all">
          {sectionHeader(
            <Database className="h-5 w-5 text-black" />,
            t('settings.database.management', 'Database Management'),
          )}
          <div className="flex flex-col gap-4 pb-24">
                <RecoveryPanel />

                {/* Zone 2 — Safe fixes: calm green maintenance that keeps the operator's data. */}
                <div data-database-safe-fixes className="rounded-2xl border liquid-glass-modal-border bg-white/5 dark:bg-black/10 p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <Wrench className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                    <div className="min-w-0">
                      <div className="font-semibold liquid-glass-modal-text">{t('settings.database.repairToolsTitle', 'Safe fixes')}</div>
                      <div className="text-xs liquid-glass-modal-text-muted">{t('settings.database.repairToolsHelp', 'Keeps your data')}</div>
                    </div>
                  </div>

                  {/* Clear Sync Queue */}
                  <div className="flex items-center justify-between gap-3 rounded-xl border liquid-glass-modal-border bg-white/5 px-3 py-2.5">
                    <div className="text-left min-w-0">
                      <span className="font-medium block liquid-glass-modal-text">{t('settings.database.clearSyncQueueLabel', 'Clear Sync Queue')}</span>
                      <span className="text-xs liquid-glass-modal-text-muted">{t('settings.database.clearSyncQueueHelp', 'Clears stuck sync items without deleting data')}</span>
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
                      className={DB_REPAIR_BTN_MD}
                    >
                      {t('settings.database.repairQueueButton', 'Fix queue')}
                    </button>
                  </div>

                  {/* Clear Old Orders */}
                  <div className="flex items-center justify-between gap-3 rounded-xl border liquid-glass-modal-border bg-white/5 px-3 py-2.5">
                    <div className="text-left min-w-0">
                      <span className="font-medium block liquid-glass-modal-text">{t('settings.database.clearOldOrdersLabel', 'Clear Old Orders')}</span>
                      <span className="text-xs liquid-glass-modal-text-muted">{t('settings.database.clearOldOrdersHelp', 'Removes orphaned orders from previous days')}</span>
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
                      className={DB_REPAIR_BTN_MD}
                    >
                      {t('settings.database.repairOldOrdersButton', 'Clean old orders')}
                    </button>
                  </div>

                  {/* Sync Deleted Orders */}
                  <div className="flex items-center justify-between gap-3 rounded-xl border liquid-glass-modal-border bg-white/5 px-3 py-2.5">
                    <div className="text-left min-w-0">
                      <span className="font-medium block liquid-glass-modal-text">{t('settings.database.syncDeletedOrdersLabel', 'Sync Deleted Orders')}</span>
                      <span className="text-xs liquid-glass-modal-text-muted">{t('settings.database.syncDeletedOrdersHelp', 'Removes orders deleted from the dashboard')}</span>
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
                      className={DB_REPAIR_BTN_MD}
                    >
                      {t('settings.database.repairDeletedOrdersButton', 'Sync deleted orders')}
                    </button>
                  </div>
                </div>

                {/* Zone 3 — Advanced reset tools: permanent deletions, COLLAPSED by default behind a
                    disclosure so they are never openly mixed with safe maintenance. The same three
                    destructive actions + their existing handlers/confirmation chain render only when an
                    operator deliberately expands. Red is reserved for the actual destructive buttons. */}
                <details data-database-danger-zone className="group rounded-2xl border-2 border-red-500/40 bg-red-500/5 p-4">
                  <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-3 transition-transform active:scale-[0.99] [&::-webkit-details-marker]:hidden">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-red-500" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-semibold text-red-600 dark:text-red-300">{t('settings.database.advancedResetTitle', 'Advanced reset tools')}</span>
                      <span className="text-xs liquid-glass-modal-text-muted">{t('settings.database.advancedResetSummary', 'Deletes data')}</span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-red-500 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="text-xs liquid-glass-modal-text-muted">{t('settings.database.dangerZoneHelp', 'These actions permanently delete data and cannot be undone.')}</div>

                  {/* Clear All Orders */}
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5">
                    <div className="text-left min-w-0">
                      <span className="font-medium block liquid-glass-modal-text">{t('settings.database.clearAllOrdersLabel', 'Clear All Orders')}</span>
                      <span className="text-xs liquid-glass-modal-text-muted">{t('settings.database.clearAllOrdersHelp', 'Removes all orders including today\'s')}</span>
                      <span className="mt-1.5 inline-flex items-center rounded-full border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-300">{t('settings.database.cannotUndo', 'Cannot be undone')}</span>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          const result = await bridge.sync.clearAllOrders() as any
                          if (result?.success) {
                            toast.success(t('settings.database.allOrdersCleared', { count: result.cleared, defaultValue: 'Cleared {{count}} orders' }))
                          } else {
                            toast.error(result?.error || t('settings.database.allOrdersClearFailed', 'Failed to clear all orders'))
                          }
                        } catch (e) {
                          console.error('Failed to clear all orders:', e)
                          toast.error(t('settings.database.allOrdersClearFailed', 'Failed to clear all orders'))
                        }
                      }}
                      className={DB_DANGER_BTN_MD}
                    >
                      {t('settings.database.dangerDeleteOrdersButton', 'Delete all orders')}
                    </button>
                  </div>

                  {/* Clear All Operational Data */}
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5">
                    <div className="text-left min-w-0">
                      <span className="font-medium block liquid-glass-modal-text">{t('settings.database.clearOperationalLabel', 'Clear All Operational Data')}</span>
                      <span className="text-xs liquid-glass-modal-text-muted">{t('settings.database.clearOperationalHelp', 'Clears orders, shifts, drawers, payments. Keeps settings.')}</span>
                      <span className="mt-1.5 inline-flex items-center rounded-full border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-300">{t('settings.database.cannotUndo', 'Cannot be undone')}</span>
                    </div>
                    <button
                      onClick={() => setShowClearOperationalConfirm(true)}
                      className={DB_DANGER_BTN_MD}
                    >
                      {t('settings.database.dangerEraseDataButton', 'Erase operational data')}
                    </button>
                  </div>

                  {/* Factory Reset */}
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5">
                    <div className="text-left min-w-0">
                      <span className="font-medium block liquid-glass-modal-text">{t('settings.database.label')}</span>
                      <span className="text-xs liquid-glass-modal-text-muted">{t('settings.database.helpText')}</span>
                      <span className="mt-1.5 inline-flex items-center rounded-full border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-300">{t('settings.database.cannotUndo', 'Cannot be undone')}</span>
                    </div>
                    <button
                      onClick={handleClearDatabase}
                      className={DB_DANGER_BTN_MD}
                    >
                      {t('settings.database.dangerFactoryResetButton', 'Factory reset')}
                    </button>
                  </div>
                  </div>
                </details>
          </div>
        </div>
        )}

        {/* Hardware Settings */}
        {activeSettingsSection === 'hardware' && (
        <div id="settings-section-hardware" className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 py-4 space-y-4 transition-all">
          {sectionHeader(
            <Cable className="h-5 w-5 text-black" />,
            t('settings.peripherals.title', 'Peripherals'),
            t('settings.peripherals.helpText', 'Configure external hardware devices'),
          )}
          <div className="space-y-4">

              {/* --- Weighing Scale --- */}
              <div className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-4 py-3 space-y-3 dark:bg-black/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span id="peripheral-scale-label" className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.scale.title', 'Weighing Scale')}</span>
                    {hardwareStatus?.scale?.connected && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                        {t('settings.peripherals.scale.connected', 'Connected')}
                      </span>
                    )}
                  </div>
                  <POSGlassSwitch aria-labelledby="peripheral-scale-label" checked={scaleEnabled} onChange={setScaleEnabled} />
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
                              await bridge.hardware.scaleDisconnect()
                            } else {
                              await bridge.hardware.scaleConnect({ port: scalePort, baud: Number(scaleBaudRate), protocol: scaleProtocol })
                            }
                          } catch (e) { console.error('Scale action failed:', e); toast.error(t('settings.peripherals.actionFailed', 'Action failed')) }
                        }}
                        className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-all inline-flex items-center justify-center ${
                          hardwareStatus?.scale?.connected
                            ? 'bg-red-500/20 border border-red-500/50 text-red-300 active:bg-red-500/30'
                            : 'bg-yellow-500/20 border border-yellow-500/50 text-yellow-900 dark:text-yellow-200 active:bg-yellow-500/30'
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

              {/* --- Customer Display --- */}
              <div className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-4 py-3 space-y-3 dark:bg-black/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span id="peripheral-display-label" className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.display.title', 'Customer Display')}</span>
                    {hardwareStatus?.customerDisplay?.connected && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                        {t('settings.peripherals.scale.connected', 'Connected')}
                      </span>
                    )}
                  </div>
                  <POSGlassSwitch aria-labelledby="peripheral-display-label" checked={displayEnabled} onChange={setDisplayEnabled} />
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
                              await bridge.hardware.displayDisconnect()
                            } else {
                              await bridge.hardware.displayConnect({
                                connectionType: displayConnectionType,
                                target: displayPort,
                                portNumber: displayConnectionType === 'network' ? Number(displayTcpPort) : undefined,
                                baudRate: displayConnectionType === 'serial' ? Number(displayBaudRate) : undefined,
                              })
                            }
                          } catch (e) { console.error('Display action failed:', e); toast.error(t('settings.peripherals.actionFailed', 'Action failed')) }
                        }}
                        className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-all inline-flex items-center justify-center ${
                          hardwareStatus?.customerDisplay?.connected
                            ? 'bg-red-500/20 border border-red-500/50 text-red-300 active:bg-red-500/30'
                            : 'bg-yellow-500/20 border border-yellow-500/50 text-yellow-900 dark:text-yellow-200 active:bg-yellow-500/30'
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

              {/* --- Serial Barcode Scanner --- */}
              <div className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-4 py-3 space-y-3 dark:bg-black/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span id="peripheral-scanner-label" className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.scanner.title', 'Serial Barcode Scanner')}</span>
                    {hardwareStatus?.serialScanner?.connected && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                        {t('settings.peripherals.scanner.running', 'Running')}
                      </span>
                    )}
                  </div>
                  <POSGlassSwitch aria-labelledby="peripheral-scanner-label" checked={scannerEnabled} onChange={setScannerEnabled} />
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
                              await bridge.hardware.scannerSerialStop()
                            } else {
                              await bridge.hardware.scannerSerialStart({ port: scannerPort, baud: Number(scannerBaudRate) })
                            }
                          } catch (e) { console.error('Scanner action failed:', e); toast.error(t('settings.peripherals.actionFailed', 'Action failed')) }
                        }}
                        className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-all inline-flex items-center justify-center ${
                          hardwareStatus?.serialScanner?.connected
                            ? 'bg-red-500/20 border border-red-500/50 text-red-300 active:bg-red-500/30'
                            : 'bg-yellow-500/20 border border-yellow-500/50 text-yellow-900 dark:text-yellow-200 active:bg-yellow-500/30'
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

              {/* --- Card Reader (MSR) --- */}
              <div className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-4 py-3 space-y-2 dark:bg-black/10">
                <div className="flex items-center justify-between">
                  <span id="peripheral-card-reader-label" className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.cardReader.title', 'Card Reader (MSR)')}</span>
                  <POSGlassSwitch aria-labelledby="peripheral-card-reader-label" checked={cardReaderEnabled} onChange={setCardReaderEnabled} />
                </div>
                <p className={`text-xs liquid-glass-modal-text-muted`}>{t('settings.peripherals.cardReader.plugAndPlay', 'Magnetic stripe readers work via keyboard input — plug and play')}</p>
              </div>

              {/* --- Loyalty / NFC Reader --- */}
              <div className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-4 py-3 space-y-2 dark:bg-black/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span id="peripheral-loyalty-reader-label" className={`font-medium text-sm liquid-glass-modal-text`}>{t('settings.peripherals.loyaltyReader.title', 'Loyalty / NFC Reader')}</span>
                    {hardwareStatus?.loyaltyReader?.connected && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                        {t('settings.peripherals.scanner.running', 'Running')}
                      </span>
                    )}
                  </div>
                  <POSGlassSwitch aria-labelledby="peripheral-loyalty-reader-label" checked={loyaltyEnabled} onChange={setLoyaltyEnabled} />
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
                      toast.success(t('settings.peripherals.saved', 'Peripheral settings saved'))
                    } catch (e) {
                      console.error('Failed to save hardware settings:', e)
                      toast.error(t('settings.peripherals.saveFailed', 'Failed to save peripheral settings'))
                    }
                  }}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-green-500 bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-green-600/30 transition-transform duration-150 active:scale-[0.98] active:bg-green-700"
                >
                  {t('settings.peripherals.saveButton', 'Save peripherals')}
                </button>
              </div>

          </div>
        </div>
        )}

        {/* Printer Settings trigger */}
        {activeSettingsSection === 'printing' && (
        <>
        <div id="settings-section-printing" className={`rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Printer className="w-5 h-5 text-yellow-500" />
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

        <div className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Printer className="w-5 h-5 text-yellow-500" />
              <div className="text-left">
                <div id="printer-receipt-print-prompt-label" className="font-medium liquid-glass-modal-text">
                  {t('settings.printer.askBeforePrint', 'Ask before printing')}
                </div>
                <div className="text-xs liquid-glass-modal-text-muted">
                  {t('settings.printer.askBeforePrintHelp', 'Show a confirmation after payment before printing the receipt')}
                </div>
              </div>
            </div>
            <POSGlassSwitch
              aria-labelledby="printer-receipt-print-prompt-label"
              checked={receiptPrintPromptEnabled}
              onChange={handleReceiptPrintPromptToggle}
            />
          </div>
        </div>

        <PrintQueuePanel />
        </>
        )}

        {/* Payment Terminals Settings trigger */}
        {activeSettingsSection === 'payments' && (
        <div id="settings-section-payments" className={`rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 px-4 py-3 transition-all`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CreditCard className="w-5 h-5 text-yellow-500" />
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
        )}

        {/* About Section */}
        {activeSettingsSection === 'about' && (
        <div id="settings-section-about" className="rounded-2xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-black/10 px-4 py-4 space-y-3 transition-all">
          {sectionHeader(
            <Info className="h-5 w-5 text-black" />,
            t('modals.connectionSettings.about'),
            aboutData ? `v${aboutData.version}` : t('modals.connectionSettings.aboutSubtitle'),
          )}
          {aboutData ? (
            <>
              {[
                { label: t('modals.connectionSettings.aboutVersion'), value: `v${aboutData.version}` },
                { label: t('modals.connectionSettings.aboutBuildDate'), value: aboutData.buildTimestamp },
                { label: t('modals.connectionSettings.aboutGitSha'), value: aboutData.gitSha },
                { label: t('modals.connectionSettings.aboutPlatform'), value: `${aboutData.platform} (${aboutData.arch})` },
                { label: t('modals.connectionSettings.aboutRust'), value: aboutData.rustVersion },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between items-center py-2 border-b border-white/5 last:border-b-0">
                  <span className="text-sm liquid-glass-modal-text-muted">{label}</span>
                  <span className="text-sm font-mono liquid-glass-modal-text">{value}</span>
                </div>
              ))}
              <div className="pt-3 flex flex-wrap justify-center gap-3">
                <button
                  onClick={handleCopyAboutInfo}
                  className={liquidGlassModalButton('secondary', 'md')}
                >
                  <span className="inline-flex items-center gap-2">
                    {aboutCopied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                    {aboutCopied ? t('modals.connectionSettings.aboutCopied') : t('modals.connectionSettings.aboutCopyInfo')}
                  </span>
                </button>
                {onCheckForUpdates && (
                  <button
                    type="button"
                    onClick={onCheckForUpdates}
                    className={liquidGlassModalButton('primary', 'md')}
                  >
                    <span className="inline-flex items-center gap-2">
                      <RefreshCw className="w-4 h-4" />
                      {t('updates.actions.checkNow', 'Check for updates')}
                    </span>
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="py-4 text-center">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-yellow-500 mx-auto" />
            </div>
          )}
        </div>
        )}
          </div>
        </div>
      </div>
      )}

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
