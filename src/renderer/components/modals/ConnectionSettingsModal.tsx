import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { posApiGet } from '../../utils/api-helpers'
import { useTheme } from '../../contexts/theme-context'
import { useI18n } from '../../contexts/i18n-context'
import type { SupportedLanguage } from '../../contexts/i18n-state'
import { Wifi, Lock, Sun, Moon, Monitor, Database, Printer, Eye, EyeOff, Clipboard, CreditCard, Cable, Copy, Check, AlertTriangle, ChevronDown, RefreshCw, Smartphone, Store } from 'lucide-react'
import { inputBase, liquidGlassModalButton } from '../../styles/designSystem';
import { LiquidGlassModal, POSGlassSwitch } from '../ui/pos-glass-components';
import PrinterSettingsModal from './PrinterSettingsModal';
import CashRegisterSection, { type CashRegisterSetupIntent } from '../peripherals/CashRegisterSection';
import CallerIdSection from '../peripherals/CallerIdSection';
import { PaymentTerminalsSection } from '../ecr/PaymentTerminalsSection';
import { CafeLanSettings } from '../settings/CafeLanSettings';
import { WaiterDevicesSection } from '../settings/WaiterDevicesSection';
import { PlatformsSection } from '../settings/PlatformsSection';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useHardwareManager } from '../../hooks/useHardwareManager';
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import { useFeatures } from '../../hooks/useFeatures';
import RecoveryPanel from '../recovery/RecoveryPanel';
import PrintQueuePanel from '../printing/PrintQueuePanel';
import { DirtyFooter, SegmentedControl, SettingsDirtyProvider, SettingsGroup, SettingsRow, StatusLine, TechDisclosure, solidButton, useSettingsDirtyRegistry, type StatusTone } from '../settings/SettingsKit';
import { buildSettingsNavGroups, resolveSettingsDeepLink, type SettingsDeepLink, type SettingsNavGroupId, type SettingsSectionId } from '../settings/settings-sections';
import { PlatformNotificationSoundSettings } from '../settings/PlatformNotificationSoundSettings';
import { useEfoodPartner } from '../../hooks/useEfoodPartner';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
  updateTerminalCredentialCache,
} from '../../services/terminal-credentials';
import { getBridge, offEvent, onEvent, type DiagnosticsAboutInfo } from '../../../lib';
import { resolveTerminalConfigHealth } from '../../utils/terminal-config-health';
import { requireSettingsSuccess } from '../../utils/settings-operation';
import { rememberLoginPinLength } from '../../utils/loginPinLength';
import { SettingsRuntimePreferences } from '../settings/SettingsRuntimePreferences';
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

// UI audit wave 7A2: the kit buttons. Save is the one yellow button; Cancel is neutral (not red).
const SAVE_BTN_MD = solidButton('primary', 'md');
const CANCEL_BTN_MD = solidButton('secondary', 'md');
// Round 325 / wave 7A2: Data section buttons share the kit geometry (48 px). Safe repairs are
// neutral; destructive tools are red text on the neutral button and stay behind a collapsed
// disclosure, so they are never openly mixed with normal maintenance.
const DB_REPAIR_BTN_MD = solidButton('secondary', 'md');
const DB_DANGER_BTN_MD = solidButton('danger', 'md');

