import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { LiquidGlassModal, POSGlassSwitch } from '../ui/pos-glass-components'
import { liquidGlassModalButton, liquidGlassModalTone } from '../../styles/designSystem'
import { DirtyFooter, SegmentedControl, SettingsGroup, SettingsRow, StatusLine, TechDisclosure, solidButton, type StatusTone } from '../settings/SettingsKit'
import { Activity, AlertTriangle, ChefHat, ChevronDown, CreditCard, FileText, FlaskConical, Info, Package, PackageCheck, Pencil, Plus, Printer, Receipt, Tag, Trash2, Truck, UserCheck, Wine, XCircle } from 'lucide-react'
import { getBridge, offEvent, onEvent } from '../../../lib'
import type { ReceiptSamplePreviewRequest, ReceiptSamplePreviewResponse } from '../../../lib'
import PrinterSetupWizard, {
  plainPrinterTypeLabel,
  readabilityPreset as PRINTER_READABILITY_PRESETS,
  type ReadabilitySize,
} from './PrinterSetupWizard'
import { parseWizardEnqueueResponse } from './printer-setup-verification'
import { ReceiptScaleSlider } from '../ui/ReceiptScaleSlider'
import { PrinterSupportEntryPoint } from '../support/PrinterSupportEntryPoint'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { buildPrinterSupportContext } from '../../support'

// UI audit wave 7A2: the kit buttons (one yellow Save, neutral Cancel).
const SAVE_BTN_MD = solidButton('primary', 'md');
const SAVE_BTN_SM = solidButton('primary', 'sm');
const CANCEL_BTN_MD = solidButton('secondary', 'md');

// The receipt live-preview renders inside an <iframe srcDoc={...}>. That iframe hosts
// its OWN document, so the parent container's `scrollbar-hide` utility cannot reach the
// iframe body's native scrollbar -- on this touchscreen POS that leaked as a bright
// native vertical rail on the right edge of the preview (Round 288, Greek/light QA).
// We prepend this CSS to the preview HTML so the iframe document hides its own scrollbar
// in every engine (Firefox `scrollbar-width`, legacy Edge `-ms-overflow-style`, WebKit/
// Chromium `::-webkit-scrollbar`) while STILL scrolling. It only suppresses scrollbar
// chrome -- it never touches margins, fonts, dimensions, or the rendered receipt content.
const PREVIEW_HIDE_SCROLLBAR_STYLE =
  '<style>html,body{scrollbar-width:none;-ms-overflow-style:none;}html::-webkit-scrollbar,body::-webkit-scrollbar{width:0;height:0;display:none;}</style>'

// Types matching the printer module types
type PrinterType = 'network' | 'bluetooth' | 'usb' | 'wifi' | 'system'
type PrinterRole = 'receipt' | 'kitchen' | 'bar' | 'label'
type PrinterState = 'online' | 'offline' | 'error' | 'busy' | 'degraded' | 'unverified' | 'unresolved'
type PaperSize = '58mm' | '80mm' | '112mm'
type GreekRenderMode = 'text' | 'bitmap'
type ReceiptTemplate = 'classic' | 'modern'
type FontType = 'a' | 'b'
type LayoutDensity = 'compact' | 'balanced' | 'spacious'
type HeaderEmphasis = 'normal' | 'strong'
type ClassicRenderMode = 'text' | 'raster_exact'
type EmulationMode = 'auto' | 'escpos' | 'star_line'
type VerificationStatus = 'unverified' | 'verified' | 'degraded' | 'candidate'
type ResolvedTransport = 'windows_queue' | 'raw_tcp' | 'serial'

interface PrinterCapabilities {
  status?: VerificationStatus | string
  resolvedTransport?: ResolvedTransport | string
  resolved_transport?: ResolvedTransport | string
  resolvedAddress?: string
  resolved_address?: string
  emulation?: EmulationMode | string
  renderMode?: ClassicRenderMode | string
  render_mode?: ClassicRenderMode | string
  baudRate?: number | null
  baud_rate?: number | null
  supportsCut?: boolean
  supports_cut?: boolean
  supportsLogo?: boolean
  supports_logo?: boolean
  lastVerifiedAt?: string | null
  last_verified_at?: string | null
}

interface ConnectionDetails {
  type: string
  ip?: string
  port?: number
  hostname?: string
  address?: string
  channel?: number
  deviceName?: string
  vendorId?: number
  productId?: number
  systemName?: string
  path?: string
  render_mode?: ClassicRenderMode
  emulation?: EmulationMode
  printable_width_dots?: number
  left_margin_dots?: number
  threshold?: number
  capabilities?: PrinterCapabilities
}

interface PrinterConfig {
  id: string
  name: string
  type: PrinterType
  connectionDetails: ConnectionDetails
  paperSize: PaperSize
  characterSet: string
  greekRenderMode?: GreekRenderMode
  escposCodePage?: number | null
  receiptTemplate?: ReceiptTemplate
  fontType?: FontType
  layoutDensity?: LayoutDensity
  headerEmphasis?: HeaderEmphasis
  role: PrinterRole
  isDefault: boolean
  fallbackPrinterId?: string
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

interface PrinterStatus {
  printerId: string
  state: PrinterState
  errorCode?: string
  errorMessage?: string
  lastSeen: Date
  queueLength: number
  verificationStatus?: VerificationStatus | string
  resolvedTransport?: ResolvedTransport | string
  resolvedAddress?: string
  transportReachable?: boolean
  supportsLogo?: boolean
  supportsCut?: boolean
}

interface PrinterDiagnostics {
  printerId: string
  connectionType: PrinterType
  connectionLatencyMs?: number
  signalStrength?: number
  model?: string
  firmwareVersion?: string
  verificationStatus?: VerificationStatus | string
  resolvedTransport?: ResolvedTransport | string
  resolvedAddress?: string
  transportReachable?: boolean
  supportsLogo?: boolean
  supportsCut?: boolean
  recentJobs: {
    total: number
    successful: number
    failed: number
  }
}

interface Props {
  isOpen: boolean
  onClose: () => void
  initialMode?: SetupMode
  autoStartWizard?: boolean
  /**
   * UI audit wave 7Γ: render the printer list inside Settings → Printers & receipts instead of a
   * window over it. The form, wizard, diagnostics and automatic printing still open as a window.
   */
  embedded?: boolean
  /** Settings' «Ask before printing» row, shown first in the «Receipts» group. */
  receiptPromptRow?: React.ReactNode
}

const PRINTER_TYPES: PrinterType[] = ['network', 'bluetooth', 'usb', 'wifi', 'system']

const isTauriDesktopRuntime = (): boolean => {
  if (typeof window === 'undefined') return false
  const runtime = window as any
  return Boolean(runtime.__TAURI_INTERNALS__ || runtime.__TAURI__)
}

const normalizePrinterType = (value: unknown): PrinterType => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if ((PRINTER_TYPES as string[]).includes(raw)) return raw as PrinterType
  return 'system'
}

const formatPrinterTypeLabel = (value: unknown): string => {
  return normalizePrinterType(value).toUpperCase()
}

const parseBooleanSetting = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
  }
  return false
}

const asTrimmedString = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  return value.trim()
}

const normalizeVerificationStatus = (value: unknown): VerificationStatus => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'verified' || raw === 'degraded' || raw === 'candidate') return raw
  return 'unverified'
}

const normalizeResolvedTransport = (value: unknown): ResolvedTransport | null => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'windows_queue' || raw === 'raw_tcp' || raw === 'serial') {
    return raw
  }
  return null
}

const defaultCapabilities = (): PrinterCapabilities => ({
  status: 'unverified',
  emulation: 'auto',
  renderMode: 'text',
  supportsCut: false,
  supportsLogo: false,
  baudRate: null,
  lastVerifiedAt: null,
})

const readCapabilities = (details?: ConnectionDetails): PrinterCapabilities => {
  const capabilities = details?.capabilities
  if (!capabilities || typeof capabilities !== 'object') {
    return defaultCapabilities()
  }
  return {
    ...defaultCapabilities(),
    ...capabilities,
    status: normalizeVerificationStatus(capabilities.status),
    resolvedTransport: capabilities.resolvedTransport ?? capabilities.resolved_transport,
    resolvedAddress: capabilities.resolvedAddress ?? capabilities.resolved_address,
    renderMode: capabilities.renderMode ?? capabilities.render_mode,
    baudRate: capabilities.baudRate ?? capabilities.baud_rate ?? null,
    supportsCut: capabilities.supportsCut ?? capabilities.supports_cut ?? false,
    supportsLogo: capabilities.supportsLogo ?? capabilities.supports_logo ?? false,
    lastVerifiedAt: capabilities.lastVerifiedAt ?? capabilities.last_verified_at ?? null,
  }
}

const transportLabel = (value: unknown, t: TFunction): string => {
  const transport = normalizeResolvedTransport(value)
  if (transport === 'windows_queue') return t('settings.printer.transportWindowsQueue', 'Windows queue')
  if (transport === 'raw_tcp') return t('settings.printer.transportRawTcp', 'Raw TCP')
  if (transport === 'serial') return t('settings.printer.transportSerial', 'Serial / RFCOMM')
  return t('settings.printer.transportUnknown', 'Not resolved')
}

const verificationLabel = (value: unknown, t: TFunction): string => {
  const status = normalizeVerificationStatus(value)
  if (status === 'verified') return t('settings.printer.verificationVerified', 'Verified')
  if (status === 'degraded') return t('settings.printer.verificationDegraded', 'Degraded')
  if (status === 'candidate') return t('settings.printer.verificationCandidate', 'Candidate')
  return t('settings.printer.verificationUnverified', 'Needs verification')
}

const verificationTone = (value: unknown): string => {
  const status = normalizeVerificationStatus(value)
  if (status === 'verified') return liquidGlassModalTone('success')
  if (status === 'degraded') return liquidGlassModalTone('warning')
  // candidate = pending/needs-verification (informational) -> amber, not blue
  if (status === 'candidate') return liquidGlassModalTone('warning')
  return liquidGlassModalTone('neutral')
}

// View modes for the modal
type SetupMode = 'quick' | 'expert'
type ViewMode = 'list' | 'add' | 'edit' | 'diagnostics' | 'wizard' | 'receiptActions'

// A labelled row of large choice buttons (radio group) for the printer basics.
const ChoiceChips = <T extends string,>({
  labelId,
  label,
  value,
  options,
  onChange,
  note,
}: {
  labelId: string
  label: string
  value: T | null
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  note?: string
}) => (
  <div>
    <div id={labelId} className="mb-1.5 text-sm font-medium liquid-glass-modal-text">{label}</div>
    {/* UI audit wave 7Γ: the kit's segmented control (radio group with arrow keys). */}
    <SegmentedControl ariaLabel={label} value={value} options={options} onChange={onChange} />
    {note ? <p className="mt-1 text-xs liquid-glass-modal-text-muted">{note}</p> : null}
  </div>
)