interface Props {
  isOpen: boolean
  onClose: () => void
  initialSection?: SettingsDeepLink
  onCheckForUpdates?: () => void
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

const ConnectionSettingsModal: React.FC<Props> = ({ isOpen, onClose, initialSection = null, onCheckForUpdates }) => {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { language: currentLanguage, setLanguage } = useI18n()
  const bridge = getBridge()
  const allowManualCredentials = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV)
  const { terminalType, ownerTerminalId, posOperatingMode } = useFeatures()
  const [connectionCode, setConnectionCode] = useState('')
  // The last code saved in this session, so a saved code no longer counts as an unsaved draft.
  const [savedConnectionCode, setSavedConnectionCode] = useState('')
  const [terminalId, setTerminalId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [adminDashboardUrl, setAdminDashboardUrl] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [editingPin, setEditingPin] = useState(false)
  const [cashRegisterSetupIntent, setCashRegisterSetupIntent] = useState<CashRegisterSetupIntent | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [showClearOperationalConfirm, setShowClearOperationalConfirm] = useState(false)
  const [isClearingOperational, setIsClearingOperational] = useState(false)

  // Factory reset confirmation dialogs
  const [showFactoryResetWarning, setShowFactoryResetWarning] = useState(false)
  const [showFactoryResetFinal, setShowFactoryResetFinal] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  // Session timeout settings
  const [receiptPrintPromptEnabled, setReceiptPrintPromptEnabled] = useState(false)
  const [pinResetRequired, setPinResetRequired] = useState(false)
  const [runtimeTerminalId, setRuntimeTerminalId] = useState('')
  const [runtimeAdminUrl, setRuntimeAdminUrl] = useState('')
  const [runtimeSyncHealth, setRuntimeSyncHealth] = useState('unknown')
  const [isSyncingSettings, setIsSyncingSettings] = useState(false)
  const [hardwareAction, setHardwareAction] = useState<string | null>(null)
  const [hardwareActionError, setHardwareActionError] = useState('')
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [settingsLoadFailed, setSettingsLoadFailed] = useState(false)
  const [settingsLoadAttempt, setSettingsLoadAttempt] = useState(0)
  const [hardwareBaseline, setHardwareBaseline] = useState<string | null>(null)
  const [showDiscardChanges, setShowDiscardChanges] = useState(false)
  const [savingLanguage, setSavingLanguage] = useState(false)
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId>('status')
  // A register setup request is for this visit to Cards & cash register only; coming back later must
  // not reopen the register form by itself (the register remounts with the section).
  useEffect(() => {
    if (activeSettingsSection !== 'payments') setCashRegisterSetupIntent(null)
  }, [activeSettingsSection])
  // Right detail pane: reset its scroll to the top whenever the active section
  // changes so a new section always starts at its header, instead of inheriting
  // the previous section's scroll offset. useLayoutEffect runs before paint so
  // there is no visible flash of the old scroll position.
  const detailScrollRef = useRef<HTMLDivElement>(null)

  const [aboutData, setAboutData] = useState<DiagnosticsAboutInfo | null>(null)
  const [aboutCopied, setAboutCopied] = useState(false)
  const [aboutError, setAboutError] = useState(false)
  const [aboutRetry, setAboutRetry] = useState(0)
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

  const { status: hardwareStatus, refresh: refreshHardware, loading: hardwareLoading, error: hardwareError } = useHardwareManager(isOpen)

  const hardwareSignature = JSON.stringify({ scaleEnabled, scalePort, scaleBaudRate, scaleProtocol,
    displayEnabled, displayConnectionType, displayPort, displayBaudRate, displayTcpPort,
    scannerEnabled, scannerPort, scannerBaudRate, cardReaderEnabled, loyaltyEnabled })
  const hardwareDirty = hardwareBaseline !== null && hardwareBaseline !== hardwareSignature
  useEffect(() => {
    if (settingsLoaded && hardwareBaseline === null) setHardwareBaseline(hardwareSignature)
  }, [settingsLoaded, hardwareBaseline, hardwareSignature])

  // Every settings form asks before its unsaved changes are dropped (UI audit wave 7):
  // devices (above), the connection code, the PIN editor, and the drafts sections report
  // through SettingsDirtyProvider (waiter permissions, efood weekly hours).
  const dirtyRegistry = useSettingsDirtyRegistry()
  const connectionDirty = connectionCode.trim() !== '' && connectionCode !== savedConnectionCode
  const pinDirty = editingPin && (pin !== '' || confirmPin !== '')
  const otherDirty = connectionDirty || pinDirty || dirtyRegistry.anyDirty
  const [pendingSection, setPendingSection] = useState<SettingsSectionId | null>(null)

  const discardDrafts = () => {
    setConnectionCode(savedConnectionCode)
    setPin('')
    setConfirmPin('')
    setEditingPin(false)
    dirtyRegistry.clear()
  }

  const handleClose = () => {
    if (hardwareAction || savingLanguage) return
    if (hardwareDirty || otherDirty) {
      setPendingSection(null)
      setShowDiscardChanges(true)
    }
    else onClose()
  }

  const runHardwareAction = async (action: string, operation: () => Promise<unknown>) => {
    if (hardwareAction) return
    setHardwareAction(action)
    setHardwareActionError('')
    try {
      requireSettingsSuccess(await operation())
    } catch (error) {
      console.warn('[ConnectionSettings] Hardware action failed:', error)
      setHardwareActionError(getErrorMessage(error, t('settings.peripherals.actionFailed', 'Action failed')))
      toast.error(t('settings.peripherals.actionFailed', 'Action failed'))
    } finally {
      await refreshHardware()
      setHardwareAction(null)
    }
  }

  // Detected serial ports, offered as suggestions next to every "Port" field.
  const [serialPorts, setSerialPorts] = useState<string[]>([])
  useEffect(() => {
    if (!isOpen || activeSettingsSection !== 'hardware') return
    let cancelled = false
    void Promise.resolve(bridge.hardware?.listSerialPorts?.())
      .then((result: unknown) => {
        const list = Array.isArray(result) ? result : (result as { ports?: unknown })?.ports
        if (!cancelled && Array.isArray(list)) {
          setSerialPorts(list.map((port: any) => String(port?.name ?? port)).filter(Boolean))
        }
      })
      .catch(() => { /* suggestions only; typing a port still works */ })
    return () => { cancelled = true }
  }, [activeSettingsSection, bridge, isOpen])

  const saveHardwareSettings = async (options?: { quiet?: boolean }): Promise<boolean> => {
    if (hardwareAction) return false
    setHardwareAction('save')
    setHardwareActionError('')
    try {
      const results = await Promise.allSettled([
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
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason
        requireSettingsSuccess(result.value)
      }
      setHardwareBaseline(hardwareSignature)
      if (!options?.quiet) toast.success(t('settings.workflow.hardwareSavedPlain', { defaultValue: 'Device settings saved.' }))
      return true
    } catch (e) {
      console.error('Failed to save hardware settings:', e)
      setHardwareActionError(getErrorMessage(e, t('settings.peripherals.saveFailed', 'Failed to save peripheral settings')))
      toast.error(t('settings.peripherals.saveFailed', 'Failed to save peripheral settings'))
      return false
    } finally {
      setHardwareAction(null)
    }
  }

  // Connect saves the device details first when they changed: one step for the cashier.
  const connectWithSave = async (action: string, operation: () => Promise<unknown>) => {
    if (hardwareAction) return
    if (hardwareDirty && !(await saveHardwareSettings({ quiet: true }))) return
    await runHardwareAction(action, operation)
  }

  // One plain status line per device (wave 7Δ2), not a tinted chip.
  const deviceStatusLine = (connected: boolean, enabled: boolean) => {
    const [tone, label] = connected
      ? ['ok', t('settings.peripherals.state.connected', 'Connected')] as const
      : enabled
        ? ['warn', t('settings.peripherals.state.notConnected', 'Not connected yet')] as const
        : ['idle', t('settings.peripherals.state.off', 'Off')] as const
    return <StatusLine tone={tone}>{label}</StatusLine>
  }

  // Cancel in the devices footer: back to what is saved (the baseline the dirty check compares with).
  const restoreHardwareDraft = () => {
    if (!hardwareBaseline) return
    const saved = JSON.parse(hardwareBaseline) as Record<string, any>
    setScaleEnabled(saved.scaleEnabled); setScalePort(saved.scalePort); setScaleBaudRate(saved.scaleBaudRate); setScaleProtocol(saved.scaleProtocol)
    setDisplayEnabled(saved.displayEnabled); setDisplayConnectionType(saved.displayConnectionType); setDisplayPort(saved.displayPort)
    setDisplayBaudRate(saved.displayBaudRate); setDisplayTcpPort(saved.displayTcpPort)
    setScannerEnabled(saved.scannerEnabled); setScannerPort(saved.scannerPort); setScannerBaudRate(saved.scannerBaudRate)
    setCardReaderEnabled(saved.cardReaderEnabled); setLoyaltyEnabled(saved.loyaltyEnabled)
  }

  const renderPortField = (id: string, label: string, value: string, onChange: (next: string) => void, placeholder: string) => (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1 liquid-glass-modal-text">{label}</label>
      <input id={id} list="settings-serial-port-options" value={value} onChange={e => onChange(e.target.value)} className="liquid-glass-modal-input w-full max-w-sm" placeholder={placeholder} />
      <p className="mt-1 text-xs liquid-glass-modal-text-muted">
        {serialPorts.length
          ? t('settings.peripherals.portsFound', { defaultValue: 'Found on this computer: {{ports}}', ports: serialPorts.join(', ') })
          : t('settings.peripherals.portsNoneFound', { defaultValue: 'No ports found. Check the cable, then reopen this page.' })}
      </p>
    </div>
  )

  const renderConnectButton = (
    action: string,
    connected: boolean,
    connectLabel: string,
    disconnectLabel: string,
    connect: () => Promise<unknown>,
    disconnect: () => Promise<unknown>,
  ) => (
    <button
      type="button"
      disabled={Boolean(hardwareAction) || hardwareLoading || !settingsLoaded}
      onClick={() => void (connected ? runHardwareAction(action, disconnect) : connectWithSave(action, connect))}
      className={solidButton(connected ? 'danger' : 'primary', 'md') + ' self-start'}
    >
      {connected ? disconnectLabel : connectLabel}
    </button>
  )

  const handleLanguageChange = async (language: 'en' | 'el' | 'de' | 'fr' | 'it' | 'sq') => {
    if (savingLanguage || language === currentLanguage) return
    setSavingLanguage(true)
    try {
      await setLanguage(language)
      toast.success(t('modals.connectionSettings.languageSaved'))
    } catch (error) {
      console.warn('[ConnectionSettings] Language save failed:', error)
      toast.error(t('settings.workflow.saveFailed', { defaultValue: 'Could not save this setting. Please try again.' }))
    } finally {
      setSavingLanguage(false)
    }
  }

  const applyRuntimeConfig = useCallback((config: any) => {
    if (!config || typeof config !== 'object') return
    if (typeof config.terminal_id === 'string') setRuntimeTerminalId(config.terminal_id)
    if (typeof config.admin_dashboard_url === 'string') setRuntimeAdminUrl(config.admin_dashboard_url)
    if (typeof config.sync_health === 'string') setRuntimeSyncHealth(config.sync_health)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const update = (payload: any) => applyRuntimeConfig(payload?.config ?? payload)
    onEvent('terminal-config-updated', update)
    return () => offEvent('terminal-config-updated', update)
  }, [isOpen, applyRuntimeConfig])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setSettingsLoaded(false)
    setSettingsLoadFailed(false)
    setRuntimeSyncHealth('unknown')
    setHardwareBaseline(null)
    setShowDiscardChanges(false)
    setConnectionCode('')
    setSavedConnectionCode('')
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

    // Read the local snapshot immediately; refresh is an explicit user action.
    const loadLocalTerminalSettings = async () => {
      try {
        const [localSettings, runtimeConfig] = await Promise.all([
          bridge.settings.getLocal(),
          bridge.terminalConfig.getFullConfig().catch(() => null),
        ])
        if (cancelled) return

        const settingsMap = (localSettings && typeof localSettings === 'object')
          ? localSettings as Record<string, any>
          : {}
        const runtime = (runtimeConfig && typeof runtimeConfig === 'object')
          ? runtimeConfig as Record<string, any>
          : {}

        setRuntimeTerminalId(parseStringSetting(runtime.terminal_id, parseStringSetting(settingsMap?.terminal?.terminal_id, '')))
        setRuntimeAdminUrl(parseStringSetting(runtime.admin_dashboard_url, parseStringSetting(settingsMap?.terminal?.admin_dashboard_url, '')))
        setRuntimeSyncHealth(parseStringSetting(runtime.sync_health, 'unknown'))

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
        setSettingsLoaded(true)
      } catch (error) {
        if (cancelled) return
        setSettingsLoadFailed(true)
        console.warn('[ConnectionSettings] Failed to load local terminal settings:', error)
      }
    }

    void loadLocalTerminalSettings()
    return () => { cancelled = true }
  }, [isOpen, settingsLoadAttempt])

  useEffect(() => {
    if (!isOpen) return
    // Health > recovery opens Backups & recovery; Health > "Check the printer" opens Printers &
    // receipts; the old Connection / Info / This register names open Status & connection.
    const target = resolveSettingsDeepLink(initialSection)
    if (target) setActiveSettingsSection(target)
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

  // Lazy-load the version and build details when Status & connection is shown.
  useEffect(() => {
    if (!isOpen || activeSettingsSection !== 'status' || aboutData) return
    let cancelled = false
    setAboutError(false)
    // Settings opens on this section, so a missing or failing diagnostics bridge must only
    // show the retry line, never break the screen.
    Promise.resolve()
      .then(() => bridge.diagnostics.getAbout())
      .then((data) => { if (!cancelled) setAboutData(requireSettingsSuccess(data)) })
      .catch((err: unknown) => { if (!cancelled) setAboutError(true); console.error('Failed to load about info:', err) })
    return () => { cancelled = true }
  }, [isOpen, activeSettingsSection, aboutData, aboutRetry, bridge.diagnostics])

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
      try { await navigator.clipboard.writeText(text) }
      catch { await bridge.clipboard.writeText(text) }
      setAboutCopied(true)
      setTimeout(() => setAboutCopied(false), 2000)
    } catch { toast.error(t('settings.workflow.copyFailed', { defaultValue: 'Could not copy device information. Please try again.' })) }
  }