// Status indicator component
const StatusIndicator: React.FC<{ state: PrinterState }> = ({ state }) => {
  const colors: Record<PrinterState, string> = {
    online: 'bg-green-500',
    offline: 'bg-gray-500',
    error: 'bg-red-500',
    busy: 'bg-yellow-500',
    degraded: 'bg-amber-400',
    unverified: 'bg-amber-400',
    unresolved: 'bg-orange-400',
  }
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[state] || 'bg-gray-400'}`} />
  )
}

const RECEIPT_ACTION_KEYS = [
  'after_order', 'after_edit', 'after_approve', 'payment_receipt', 'split_receipt', 'shift_close',
  'driver_assigned', 'z_report', 'kitchen_ticket', 'on_complete', 'on_cancel', 'print_sandbox_orders',
] as const
type ReceiptActionKey = typeof RECEIPT_ACTION_KEYS[number]
const RECEIPT_ACTION_DEFAULTS: Record<ReceiptActionKey, boolean> = {
  after_order: true, after_edit: true, after_approve: true, payment_receipt: true, split_receipt: true, shift_close: true,
  driver_assigned: true, z_report: true, kitchen_ticket: true,
  on_complete: false, on_cancel: false,
  // Sandbox/test orders never print unless someone is actively running an
  // integration test at this till; the slips carry a «ΔΟΚΙΜΗ TEST» banner.
  print_sandbox_orders: false,
}
const camelCase = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
const getReceiptActionIcon = (key: ReceiptActionKey) => {
  switch (key) {
    case 'after_edit':
      return Pencil
    case 'after_approve':
      return PackageCheck
    case 'print_sandbox_orders':
      return FlaskConical
    case 'payment_receipt':
      return CreditCard
    case 'split_receipt':
      return FileText
    case 'shift_close':
      return Activity
    case 'driver_assigned':
      return Truck
    case 'z_report':
      return Receipt
    case 'kitchen_ticket':
      return ChefHat
    case 'on_complete':
      return Package
    case 'on_cancel':
      return XCircle
    case 'after_order':
    default:
      return UserCheck
  }
}

const PrinterSettingsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  initialMode = 'quick',
  autoStartWizard = false,
  embedded = false,
  receiptPromptRow,
}) => {
  const { t } = useTranslation()
  const bridge = getBridge()
  const api = useMemo(() => {
    return {
      printerGetAll: async () => {
        const result: any = await bridge.printer.getAll()
        if (result && typeof result === 'object' && 'success' in result) {
          return result
        }
        const printers = Array.isArray(result)
          ? result
          : Array.isArray(result?.printers)
          ? result.printers
          : []
        return { success: true, printers }
      },
      printerGetAllStatuses: async () => {
        const result: any = await bridge.printer.getAllStatuses()
        if (result && typeof result === 'object' && 'success' in result) {
          return result
        }
        const statuses = result?.statuses ?? result ?? {}
        return { success: true, statuses }
      },
      onPrinterStatusChanged: (callback: (data: { printerId: string; status: PrinterStatus }) => void) => {
        const handler = (payload: any) => {
          const printerId = payload?.printerId ?? payload?.printer_id ?? payload?.id
          const status = payload?.status ?? payload
          if (typeof printerId === 'string' && status) {
            callback({ printerId, status })
            return
          }
          callback(payload)
        }
        onEvent('printer:status-changed', handler)
        return () => offEvent('printer:status-changed', handler)
      },
      printerDiscover: async (types?: string[]) => {
        const result: any = await bridge.printer.discover(types)
        if (result && typeof result === 'object' && 'success' in result) {
          return result
        }
        const printers = Array.isArray(result)
          ? result
          : Array.isArray(result?.printers)
          ? result.printers
          : []
        return { success: true, printers }
      },
      printerAdd: (config: any) => bridge.printer.add(config),
      printerUpdate: (printerId: string, updates: any) => bridge.printer.update(printerId, updates),
      printerRemove: (printerId: string) => bridge.printer.remove(printerId),
      printerTest: (printerId: string) => bridge.printer.test(printerId),
      printerTestGreekDirect: (printerId: string) => bridge.printer.testGreekDirect(printerId),
      printerGetAutoConfig: (printerId: string) => bridge.printer.getAutoConfig(printerId),
      printerGetDiagnostics: async (printerId: string) => {
        const result: any = await bridge.printer.diagnostics(printerId)
        if (result && typeof result === 'object' && 'success' in result) {
          return result
        }
        return { success: true, diagnostics: result?.diagnostics ?? result }
      },
    }
  }, [bridge])

  // State
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  // «Εμφάνιση απόδειξης» opens over the list or the wizard; the view under it stays as it was.
  const [receiptLookOpen, setReceiptLookOpen] = useState(false)
  const [setupMode, setSetupMode] = useState<SetupMode>(initialMode)
  const [printers, setPrinters] = useState<PrinterConfig[]>([])
  const [statuses, setStatuses] = useState<Record<string, PrinterStatus>>({})
  const [selectedPrinter, setSelectedPrinter] = useState<PrinterConfig | null>(null)
  const [diagnostics, setDiagnostics] = useState<PrinterDiagnostics | null>(null)
  const [loading, setLoading] = useState(false)
  const [wizardBusy, setWizardBusy] = useState(false)
  const wizardBusyRef = useRef(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [autoConfig, setAutoConfig] = useState<{
    detectedBrand: string
    appLanguage: string
    autoCharacterSet: string
    autoCodePage: number | null
  } | null>(null)
  const [logoEnabled, setLogoEnabled] = useState(false)
  const [logoSourceOverride, setLogoSourceOverride] = useState('')
  const [orgLogoSource, setOrgLogoSource] = useState('')
  const [logoSaving, setLogoSaving] = useState(false)
  const [logoLoaded, setLogoLoaded] = useState(false)
  const [persistedLogoConfigured, setPersistedLogoConfigured] = useState(false)
  // Form state for add/edit
  const [formData, setFormData] = useState({
    name: '',
    type: 'network' as PrinterType,
    ip: '',
    port: 9100,
    bluetoothAddress: '',
    bluetoothChannel: 1,
    usbVendorId: 0,
    usbProductId: 0,
    usbSystemName: '',
    usbPath: '',
    systemPrinterName: '',
    paperSize: '80mm' as PaperSize,
    characterSet: 'PC437_USA',
    greekRenderMode: 'text' as GreekRenderMode,
    escposCodePage: '' as string,
    receiptTemplate: 'classic' as ReceiptTemplate,
    fontType: 'a' as FontType,
    layoutDensity: 'compact' as LayoutDensity,
    headerEmphasis: 'strong' as HeaderEmphasis,
    classicRenderMode: 'text' as ClassicRenderMode,
    emulationMode: 'auto' as EmulationMode,
    printableWidthDots: '',
    leftMarginDots: '',
    rasterThreshold: '',
    role: 'receipt' as PrinterRole,
    isDefault: false,
    fallbackPrinterId: '',
    enabled: true,
    textScale: 1.25,
    logoScale: 1.0,
  })

  // Collapsible sections state
  const [openSections, setOpenSections] = useState({
    connection: true,
    paperTemplate: true,
    typography: true,
    logo: true,
    encoding: false,
    calibration: false,
    roleDefaults: true,
    technical: false,
    receiptActions: false,
  })
  const toggleSection = (key: string) => setOpenSections(prev => ({ ...prev, [key as keyof typeof prev]: !prev[key as keyof typeof prev] }))

  // Live preview state
  const [preview, setPreview] = useState<ReceiptSamplePreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [textScaleAutoSwitchNotice, setTextScaleAutoSwitchNotice] = useState(false)
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewRequestIdRef = useRef(0)
  const textScaleAutoSwitchToastShownRef = useRef(false)

  // Receipt action toggles and body boldness
  const [receiptActions, setReceiptActions] = useState<Record<ReceiptActionKey, boolean>>(RECEIPT_ACTION_DEFAULTS)
  const [bodyBoldness, setBodyBoldness] = useState<number>(1)
  const [layoutDensityScale, setLayoutDensityScale] = useState<number>(1)

  // Load printers and statuses
  const loadPrinters = useCallback(async () => {
    try {
      const result = await api?.printerGetAll?.()
      if (result?.success) {
        setPrinters(result.printers || [])
      }
    } catch (e) {
      console.error('Failed to load printers:', e)
    }
  }, [api])

  const loadStatuses = useCallback(async () => {
    try {
      const result = await api?.printerGetAllStatuses?.()
      if (result?.success) {
        setStatuses(result.statuses || {})
      }
    } catch (e) {
      console.error('Failed to load statuses:', e)
    }
  }, [api])

  const loadReceiptLogoSettings = useCallback(async () => {
    setLogoLoaded(false)
    setPersistedLogoConfigured(false)
    try {
      const [showLogoRaw, logoSourceRaw, orgLogoRaw] = await Promise.all([
        bridge.settings.get({ category: 'receipt', key: 'show_logo', defaultValue: false }),
        bridge.settings.get({ category: 'receipt', key: 'logo_source' }),
        bridge.settings.get({ category: 'organization', key: 'logo_url' }),
      ])
      const loadedLogoEnabled = parseBooleanSetting(showLogoRaw)
      const loadedLogoSource = asTrimmedString(logoSourceRaw)
      const loadedOrganizationLogo = asTrimmedString(orgLogoRaw)
      setLogoEnabled(loadedLogoEnabled)
      setLogoSourceOverride(loadedLogoSource)
      persistedLogoRef.current = { enabled: loadedLogoEnabled, source: loadedLogoSource }
      setOrgLogoSource(loadedOrganizationLogo)
      setPersistedLogoConfigured(
        loadedLogoEnabled && Boolean(loadedLogoSource || loadedOrganizationLogo),
      )
      setLogoLoaded(true)

      const [textScaleResult, logoScaleResult, layoutDensityScaleResult] = await Promise.allSettled([
        bridge.settings.get({ category: 'receipt', key: 'text_scale' }),
        bridge.settings.get({ category: 'receipt', key: 'logo_scale' }),
        bridge.settings.get({ category: 'receipt', key: 'layout_density_scale' }),
      ])
      const textScaleRaw = textScaleResult.status === 'fulfilled' ? textScaleResult.value : null
      const logoScaleRaw = logoScaleResult.status === 'fulfilled' ? logoScaleResult.value : null
      const layoutDensityScaleRaw = layoutDensityScaleResult.status === 'fulfilled'
        ? layoutDensityScaleResult.value
        : null
      const parsedTextScale = parseFloat(asTrimmedString(textScaleRaw))
      const parsedLogoScale = parseFloat(asTrimmedString(logoScaleRaw))
      const parsedLayoutDensityScale = parseFloat(asTrimmedString(layoutDensityScaleRaw))
      if (Number.isFinite(parsedTextScale) && parsedTextScale > 0) {
        setFormData(prev => ({ ...prev, textScale: parsedTextScale }))
      }
      if (Number.isFinite(parsedLogoScale) && parsedLogoScale > 0) {
        setFormData(prev => ({ ...prev, logoScale: parsedLogoScale }))
      }
      if (Number.isFinite(parsedLayoutDensityScale) && parsedLayoutDensityScale > 0) {
        setLayoutDensityScale(parsedLayoutDensityScale)
      } else {
        setLayoutDensityScale(1)
      }
    } catch (e) {
      console.error('Failed to load receipt logo settings:', e)
      setPersistedLogoConfigured(false)
      setLogoLoaded(false)
    }
  }, [bridge])

  const loadReceiptActionSettings = useCallback(async () => {
    try {
      const results = await Promise.all(
        RECEIPT_ACTION_KEYS.map(key =>
          bridge.settings.get({ category: 'receipt_actions', key, defaultValue: RECEIPT_ACTION_DEFAULTS[key] })
        )
      )
      const loaded = Object.fromEntries(
        RECEIPT_ACTION_KEYS.map((key, i) => [key, parseBooleanSetting(results[i])])
      ) as Record<ReceiptActionKey, boolean>
      setReceiptActions(loaded)

      const boldnessRaw = await bridge.settings.get({ category: 'receipt', key: 'body_boldness' })
      const parsed = parseInt(String(boldnessRaw), 10)
      setBodyBoldness(Number.isFinite(parsed) && parsed >= 1 && parsed <= 5 ? parsed : 1)
    } catch (e) {
      console.error('Failed to load receipt action settings:', e)
    }
  }, [bridge])

  // The receipt logo is a terminal-wide receipt setting. The form's single Save
  // persists it when it changed, so the user never meets a second Save button.
  const persistedLogoRef = useRef<{ enabled: boolean; source: string }>({ enabled: false, source: '' })
  const logoSettingsChanged = () =>
    logoEnabled !== persistedLogoRef.current.enabled
    || logoSourceOverride.trim() !== persistedLogoRef.current.source

  const handleSaveLogoSettings = useCallback(async (options?: { quiet?: boolean }) => {
    setLogoSaving(true)
    try {
      await bridge.settings.updateLocal({
        settingType: 'receipt',
        settings: {
          show_logo: logoEnabled,
          logo_source: logoSourceOverride.trim(),
        },
      })
      persistedLogoRef.current = { enabled: logoEnabled, source: logoSourceOverride.trim() }
      setPersistedLogoConfigured(
        logoEnabled && Boolean(logoSourceOverride.trim() || orgLogoSource.trim()),
      )
      if (!options?.quiet) toast.success(t('settings.printer.logoSettingsSaved', 'Receipt logo settings saved'))
    } catch (e) {
      console.error('Failed to save logo settings:', e)
      toast.error(t('settings.printer.logoSettingsSaveFailed', 'Failed to save receipt logo settings'))
    } finally {
      setLogoSaving(false)
    }
  }, [bridge, logoEnabled, logoSourceOverride, orgLogoSource, t])

  const handleLogoFileSelected = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return
      const mime = (file.type || '').toLowerCase()
      if (!mime.includes('png') && !mime.includes('jpeg') && !mime.includes('jpg')) {
        toast.error(t('settings.printer.logoFileTypeUnsupported', 'Please choose a PNG or JPG file'))
        return
      }
      if (file.size > 2 * 1024 * 1024) {
        toast.error(t('settings.printer.logoFileTooLarge', 'Logo file is too large (max 2MB).'))
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : ''
        if (!result.startsWith('data:image/')) {
          toast.error(t('settings.printer.logoFileReadFailed', 'Failed to read logo file'))
          return
        }
        setLogoSourceOverride(result)
        toast.success(t('settings.printer.logoFileLoaded', 'Logo file loaded. Save settings to apply.'))
      }
      reader.onerror = () => {
        toast.error(t('settings.printer.logoFileReadFailed', 'Failed to read logo file'))
      }
      reader.readAsDataURL(file)
      event.target.value = ''
    },
    [t],
  )

  const handleReceiptActionToggle = useCallback(async (key: ReceiptActionKey) => {
    const newValue = !receiptActions[key]
    setReceiptActions(prev => ({ ...prev, [key]: newValue }))
    try {
      await bridge.settings.updateLocal({
        settingType: 'receipt_actions',
        settings: { [key]: newValue },
      })
    } catch (e) {
      console.error('Failed to save receipt action setting:', e)
      setReceiptActions(prev => ({ ...prev, [key]: !newValue }))
      toast.error(t('settings.printer.saveFailed', 'Failed to save setting'))
    }
  }, [bridge, receiptActions, t])

  const handleBodyBoldnessChange = useCallback(async (value: number) => {
    setBodyBoldness(value)
    try {
      await bridge.settings.updateLocal({
        settingType: 'receipt',
        settings: { body_boldness: value },
      })
    } catch (e) {
      console.error('Failed to save body boldness:', e)
    }
  }, [bridge])

  const handleLayoutDensityScaleChange = useCallback((value: number) => {
    setLayoutDensityScale(value)
  }, [])

  // Initial load (status updates are pushed by Rust monitor events)
  useEffect(() => {
    if (!isOpen) return
    loadPrinters()
    loadStatuses()
    loadReceiptLogoSettings()
    loadReceiptActionSettings()
    return
  }, [isOpen, loadPrinters, loadStatuses, loadReceiptLogoSettings, loadReceiptActionSettings])

  useEffect(() => {
    if (!isOpen) return
    setSetupMode(initialMode)
    if (autoStartWizard) {
      setSelectedPrinter(null)
      setViewMode('wizard')
    } else {
      setViewMode('list')
    }
  }, [autoStartWizard, initialMode, isOpen])

  // Listen for real-time status changes
  useEffect(() => {
    if (!isOpen) return
    const unsubscribe = api?.onPrinterStatusChanged?.((data: any) => {
      if (data?.statuses && typeof data.statuses === 'object') {
        setStatuses(data.statuses)
        return
      }
      if (typeof data?.printerId === 'string' && data?.status) {
        setStatuses(prev => ({ ...prev, [data.printerId]: data.status }))
      }
    })
    return () => unsubscribe?.()
  }, [isOpen, api])

  const buildCapabilitiesForSave = useCallback((printer?: PrinterConfig | null): PrinterCapabilities => {
    if (!printer) return defaultCapabilities()
    const existing = readCapabilities(printer.connectionDetails)
    const connectionChanged =
      printer.type !== formData.type ||
      (printer.connectionDetails?.ip || '') !== formData.ip ||
      (printer.connectionDetails?.port || 9100) !== formData.port ||
      (printer.connectionDetails?.address || '') !== formData.bluetoothAddress ||
      (printer.connectionDetails?.channel || 1) !== formData.bluetoothChannel ||
      (printer.connectionDetails?.vendorId || 0) !== formData.usbVendorId ||
      (printer.connectionDetails?.productId || 0) !== formData.usbProductId ||
      (printer.connectionDetails?.systemName || '') !== (formData.type === 'system' ? formData.systemPrinterName : formData.usbSystemName) ||
      (printer.connectionDetails?.path || '') !== formData.usbPath ||
      (printer.connectionDetails?.render_mode || 'text') !== formData.classicRenderMode ||
      (printer.connectionDetails?.emulation || 'auto') !== formData.emulationMode

    return connectionChanged ? defaultCapabilities() : existing
  }, [formData])

  // Build connection details from form
  const buildConnectionDetails = useCallback((): ConnectionDetails => {
    const details: ConnectionDetails = { type: formData.type }
    switch (formData.type) {
      case 'network':
      case 'wifi':
        details.ip = formData.ip
        details.port = formData.port
        break
      case 'bluetooth':
        details.type = 'bluetooth'
        details.address = formData.bluetoothAddress
        details.channel = formData.bluetoothChannel
        break
      case 'usb':
        details.type = 'usb'
        details.vendorId = formData.usbVendorId
        details.productId = formData.usbProductId
        details.systemName = formData.usbSystemName
        details.path = formData.usbPath
        break
      case 'system':
        details.type = 'system'
        details.systemName = formData.systemPrinterName
        break
      default:
        break
    }
    details.render_mode = formData.classicRenderMode
    details.emulation = formData.emulationMode
    details.capabilities = buildCapabilitiesForSave(selectedPrinter)
    if (formData.printableWidthDots.trim()) {
      const value = Number.parseInt(formData.printableWidthDots, 10)
      if (Number.isFinite(value) && value > 0) {
        details.printable_width_dots = value
      }
    }
    if (formData.leftMarginDots.trim()) {
      const value = Number.parseInt(formData.leftMarginDots, 10)
      if (Number.isFinite(value) && value >= 0) {
        details.left_margin_dots = value
      }
    }
    if (formData.rasterThreshold.trim()) {
      const value = Number.parseInt(formData.rasterThreshold, 10)
      if (Number.isFinite(value) && value > 0) {
        details.threshold = value
      }
    }
    return details
  }, [formData, selectedPrinter])

  const buildProfileDraft = useCallback(() => ({
    name: formData.name.trim() || 'Receipt Preview',
    type: formData.type,
    connectionDetails: buildConnectionDetails(),
    paperSize: formData.paperSize,
    characterSet: formData.characterSet,
    greekRenderMode: formData.greekRenderMode,
    escposCodePage: formData.escposCodePage ? parseInt(formData.escposCodePage, 10) : null,
    receiptTemplate: formData.receiptTemplate,
    fontType: formData.fontType,
    layoutDensity: formData.layoutDensity,
    headerEmphasis: formData.headerEmphasis,
    role: formData.role,
    isDefault: formData.isDefault,
    fallbackPrinterId: formData.fallbackPrinterId || undefined,
    enabled: formData.enabled,
  }), [buildConnectionDetails, formData])

  const effectiveLogoSource = useMemo(() => {
    const customSource = logoSourceOverride.trim()
    if (customSource) return customSource
    const fallbackSource = orgLogoSource.trim()
    return fallbackSource || ''
  }, [logoSourceOverride, orgLogoSource])

  const previewRequest = useMemo<ReceiptSamplePreviewRequest | null>(() => {
    if ((viewMode !== 'add' && viewMode !== 'edit') || !logoLoaded) return null
    return {
      profileDraft: buildProfileDraft(),
      receiptSettings: {
        showLogo: logoEnabled,
        logoSource: effectiveLogoSource,
        textScale: formData.textScale,
        logoScale: formData.logoScale,
        layoutDensityScale,
        bodyBoldness,
      },
    }
  }, [
    bodyBoldness,
    buildProfileDraft,
    effectiveLogoSource,
    formData.logoScale,
    formData.textScale,
    layoutDensityScale,
    logoEnabled,
    logoLoaded,
    viewMode,
  ])

  useEffect(() => {
    if ((viewMode === 'add' || viewMode === 'edit') && !previewRequest) return
    if (viewMode !== 'add' && viewMode !== 'edit') {
      setPreview(null)
      setPreviewError(null)
      setPreviewLoading(false)
      return
    }
    if (!previewRequest) return
    if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current)
    const requestId = ++previewRequestIdRef.current
    previewTimeoutRef.current = setTimeout(async () => {
      setPreviewLoading(true)
      setPreviewError(null)
      try {
        const result = await bridge.receipt.samplePreview(previewRequest) as ReceiptSamplePreviewResponse
        if (requestId !== previewRequestIdRef.current) return
        if (result?.success) {
          setPreview(result)
          setPreviewError(null)
        } else {
          setPreview(null)
          setPreviewError(result?.error || t('settings.printer.previewUnavailable', 'Preview unavailable'))
        }
      } catch (e) {
        if (requestId !== previewRequestIdRef.current) return
        console.warn('Preview failed:', e)
        setPreview(null)
        setPreviewError(t('settings.printer.previewUnavailable', 'Preview unavailable'))
      } finally {
        if (requestId === previewRequestIdRef.current) {
          setPreviewLoading(false)
        }
      }
    }, 200)
    return () => {
      if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current)
    }
  }, [bridge, previewRequest, t, viewMode])

  // Save printer (add or update)
  const handleSave = async () => {
    if (!formData.name.trim()) {
      toast.error(t('settings.printer.nameRequired', 'Printer name is required'))
      return
    }
    if (formData.type === 'system' && !formData.systemPrinterName.trim()) {
      toast.error(t('settings.printer.systemNameRequired', 'System printer name is required'))
      return
    }
    if ((formData.type === 'network' || formData.type === 'wifi') && !formData.ip.trim()) {
      toast.error(t('settings.printer.networkIpRequired', 'Network printer IP is required'))
      return
    }
    if (formData.type === 'bluetooth' && !formData.bluetoothAddress.trim()) {
      toast.error(t('settings.printer.bluetoothAddressRequired', 'Bluetooth address is required'))
      return
    }

    setLoading(true)
    try {
      const config = buildProfileDraft()

      let result
      if (selectedPrinter) {
        result = await api?.printerUpdate?.(selectedPrinter.id, config)
      } else {
        result = await api?.printerAdd?.(config)
      }

      if (result?.success) {
        // Persist scale settings
        try {
          await bridge.settings.updateLocal({
            settingType: 'receipt',
            settings: {
              text_scale: String(formData.textScale),
              logo_scale: String(formData.logoScale),
              layout_density_scale: String(layoutDensityScale),
            },
          })
        } catch (scaleErr) {
          console.warn('Failed to save scale settings:', scaleErr)
        }
        if (logoSettingsChanged()) await handleSaveLogoSettings({ quiet: true })
        toast.success(t('settings.printer.saved'))
        await loadPrinters()
        setViewMode('list')
        setSelectedPrinter(null)
        resetForm()
      } else {
        toast.error(result?.error || t('errors.operationFailed'))
      }
    } catch (e) {
      console.error('Save failed:', e)
      toast.error(t('errors.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Delete printer — show in-app confirmation first
  const handleDeleteRequest = (printerId: string) => {
    setDeleteConfirmId(printerId)
  }

  const handleDeleteConfirm = async () => {
    const printerId = deleteConfirmId
    if (!printerId) return
    setDeleteConfirmId(null)
    setLoading(true)
    try {
      const result = await api?.printerRemove?.(printerId)
      if (result?.success) {
        toast.success(t('settings.printer.deleted'))
        await loadPrinters()
      } else {
        toast.error(result?.error || t('errors.operationFailed'))
      }
    } catch (e) {
      console.error('Delete failed:', e)
      toast.error(t('errors.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Test print with detailed error handling
  // Requirements: 10.1, 10.2, 10.3, 10.5
  const handleTestPrint = async (printerId: string) => {
    setLoading(true)
    const printer = printers.find(p => p.id === printerId)
    const printerName = printer?.name || 'Printer'
    
    try {
      const result: any = await api?.printerTest?.(printerId)
      if (result?.success) {
        const latencyInfo = result.latencyMs ? ` (${result.latencyMs}ms)` : ''
        const dispatched = normalizeResolvedTransport(result?.resolvedTransport) === 'raw_tcp' || normalizeResolvedTransport(result?.resolvedTransport) === 'serial'
        const successText = dispatched
          ? t('settings.printer.testPrintDispatched', 'Test print dispatched')
          : t('settings.printer.testPrintSuccess')
        toast.success(`${printerName}: ${successText}${latencyInfo}`)
      } else {
        // Show detailed error message (Requirement 10.3)
        const errorMsg = result?.error || t('settings.printer.testPrintFailed')
        toast.error(`${printerName}: ${errorMsg}`, { duration: 6000 })
        
        // Log error and automatically show diagnostics for troubleshooting
        console.error(`Test print failed for ${printerName}:`, result?.error)
        
        // Automatically navigate to diagnostics view to help troubleshoot
        handleGetDiagnostics(printerId)
      }
    } catch (e) {
      console.error('Test print failed:', e)
      const errorMessage = e instanceof Error ? e.message : String(t('settings.printer.testPrintFailed'))
      toast.error(`${printerName}: ${errorMessage}`, { duration: 6000 })
      
      // Automatically navigate to diagnostics view to help troubleshoot
      handleGetDiagnostics(printerId)
    } finally {
      setLoading(false)
    }
  }

  // Greek test print — uses profile's character set and code page override
  const handleGreekTestPrint = async (printerId: string) => {
    setLoading(true)
    const printer = printers.find(p => p.id === printerId)
    const printerName = printer?.name || 'Printer'

    try {
      const result: unknown = await api?.printerTestGreekDirect?.(printerId)
      const parsed = parseWizardEnqueueResponse('encoding', result)
      if (parsed.ok) {
        toast.success(`${printerName}: ${t('settings.printer.greekTestPrintQueued', 'Greek test print queued')}`)
      } else {
        console.error('Greek test print returned an invalid managed queue response')
        toast.error(`${printerName}: ${t('settings.printer.testPrintFailed')}`, { duration: 6000 })
      }
    } catch (e) {
      console.error('Greek test print failed:', e)
      toast.error(`${printerName}: ${t('settings.printer.testPrintFailed')}`, { duration: 6000 })
    } finally {
      setLoading(false)
    }
  }

  // Get diagnostics
  const handleGetDiagnostics = async (printerId: string) => {
    setLoading(true)
    try {
      const result = await api?.printerGetDiagnostics?.(printerId)
      if (result?.success) {
        setDiagnostics(result.diagnostics)
        setViewMode('diagnostics')
      } else {
        toast.error(result?.error || t('errors.operationFailed'))
      }
    } catch (e) {
      console.error('Get diagnostics failed:', e)
      toast.error(t('errors.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Edit printer
  const handleEdit = (printer: PrinterConfig) => {
    setSelectedPrinter(printer)
    const conn = printer.connectionDetails
    setFormData({
      name: printer.name,
      type: printer.type,
      ip: conn.ip || '',
      port: conn.port || 9100,
      bluetoothAddress: conn.address || '',
      bluetoothChannel: conn.channel || 1,
      usbVendorId: conn.vendorId || 0,
      usbProductId: conn.productId || 0,
      usbSystemName: conn.systemName || '',
      usbPath: conn.path || '',
      systemPrinterName: printer.type === 'system' ? (conn.systemName || '') : '',
      paperSize: printer.paperSize,
      characterSet: printer.characterSet,
      greekRenderMode: printer.greekRenderMode || 'text',
      escposCodePage: printer.escposCodePage != null ? String(printer.escposCodePage) : '',
      receiptTemplate:
        printer.receiptTemplate || 'classic',
      fontType: printer.fontType || 'a',
      layoutDensity: printer.layoutDensity || 'compact',
      headerEmphasis: printer.headerEmphasis || 'strong',
      classicRenderMode:
        ((conn.render_mode as ClassicRenderMode | undefined) || 'text'),
      emulationMode:
        ((conn.emulation as EmulationMode | undefined) || 'auto'),
      printableWidthDots:
        conn.printable_width_dots != null ? String(conn.printable_width_dots) : '',
      leftMarginDots:
        conn.left_margin_dots != null ? String(conn.left_margin_dots) : '',
      rasterThreshold:
        conn.threshold != null ? String(conn.threshold) : '',
      role: printer.role,
      isDefault: printer.isDefault,
      fallbackPrinterId: printer.fallbackPrinterId || '',
      enabled: printer.enabled,
      textScale: formData.textScale,
      logoScale: formData.logoScale,
    })
    // Fetch auto-config for this printer
    setAutoConfig(null)
    api?.printerGetAutoConfig?.(printer.id).then((result: any) => {
      if (result && result.detectedBrand) {
        setAutoConfig({
          detectedBrand: result.detectedBrand,
          appLanguage: result.appLanguage || 'en',
          autoCharacterSet: result.autoCharacterSet || 'PC437_USA',
          autoCodePage: result.autoCodePage ?? null,
        })
      }
    }).catch(() => { /* auto-config is informational — ignore errors */ })
    setViewMode('edit')
  }

  const handleOpenQuickSetup = () => {
    setSetupMode('quick')
    setViewMode('wizard')
  }

  const handleEditDefaultCandidate = () => {
    const defaultCandidate =
      printers.find((printer) => printer.role === 'receipt') || printers[0]
    if (defaultCandidate) {
      handleEdit(defaultCandidate)
    }
  }

  const listSupportContext = useMemo(
    () =>
      buildPrinterSupportContext({
        view: 'list',
        printers,
        statuses,
      }),
    [printers, statuses],
  )

  const diagnosticsSupportContext = useMemo(
    () =>
      buildPrinterSupportContext({
        view: 'diagnostics',
        printers,
        statuses,
        diagnostics,
        selectedPrinterId: diagnostics?.printerId || selectedPrinter?.id || null,
      }),
    [diagnostics, printers, selectedPrinter?.id, statuses],
  )

  // Reset form
  const resetForm = () => {
    setFormData({
      name: '',
      type: 'network',
      ip: '',
      port: 9100,
      bluetoothAddress: '',
      bluetoothChannel: 1,
      usbVendorId: 0,
      usbProductId: 0,
      usbSystemName: '',
      usbPath: '',
      systemPrinterName: '',
      paperSize: '80mm',
      characterSet: 'PC437_USA',
      greekRenderMode: 'text',
      escposCodePage: '',
      receiptTemplate: 'classic',
      fontType: 'a',
      layoutDensity: 'compact',
      headerEmphasis: 'strong',
      classicRenderMode: 'text',
      emulationMode: 'auto',
      printableWidthDots: '',
      leftMarginDots: '',
      rasterThreshold: '',
      role: 'receipt',
      isDefault: false,
      fallbackPrinterId: '',
      enabled: true,
      textScale: 1.25,
      logoScale: 1.0,
    })
    setPreview(null)
    setPreviewError(null)
    setSelectedPrinter(null)
    setAutoConfig(null)
    setTextScaleAutoSwitchNotice(false)
  }

  // Get role label
  const getRoleLabel = (role: PrinterRole): string => {
    const labels: Record<PrinterRole, string> = {
      receipt: t('settings.printer.roleReceipt'),
      kitchen: t('settings.printer.roleKitchen'),
      bar: t('settings.printer.roleBar'),
      label: t('settings.printer.roleLabel'),
    }
    return labels[role] || role
  }

  // Get state label
  const getStateLabel = (state: PrinterState): string => {
    const labels: Record<PrinterState, string> = {
      online: t('settings.printer.stateOnline'),
      offline: t('settings.printer.stateOffline'),
      error: t('settings.printer.stateError'),
      busy: t('settings.printer.stateBusy'),
      degraded: t('settings.printer.stateDegraded', 'Degraded'),
      unverified: t('settings.printer.stateUnverified', 'Needs verification'),
      unresolved: t('settings.printer.stateUnresolved', 'Unresolved'),
    }
    return labels[state] || state
  }

  const getVerificationStatus = (printer: PrinterConfig, status?: PrinterStatus): VerificationStatus => {
    return normalizeVerificationStatus(status?.verificationStatus ?? readCapabilities(printer.connectionDetails).status)
  }

  const getResolvedTransport = (printer: PrinterConfig, status?: PrinterStatus): ResolvedTransport | null => {
    return normalizeResolvedTransport(status?.resolvedTransport ?? readCapabilities(printer.connectionDetails).resolvedTransport)
  }

  const getResolvedAddress = (printer: PrinterConfig, status?: PrinterStatus): string => {
    return asTrimmedString(status?.resolvedAddress ?? readCapabilities(printer.connectionDetails).resolvedAddress)
  }

  const getTransportReachable = (printer: PrinterConfig, status?: PrinterStatus): boolean | null => {
    if (typeof status?.transportReachable === 'boolean') return status.transportReachable
    const resolved = getResolvedTransport(printer, status)
    if (!resolved) return null
    return status?.state === 'online' || status?.state === 'degraded' || status?.state === 'unverified'
  }

  // Get printers by role
  const getPrintersByRole = (role: PrinterRole): PrinterConfig[] => {
    return printers.filter(p => p.role === role && p.enabled)
  }

  const handleClassicRenderModeChange = useCallback((nextMode: ClassicRenderMode) => {
    if (nextMode === 'text') {
      setTextScaleAutoSwitchNotice(false)
    }
    setFormData(prev => ({ ...prev, classicRenderMode: nextMode }))
  }, [])

  const handleTextScaleChange = useCallback((nextValue: number) => {
    const shouldAutoSwitch =
      formData.role === 'receipt' &&
      formData.receiptTemplate === 'classic' &&
      formData.classicRenderMode === 'text'

    if (shouldAutoSwitch) {
      setFormData(prev => ({
        ...prev,
        textScale: nextValue,
        classicRenderMode: 'raster_exact',
      }))
      setTextScaleAutoSwitchNotice(true)
      if (!textScaleAutoSwitchToastShownRef.current) {
        toast(t(
          'settings.printer.textScaleAutoSwitchToast',
          'Text-size changes switch this draft to image-like receipt mode so preview and print can match.',
        ))
        textScaleAutoSwitchToastShownRef.current = true
      }
      return
    }

    setFormData(prev => ({ ...prev, textScale: nextValue }))
  }, [formData.classicRenderMode, formData.receiptTemplate, formData.role, t])

  // Render role assignment summary
  const renderRolesSummary = () => {
    const roles: PrinterRole[] = ['receipt', 'kitchen', 'bar', 'label']
    const roleIcons: Record<PrinterRole, React.ReactNode> = {
      receipt: <Receipt className="w-4 h-4" />,
      kitchen: <ChefHat className="w-4 h-4" />,
      bar: <Wine className="w-4 h-4" />,
      label: <Tag className="w-4 h-4" />,
    }

    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        {roles.map(role => {
          const rolePrinters = getPrintersByRole(role)
          const hasOnline = rolePrinters.some(p => statuses[p.id]?.state === 'online')
          return (
            <div
              key={role}
              className={`p-2 rounded-lg border ${
                rolePrinters.length > 0
                  ? hasOnline
                    ? liquidGlassModalTone('success')
                    : liquidGlassModalTone('warning')
                  : liquidGlassModalTone('neutral')
              }`}
            >
              <div className="flex items-center gap-1 text-sm">
                <span className="inline-flex items-center">{roleIcons[role]}</span>
                <span className="font-medium liquid-glass-modal-text">{getRoleLabel(role)}</span>
              </div>
              <div className="text-xs liquid-glass-modal-text-muted mt-1">
                {rolePrinters.length === 0
                  ? t('settings.printer.noAssigned')
                  : rolePrinters.map(p => p.name).join(', ')}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // Section header helper — shared across list and form views
  const renderSectionHeader = (key: string, labelKey: string, labelDefault: string) => (
    <button
      type="button"
      onClick={() => toggleSection(key)}
      aria-expanded={Boolean(openSections[key as keyof typeof openSections])}
      className="w-full min-h-touch flex items-center justify-between px-3 py-2 rounded-xl bg-slate-100 text-slate-900 transition-colors active:bg-slate-200 dark:bg-zinc-800 dark:active:bg-zinc-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-slate-100 dark:focus-visible:ring-amber-500"
    >
      <span className="text-sm font-semibold text-slate-900 dark:text-white/90">
        {t(labelKey, labelDefault)}
      </span>
      <ChevronDown className={`w-4 h-4 text-slate-500 dark:text-white/60 transition-transform duration-200 ${openSections[key as keyof typeof openSections] ? 'rotate-180' : ''}`} />
    </button>
  )

  const renderReceiptActionSwitchRow = (key: ReceiptActionKey) => {
    const enabled = receiptActions[key]
    const Icon = getReceiptActionIcon(key)
    const label = t(`settings.printer.receiptActions.${camelCase(key)}`, key)

    // Round 301: the bespoke warm-pill switch is replaced by the shared POSGlassSwitch (green-on /
    // neutral-off, 58x34, no hover), matching the Round 295 Settings switch family. The whole row/card is
    // tappable for touchscreen convenience -- its onClick + cursor/active feedback toggle the action once --
    // while POSGlassSwitch remains the accessible button[role=switch] carrying the aria-label + checked
    // state. The switch is wrapped in a stopPropagation span so a tap on the switch toggles exactly once via
    // POSGlassSwitch.onChange and does not also bubble to the row tap (no double-toggle); the row is a div,
    // not a button, so there are no nested buttons. UI audit wave 7Γ: the row is neutral in both states;
    // the yellow switch and the «Active»/«Inactive» words carry the state (no green fill).
    return (
      <div
        key={key}
        onClick={() => handleReceiptActionToggle(key)}
        className="pos-choice-card pos-choice-card--row min-h-17 cursor-pointer active:scale-[0.99] focus-within:ring-2 focus-within:ring-zinc-900 dark:focus-within:ring-zinc-50"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center liquid-glass-modal-text-muted" aria-hidden="true">
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block whitespace-normal wrap-break-word text-sm font-semibold leading-tight liquid-glass-modal-text">
            {label}
          </span>
        </span>
        {/* The whole row toggles (touch UX); stopPropagation here means a tap on the switch toggles exactly
            once via POSGlassSwitch.onChange instead of also bubbling to the row's onClick. */}
        <span onClick={(event) => event.stopPropagation()}>
          <POSGlassSwitch
            checked={enabled}
            onChange={() => handleReceiptActionToggle(key)}
            aria-label={label}
          />
        </span>
      </div>
    )
  }

  const renderReceiptActionGrid = (keys: readonly ReceiptActionKey[]) => (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,23rem),1fr))] gap-2">
      {keys.map(renderReceiptActionSwitchRow)}
    </div>
  )

  // What a cashier needs to know about a printer, in plain words. Transport,
  // resolved address and protocol details live in Diagnostics.
  const getPlainPrinterState = (
    printer: PrinterConfig,
    status?: PrinterStatus,
  ): { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string; help?: string } => {
    if (!printer.enabled) {
      return { tone: 'neutral', label: t('settings.printer.plainState.off', 'Switched off in settings') }
    }
    const state = status?.state
    if (state === 'error' && status?.errorCode) {
      return { tone: 'danger', label: getStateLabel('error'), help: getErrorDescription(status.errorCode) }
    }
    if (state === 'offline' || state === 'error' || getTransportReachable(printer, status) === false) {
      return {
        tone: 'warning',
        label: t('settings.printer.plainState.notResponding', 'Not responding'),
        help: t('settings.printer.plainState.notRespondingHelp', 'Check that it is switched on, has paper and is connected.'),
      }
    }
    if (getVerificationStatus(printer, status) !== 'verified') {
      return {
        tone: 'warning',
        label: t('settings.printer.plainState.notTested', 'Not tested yet'),
        help: t('settings.printer.plainState.notTestedHelp', 'Print a test receipt to make sure Greek letters and € come out right.'),
      }
    }
    if (state === 'busy') return { tone: 'neutral', label: getStateLabel('busy') }
    return { tone: 'success', label: t('settings.printer.plainState.ready', 'Ready') }
  }

  const RECEIPT_ACTION_GROUPS: ReadonlyArray<{ id: string; labelKey: string; label: string; keys: readonly ReceiptActionKey[] }> = [
    { id: 'customer', labelKey: 'settings.printer.receiptActions.groupCustomer', label: 'Customer receipt', keys: ['after_order', 'after_edit', 'after_approve', 'payment_receipt', 'split_receipt'] },
    { id: 'kitchen', labelKey: 'settings.printer.receiptActions.groupKitchen', label: 'Kitchen and delivery', keys: ['kitchen_ticket', 'driver_assigned', 'on_complete', 'on_cancel'] },
    { id: 'day', labelKey: 'settings.printer.receiptActions.groupDay', label: 'Shift and Z report', keys: ['shift_close', 'z_report'] },
    { id: 'test', labelKey: 'settings.printer.receiptActions.groupTest', label: 'For testing', keys: ['print_sandbox_orders'] },
  ]

  // Render printer list view (UI audit wave 7Γ: kit rows, one status line, «Receipts» group).
  const renderListView = () => {
    const activeActionCount = RECEIPT_ACTION_KEYS.filter(key => receiptActions[key]).length
    const toneOf = (tone: string): StatusTone =>
      tone === 'success' ? 'ok' : tone === 'danger' ? 'bad' : tone === 'warning' ? 'warn' : 'idle'
    return (
    <div className="space-y-4" data-printer-list>
      {/* One clear way in: the guided setup finds and tests the printer. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PrinterSupportEntryPoint
          context={listSupportContext}
          onOpenQuickSetup={handleOpenQuickSetup}
          onEditPrinter={handleEditDefaultCandidate}
          showWhenFallback={false}
        />
        <button
          type="button"
          onClick={() => {
            resetForm()
            setSetupMode('quick')
            setViewMode('wizard')
          }}
          className={solidButton('primary', 'md') + ' ms-auto'}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('settings.printer.addPrinter')}
        </button>
      </div>

      <SettingsGroup title={t('settings.printer.printersGroup', 'Printers')}>
        {printers.length === 0 ? (
          <p className="pos-queue__empty">{t('settings.printer.noPrintersConfigured')}</p>
        ) : (
          <div className="pos-enter-stagger">
            {printers.map(printer => {
              const status = statuses[printer.id]
              const plain = getPlainPrinterState(printer, status)
              return (
                <div key={printer.id} data-printer-card className="pos-row">
                  <div className="pos-row__label">
                    <span className="pos-row__title">
                      {printer.name}
                      {printer.isDefault && (
                        <span className="pos-badge ms-2">{t('settings.printer.default')}</span>
                      )}
                    </span>
                    <span className="pos-row__help">
                      {getRoleLabel(printer.role)} · {plainPrinterTypeLabel(printer.type, t)} · {printer.paperSize.replace('mm', ' mm')}
                      {status?.queueLength > 0 && ` · ${status.queueLength} ${t('settings.printer.jobsInQueue')}`}
                    </span>
                    <StatusLine tone={toneOf(plain.tone)}>{plain.label}</StatusLine>
                    {plain.help && <span className="pos-row__help">{plain.help}</span>}
                  </div>
                  <div className="pos-row__control">
                    <button
                      type="button"
                      onClick={() => handleTestPrint(printer.id)}
                      disabled={loading || !printer.enabled}
                      className={solidButton('secondary', 'sm')}
                    >
                      {t('settings.printer.testPrint')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEdit(printer)}
                      className={solidButton('secondary', 'sm')}
                    >
                      {t('settings.printer.changes', 'Changes')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleGetDiagnostics(printer.id)}
                      disabled={loading}
                      aria-label={t('settings.printer.diagnostics')}
                      className="pos-icon-btn"
                    >
                      <Activity className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <TechDisclosure title={t('settings.printer.forTechnicians', 'Settings for technicians')}>
          <div>
            <button
              type="button"
              onClick={() => {
                resetForm()
                setSetupMode('expert')
                setViewMode('add')
              }}
              className={solidButton('secondary', 'md')}
            >
              {t('settings.printer.addPrinterManually', 'Enter a printer by hand')}
            </button>
          </div>
        </TechDisclosure>
      </SettingsGroup>

      {/* Receipts: terminal-wide settings that apply to every printer. */}
      <SettingsGroup title={t('settings.printer.receiptsGroup', 'Receipts')}>
        {receiptPromptRow}
        <SettingsRow
          title={t('settings.printer.autoPrintTitle', 'Automatic printing')}
          help={t('settings.printer.receiptActions.activeCount', {
            defaultValue: '{{count}} of {{total}} on',
            count: activeActionCount,
            total: RECEIPT_ACTION_KEYS.length,
          })}
          control={(
            <button type="button" onClick={() => setViewMode('receiptActions')} className={solidButton('secondary', 'sm')}>
              {t('settings.printer.change', 'Change')}
            </button>
          )}
        />
        <SettingsRow
          title={t('settings.printer.receiptLookTitle', 'Receipt look')}
          help={`${bodyBoldness > 1 ? t('settings.printer.receiptLookBold', 'Bold text') : t('settings.printer.receiptLookRegular', 'Regular text')} · ${logoEnabled ? t('settings.printer.receiptLookWithLogo', 'with logo') : t('settings.printer.receiptLookNoLogo', 'no logo')}`}
          control={(
            <button type="button" onClick={() => setReceiptLookOpen(true)} className={solidButton('secondary', 'sm')}>
              {t('settings.printer.change', 'Change')}
            </button>
          )}
        />
      </SettingsGroup>
    </div>
    )
  }

  // Receipt look (terminal-wide): bold text saves at once, as before; the logo saves with the footer.
  const restoreLogoDraft = () => {
    setLogoEnabled(persistedLogoRef.current.enabled)
    setLogoSourceOverride(persistedLogoRef.current.source)
  }
  const renderReceiptLookView = () => (
    <div className="space-y-4">
      <p className="text-sm liquid-glass-modal-text-muted">
        {t('settings.printer.receiptLookHelp', 'These apply to every printer of this till.')}
      </p>
      <SettingsGroup>
        <SettingsRow
          title={<span id="receipt-look-bold">{t('settings.printer.bolderText', 'Bolder text')}</span>}
          control={(
            <POSGlassSwitch
              aria-labelledby="receipt-look-bold"
              checked={bodyBoldness > 1}
              onChange={(checked) => { void handleBodyBoldnessChange(checked ? 3 : 1) }}
            />
          )}
        />
        <SettingsRow
          title={<span id="receipt-look-logo">{t('settings.printer.logoOnReceipt', 'Logo on the receipt')}</span>}
          help={t('settings.printer.logoOnReceiptHelp', 'Prints the business logo at the top of the receipt.')}
          control={<POSGlassSwitch aria-labelledby="receipt-look-logo" checked={logoEnabled} onChange={setLogoEnabled} />}
        />
        {logoEnabled && (
          <div className="pos-row pos-row--stack">
            <div className="flex flex-wrap gap-3">
              <label className={solidButton('secondary', 'sm')}>
                {t('settings.printer.chooseLogoFile', 'Choose file')}
                <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={handleLogoFileSelected} />
              </label>
              <button type="button" onClick={() => setLogoSourceOverride('')} className={solidButton('secondary', 'sm')}>
                {t('settings.printer.useBusinessLogo', 'Use the business logo')}
              </button>
            </div>
            <p className="pos-row__help">
              {logoSourceOverride.trim()
                ? t('settings.printer.logoFileChosenPlain', 'The receipt prints the file you chose.')
                : t('settings.printer.logoFallbackPlain', 'Without a file of your own, the receipt prints the business logo from the admin dashboard.')}
            </p>
            {logoLoaded && effectiveLogoSource && (
              <img
                src={effectiveLogoSource}
                alt={t('settings.printer.receiptLogoTitle', 'Receipt Logo') as string}
                className="max-h-20 self-start rounded-sm bg-white object-contain p-1"
              />
            )}
          </div>
        )}
      </SettingsGroup>
      <DirtyFooter
        visible={logoSettingsChanged()}
        note={t('settings.workflow.unsavedAnyTitle', 'Unsaved changes')}
        saveLabel={t('common.actions.save', 'Save')}
        cancelLabel={t('common.actions.cancel', 'Cancel')}
        saving={logoSaving}
        onSave={() => { void handleSaveLogoSettings().then(() => setReceiptLookOpen(false)) }}
        onCancel={restoreLogoDraft}
      />
    </div>
  )

  // Automatic printing: grouped by moment of the day; each switch saves at once.
  const renderReceiptActionsView = () => (
    <div className="space-y-4">
      <p className="text-sm liquid-glass-modal-text-muted">
        {t('settings.printer.autoPrintHelp', 'Choose what prints by itself. Changes are saved at once.')}
      </p>
      {RECEIPT_ACTION_GROUPS.map(group => (
        <div key={group.id} className="space-y-2">
          <div className="text-sm font-semibold liquid-glass-modal-text">{t(group.labelKey, group.label)}</div>
          {renderReceiptActionGrid(group.keys)}
        </div>
      ))}
      <div className="flex justify-end">
        <button type="button" onClick={() => setViewMode('list')} className={solidButton('primary', 'md')}>
          {t('common.actions.done', 'Done')}
        </button>
      </div>
    </div>
  )

  // Render add/edit form
  const renderFormView = () => {
    const selectedStatus = selectedPrinter ? statuses[selectedPrinter.id] : undefined
    const selectedVerification = selectedPrinter ? getVerificationStatus(selectedPrinter, selectedStatus) : 'unverified'
    const selectedTransport = selectedPrinter ? getResolvedTransport(selectedPrinter, selectedStatus) : null
    const selectedAddress = selectedPrinter ? getResolvedAddress(selectedPrinter, selectedStatus) : ''
    const savedCapabilities = selectedPrinter ? readCapabilities(selectedPrinter.connectionDetails) : defaultCapabilities()
    const nextCapabilities = buildCapabilitiesForSave(selectedPrinter)
    const resetsVerification = Boolean(selectedPrinter) &&
      normalizeVerificationStatus(savedCapabilities.status) === 'verified' &&
      normalizeVerificationStatus(nextCapabilities.status) === 'unverified'
    const textScaleDisabled = formData.receiptTemplate === 'modern'
    const previewBusy = previewLoading || !logoLoaded
    const previewBadgeClass = preview?.isExactPreview
      ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
      : 'border-amber-300 dark:border-amber-800 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
    const previewBadgeText = preview?.isExactPreview
      ? t('settings.printer.previewExact', 'Exact preview')
      : t('settings.printer.previewApproximate', 'Approximate preview')
    // Display-only: map known template/render-mode values to localized short
    // labels; fall back to the raw value for any unknown value. No data change.
    const previewTemplateValue = preview?.effectiveTemplate || formData.receiptTemplate
    const previewRenderModeValue = preview?.effectiveRenderMode || formData.classicRenderMode
    const previewTemplateLabel =
      previewTemplateValue === 'classic'
        ? t('settings.printer.previewTemplateClassic', 'Classic')
        : previewTemplateValue === 'modern'
          ? t('settings.printer.previewTemplateModern', 'Modern')
          : String(previewTemplateValue)
    const previewRenderModeLabel =
      previewRenderModeValue === 'text'
        ? t('settings.printer.previewRenderModeText', 'Text')
        : previewRenderModeValue === 'raster_exact'
          ? t('settings.printer.previewRenderModeRasterExact', 'Raster Exact')
          : String(previewRenderModeValue)
    const previewDetails = `${previewTemplateLabel} / ${previewRenderModeLabel}`
    // The basics show the three-step text size the wizard uses; any other mix of
    // font, density and header emphasis reads as "Custom".
    const textSizeChoice: ReadabilitySize | null =
      (Object.keys(PRINTER_READABILITY_PRESETS) as ReadabilitySize[]).find(size => {
        const preset = PRINTER_READABILITY_PRESETS[size]
        return preset.fontType === formData.fontType
          && preset.layoutDensity === formData.layoutDensity
          && preset.headerEmphasis === formData.headerEmphasis
      }) ?? null
    const textScaleHint = textScaleDisabled
      ? t(
        'settings.printer.textScaleModernUnavailable',
        'Modern receipts use fixed text size. Switch to Classic + Image-like receipt to adjust text size.',
      )
      : formData.role === 'receipt' &&
        formData.receiptTemplate === 'classic' &&
        formData.classicRenderMode === 'text'
      ? t(
        'settings.printer.textScaleTextModeHint',
        'Printer text ignores exact sizing. Moving this slider switches the preview to image-like receipt mode.',
      )
      : t('settings.printer.textScaleHint', 'Adjust the overall text size on printed receipts.')

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold liquid-glass-modal-text">
            {selectedPrinter ? selectedPrinter.name : t('settings.printer.addPrinter')}
          </h3>
          {selectedPrinter ? (
            <span className={`rounded-full border px-2.5 py-0.5 text-sm font-medium ${verificationTone(selectedVerification)}`}>
              {selectedVerification === 'verified'
                ? t('settings.printer.plainState.tested', 'Tested')
                : t('settings.printer.plainState.notTested', 'Not tested yet')}
            </span>
          ) : null}
        </div>

        {!selectedPrinter && (
          <div className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-3 text-sm ${liquidGlassModalTone('neutral')}`}>
            <span className="min-w-0 flex-1">
              {t('settings.printer.manualEntryHint', 'Enter the connection details your technician gave you. The guided setup can find and test the printer for you.')}
            </span>
            <button
              type="button"
              onClick={() => {
                setSetupMode('quick')
                setViewMode('wizard')
              }}
              className={`${liquidGlassModalButton('secondary', 'sm')} min-h-touch`}
            >
              {t('settings.printer.useGuidedSetup', 'Use guided setup')}
            </button>
          </div>
        )}

        {resetsVerification && (
          <div className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('warning')}`}>
            {t(
              'settings.printer.verificationResetWarning',
              'These manual changes affect transport or protocol settings, so this profile will return to an unverified state after save.',
            )}
          </div>
        )}

        {/* Split-pane layout: Form + Live Preview */}
        <div className="flex gap-4" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {/* Left: Form sections */}
          <div className="flex-1 min-w-0 overflow-y-auto scrollbar-hide pr-2 space-y-3">

            {/* Basics: what a cashier or owner sets. */}
            <div data-printer-basics className="space-y-4">
                  {/* Name */}
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.name')}
                    </label>
                    <input
                      value={formData.name}
                      onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                      className="liquid-glass-modal-input"
                      placeholder={t('settings.printer.namePlaceholder') as string}
                    />
                  </div>


              {!selectedPrinter && (
                <div className="space-y-3">
                    {/* Type */}
                    <div>
                      <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.type')}
                      </label>
                      <select
                        value={formData.type}
                        onChange={e => setFormData(prev => ({ ...prev, type: e.target.value as PrinterType }))}
                        className="liquid-glass-modal-input"
                      >
                        <option value="network">{t('settings.printer.typeNetwork')}</option>
                        <option value="wifi">{t('settings.printer.typeWifi')}</option>
                        <option value="bluetooth">{t('settings.printer.typeBluetooth')}</option>
                        <option value="usb">{t('settings.printer.typeUsb')}</option>
                        <option value="system">{t('settings.printer.typeSystem', 'System Printer')}</option>
                      </select>
                    </div>

                    {/* Connection details based on type */}
                    {(formData.type === 'network' || formData.type === 'wifi') && (
                      <>
                        <div>
                          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                            {t('settings.printer.networkIp')}
                          </label>
                          <input
                            value={formData.ip}
                            onChange={e => setFormData(prev => ({ ...prev, ip: e.target.value }))}
                            className="liquid-glass-modal-input"
                            placeholder="192.168.1.100"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                            {t('settings.printer.networkPort')}
                          </label>
                          <input
                            type="number"
                            value={formData.port}
                            onChange={e => setFormData(prev => ({ ...prev, port: parseInt(e.target.value) || 9100 }))}
                            className="liquid-glass-modal-input"
                            placeholder="9100"
                          />
                        </div>
                      </>
                    )}

                    {formData.type === 'bluetooth' && (
                      <>
                        <div>
                          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                            {t('settings.printer.bluetoothAddress')}
                          </label>
                          <input
                            value={formData.bluetoothAddress}
                            onChange={e => setFormData(prev => ({ ...prev, bluetoothAddress: e.target.value }))}
                            className="liquid-glass-modal-input"
                            placeholder="00:11:22:33:44:55"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                            {t('settings.printer.bluetoothChannel')}
                          </label>
                          <input
                            type="number"
                            value={formData.bluetoothChannel}
                            onChange={e => setFormData(prev => ({ ...prev, bluetoothChannel: parseInt(e.target.value) || 1 }))}
                            className="liquid-glass-modal-input"
                            placeholder="1"
                          />
                        </div>
                      </>
                    )}

                    {formData.type === 'usb' && (
                      <div>
                        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                          {t('settings.printer.usbPath')}
                        </label>
                        <input
                          value={formData.usbPath}
                          onChange={e => setFormData(prev => ({ ...prev, usbPath: e.target.value }))}
                          className="liquid-glass-modal-input"
                          placeholder={t('settings.printer.usbPathPlaceholder') as string}
                        />
                      </div>
                    )}

                    {formData.type === 'system' && (
                      <div>
                        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                          {t('settings.printer.systemName', 'Windows Printer Name')}
                        </label>
                        <input
                          value={formData.systemPrinterName || ''}
                          onChange={e => setFormData(prev => ({ ...prev, systemPrinterName: e.target.value }))}
                          className="liquid-glass-modal-input"
                          placeholder={t('settings.printer.systemNamePlaceholder', 'e.g., POS-58 Printer') as string}
                        />
                        <p className="text-xs liquid-glass-modal-text-muted mt-1">
                          {t('settings.printer.systemNameHint', 'Enter the exact printer name as shown in Windows Printers & Scanners')}
                        </p>
                      </div>
                    )}

                </div>
              )}

              <ChoiceChips
                labelId="printer-basics-role"
                label={t('settings.printer.whatItPrints', 'What it prints')}
                value={formData.role}
                onChange={(role) => setFormData(prev => ({ ...prev, role }))}
                options={[
                  { value: 'receipt', label: t('settings.printer.roleShort.receipt', 'Receipts') },
                  { value: 'kitchen', label: t('settings.printer.roleShort.kitchen', 'Kitchen') },
                  { value: 'bar', label: t('settings.printer.roleShort.bar', 'Bar') },
                  { value: 'label', label: t('settings.printer.roleShort.label', 'Labels') },
                ]}
              />

              <ChoiceChips
                labelId="printer-basics-paper"
                label={t('settings.printer.paperWidth', 'Paper width')}
                value={formData.paperSize}
                onChange={(paperSize) => setFormData(prev => ({ ...prev, paperSize }))}
                options={[
                  { value: '58mm', label: '58 mm' },
                  { value: '80mm', label: '80 mm' },
                  { value: '112mm', label: '112 mm' },
                ]}
              />

              {(formData.role === 'receipt' || formData.role === 'kitchen') && (
                <ChoiceChips
                  labelId="printer-basics-text-size"
                  label={t('settings.printer.textSize', 'Text size')}
                  value={textSizeChoice}
                  onChange={(size) => setFormData(prev => ({ ...prev, ...PRINTER_READABILITY_PRESETS[size] }))}
                  options={[
                    { value: 'small', label: t('settings.printer.quickWizardReadability.small', 'Small') },
                    { value: 'normal', label: t('settings.printer.quickWizardReadability.normal', 'Normal') },
                    { value: 'large', label: t('settings.printer.quickWizardReadability.large', 'Large') },
                  ]}
                  note={textSizeChoice ? undefined : t('settings.printer.textSizeCustom', 'Custom: set under Settings for technicians')}
                />
              )}

              <div className="space-y-1">
                {/* Bold text and the logo apply to every printer: «Αποδείξεις → Εμφάνιση απόδειξης». */}
                <div className="flex min-h-touch items-center justify-between gap-3">
                  <span id="printer-basics-default" className="text-sm liquid-glass-modal-text">{t('settings.printer.setAsDefault')}</span>
                  <POSGlassSwitch
                    aria-labelledby="printer-basics-default"
                    checked={formData.isDefault}
                    onChange={(checked) => setFormData(prev => ({ ...prev, isDefault: checked }))}
                  />
                </div>
                <div className="flex min-h-touch items-center justify-between gap-3">
                  <span id="printer-basics-enabled" className="text-sm liquid-glass-modal-text">{t('settings.printer.enabled')}</span>
                  <POSGlassSwitch
                    aria-labelledby="printer-basics-enabled"
                    checked={formData.enabled}
                    onChange={(checked) => setFormData(prev => ({ ...prev, enabled: checked }))}
                  />
                </div>
              </div>
            </div>

            {/* For technicians: every remaining field, closed by default. */}
            <button
              type="button"
              onClick={() => toggleSection('technical')}
              aria-expanded={openSections.technical}
              className="w-full min-h-touch flex items-center justify-between gap-3 px-3 py-2 rounded-xl border liquid-glass-modal-border text-left transition-colors active:bg-white"
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold liquid-glass-modal-text">{t('settings.printer.forTechnicians', 'Settings for technicians')}</span>
                <span className="block text-xs liquid-glass-modal-text-muted">{t('settings.printer.forTechniciansHint', 'Connection, printer language, characters, calibration')}</span>
              </span>
              <ChevronDown className={`w-4 h-4 shrink-0 text-slate-500 dark:text-white/60 transition-transform duration-200 ${openSections.technical ? 'rotate-180' : ''}`} />
            </button>
            {openSections.technical && (
            <div data-printer-technicians className="pos-enter space-y-3">
            {selectedPrinter && renderSectionHeader('connection', 'settings.printer.sectionConnection', 'Connection')}
            {selectedPrinter && openSections.connection && (
              <div className="space-y-3 pl-1">
                {/* Type */}
                <div>
                  <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                    {t('settings.printer.type')}
                  </label>
                  <select
                    value={formData.type}
                    onChange={e => setFormData(prev => ({ ...prev, type: e.target.value as PrinterType }))}
                    className="liquid-glass-modal-input"
                  >
                    <option value="network">{t('settings.printer.typeNetwork')}</option>
                    <option value="wifi">{t('settings.printer.typeWifi')}</option>
                    <option value="bluetooth">{t('settings.printer.typeBluetooth')}</option>
                    <option value="usb">{t('settings.printer.typeUsb')}</option>
                    <option value="system">{t('settings.printer.typeSystem', 'System Printer')}</option>
                  </select>
                </div>

                {/* Connection details based on type */}
                {(formData.type === 'network' || formData.type === 'wifi') && (
                  <>
                    <div>
                      <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.networkIp')}
                      </label>
                      <input
                        value={formData.ip}
                        onChange={e => setFormData(prev => ({ ...prev, ip: e.target.value }))}
                        className="liquid-glass-modal-input"
                        placeholder="192.168.1.100"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.networkPort')}
                      </label>
                      <input
                        type="number"
                        value={formData.port}
                        onChange={e => setFormData(prev => ({ ...prev, port: parseInt(e.target.value) || 9100 }))}
                        className="liquid-glass-modal-input"
                        placeholder="9100"
                      />
                    </div>
                  </>
                )}

                {formData.type === 'bluetooth' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.bluetoothAddress')}
                      </label>
                      <input
                        value={formData.bluetoothAddress}
                        onChange={e => setFormData(prev => ({ ...prev, bluetoothAddress: e.target.value }))}
                        className="liquid-glass-modal-input"
                        placeholder="00:11:22:33:44:55"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.bluetoothChannel')}
                      </label>
                      <input
                        type="number"
                        value={formData.bluetoothChannel}
                        onChange={e => setFormData(prev => ({ ...prev, bluetoothChannel: parseInt(e.target.value) || 1 }))}
                        className="liquid-glass-modal-input"
                        placeholder="1"
                      />
                    </div>
                  </>
                )}

                {formData.type === 'usb' && (
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.usbPath')}
                    </label>
                    <input
                      value={formData.usbPath}
                      onChange={e => setFormData(prev => ({ ...prev, usbPath: e.target.value }))}
                      className="liquid-glass-modal-input"
                      placeholder={t('settings.printer.usbPathPlaceholder') as string}
                    />
                  </div>
                )}

                {formData.type === 'system' && (
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.systemName', 'Windows Printer Name')}
                    </label>
                    <input
                      value={formData.systemPrinterName || ''}
                      onChange={e => setFormData(prev => ({ ...prev, systemPrinterName: e.target.value }))}
                      className="liquid-glass-modal-input"
                      placeholder={t('settings.printer.systemNamePlaceholder', 'e.g., POS-58 Printer') as string}
                    />
                    <p className="text-xs liquid-glass-modal-text-muted mt-1">
                      {t('settings.printer.systemNameHint', 'Enter the exact printer name as shown in Windows Printers & Scanners')}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Section 2: Paper & Template */}
            {renderSectionHeader('paperTemplate', 'settings.printer.sectionPaperTemplate', 'Paper & Template')}
            {openSections.paperTemplate && (
              <div className="space-y-3 pl-1">
                {/* Receipt Template */}
                {(formData.role === 'receipt' || formData.role === 'kitchen') && (
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.receiptTemplate', 'Receipt Template')}
                    </label>
                    <select
                      value={formData.receiptTemplate}
                      onChange={e => setFormData(prev => ({ ...prev, receiptTemplate: e.target.value as ReceiptTemplate }))}
                      className="liquid-glass-modal-input"
                    >
                      <option value="classic">{t('settings.printer.receiptTemplateClassic', 'Classic (operational)')}</option>
                      <option value="modern">{t('settings.printer.receiptTemplateModern', 'Modern (branded)')}</option>
                    </select>
                    <p className="text-xs liquid-glass-modal-text-muted mt-1">
                      {t('settings.printer.receiptTemplateHint', 'Classic: compact speed-first text layout. Modern: larger and bolder hierarchy with detailed ingredient lines.')}
                    </p>
                  </div>
                )}

                {/* Classic Render Mode */}
                {formData.role === 'receipt' && formData.receiptTemplate === 'classic' && (
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.classicRenderMode', 'Classic print style')}
                    </label>
                    <select
                      value={formData.classicRenderMode}
                      onChange={e => handleClassicRenderModeChange(e.target.value as ClassicRenderMode)}
                      className="liquid-glass-modal-input"
                    >
                      <option value="text">{t('settings.printer.classicRenderModeText', 'Printer text')}</option>
                      <option value="raster_exact">{t('settings.printer.classicRenderModeRasterExact', 'Image-like receipt')}</option>
                    </select>
                  </div>
                )}

                {/* Emulation Mode */}
                {formData.role === 'receipt' && formData.receiptTemplate === 'classic' && (
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.classicEmulationMode', 'Printer language')}
                    </label>
                    <select
                      value={formData.emulationMode}
                      onChange={e => setFormData(prev => ({ ...prev, emulationMode: e.target.value as EmulationMode }))}
                      className="liquid-glass-modal-input"
                    >
                      <option value="auto">{t('settings.printer.classicEmulationAuto', 'Auto detect')}</option>
                      <option value="escpos">{t('settings.printer.classicEmulationEscpos', 'ESC/POS')}</option>
                      <option value="star_line">{t('settings.printer.classicEmulationStarLine', 'Star Line')}</option>
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Section 3: Typography & Size */}
            {renderSectionHeader('typography', 'settings.printer.sectionTypography', 'Typography & Size')}
            {openSections.typography && (
              <div className="space-y-3 pl-1">
                {(formData.role === 'receipt' || formData.role === 'kitchen') && (
                  <>
                    <div>
                      <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.fontType', 'Font size')}
                      </label>
                      <select
                        value={formData.fontType}
                        onChange={e => setFormData(prev => ({ ...prev, fontType: e.target.value as FontType }))}
                        className="liquid-glass-modal-input"
                      >
                        <option value="a">{t('settings.printer.fontTypeA', 'Larger')}</option>
                        <option value="b">{t('settings.printer.fontTypeB', 'Compact')}</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.layoutDensityPreset', 'Density Preset')}
                      </label>
                      <select
                        value={formData.layoutDensity}
                        onChange={e => setFormData(prev => ({ ...prev, layoutDensity: e.target.value as LayoutDensity }))}
                        className="liquid-glass-modal-input"
                      >
                        <option value="compact">{t('settings.printer.layoutDensityCompact', 'Compact')}</option>
                        <option value="balanced">{t('settings.printer.layoutDensityBalanced', 'Balanced')}</option>
                        <option value="spacious">{t('settings.printer.layoutDensitySpacious', 'Spacious')}</option>
                      </select>
                    </div>

                    <ReceiptScaleSlider
                      label={t('settings.printer.layoutDensity', 'Layout Density')}
                      value={layoutDensityScale}
                      min={0.7}
                      max={1.35}
                      step={0.05}
                      defaultValue={1}
                      onChange={handleLayoutDensityScaleChange}
                      hint={t(
                        'settings.printer.layoutDensityScaleHint',
                        'Fine-tune spacing around the preset. Lower values tighten the receipt, higher values open it up.',
                      )}
                      resetLabel={t('settings.printer.resetToDefault', 'Reset')}
                    />

                    <div>
                      <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.headerEmphasis', 'Header Emphasis')}
                      </label>
                      <select
                        value={formData.headerEmphasis}
                        onChange={e => setFormData(prev => ({ ...prev, headerEmphasis: e.target.value as HeaderEmphasis }))}
                        className="liquid-glass-modal-input"
                      >
                        <option value="strong">{t('settings.printer.headerEmphasisStrong', 'Strong')}</option>
                        <option value="normal">{t('settings.printer.headerEmphasisNormal', 'Normal')}</option>
                      </select>
                    </div>

                    <p className="text-xs liquid-glass-modal-text-muted">
                      {t('settings.printer.safeTypographyHint', 'Safe mode avoids risky size commands. Use font, density, and emphasis presets for reliable receipts.')}
                    </p>
                  </>
                )}

                {/* Text Scale Slider */}
                <ReceiptScaleSlider
                  label={t('settings.printer.textScaleLabel', 'Text Scale')}
                  value={formData.textScale}
                  min={0.8}
                  max={2.0}
                  step={0.05}
                  defaultValue={1.25}
                  onChange={handleTextScaleChange}
                  hint={textScaleHint}
                  resetLabel={t('settings.printer.resetToDefault', 'Reset')}
                  disabled={textScaleDisabled}
                />
                {textScaleAutoSwitchNotice && formData.role === 'receipt' && formData.receiptTemplate === 'classic' && (
                  <div className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('warning')}`}>
                    {t(
                      'settings.printer.textScaleAutoSwitchInline',
                      'Text-size changes switch this draft to image-like receipt mode so preview and print can match.',
                    )}
                  </div>
                )}
                {/* Body Boldness Slider — receipt printers only */}
                {formData.role === 'receipt' && (
                  <ReceiptScaleSlider
                    label={t('settings.printer.bodyBoldness', 'Body Boldness')}
                    value={bodyBoldness}
                    min={1}
                    max={5}
                    step={1}
                    defaultValue={1}
                    onChange={handleBodyBoldnessChange}
                    hint={t('settings.printer.bodyBoldnessHint', 'Controls the weight of body text on printed receipts.')}
                    resetLabel={t('settings.printer.resetToDefault', 'Reset')}
                  />
                )}
              </div>
            )}

            {/* Section 4: Logo */}
            {renderSectionHeader('logo', 'settings.printer.sectionLogo', 'Logo')}
            {openSections.logo && (
              <div className="space-y-3 pl-1">
                <div className="flex flex-wrap gap-2 items-center">
                  <label className={liquidGlassModalButton('secondary', 'sm')}>
                    {t('settings.printer.chooseLogoFile', 'Choose file')}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={handleLogoFileSelected}
                    />
                  </label>
                  <button
                    onClick={() => setLogoSourceOverride('')}
                    className={liquidGlassModalButton('secondary', 'sm')}
                    type="button"
                  >
                    {t('settings.printer.useBusinessLogo', 'Use the business logo')}
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                    {t('settings.printer.logoSource', 'Logo source (URL / file path / data URL)')}
                  </label>
                  <input
                    value={logoSourceOverride}
                    onChange={e => setLogoSourceOverride(e.target.value)}
                    className="liquid-glass-modal-input"
                    placeholder={t('settings.printer.logoSourcePlaceholder', 'Paste URL or choose file') as string}
                  />
                  <p className="text-xs liquid-glass-modal-text-muted mt-1">
                    {logoSourceOverride.trim()
                      ? t('settings.printer.logoFileChosenPlain', 'The receipt prints the file you chose.')
                      : t('settings.printer.logoFallbackPlain', 'Without a file of your own, the receipt prints the business logo from the admin dashboard.')}
                  </p>
                </div>

                {/* Logo Scale Slider */}
                <ReceiptScaleSlider
                  label={t('settings.printer.logoScaleLabel', 'Logo Scale')}
                  value={formData.logoScale}
                  min={0.5}
                  max={2.0}
                  step={0.1}
                  defaultValue={1.0}
                  onChange={(v) => setFormData(prev => ({ ...prev, logoScale: v }))}
                  hint={t('settings.printer.logoScaleHint', 'Adjust the logo size on printed receipts.')}
                  resetLabel={t('settings.printer.resetToDefault', 'Reset')}
                />

                {/* Logo preview thumbnail */}
                {logoLoaded && effectiveLogoSource && (
                  <div className="rounded-2xl border liquid-glass-modal-border bg-slate-100 p-2">
                    <div className="text-xs liquid-glass-modal-text-muted mb-2">
                      {t('settings.printer.logoPreview', 'Preview')}
                    </div>
                    <img
                      src={effectiveLogoSource}
                      alt={t('settings.printer.receiptLogoTitle', 'Receipt Logo') as string}
                      className="max-h-20 object-contain bg-white rounded-sm p-1"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Section 5: Encoding */}
            {renderSectionHeader('encoding', 'settings.printer.sectionEncoding', 'Encoding')}
            {openSections.encoding && (
              <div className="space-y-3 pl-1">
                {/* Auto-Detection Info Banner */}
                {autoConfig && autoConfig.detectedBrand !== 'Unknown' && (
                  <div className="flex items-start gap-2 p-3 rounded-2xl bg-amber-50 dark:bg-amber-950 border border-amber-300 dark:border-amber-800">
                    <Info className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <div className="text-xs">
                      <div className="font-medium text-amber-800 dark:text-amber-300 mb-1">
                        {t('settings.printer.autoDetected', 'Auto-Detected Configuration')}
                      </div>
                      <div className="liquid-glass-modal-text-muted space-y-0.5">
                        <div>{t('settings.printer.detectedBrand', 'Brand')}: <span className="text-amber-800 dark:text-amber-300">{autoConfig.detectedBrand}</span></div>
                        <div>{t('settings.printer.autoCharacterSet', 'Character Set')}: <span className="text-amber-800 dark:text-amber-300">{autoConfig.autoCharacterSet}</span></div>
                        <div>{t('settings.printer.autoCodePage', 'Code Page')}: <span className="text-amber-800 dark:text-amber-300">{autoConfig.autoCodePage ?? 'N/A'}</span></div>
                      </div>
                      <p className="mt-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.autoDetectedHint', 'These values are used automatically when printing. Manual overrides below take priority.')}
                      </p>
                    </div>
                  </div>
                )}

                {/* Character Set */}
                <div>
                  <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                    {t('settings.printer.characterSet', 'Character Set')}
                  </label>
                  <select
                    value={formData.characterSet}
                    onChange={e => setFormData(prev => ({ ...prev, characterSet: e.target.value }))}
                    className="liquid-glass-modal-input"
                  >
                    <option value="PC437_USA">PC437 (USA/Standard)</option>
                    <option value="CP66_GREEK">CP66 (Chinese/Netum Greek)</option>
                    <option value="PC737_GREEK">PC737 (Greek)</option>
                    <option value="PC851_GREEK">PC851 (Greek)</option>
                    <option value="PC869_GREEK">PC869 (Greek)</option>
                    <option value="PC850_MULTILINGUAL">PC850 (Multilingual)</option>
                    <option value="PC852_LATIN2">PC852 (Latin 2)</option>
                    <option value="PC866_CYRILLIC">PC866 (Cyrillic)</option>
                    <option value="PC1252_LATIN1">PC1252 (Latin 1)</option>
                    <option value="PC1253_GREEK">PC1253 (Windows Greek)</option>
                  </select>
                  <p className="text-xs liquid-glass-modal-text-muted mt-1">
                    {t('settings.printer.characterSetHint', 'The character set is auto-detected from your app language. Only change this if auto-detection picks the wrong encoding.')}
                  </p>
                </div>

                {/* Greek Render Mode */}
                {(formData.characterSet.includes('GREEK') || formData.characterSet === 'CP66_GREEK') && (
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.greekRenderMode', 'Greek Rendering Mode')}
                    </label>
                    <select
                      value={formData.greekRenderMode}
                      onChange={e => setFormData(prev => ({ ...prev, greekRenderMode: e.target.value as GreekRenderMode }))}
                      className="liquid-glass-modal-input"
                    >
                      <option value="text">{t('settings.printer.greekRenderModeText', 'Text (use printer fonts)')}</option>
                      <option value="bitmap">{t('settings.printer.greekRenderModeBitmap', 'Bitmap (render as image)')}</option>
                    </select>
                    <p className="text-xs liquid-glass-modal-text-muted mt-1">
                      {t('settings.printer.greekRenderModeHint', 'Use "Text" if your printer has Greek fonts. Use "Bitmap" if Greek characters print as gibberish or squares.')}
                    </p>
                  </div>
                )}

                {/* ESC/POS Code Page Override */}
                <div>
                  <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                    {t('settings.printer.escposCodePage', 'ESC/POS Code Page Number')}
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={formData.escposCodePage}
                    onChange={e => setFormData(prev => ({ ...prev, escposCodePage: e.target.value }))}
                    placeholder={t('settings.printer.escposCodePagePlaceholder', 'Auto (leave empty for default)')}
                    className="liquid-glass-modal-input"
                  />
                  <p className="text-xs liquid-glass-modal-text-muted mt-1">
                    {t('settings.printer.escposCodePageHint', 'The code page is auto-detected from your printer brand and character set. Only set this if the auto-detected value doesn\'t work correctly.')}
                  </p>
                </div>
              </div>
            )}

            {/* Section 6: Calibration */}
            {renderSectionHeader('calibration', 'settings.printer.sectionCalibration', 'Calibration')}
            {openSections.calibration && (
              <div className="space-y-3 pl-1">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.classicPrintableWidthDots', 'Printable Width (dots)')}
                    </label>
                    <input
                      type="number"
                      min={64}
                      max={832}
                      value={formData.printableWidthDots}
                      onChange={e => setFormData(prev => ({ ...prev, printableWidthDots: e.target.value }))}
                      placeholder={t('settings.printer.classicPrintableWidthDotsAuto', 'Auto')}
                      className="liquid-glass-modal-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.classicLeftMarginDots', 'Left Margin (dots)')}
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={200}
                      value={formData.leftMarginDots}
                      onChange={e => setFormData(prev => ({ ...prev, leftMarginDots: e.target.value }))}
                      placeholder="0"
                      className="liquid-glass-modal-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.classicRasterThreshold', 'Threshold (1-255)')}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={255}
                      value={formData.rasterThreshold}
                      onChange={e => setFormData(prev => ({ ...prev, rasterThreshold: e.target.value }))}
                      placeholder="160"
                      className="liquid-glass-modal-input"
                    />
                  </div>
                </div>

                <p className="text-xs liquid-glass-modal-text-muted">
                  {t(
                    'settings.printer.classicRenderModeHint',
                    'Image-like receipt is best when exact spacing matters. Leave the advanced fields on Auto unless support asks you to change them.'
                  )}
                </p>
              </div>
            )}

            {/* Section 7: Role & Defaults */}
            {printers.length > 0 && renderSectionHeader('roleDefaults', 'settings.printer.sectionFallback', 'Backup printer')}
            {printers.length > 0 && openSections.roleDefaults && (
              <div className="space-y-3 pl-1">
                {/* Fallback Printer */}
                {printers.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.fallbackPrinter')}
                    </label>
                    <select
                      value={formData.fallbackPrinterId}
                      onChange={e => setFormData(prev => ({ ...prev, fallbackPrinterId: e.target.value }))}
                      className="liquid-glass-modal-input"
                    >
                      <option value="">{t('settings.printer.noFallback')}</option>
                      {printers
                        .filter(p => p.id !== selectedPrinter?.id)
                        .map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                  </div>
                )}

              </div>
            )}
            </div>
            )}
          </div>

          {/* Right: Live Preview */}
          <div className="w-[340px] shrink-0 flex flex-col">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold liquid-glass-modal-text">
                {t('settings.printer.livePreview', 'Live Preview')}
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${previewBadgeClass}`}>
                {previewBadgeText}
              </span>
            </div>
            <div className="mb-2 text-xs liquid-glass-modal-text-muted">
              {previewDetails}
            </div>
            {preview?.warnings && preview.warnings.length > 0 && (
              <div className={`mb-2 rounded-2xl border px-3 py-2 text-xs ${liquidGlassModalTone('warning')}`}>
                {preview.warnings.join(' ')}
              </div>
            )}
            <div className="flex-1 rounded-2xl border liquid-glass-modal-border bg-slate-200 overflow-hidden relative">
              {previewBusy && (
                <div className="absolute inset-0 flex items-center justify-center z-10">
                  <span className="text-xs liquid-glass-modal-text-muted">{t('settings.printer.previewLoading', 'Loading preview...')}</span>
                </div>
              )}
              {previewError ? (
                <div className="flex items-center justify-center h-full min-h-[500px] px-4 text-center text-xs text-amber-800 dark:text-amber-200">
                  {previewError}
                </div>
              ) : preview?.kind === 'image' && preview.dataUrl ? (
                <div className="h-full min-h-[500px] overflow-auto scrollbar-hide p-3">
                  {/* The raster image is exactly the printable width, so right-aligned
                      amounts touch its edge. White "paper" padding keeps them readable;
                      nothing may cover the image (a former edge mask hid "7,00" as "7,"). */}
                  <div className="rounded-md bg-white px-2 py-3 shadow-sm">
                    <img
                      src={preview.dataUrl}
                      alt={t('settings.printer.livePreview', 'Live Preview') as string}
                      className="block w-full h-auto"
                    />
                  </div>
                </div>
              ) : preview?.kind === 'html' && preview.html ? (
                <iframe
                  // Prepend scrollbar-hiding CSS so the iframe's own document does not
                  // show a native vertical rail (the parent `scrollbar-hide` cannot reach
                  // inside a separate iframe document). Scrolling + receipt rendering are
                  // unchanged -- this only suppresses the scrollbar chrome.
                  srcDoc={PREVIEW_HIDE_SCROLLBAR_STYLE + preview.html}
                  className="w-full h-full border-0"
                  sandbox="allow-same-origin"
                  style={{ minHeight: '500px' }}
                />
              ) : (
                <div className="flex items-center justify-center h-full min-h-[500px] text-xs liquid-glass-modal-text-muted">
                  {previewBusy
                    ? t('settings.printer.previewLoading', 'Loading preview...')
                    : t('settings.printer.previewUnavailable', 'Preview unavailable')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <div>
            {selectedPrinter && (
              <button
                type="button"
                onClick={() => handleDeleteRequest(selectedPrinter.id)}
                disabled={loading}
                className={`${liquidGlassModalButton('danger', 'md')} min-h-touch inline-flex items-center gap-2`}
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" />
                {t('common.actions.delete', 'Delete')}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { setViewMode('list'); resetForm() }}
              className={CANCEL_BTN_MD}
            >
              {t('common.actions.cancel')}
            </button>
            {selectedPrinter && (
              <button
                type="button"
                onClick={() => handleTestPrint(selectedPrinter.id)}
                disabled={loading}
                className={`${liquidGlassModalButton('secondary', 'md')} min-h-touch`}
              >
                {t('settings.printer.testPrint')}
              </button>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={loading || !formData.name}
              className={SAVE_BTN_MD}
            >
              {loading ? t('common.actions.saving') : t('common.actions.save')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Get error description for user-friendly display
  const getErrorDescription = (errorCode?: string): string => {
    if (!errorCode) return ''
    const errorDescriptions: Record<string, string> = {
      PAPER_OUT: t('settings.printer.errorPaperOut'),
      COVER_OPEN: t('settings.printer.errorCoverOpen'),
      PAPER_JAM: t('settings.printer.errorPaperJam'),
      CUTTER_ERROR: t('settings.printer.errorCutterError'),
      OVERHEATED: t('settings.printer.errorOverheated'),
      CONNECTION_LOST: t('settings.printer.errorConnectionLost'),
      UNKNOWN: t('settings.printer.errorUnknown'),
    }
    return errorDescriptions[errorCode] || errorCode
  }

  // Render diagnostics view
  const renderDiagnosticsView = () => {
    const printer = diagnostics ? printers.find(p => p.id === diagnostics.printerId) : null
    const status = diagnostics ? statuses[diagnostics.printerId] : null

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium liquid-glass-modal-text">
            {t('settings.printer.diagnostics')}
            {printer && `: ${printer.name}`}
          </h3>
          {diagnostics && (
            <button
              onClick={() => handleTestPrint(diagnostics.printerId)}
              disabled={loading}
              className={liquidGlassModalButton('primary', 'sm')}
            >
              {t('settings.printer.testPrint')}
            </button>
          )}
        </div>

        <PrinterSupportEntryPoint
          context={diagnosticsSupportContext}
          onRefreshDiagnostics={
            diagnostics ? () => handleGetDiagnostics(diagnostics.printerId) : undefined
          }
          onOpenQuickSetup={handleOpenQuickSetup}
          onEditPrinter={printer ? () => handleEdit(printer) : undefined}
          onBackToPrinters={() => setViewMode('list')}
        />

        {diagnostics ? (
          <div className="space-y-3">
            {/* Current Status */}
            {status && (
              <div className={`p-3 rounded-2xl border ${
                status.state === 'online' ? 'bg-green-50 dark:bg-green-950 border-green-300 dark:border-green-800' :
                status.state === 'error' ? 'bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-800' :
                status.state === 'busy' ? 'bg-yellow-50 dark:bg-yellow-950 border-yellow-300 dark:border-yellow-800' :
                status.state === 'degraded' ? 'bg-amber-50 dark:bg-amber-950 border-amber-300 dark:border-amber-800' :
                status.state === 'unverified' || status.state === 'unresolved' ? 'bg-amber-50 dark:bg-amber-950 border-amber-300 dark:border-amber-800' :
                'border-zinc-200 dark:border-zinc-700'
              }`}>
                <div className="flex items-center gap-2">
                  <StatusIndicator state={status.state} />
                  <span className="font-medium liquid-glass-modal-text">
                    {getStateLabel(status.state)}
                  </span>
                </div>
                {status.errorCode && (
                  <div className="mt-1 text-sm text-red-700 dark:text-red-400">
                    {getErrorDescription(status.errorCode)}
                    {status.errorMessage && `: ${status.errorMessage}`}
                  </div>
                )}
                {status.queueLength > 0 && (
                  <div className="mt-1 text-xs liquid-glass-modal-text-muted">
                    {status.queueLength} {t('settings.printer.jobsInQueue')}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                  <span className={`px-2 py-0.5 rounded-sm border ${verificationTone(status.verificationStatus)}`}>
                    {verificationLabel(status.verificationStatus, t)}
                  </span>
                  <span className="px-2 py-0.5 rounded-sm border liquid-glass-modal-border liquid-glass-modal-text-muted">
                    {transportLabel(status.resolvedTransport, t)}
                  </span>
                  {status.resolvedAddress ? (
                    <span className="px-2 py-0.5 rounded-sm border liquid-glass-modal-border liquid-glass-modal-text-muted">
                      {status.resolvedAddress}
                    </span>
                  ) : null}
                </div>
              </div>
            )}

            {/* Connection Details */}
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="liquid-glass-modal-text-muted">{t('settings.printer.connectionType')}:</div>
              <div className="liquid-glass-modal-text">{formatPrinterTypeLabel(diagnostics.connectionType)}</div>

              {diagnostics.connectionLatencyMs !== undefined && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.latency')}:</div>
                  <div className={`liquid-glass-modal-text ${
                    diagnostics.connectionLatencyMs > 1000 ? 'text-red-700 dark:text-red-400' :
                    diagnostics.connectionLatencyMs > 500 ? 'text-amber-700 dark:text-yellow-400' : ''
                  }`}>
                    {diagnostics.connectionLatencyMs}ms
                    {diagnostics.connectionLatencyMs > 500 && (
                      <AlertTriangle className="w-3 h-3 inline-block ml-1 align-text-top text-amber-700 dark:text-yellow-400" />
                    )}
                  </div>
                </>
              )}

              {diagnostics.signalStrength !== undefined && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.signalStrength')}:</div>
                  <div className={`liquid-glass-modal-text ${
                    diagnostics.signalStrength < 30 ? 'text-red-700 dark:text-red-400' :
                    diagnostics.signalStrength < 60 ? 'text-amber-700 dark:text-yellow-400' : ''
                  }`}>
                    {diagnostics.signalStrength}%
                    {diagnostics.signalStrength < 30 && (
                      <span className="inline-flex items-center gap-1 ml-1 text-red-700 dark:text-red-400">
                        <AlertTriangle className="w-3 h-3" />
                        {t('settings.printer.weakSignal')}
                      </span>
                    )}
                  </div>
                </>
              )}

              {diagnostics.model && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.model')}:</div>
                  <div className="liquid-glass-modal-text">{diagnostics.model}</div>
                </>
              )}

              {diagnostics.firmwareVersion && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.firmware')}:</div>
                  <div className="liquid-glass-modal-text">{diagnostics.firmwareVersion}</div>
                </>
              )}

              {diagnostics.verificationStatus && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.verification', 'Verification')}:</div>
                  <div className="liquid-glass-modal-text">{verificationLabel(diagnostics.verificationStatus, t)}</div>
                </>
              )}

              {diagnostics.resolvedTransport && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.resolvedTransport', 'Resolved Transport')}:</div>
                  <div className="liquid-glass-modal-text">{transportLabel(diagnostics.resolvedTransport, t)}</div>
                </>
              )}

              {diagnostics.resolvedAddress && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.resolvedAddress', 'Resolved Address')}:</div>
                  <div className="liquid-glass-modal-text">{diagnostics.resolvedAddress}</div>
                </>
              )}
            </div>

            {/* Recent Jobs Statistics */}
            <div className="border-t liquid-glass-modal-border pt-3">
              <div className="text-sm font-medium liquid-glass-modal-text mb-2">
                {t('settings.printer.recentJobs')}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-2 rounded-sm">
                  <div className="text-lg font-bold liquid-glass-modal-text">{diagnostics.recentJobs.total}</div>
                  <div className="text-xs liquid-glass-modal-text-muted">{t('settings.printer.total')}</div>
                </div>
                <div className="p-2 rounded-sm bg-green-50 dark:bg-green-950">
                  <div className="text-lg font-bold text-green-700 dark:text-green-400">{diagnostics.recentJobs.successful}</div>
                  <div className="text-xs liquid-glass-modal-text-muted">{t('settings.printer.successful')}</div>
                </div>
                <div className="p-2 rounded-sm bg-red-50 dark:bg-red-950">
                  <div className="text-lg font-bold text-red-700 dark:text-red-400">{diagnostics.recentJobs.failed}</div>
                  <div className="text-xs liquid-glass-modal-text-muted">{t('settings.printer.failed')}</div>
                </div>
              </div>
              {/* Success rate */}
              {diagnostics.recentJobs.total > 0 && (
                <div className="mt-2 text-xs text-center liquid-glass-modal-text-muted">
                  {t('settings.printer.successRate')}: {Math.round((diagnostics.recentJobs.successful / diagnostics.recentJobs.total) * 100)}%
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center py-8 liquid-glass-modal-text-muted">
            {t('settings.printer.noDiagnostics')}
          </div>
        )}

        <button onClick={() => setViewMode('list')} className={liquidGlassModalButton('secondary', 'md')}>
          {t('common.actions.back')}
        </button>
      </div>
    )
  }

  const renderWizardView = () => (
    <PrinterSetupWizard
      existingPrinters={printers as any}
      logoSettingsLoaded={logoLoaded}
      logoConfigured={logoLoaded && persistedLogoConfigured}
      onBusyChange={handleWizardBusyChange}
      onOpenLogoSettings={() => {
        setReceiptLookOpen(true)
      }}
      onCancel={() => setViewMode('list')}
      onOpenExpert={() => {
        setSetupMode('expert')
        resetForm()
        setViewMode('add')
      }}
      onSaved={async () => {
        await loadPrinters()
        setViewMode('list')
      }}
    />
  )

  const handleWizardBusyChange = useCallback((busy: boolean) => {
    wizardBusyRef.current = busy
    setWizardBusy(busy)
  }, [])

  const handleModalClose = () => {
    if (!wizardBusyRef.current) onClose()
  }

  // Render content based on view mode
  const renderContent = () => {
    switch (viewMode) {
      case 'list':
        return renderListView()
      case 'add':
      case 'edit':
        return renderFormView()
      case 'diagnostics':
        return renderDiagnosticsView()
      case 'wizard':
        return renderWizardView()
      case 'receiptActions':
        return renderReceiptActionsView()
      default:
        return renderListView()
    }
  }

  const deleteConfirmDialog = (
    <ConfirmDialog
      isOpen={Boolean(deleteConfirmId)}
      onClose={() => setDeleteConfirmId(null)}
      onConfirm={() => { void handleDeleteConfirm() }}
      variant="error"
      title={t('settings.printer.deleteTitle', {
        name: printers.find(p => p.id === deleteConfirmId)?.name || '',
        defaultValue: 'Delete printer “{{name}}”',
      })}
      message={t('settings.printer.confirmDelete')}
      confirmText={t('common.actions.delete', 'Delete')}
      cancelText={t('common.actions.cancel', 'Cancel')}
      isLoading={loading}
    />
  )

  const receiptLookWindow = (
    <LiquidGlassModal
      isOpen={isOpen && receiptLookOpen}
      onClose={() => { restoreLogoDraft(); setReceiptLookOpen(false) }}
      title={t('settings.printer.receiptLookTitle', 'Receipt look')}
      size="md"
      className="max-w-2xl!"
    >
      <div className="pos-enter px-6 pb-6">{renderReceiptLookView()}</div>
    </LiquidGlassModal>
  )

  if (embedded) {
    const closeWindow = () => {
      if (wizardBusyRef.current) return
      setViewMode('list')
      setSelectedPrinter(null)
      resetForm()
    }
    return (
      <>
        {renderListView()}
        <LiquidGlassModal
          isOpen={isOpen && viewMode !== 'list'}
          onClose={closeWindow}
          title={viewMode === 'receiptActions'
            ? t('settings.printer.autoPrintTitle', 'Automatic printing')
            : t('settings.printer.title')}
          size="lg"
          className={viewMode === 'add' || viewMode === 'edit' ? 'max-w-5xl!' : 'max-w-2xl!'}
          closeOnBackdrop={!wizardBusy}
          closeOnEscape={!wizardBusy}
        >
          {/* The window body already pads; only the sides and bottom need more (wave 7Γ). */}
          <div key={viewMode} className="pos-enter px-6 pb-6">
            {renderContent()}
          </div>
          {deleteConfirmDialog}
        </LiquidGlassModal>
        {receiptLookWindow}
      </>
    )
  }

  return (
    <>
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleModalClose}
      title={t('settings.printer.title')}
      size="lg"
      className={viewMode === 'add' || viewMode === 'edit' ? 'max-w-5xl!' : 'max-w-2xl!'}
      closeOnBackdrop={!wizardBusy}
      closeOnEscape={!wizardBusy}
    >
      <div key={viewMode} className="pos-enter p-6">
        {renderContent()}
      </div>

      {/* Delete confirmation: the shared themed dialog, localized in every language. */}
      {deleteConfirmDialog}
    </LiquidGlassModal>
    {receiptLookWindow}
    </>
  )
}

export default PrinterSettingsModal