  // Navigation: the left rail selects which section is shown. Each section now
  // renders its content directly (no inner accordion), so selecting is all we do.
  const openSection = (section: SettingsSectionId) => {
    // Drafts that live inside a section (waiter permissions, efood hours) are lost when it
    // closes, so leaving that section asks first.
    if (section !== activeSettingsSection && dirtyRegistry.anyDirty) {
      setPendingSection(section)
      setShowDiscardChanges(true)
      return
    }
    setActiveSettingsSection(section)
  }

  // A short pulse on a Save button that just succeeded (CSS .pos-saved; off under reduce motion).
  const [savedPulse, setSavedPulse] = useState<string | null>(null)
  const pulseSaved = (id: string) => {
    setSavedPulse(id)
    window.setTimeout(() => setSavedPulse(current => (current === id ? null : current)), 400)
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
      requireSettingsSuccess(await bridge.settings.updateTerminalCredentials({
        terminalId: nextTerminalId,
        apiKey: nextApiKey,
        adminUrl: normalizedAdminDashboardUrl,
        adminDashboardUrl: normalizedAdminDashboardUrl,
        supabaseUrl: nextSupabaseUrl,
        supabaseAnonKey: nextSupabaseAnonKey,
      }))
      localStorage.removeItem('activeShift')
      localStorage.removeItem('staff')
      const syncResult = requireSettingsSuccess(await bridge.terminalConfig.syncFromAdmin())
      const runtimeConfig = syncResult?.data?.config
      applyRuntimeConfig(runtimeConfig)

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
          ? t('modals.connectionSettings.connectionSavedSyncing', 'Connection saved. Syncing data…')
          : t('modals.connectionSettings.connectionSaved')
      )
      setSavedConnectionCode(connectionCode)
      pulseSaved('connection')
    } catch (e: any) {
      console.warn('Failed to update credentials or trigger sync:', e)
      toast.error(e?.message || t('modals.connectionSettings.networkError'))
    }
  }

  const handleManualPolicySync = async () => {
    if (isSyncingSettings) return
    setIsSyncingSettings(true)
    try {
      const syncResult: any = requireSettingsSuccess(await bridge.terminalConfig.syncFromAdmin())
      const runtimeConfig = syncResult?.data?.config || syncResult?.config || await bridge.terminalConfig.getFullConfig()
      applyRuntimeConfig(runtimeConfig)

      const localSettings = await bridge.settings.getLocal()
      const settingsMap = (localSettings && typeof localSettings === 'object')
        ? localSettings as Record<string, any>
        : {}
      setPinResetRequired(parseBooleanSetting(getNestedSetting(settingsMap, 'terminal', 'pin_reset_required')))

      toast.success(t('settings.deviceSetup.synced', 'Settings synced'))
    } catch (error: any) {
      console.error('[ConnectionSettings] Failed to sync settings:', error)
      toast.error(error?.message || t('settings.deviceSetup.syncFailed', 'Could not sync settings'))
    } finally {
      setIsSyncingSettings(false)
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
      requireSettingsSuccess(await bridge.auth.setupPin({
        staffPin: pin
      }))
    } catch (e) {
      console.warn('Failed to persist secure PIN hash to main process:', e)
      toast.error(t('modals.connectionSettings.pinSaveError', { defaultValue: 'Failed to save PIN' }))
      return
    }

    // The PIN screen signs in by itself at the PIN's length: keep the new staff PIN's digit count.
    void rememberLoginPinLength(bridge, ['staff'], pin.length)
    toast.success(t('modals.connectionSettings.pinSaved'))
    setPinResetRequired(false)
    setEditingPin(false)
  }

  const handleReceiptPrintPromptToggle = async (enabled: boolean) => {
    const previous = receiptPrintPromptEnabled
    setReceiptPrintPromptEnabled(enabled)
    try {
      requireSettingsSuccess(await bridge.settings.updateLocal({
        settingType: 'receipt',
        settings: {
          ask_before_print: enabled,
        }
      }))
      toast.success(t('settings.printer.receiptPromptSaved', 'Receipt print prompt setting saved'))
    } catch (error) {
      setReceiptPrintPromptEnabled(previous)
      console.error('[ConnectionSettings] Failed to save receipt print prompt setting:', error)
      toast.error(t('settings.printer.receiptPromptSaveFailed', 'Failed to save receipt print prompt setting'))
    }
  }

  const handleSaveTheme = (newTheme: 'light' | 'dark' | 'auto') => {
    try {
      setTheme(newTheme)
      toast.success(t('modals.connectionSettings.themeUpdated'))
    } catch {
      toast.error(t('settings.workflow.saveFailed', { defaultValue: 'Could not save this setting. Please try again.' }))
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

  const resolvedTerminalTypeLabel =
    terminalType === 'mobile_waiter'
      ? t('settings.terminal.type.mobile_waiter', 'Mobile POS')
      : t('settings.terminal.type.main', 'Main Terminal')
  // The till's own name on the main till; on any other till, the main till it belongs to.
  const terminalOwnerLabel = ownerTerminalId
    ? terminalType === 'main'
      ? t('settings.status.tillName', { name: ownerTerminalId, defaultValue: 'Till name: {{name}}' })
      : t('settings.status.mainTill', { name: ownerTerminalId, defaultValue: 'Main till: {{name}}' })
    : null
  const syncHealth = resolveTerminalConfigHealth(runtimeSyncHealth)
  const syncHealthLabel = syncHealth.isHealthy ? t('settings.workflow.configHealthyLabel', 'Settings up to date') : t(`settings.managedByAdmin.syncHealth.${runtimeSyncHealth}`, {
    defaultValue: runtimeSyncHealth,
  })
  const isSyncHealthy = syncHealth.isHealthy
  const syncStatusTone = ({ success: 'ok', warning: 'warn', danger: 'bad', neutral: 'idle' } as const satisfies Record<string, StatusTone>)[syncHealth.tone]
  const syncStatusTitle = isSyncHealthy
    ? t('settings.workflow.configHealthyTitle', 'Settings are up to date')
    : syncHealth.state === 'stale'
      ? t('settings.workflow.configStaleTitle', 'Settings need refreshing')
      : syncHealth.state === 'unknown'
        ? t('settings.workflow.configUnknownTitle', 'Checking settings status')
        : t('settings.workflow.configProblemTitle', 'Settings sync needs attention')
  const syncStatusHelp = isSyncHealthy
    ? t('settings.workflow.configHealthyHelp', 'This till has a recent settings snapshot. Orders and device connections have their own status.')
    : syncHealth.state === 'unknown'
      ? t('settings.workflow.configUnknownHelp', 'The settings status is not available yet. You can refresh it below.')
      : t('settings.workflow.configProblemHelp', 'Refresh settings below. If this fails, open Connection and check the connection details with your administrator.')
  // Rail labels are also the section titles (one name per place).
  const sectionLabels: Record<SettingsSectionId, string> = {
    status: t('settings.settingsHub.nav.status', 'Status & connection'),
    platforms: t('settings.settingsHub.nav.platforms', 'Platforms'),
    printing: t('settings.settingsHub.nav.printing', 'Printers & receipts'),
    payments: t('settings.settingsHub.nav.payments', 'Cards & cash register'),
    hardware: t('settings.settingsHub.nav.hardware', 'Scale, display, scanner'),
    waiter_devices: t('settings.settingsHub.nav.waiter_devices', 'Waiter phones'),
    terminal: t('settings.settingsHub.nav.terminal', 'Display & sound'),
    security: t('settings.settingsHub.nav.security', 'PIN & lock'),
    database: t('settings.settingsHub.nav.database', 'Backups & recovery'),
  }
  const sectionIntros: Partial<Record<SettingsSectionId, string>> = {
    status: t('settings.settingsHub.intro.status', 'What this till does and whether it is connected.'),
    terminal: t('settings.settingsHub.intro.terminal', 'Changes here apply immediately.'),
    hardware: t('settings.peripherals.helpText', 'Configure external hardware devices'),
    printing: t('settings.settingsHub.intro.printing', 'The printers of this till and how receipts print.'),
    payments: t('settings.settingsHub.intro.payments', 'The card machines (bank POS) and the cash register of this till.'),
  }
  const navGroupLabels: Record<SettingsNavGroupId, string> = {
    register: t('settings.settingsHub.navGroups.register', 'This till'),
    devices: t('settings.settingsHub.navGroups.devices', 'Devices'),
    appearance: t('settings.settingsHub.navGroups.appearance', 'Appearance & security'),
  }

  // Neutral line icons: the open row's fill and bar are the only accent in the rail.
  const settingsNav: Array<{ id: SettingsSectionId; icon: React.ReactNode }> = [
    { id: 'status', icon: <Wifi className="pos-rail-item__icon" aria-hidden="true" /> },
    { id: 'platforms', icon: <Store className="pos-rail-item__icon" aria-hidden="true" /> },
    { id: 'printing', icon: <Printer className="pos-rail-item__icon" aria-hidden="true" /> },
    { id: 'payments', icon: <CreditCard className="pos-rail-item__icon" aria-hidden="true" /> },
    { id: 'hardware', icon: <Cable className="pos-rail-item__icon" aria-hidden="true" /> },
    { id: 'waiter_devices', icon: <Smartphone className="pos-rail-item__icon" aria-hidden="true" /> },
    { id: 'terminal', icon: <Monitor className="pos-rail-item__icon" aria-hidden="true" /> },
    { id: 'security', icon: <Lock className="pos-rail-item__icon" aria-hidden="true" /> },
    { id: 'database', icon: <Database className="pos-rail-item__icon" aria-hidden="true" /> },
  ]

  // Nine sections in three groups; waiter phones only on the main till (the server enforces
  // the same rule with 403 WAITER_MGMT_MAIN_ONLY).
  const isMainTerminal = terminalType === 'main'
  const settingsNavGroups = buildSettingsNavGroups(isMainTerminal)
  const efoodPartner = useEfoodPartner()

  // Calm, non-clickable header for a detail section: a standalone line icon beside
  // a plain title (and optional one-line help).
  return (
    <SettingsDirtyProvider report={dirtyRegistry.report}>
    <LiquidGlassModal
      recoveryAccess
      isOpen={isOpen}
      onClose={handleClose}
      closeMode="request"
      closeDisabled={Boolean(hardwareAction) || savingLanguage}
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
            onClick={handleClose}
            disabled={Boolean(hardwareAction) || savingLanguage}
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
      className="max-w-[min(1180px,96vw)]! max-h-[min(900px,94vh)]!"
      contentClassName="overflow-hidden! p-4! sm:p-5!"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <div
        data-settings-hub
        className="settings-hub flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          {/* Left column — the settings navigation list. One row per area; the
              active row carries the single yellow accent. */}
          <nav
            aria-label={t('modals.connectionSettings.title')}
            className="min-h-0 space-y-3 overflow-y-auto overflow-x-hidden pr-1 scrollbar-thin lg:pr-2"
          >
            {settingsNavGroups.map((group) => (
              <div key={group.id} className="space-y-1">
                <div className="pos-rail-group">{navGroupLabels[group.id]}</div>
                {group.items.map((id) => {
                  const isActive = activeSettingsSection === id
                  const navItem = settingsNav.find((entry) => entry.id === id)
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => openSection(id)}
                      aria-current={isActive ? 'page' : undefined}
                      className={'pos-rail-item' + (isActive ? ' is-active' : '')}
                    >
                      {navItem?.icon}
                      <span className="pos-rail-item__label">{sectionLabels[id]}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>

          {/* Right column — the active section body. */}
          <div ref={detailScrollRef} key={activeSettingsSection} className="pos-enter min-h-0 space-y-3 overflow-y-auto overflow-x-hidden pr-1 scrollbar-thin lg:pr-2">
          <header className="pos-pane-head">
            <h3 className="pos-pane-title">{sectionLabels[activeSettingsSection]}</h3>
            {sectionIntros[activeSettingsSection] && <p className="pos-pane-intro">{sectionIntros[activeSettingsSection]}</p>}
          </header>
          {settingsLoadFailed && <div role="alert" className="pos-notice pos-notice--warn pos-notice--stack">
            <p className="text-sm liquid-glass-modal-text">{t('settings.workflow.deviceLoadFailed', { defaultValue: 'Could not read saved device settings. Retry before changing device connections.' })}</p>
            <button type="button" onClick={() => setSettingsLoadAttempt(value => value + 1)} className={liquidGlassModalButton('secondary', 'md')}>{t('common.retry', 'Retry')}</button>
          </div>}
        {/* Status & connection (UI audit wave 7B): the former This register, Connection and Info
            sections in one place. One status, one Sync now, the connection code, and the version at
            the bottom. Technical fields and build details stay behind a "for technicians" row. */}
        {activeSettingsSection === 'status' && (
        <div id="settings-section-status" data-settings-status className="space-y-4">
          <SettingsGroup id="settings-status-register" title={t('settings.settingsHub.status.register', 'This register')}>
            <SettingsRow title={resolvedTerminalTypeLabel} help={terminalOwnerLabel ?? undefined} />
            <div data-register-status-card className="pos-row">
              <div className="pos-row__label">
                <span className="pos-row__title">{syncStatusTitle}</span>
                <span className="pos-row__help">{syncStatusHelp}</span>
                <StatusLine tone={syncStatusTone}>{syncHealthLabel}</StatusLine>
              </div>
              <div className="pos-row__control">
                <button
                  type="button"
                  data-register-sync-action
                  onClick={handleManualPolicySync}
                  disabled={isSyncingSettings}
                  className={solidButton('secondary', 'sm')}
                >
                  <RefreshCw className={`h-4 w-4 shrink-0${isSyncingSettings ? ' animate-spin' : ''}`} aria-hidden="true" />
                  {isSyncingSettings ? t('settings.workflow.syncing', 'Syncing…') : t('sync.syncNow', 'Sync now')}
                </button>
              </div>
            </div>
            <SettingsRow
              title={t('settings.status.staffPin', 'Staff PIN')}
              help={pinResetRequired
                ? t('settings.deviceSetup.pinResetRequired', 'A new PIN is required at next sign-in.')
                : t('settings.deviceSetup.pinResetClear', 'No PIN reset pending.')}
              control={(
                <StatusLine tone={pinResetRequired ? 'warn' : 'ok'}>
                  {pinResetRequired
                    ? t('settings.deviceSetup.overview.pinResetShort', 'New PIN needed')
                    : t('settings.deviceSetup.overview.pinOkShort', 'PIN ready')}
                </StatusLine>
              )}
            />
            <p className="pos-row pos-row__help">{t('settings.workflow.capabilitiesHelp', { defaultValue: 'Permissions and available areas are managed by your administrator.' })}</p>
          </SettingsGroup>

          <SettingsGroup id="settings-section-connection" title={t('settings.status.account', 'Link to your account')}>
            <div className="pos-row pos-row--stack">
              <label htmlFor="settings-connection-code" className="pos-row__title">
                {t('onboarding.connectionString', { defaultValue: 'Connection Code' })}
              </label>
              <span className="pos-row__help">
                {t('settings.deviceSetup.connectionCodeHelp', { defaultValue: 'Paste the connection code from your dashboard.' })}
              </span>
              <textarea
                id="settings-connection-code"
                aria-label={t('onboarding.connectionString', { defaultValue: 'Connection Code' })}
                value={connectionCode}
                onChange={e => setConnectionCode(e.target.value)}
                className="liquid-glass-modal-input w-full min-h-[72px] font-mono text-xs"
                placeholder={t('onboarding.connectionStringPlaceholder', { defaultValue: 'Paste connection code here...' })}
              />
              <div data-connection-action-bar className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={handlePasteBoth}
                  aria-label={t('modals.connectionSettings.pasteBothTooltip')}
                  className={solidButton('secondary', 'md')}
                >
                  <Clipboard className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t('modals.connectionSettings.pasteBoth')}
                </button>
                <button
                  type="button"
                  data-connection-primary-action
                  onClick={handleSaveConnection}
                  className={solidButton('primary', 'md') + (savedPulse === 'connection' ? ' pos-saved' : '')}
                >
                  <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t('modals.connectionSettings.save')}
                </button>
              </div>
            </div>
            {allowManualCredentials && (
              <TechDisclosure title={t('settings.printer.forTechnicians', 'Settings for technicians')}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block text-sm font-medium liquid-glass-modal-text">
                    {t('settings.deviceSetup.registerId', 'Register ID')}
                    <input
                      value={terminalId}
                      aria-label={t('settings.deviceSetup.registerId', 'Register ID')}
                      onChange={e => setTerminalId(e.target.value)}
                      className="liquid-glass-modal-input mt-1 w-full"
                      placeholder={t('modals.connectionSettings.terminalPlaceholder')}
                    />
                  </label>
                  <label className="block text-sm font-medium liquid-glass-modal-text">
                    {t('settings.deviceSetup.dashboardAddress', 'Dashboard address')}
                    <input
                      value={adminDashboardUrl}
                      aria-label={t('settings.deviceSetup.dashboardAddress', 'Dashboard address')}
                      onChange={e => setAdminDashboardUrl(e.target.value)}
                      className="liquid-glass-modal-input mt-1 w-full"
                      placeholder={t('settings.deviceSetup.dashboardAddressPlaceholder', { defaultValue: 'https://your-dashboard.example.com' })}
                    />
                  </label>
                </div>
                <label className="block text-sm font-medium liquid-glass-modal-text">
                  {t('settings.deviceSetup.posKey', 'POS key')}
                  <span className="relative mt-1 block">
                    <input
                      value={apiKey}
                      aria-label={t('settings.deviceSetup.posKey', 'POS key')}
                      onChange={e => setApiKey(e.target.value)}
                      type={showApiKey ? 'text' : 'password'}
                      className="liquid-glass-modal-input w-full pr-12"
                      placeholder={t('modals.connectionSettings.apiKeyPlaceholder')}
                    />
                    <button
                      type="button"
                      aria-label={showApiKey ? t('common.hide') : t('common.show')}
                      onClick={() => setShowApiKey(v => !v)}
                      className="absolute right-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg liquid-glass-modal-text-muted active:scale-95"
                    >
                      {showApiKey ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </span>
                </label>
                <div>
                  <button type="button" onClick={handleTest} className={solidButton('secondary', 'md')}>
                    {t('modals.connectionSettings.test')}
                  </button>
                </div>
              </TechDisclosure>
            )}
          </SettingsGroup>

          <SettingsGroup id="settings-status-version">
            <SettingsRow
              title={aboutData
                ? t('updates.available.version', { version: aboutData.version, defaultValue: 'Version {{version}}' })
                : t('modals.connectionSettings.aboutVersion', 'Version')}
              help={aboutData?.buildTimestamp}
              control={onCheckForUpdates ? (
                <button type="button" onClick={onCheckForUpdates} className={solidButton('secondary', 'sm')}>
                  <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t('updates.actions.checkNow', 'Check for updates')}
                </button>
              ) : undefined}
            />
            <TechDisclosure title={t('settings.status.deviceDetails', 'Device details')}>
              {aboutData ? (
                <>
                  <dl className="divide-y liquid-glass-modal-border">
                    {[
                      { label: t('modals.connectionSettings.aboutBuildDate'), value: aboutData.buildTimestamp },
                      { label: t('modals.connectionSettings.aboutGitSha'), value: aboutData.gitSha },
                      { label: t('modals.connectionSettings.aboutPlatform'), value: `${aboutData.platform} (${aboutData.arch})` },
                      { label: t('modals.connectionSettings.aboutRust'), value: aboutData.rustVersion },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex items-center justify-between gap-4 py-2">
                        <dt className="text-sm liquid-glass-modal-text-muted">{label}</dt>
                        <dd className="text-sm font-mono liquid-glass-modal-text">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div>
                    <button type="button" onClick={handleCopyAboutInfo} className={solidButton('secondary', 'md')}>
                      {aboutCopied ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : <Copy className="h-4 w-4 shrink-0" aria-hidden="true" />}
                      {aboutCopied ? t('modals.connectionSettings.aboutCopied') : t('modals.connectionSettings.aboutCopyInfo')}
                    </button>
                  </div>
                </>
              ) : aboutError ? (
                <div role="alert" className="space-y-3">
                  <p className="text-sm liquid-glass-modal-text">{t('settings.workflow.aboutLoadFailed', { defaultValue: 'Could not load device information.' })}</p>
                  <button type="button" onClick={() => setAboutRetry(value => value + 1)} className={solidButton('secondary', 'md')}>{t('common.retry', 'Retry')}</button>
                </div>
              ) : (
                <div className="py-2"><div className="mx-auto h-6 w-6 animate-spin rounded-full border-b-2 border-zinc-500" /></div>
              )}
            </TechDisclosure>
          </SettingsGroup>
        </div>
        )}


        {/* PIN Settings */}
        {activeSettingsSection === 'security' && (
        <section id="settings-section-security" className="pos-group">
          <div className={editingPin ? 'pos-row pos-row--stack' : 'pos-row'}>
            <div className="pos-row__label">
              <span className="pos-row__title">{t('modals.connectionSettings.pinSetup', 'Local PIN')}</span>
              <span className="pos-row__help">
                {pinResetRequired
                  ? t('settings.deviceSetup.pinResetRequired', 'A new PIN is required at next sign-in.')
                  : pin && !editingPin
                    ? '••••'
                    : t('settings.security.pinHelp', 'Local staff authentication')}
              </span>
            </div>
          {!editingPin ? (
            <div className="pos-row__control">
              <button
                type="button"
                onClick={() => setEditingPin(true)}
                className={SAVE_BTN_MD}
              >
                {t('modals.connectionSettings.changePin')}
              </button>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="settings-new-pin" className="block text-sm font-medium mb-1 liquid-glass-modal-text">{t('modals.connectionSettings.newPin')}</label>
                <input
                  id="settings-new-pin"
                  value={pin}
                  onChange={e => setPin(e.target.value.replace(/[^0-9]/g, ''))}
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  className="liquid-glass-modal-input w-full max-w-xs"
                  placeholder={t('modals.connectionSettings.enterPin')}
                />
              </div>
              <div>
                <label htmlFor="settings-confirm-pin" className="block text-sm font-medium mb-1 liquid-glass-modal-text">{t('modals.connectionSettings.confirmPin')}</label>
                <input
                  id="settings-confirm-pin"
                  value={confirmPin}
                  onChange={e => setConfirmPin(e.target.value.replace(/[^0-9]/g, ''))}
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  className="liquid-glass-modal-input w-full max-w-xs"
                  placeholder={t('modals.connectionSettings.confirmPinPlaceholder')}
                />
              </div>
              <div className="flex gap-2 pt-1">
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
        </section>
        )}

        {/* Theme Switcher */}
        {activeSettingsSection === 'terminal' && (
        <>
        {/* Appearance and language: labelled choices (not bare icons or codes) so a
            cashier can read every option. Languages show in their own name. */}
        <section id="settings-section-terminal" data-settings-appearance className="pos-group">
          <header className="pos-group__head">
            <h3 className="pos-group__title">{t('modals.connectionSettings.theme')}</h3>
          </header>
          <div className="px-5 pb-4">
          {/* Solid segmented choice (founder 30/10: no translucent selected wash). */}
          <SegmentedControl
            ariaLabel={t('modals.connectionSettings.theme')}
            value={theme}
            onChange={(value) => handleSaveTheme(value)}
            options={[
              { value: 'light', label: <><Sun className="h-4 w-4 shrink-0" aria-hidden="true" />{t('modals.connectionSettings.light')}</> },
              { value: 'dark', label: <><Moon className="h-4 w-4 shrink-0" aria-hidden="true" />{t('modals.connectionSettings.dark')}</> },
              { value: 'auto', label: <><Monitor className="h-4 w-4 shrink-0" aria-hidden="true" />{t('modals.connectionSettings.themeAutoDayNight', 'Automatic (day / night)')}</> },
            ]}
          />
          </div>
        </section>

        <section data-settings-language className="pos-group">
          <header className="pos-group__head">
            <h3 className="pos-group__title">{t('modals.connectionSettings.language')}</h3>
          </header>
          <div className="px-5 pb-4">
          {/* Each language in its own name; the accessible name stays the translated settings.display.lang* key. */}
          <SegmentedControl
            ariaLabel={t('modals.connectionSettings.language')}
            value={currentLanguage as SupportedLanguage}
            disabled={savingLanguage}
            columns={3}
            onChange={(code) => void handleLanguageChange(code)}
            options={([
              { code: 'el', name: 'Ελληνικά', aria: 'settings.display.langGreek' },
              { code: 'en', name: 'English', aria: 'settings.display.langEnglish' },
              { code: 'de', name: 'Deutsch', aria: 'settings.display.langGerman' },
              { code: 'fr', name: 'Français', aria: 'settings.display.langFrench' },
              { code: 'it', name: 'Italiano', aria: 'settings.display.langItalian' },
              { code: 'sq', name: 'Shqip', aria: 'settings.display.langAlbanian' },
            ] as const).map(({ code, name, aria }) => ({ value: code, label: name, lang: code, ariaLabel: t(aria) }))}
          />
          </div>
        </section>

        <SettingsRuntimePreferences
          soundExtras={(
            <>
              <PlatformNotificationSoundSettings />
              {efoodPartner.efoodControllable && (
                <SettingsGroup>
                  <SettingsRow
                    title={<span id="settings-efood-mute-label">{t('settings.platforms.efoodPartner.mute', 'Mute efood sounds')}</span>}
                    help={t('settings.display.efoodMuteHelp', 'On the efood page inside the POS')}
                    control={(
                      <POSGlassSwitch
                        aria-labelledby="settings-efood-mute-label"
                        checked={efoodPartner.settings.muted}
                        onChange={(muted: boolean) => efoodPartner.updateSettings({ muted })}
                      />
                    )}
                  />
                </SettingsGroup>
              )}
            </>
          )}
        />
        </>
        )}

        {/* Native sessions expire independently of display/power preferences. */}
        {activeSettingsSection === 'security' && (
          <section data-session-timeout-card className="pos-group">
            <header className="pos-group__head">
              <h3 className="pos-group__title">{t('settings.workflow.sessionTitle', 'Session access')}</h3>
              <p className="pos-group__desc">{t('settings.workflow.sessionHelp', 'The POS requires your PIN again when the authenticated session expires.')}</p>
            </header>
            <div className="space-y-2 px-5 pb-4">
              <p className="text-sm liquid-glass-modal-text">{t('settings.workflow.sessionLimits', 'This version uses a 30-minute inactivity limit and a maximum session duration of 2 hours. Custom auto-lock timing is not available.')}</p>
              <p className="text-sm liquid-glass-modal-text-muted">{t('settings.workflow.sessionShift', 'Signing in again does not close the active shift. Windows screen sleep is configured separately under Screen & Sound.')}</p>
            </div>
          </section>
        )}

        {/* Database Management */}
        {activeSettingsSection === 'database' && (
        <div id="settings-section-database" className="space-y-4">
          <div className="flex flex-col gap-4 pb-24">
                <RecoveryPanel />

                {/* Zone 2 — Safe fixes: maintenance that keeps the operator's data (kit rows, neutral). */}
                <section data-database-safe-fixes className="pos-group">
                  <header className="pos-group__head">
                    <h3 className="pos-group__title">{t('settings.database.repairToolsTitle', 'Safe fixes')}</h3>
                    <p className="pos-group__desc">{t('settings.database.repairToolsHelp', 'Keeps your data')}</p>
                  </header>

                  {/* Clear Sync Queue */}
                  <div className="pos-row">
                    <div className="pos-row__label">
                      <span className="pos-row__title">{t('settings.database.clearSyncQueueLabel', 'Clear Sync Queue')}</span>
                      <span className="pos-row__help">{t('settings.database.clearSyncQueueHelp', 'Clears stuck sync items without deleting data')}</span>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          // Gap review P0: clear-sync-queue now requires SystemControl —
                          // run it through the admin-PIN elevation flow (factory-reset pattern).
                          const result = await runWithPrivilegedConfirmation({
                            scope: 'system_control',
                            action: () => bridge.sync.clearAll(),
                            title: t('settings.database.clearSyncQueuePinTitle', 'Confirm clear sync queue'),
                            subtitle: t('settings.database.clearSyncQueuePinSubtitle', 'Enter the admin PIN to clear stuck sync items.'),
                          }) as any
                          if (result?.success) {
                            toast.success(t('settings.database.syncQueueCleared', { count: result.cleared }))
                          } else {
                            throw new Error(result?.error || 'Unknown error')
                          }
                        } catch (e) {
                          console.error('Failed to clear sync queue:', e)
                          toast.error(getErrorMessage(e, t('settings.database.syncQueueClearFailed')))
                        }
                      }}
                      className={DB_REPAIR_BTN_MD}
                    >
                      {t('settings.database.repairQueueButton', 'Fix queue')}
                    </button>
                  </div>

                  {/* Clear Old Orders */}
                  <div className="pos-row">
                    <div className="pos-row__label">
                      <span className="pos-row__title">{t('settings.database.clearOldOrdersLabel', 'Clear Old Orders')}</span>
                      <span className="pos-row__help">{t('settings.database.clearOldOrdersHelp', 'Removes orphaned orders from previous days')}</span>
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
                  <div className="pos-row">
                    <div className="pos-row__label">
                      <span className="pos-row__title">{t('settings.database.syncDeletedOrdersLabel', 'Sync Deleted Orders')}</span>
                      <span className="pos-row__help">{t('settings.database.syncDeletedOrdersHelp', 'Removes orders deleted from the dashboard')}</span>
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
                </section>

                {/* Zone 3 — Advanced reset tools: permanent deletions, COLLAPSED by default behind a
                    disclosure so they are never openly mixed with safe maintenance. The same three
                    destructive actions + their existing handlers/confirmation chain render only when an
                    operator deliberately expands. Red is reserved for the actual destructive buttons. */}
                {/* Neutral group; red is the text of the warning and of the destructive buttons only. */}
                <details data-database-danger-zone className="group pos-group">
                  <summary className="flex min-h-touch cursor-pointer list-none items-center gap-3 px-5 py-3 [&::-webkit-details-marker]:hidden">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-red-700 dark:text-red-300" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-semibold text-red-700 dark:text-red-300">{t('settings.database.advancedResetTitle', 'Advanced reset tools')}</span>
                      <span className="text-sm liquid-glass-modal-text-muted">{t('settings.database.advancedResetSummary', 'Deletes data')}</span>
                    </span>
                    <ChevronDown className="h-5 w-5 shrink-0 liquid-glass-modal-text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
                  </summary>
                  <div>
                    <p className="px-5 pb-3 text-sm liquid-glass-modal-text-muted">{t('settings.database.dangerZoneHelp', 'These actions permanently delete data and cannot be undone.')}</p>

                  {/* Clear All Orders */}
                  <div className="pos-row">
                    <div className="pos-row__label">
                      <span className="pos-row__title">{t('settings.database.clearAllOrdersLabel', 'Clear All Orders')}</span>
                      <span className="pos-row__help">{t('settings.database.clearAllOrdersHelp', 'Removes all orders including today\'s')}</span>
                      <span className="mt-1.5 inline-flex w-fit items-center rounded-full border border-zinc-300 dark:border-zinc-600 px-2 py-0.5 text-xs font-semibold text-red-800 dark:text-red-300">{t('settings.database.cannotUndo', 'Cannot be undone')}</span>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          // Gap review P0: clear-all-orders now requires SystemControl.
                          const result = await runWithPrivilegedConfirmation({
                            scope: 'system_control',
                            action: () => bridge.sync.clearAllOrders(),
                            title: t('settings.database.clearAllOrdersPinTitle', 'Confirm delete all orders'),
                            subtitle: t('settings.database.clearAllOrdersPinSubtitle', 'Enter the admin PIN to permanently delete all orders.'),
                          }) as any
                          if (result?.success) {
                            toast.success(t('settings.database.allOrdersCleared', { count: result.cleared, defaultValue: 'Cleared {{count}} orders' }))
                          } else {
                            throw new Error(result?.error || 'Unknown error')
                          }
                        } catch (e) {
                          console.error('Failed to clear all orders:', e)
                          toast.error(getErrorMessage(e, t('settings.database.allOrdersClearFailed', 'Failed to clear all orders')))
                        }
                      }}
                      className={DB_DANGER_BTN_MD}
                    >
                      {t('settings.database.dangerDeleteOrdersButton', 'Delete all orders')}
                    </button>
                  </div>

                  {/* Clear All Operational Data */}
                  <div className="pos-row">
                    <div className="pos-row__label">
                      <span className="pos-row__title">{t('settings.database.clearOperationalLabel', 'Clear All Operational Data')}</span>
                      <span className="pos-row__help">{t('settings.database.clearOperationalHelp', 'Clears orders, shifts, drawers, payments. Keeps settings.')}</span>
                      <span className="mt-1.5 inline-flex w-fit items-center rounded-full border border-zinc-300 dark:border-zinc-600 px-2 py-0.5 text-xs font-semibold text-red-800 dark:text-red-300">{t('settings.database.cannotUndo', 'Cannot be undone')}</span>
                    </div>
                    <button
                      onClick={() => setShowClearOperationalConfirm(true)}
                      className={DB_DANGER_BTN_MD}
                    >
                      {t('settings.database.dangerEraseDataButton', 'Erase operational data')}
                    </button>
                  </div>

                  {/* Factory Reset */}
                  <div className="pos-row">
                    <div className="pos-row__label">
                      <span className="pos-row__title">{t('settings.database.label')}</span>
                      <span className="pos-row__help">{t('settings.database.helpText')}</span>
                      <span className="mt-1.5 inline-flex w-fit items-center rounded-full border border-zinc-300 dark:border-zinc-600 px-2 py-0.5 text-xs font-semibold text-red-800 dark:text-red-300">{t('settings.database.cannotUndo', 'Cannot be undone')}</span>
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

        {/* Hardware Settings: one card per device with a plain state. "Connect" saves the
            card's details first, so a cashier never needs a separate Save step. */}
        {activeSettingsSection === 'hardware' && (
        <div id="settings-section-hardware" className="space-y-4">
          {hardwareError && (
            <div role="alert" className="pos-notice pos-notice--bad pos-notice--row">
              <span className="text-sm">{t('settings.workflow.hardwareUnknownPlain', { defaultValue: 'Device status is unavailable right now.' })}</span>
              <button type="button" disabled={hardwareLoading || Boolean(hardwareAction)} onClick={() => void refreshHardware()} className={solidButton('secondary', 'sm')}>
                {t('common.retry', 'Retry')}
              </button>
            </div>
          )}
          {hardwareActionError && <p role="alert" className="pos-notice pos-notice--bad text-sm">{hardwareActionError}</p>}
          <datalist id="settings-serial-port-options">
            {serialPorts.map(port => <option key={port} value={port} />)}
          </datalist>

          {/* --- Weighing Scale --- */}
          <section data-device-card="scale" className="pos-group">
            <div className="pos-row">
              <div className="pos-row__label">
                <span id="peripheral-scale-label" className="pos-row__title">{t('settings.peripherals.scale.title', 'Weighing Scale')}</span>
                {deviceStatusLine(Boolean(hardwareStatus?.scale?.connected), scaleEnabled)}
              </div>
              <div className="pos-row__control">
                <POSGlassSwitch aria-labelledby="peripheral-scale-label" checked={scaleEnabled} onChange={setScaleEnabled} />
              </div>
            </div>
            {(scaleEnabled || hardwareStatus?.scale?.connected) && (
              <>
                <div className="pos-row pos-row--stack">
                  {renderPortField('peripheral-scale-port', t('settings.peripherals.scale.portPlain', 'Port (where the cable is plugged in)'), scalePort, setScalePort, 'COM3')}
                  {renderConnectButton(
                    'scale',
                    Boolean(hardwareStatus?.scale?.connected),
                    t('settings.peripherals.scale.connect', 'Connect'),
                    t('settings.peripherals.scale.disconnect', 'Disconnect'),
                    () => bridge.hardware.scaleConnect({ port: scalePort, baud: Number(scaleBaudRate), protocol: scaleProtocol }),
                    () => bridge.hardware.scaleDisconnect(),
                  )}
                </div>
                <TechDisclosure title={t('settings.printer.forTechnicians', 'Settings for technicians')}>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="peripheral-scale-baud" className="block text-sm font-medium mb-1 liquid-glass-modal-text">{t('settings.peripherals.scale.baudRate', 'Baud Rate')}</label>
                      <select id="peripheral-scale-baud" value={scaleBaudRate} onChange={e => setScaleBaudRate(e.target.value)} className="liquid-glass-modal-input w-full">
                    <option value="2400">2400</option>
                    <option value="4800">4800</option>
                    <option value="9600">9600</option>
                    <option value="19200">19200</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="peripheral-scale-protocol" className="block text-sm font-medium mb-1 liquid-glass-modal-text">{t('settings.peripherals.scale.protocol', 'Protocol')}</label>
                      <select id="peripheral-scale-protocol" value={scaleProtocol} onChange={e => setScaleProtocol(e.target.value)} className="liquid-glass-modal-input w-full">
                        <option value="generic">{t('settings.peripherals.scale.protocolGeneric', 'Generic')}</option>
                        <option value="toledo">{t('settings.peripherals.scale.protocolToledo', 'Toledo / Mettler-Toledo')}</option>
                        <option value="cas">{t('settings.peripherals.scale.protocolCas', 'CAS')}</option>
                      </select>
                    </div>
                  </div>
                </TechDisclosure>
              </>
            )}
          </section>

          {/* --- Customer Display --- */}
          <section data-device-card="display" className="pos-group">
            <div className="pos-row">
              <div className="pos-row__label">
                <span id="peripheral-display-label" className="pos-row__title">{t('settings.peripherals.display.title', 'Customer Display')}</span>
                {deviceStatusLine(Boolean(hardwareStatus?.customerDisplay?.connected), displayEnabled)}
              </div>
              <div className="pos-row__control">
                <POSGlassSwitch aria-labelledby="peripheral-display-label" checked={displayEnabled} onChange={setDisplayEnabled} />
              </div>
            </div>
            {(displayEnabled || hardwareStatus?.customerDisplay?.connected) && (
              <>
                <div className="pos-row pos-row--stack">
                  <div>
                    <div id="peripheral-display-connection-label" className="mb-1.5 text-sm font-medium liquid-glass-modal-text">{t('settings.peripherals.display.connectionPlain', 'How it is connected')}</div>
                    <SegmentedControl
                      ariaLabel={t('settings.peripherals.display.connectionPlain', 'How it is connected')}
                      value={displayConnectionType}
                      onChange={(value) => setDisplayConnectionType(value)}
                      options={[
                        { value: 'serial', label: t('settings.peripherals.display.serialPlain', 'Cable (COM port)') },
                        { value: 'network', label: t('settings.peripherals.display.networkPlain', 'Network (IP address)') },
                      ]}
                    />
                  </div>
                  {displayConnectionType === 'serial'
                    ? renderPortField('peripheral-display-port', t('settings.peripherals.scale.portPlain', 'Port (where the cable is plugged in)'), displayPort, setDisplayPort, 'COM4')
                    : (
                      <div>
                        <label htmlFor="peripheral-display-ip" className="block text-sm font-medium mb-1 liquid-glass-modal-text">{t('settings.peripherals.display.ipPlain', 'IP address of the display')}</label>
                        <input id="peripheral-display-ip" value={displayPort} onChange={e => setDisplayPort(e.target.value)} className="liquid-glass-modal-input w-full max-w-sm" placeholder="192.168.1.100" />
                      </div>
                    )}
                  {renderConnectButton(
                    'display',
                    Boolean(hardwareStatus?.customerDisplay?.connected),
                    t('settings.peripherals.scale.connect', 'Connect'),
                    t('settings.peripherals.scale.disconnect', 'Disconnect'),
                    () => bridge.hardware.displayConnect({ connectionType: displayConnectionType, target: displayPort, portNumber: displayConnectionType === 'network' ? Number(displayTcpPort) : undefined, baudRate: displayConnectionType === 'serial' ? Number(displayBaudRate) : undefined }),
                    () => bridge.hardware.displayDisconnect(),
                  )}
                </div>
                <TechDisclosure title={t('settings.printer.forTechnicians', 'Settings for technicians')}>
                  {displayConnectionType === 'serial' ? (
                    <div>
                      <label htmlFor="peripheral-display-baud" className="block text-sm font-medium mb-1 liquid-glass-modal-text">{t('settings.peripherals.display.baudRate', 'Baud Rate')}</label>
                      <select id="peripheral-display-baud" value={displayBaudRate} onChange={e => setDisplayBaudRate(e.target.value)} className="liquid-glass-modal-input w-full">
                    <option value="2400">2400</option>
                    <option value="4800">4800</option>
                    <option value="9600">9600</option>
                    <option value="19200">19200</option>
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label htmlFor="peripheral-display-tcp" className="block text-sm font-medium mb-1 liquid-glass-modal-text">{t('settings.peripherals.display.tcpPort', 'TCP Port')}</label>
                      <input id="peripheral-display-tcp" type="number" value={displayTcpPort} onChange={e => setDisplayTcpPort(e.target.value)} className="liquid-glass-modal-input w-full" placeholder="9100" />
                    </div>
                  )}
                </TechDisclosure>
              </>
            )}
          </section>

          {/* --- Serial Barcode Scanner --- */}
          <section data-device-card="scanner" className="pos-group">
            <div className="pos-row">
              <div className="pos-row__label">
                <span id="peripheral-scanner-label" className="pos-row__title">{t('settings.peripherals.scanner.title', 'Serial Barcode Scanner')}</span>
                <span className="pos-row__help">{t('settings.peripherals.scanner.keyboardNote', 'Keyboard-wedge scanners work automatically — no configuration needed')}</span>
                {deviceStatusLine(Boolean(hardwareStatus?.serialScanner?.connected), scannerEnabled)}
              </div>
              <div className="pos-row__control">
                <POSGlassSwitch aria-labelledby="peripheral-scanner-label" checked={scannerEnabled} onChange={setScannerEnabled} />
              </div>
            </div>
            {(scannerEnabled || hardwareStatus?.serialScanner?.connected) && (
              <>
                <div className="pos-row pos-row--stack">
                  {renderPortField('peripheral-scanner-port', t('settings.peripherals.scale.portPlain', 'Port (where the cable is plugged in)'), scannerPort, setScannerPort, 'COM2')}
                  {renderConnectButton(
                    'scanner',
                    Boolean(hardwareStatus?.serialScanner?.connected),
                    t('settings.peripherals.scanner.start', 'Start'),
                    t('settings.peripherals.scanner.stop', 'Stop'),
                    () => bridge.hardware.scannerSerialStart({ port: scannerPort, baud: Number(scannerBaudRate) }),
                    () => bridge.hardware.scannerSerialStop(),
                  )}
                </div>
                <TechDisclosure title={t('settings.printer.forTechnicians', 'Settings for technicians')}>
                  <div>
                    <label htmlFor="peripheral-scanner-baud" className="block text-sm font-medium mb-1 liquid-glass-modal-text">{t('settings.peripherals.scanner.baudRate', 'Baud Rate')}</label>
                    <select id="peripheral-scanner-baud" value={scannerBaudRate} onChange={e => setScannerBaudRate(e.target.value)} className="liquid-glass-modal-input w-full">
                    <option value="2400">2400</option>
                    <option value="4800">4800</option>
                    <option value="9600">9600</option>
                    <option value="19200">19200</option>
                    </select>
                  </div>
                </TechDisclosure>
              </>
            )}
          </section>

          {/* --- Loyalty / NFC Reader --- */}
          <section data-device-card="loyalty" className="pos-group">
            <div className="pos-row">
              <div className="pos-row__label">
                <span id="peripheral-loyalty-reader-label" className="pos-row__title">{t('settings.workflow.loyaltyInput', { defaultValue: 'Loyalty card keyboard input' })}</span>
                <span className="pos-row__help">{t('settings.workflow.loyaltyInputHelp', { defaultValue: 'For readers that type the card number like a keyboard. Running means the input listener is active; it does not confirm that an NFC device is connected.' })}</span>
                {hardwareStatus?.loyaltyReader?.connected && (
                  <StatusLine tone="ok">{t('settings.peripherals.scanner.running', 'Running')}</StatusLine>
                )}
              </div>
              <div className="pos-row__control">
                <POSGlassSwitch aria-labelledby="peripheral-loyalty-reader-label" checked={loyaltyEnabled} onChange={setLoyaltyEnabled} />
              </div>
            </div>
          </section>

          {/* --- Caller ID / VoIP --- (the cash register lives in Cards & cash register) */}
          <CallerIdSection />

          {/* Changes that are not followed by Connect (a device switched off, the loyalty input, a
              corrected port) are saved here; Cancel goes back to what is saved. */}
          <DirtyFooter
            visible={hardwareDirty}
            note={<span role="status">{t('settings.workflow.pendingChanges', { defaultValue: 'Unsaved device changes' })}</span>}
            saveLabel={t('settings.peripherals.saveButton', 'Save peripherals')}
            cancelLabel={t('common.actions.cancel', 'Cancel')}
            onSave={() => void saveHardwareSettings()}
            onCancel={restoreHardwareDraft}
            saving={Boolean(hardwareAction)}
            saveDisabled={!settingsLoaded}
          />
        </div>
        )}

        {/* Printer Settings trigger */}
        {activeSettingsSection === 'printing' && (
        <div id="settings-section-printing" className="space-y-4">
          {/* UI audit wave 7Γ: the printers and the receipt settings live here, not in a window
              over Settings; the form, wizard and diagnostics open as a window when needed. */}
          <PrinterSettingsModal
            embedded
            isOpen={isOpen}
            onClose={() => undefined}
            receiptPromptRow={(
              <SettingsRow
                title={<span id="printer-receipt-print-prompt-label">{t('settings.printer.askBeforePrint', 'Ask before printing')}</span>}
                help={t('settings.printer.askBeforePrintHelp', 'Show a confirmation after payment before printing the receipt')}
                control={(
                  <POSGlassSwitch
                    aria-labelledby="printer-receipt-print-prompt-label"
                    checked={receiptPrintPromptEnabled}
                    onChange={handleReceiptPrintPromptToggle}
                  />
                )}
              />
            )}
          />
          <PrintQueuePanel />
        </div>
        )}

        {/* Cards & cash register (UI audit wave 7Δ): the card machines and the cash register of this
            till together; two different devices, saved where they always were. */}
        {activeSettingsSection === 'payments' && (
        <div id="settings-section-payments" className="space-y-4">
          <PaymentTerminalsSection
            embedded
            onOpenCashRegisterSetup={() => {
              // Same section now: the register below opens its network setup.
              setCashRegisterSetupIntent({ mode: 'rbs_network', token: Date.now() })
            }}
          />
          <CashRegisterSection setupIntent={cashRegisterSetupIntent} />
        </div>
        )}

        {/* Waiter Devices Section — main terminal manages its mobile_waiter unit */}
        {activeSettingsSection === 'waiter_devices' && isMainTerminal && (
          <>
            <WaiterDevicesSection />
            <CafeLanSettings isMain={isMainTerminal} />
          </>
        )}

        {/* Platforms Section — connected delivery platforms, open/close switches */}
        {isOpen && activeSettingsSection === 'platforms' && (
          <PlatformsSection />
        )}



          </div>
        </div>
      </div>

    </LiquidGlassModal>

    <ConfirmDialog
      isOpen={showDiscardChanges}
      onClose={() => { setShowDiscardChanges(false); setPendingSection(null) }}
      onConfirm={() => {
        setShowDiscardChanges(false)
        if (pendingSection) {
          // Leaving a section: drop that section's drafts only.
          dirtyRegistry.clear()
          setActiveSettingsSection(pendingSection)
          setPendingSection(null)
          return
        }
        discardDrafts()
        onClose()
      }}
      title={hardwareDirty && !otherDirty && !pendingSection
        ? t('settings.workflow.pendingChanges', { defaultValue: 'Unsaved device changes' })
        : t('settings.workflow.unsavedAnyTitle', { defaultValue: 'Unsaved changes' })}
      message={hardwareDirty && !otherDirty && !pendingSection
        ? t('settings.workflow.unsavedHelp', { defaultValue: 'Device connection details have not been saved. Save them before leaving, or discard your changes.' })
        : t('settings.workflow.unsavedAnyHelp', { defaultValue: 'Some changes on this screen have not been saved. Discard them?' })}
      confirmText={t('settings.workflow.discardChanges', { defaultValue: 'Discard changes' })}
      cancelText={t('settings.workflow.keepEditing', { defaultValue: 'Keep editing' })}
      variant="warning"
    />

    {/* Sub-modals rendered outside LiquidGlassModal for independent viewport positioning */}

    {/* Clear Operational Data Confirmation Dialog */}
    <ConfirmDialog
      isOpen={showClearOperationalConfirm}
      onClose={() => setShowClearOperationalConfirm(false)}
      onConfirm={async () => {
        setIsClearingOperational(true)
        try {
          // Gap review P0: clear-operational-data now requires SystemControl.
          const result = await runWithPrivilegedConfirmation({
            scope: 'system_control',
            action: () => bridge.database.clearOperationalData(),
            title: t('settings.database.clearOperationalPinTitle', 'Confirm clear operational data'),
            subtitle: t('settings.database.clearOperationalPinSubtitle', 'Enter the admin PIN to permanently delete all operational data.'),
          })
          if (result?.success) {
            toast.success(t('settings.database.operationalCleared', 'All operational data cleared successfully'))
            setShowClearOperationalConfirm(false)
          } else {
            throw new Error(result?.error || 'Unknown error')
          }
        } catch (e) {
          console.error('Failed to clear operational data:', e)
          toast.error(getErrorMessage(e, t('settings.database.operationalClearFailed', 'Failed to clear operational data')))
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
        <ul className="list-disc list-inside space-y-1">
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
        <ul className="list-disc list-inside space-y-1">
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
        <div className="font-medium">
          {t('settings.database.factoryResetFinalWarning', 'The POS will create a local recovery snapshot, clear terminal data, and restart.')}
        </div>
      }
    />
    {confirmationModal}
    </SettingsDirtyProvider>
  )
}

export default ConnectionSettingsModal
