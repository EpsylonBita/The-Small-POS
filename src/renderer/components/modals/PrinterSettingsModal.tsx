import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { LiquidGlassModal } from '../ui/pos-glass-components'
import { liquidGlassModalButton } from '../../styles/designSystem'
import { Activity, AlertTriangle, ChefHat, ChevronDown, Info, Pencil, Printer, Receipt, Tag, Trash2, Wine } from 'lucide-react'
import { getBridge, offEvent, onEvent } from '../../../lib'
import PrinterSetupWizard from './PrinterSetupWizard'
import { ReceiptScaleSlider } from '../ui/ReceiptScaleSlider'

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

interface DiscoveredPrinter {
  name: string
  type: PrinterType
  address: string
  port?: number
  model?: string
  manufacturer?: string
  isConfigured: boolean
  source?: string
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

const normalizeDiscoveredPrinterEntry = (raw: any): DiscoveredPrinter | null => {
  if (!raw || typeof raw !== 'object') return null

  const type = normalizePrinterType(raw.type)
  const name =
    (typeof raw.name === 'string' && raw.name.trim()) ||
    (typeof raw.printerName === 'string' && raw.printerName.trim()) ||
    ''
  const addressCandidate =
    (typeof raw.address === 'string' && raw.address.trim()) ||
    (typeof raw.ip === 'string' && raw.ip.trim()) ||
    (typeof raw.host === 'string' && raw.host.trim()) ||
    name
  if (!name && !addressCandidate) return null

  const parsedPort = Number(raw.port)
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined

  return {
    name: name || addressCandidate,
    type,
    address: addressCandidate || name,
    port,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    manufacturer: typeof raw.manufacturer === 'string' ? raw.manufacturer : undefined,
    isConfigured: Boolean(raw.isConfigured),
    source: typeof raw.source === 'string' ? raw.source : undefined,
  }
}

const dedupeDiscoveredPrinters = (printers: DiscoveredPrinter[]): DiscoveredPrinter[] => {
  const seen = new Set<string>()
  const out: DiscoveredPrinter[] = []
  for (const printer of printers) {
    const key = `${normalizePrinterType(printer.type)}:${(printer.address || '').trim().toLowerCase()}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(printer)
    }
  }
  return out
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
  if (status === 'verified') return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
  if (status === 'degraded') return 'bg-amber-500/10 border-amber-500/30 text-amber-200'
  if (status === 'candidate') return 'bg-blue-500/10 border-blue-500/30 text-blue-200'
  return 'bg-white/5 border-white/10 liquid-glass-modal-text-muted'
}

// View modes for the modal
type SetupMode = 'quick' | 'expert'
type ViewMode = 'list' | 'add' | 'edit' | 'discover' | 'diagnostics' | 'wizard'

// Status indicator component
const StatusIndicator: React.FC<{ state: PrinterState }> = ({ state }) => {
  const colors: Record<PrinterState, string> = {
    online: 'bg-green-500',
    offline: 'bg-gray-500',
    error: 'bg-red-500',
    busy: 'bg-yellow-500',
    degraded: 'bg-amber-400',
    unverified: 'bg-blue-400',
    unresolved: 'bg-orange-400',
  }
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[state] || 'bg-gray-400'}`} />
  )
}

const PrinterSettingsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  initialMode = 'quick',
  autoStartWizard = false,
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
  const [setupMode, setSetupMode] = useState<SetupMode>(initialMode)
  const [printers, setPrinters] = useState<PrinterConfig[]>([])
  const [statuses, setStatuses] = useState<Record<string, PrinterStatus>>({})
  const [discoveredPrinters, setDiscoveredPrinters] = useState<DiscoveredPrinter[]>([])
  const [selectedPrinter, setSelectedPrinter] = useState<PrinterConfig | null>(null)
  const [diagnostics, setDiagnostics] = useState<PrinterDiagnostics | null>(null)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
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
  })
  const toggleSection = (key: string) => setOpenSections(prev => ({ ...prev, [key as keyof typeof prev]: !prev[key as keyof typeof prev] }))

  // Live preview state
  const [previewHtml, setPreviewHtml] = useState<string>('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    try {
      const [showLogoRaw, logoSourceRaw, orgLogoRaw, textScaleRaw, logoScaleRaw] = await Promise.all([
        bridge.settings.get({ category: 'receipt', key: 'show_logo', defaultValue: false }),
        bridge.settings.get({ category: 'receipt', key: 'logo_source' }),
        bridge.settings.get({ category: 'organization', key: 'logo_url' }),
        bridge.settings.get({ category: 'receipt', key: 'text_scale' }),
        bridge.settings.get({ category: 'receipt', key: 'logo_scale' }),
      ])
      setLogoEnabled(parseBooleanSetting(showLogoRaw))
      setLogoSourceOverride(asTrimmedString(logoSourceRaw))
      setOrgLogoSource(asTrimmedString(orgLogoRaw))
      const parsedTextScale = parseFloat(asTrimmedString(textScaleRaw))
      const parsedLogoScale = parseFloat(asTrimmedString(logoScaleRaw))
      if (Number.isFinite(parsedTextScale) && parsedTextScale > 0) {
        setFormData(prev => ({ ...prev, textScale: parsedTextScale }))
      }
      if (Number.isFinite(parsedLogoScale) && parsedLogoScale > 0) {
        setFormData(prev => ({ ...prev, logoScale: parsedLogoScale }))
      }
      setLogoLoaded(true)
    } catch (e) {
      console.error('Failed to load receipt logo settings:', e)
      setLogoLoaded(true)
    }
  }, [bridge])

  const handleSaveLogoSettings = useCallback(async () => {
    setLogoSaving(true)
    try {
      await bridge.settings.updateLocal({
        settingType: 'receipt',
        settings: {
          show_logo: logoEnabled,
          logo_source: logoSourceOverride.trim(),
        },
      })
      toast.success(t('settings.printer.logoSettingsSaved', 'Receipt logo settings saved'))
    } catch (e) {
      console.error('Failed to save logo settings:', e)
      toast.error(t('settings.printer.logoSettingsSaveFailed', 'Failed to save receipt logo settings'))
    } finally {
      setLogoSaving(false)
    }
  }, [bridge, logoEnabled, logoSourceOverride, t])

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

  // Initial load (status updates are pushed by Rust monitor events)
  useEffect(() => {
    if (!isOpen) return
    loadPrinters()
    loadStatuses()
    loadReceiptLogoSettings()
    return
  }, [isOpen, loadPrinters, loadStatuses, loadReceiptLogoSettings])

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

  // Fetch preview when textScale or logoScale changes (debounced)
  useEffect(() => {
    if (viewMode !== 'add' && viewMode !== 'edit') return
    if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current)
    previewTimeoutRef.current = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const bridgeAny = bridge as any
        const result: any = await bridgeAny.receipt?.samplePreview?.({ textScale: formData.textScale, logoScale: formData.logoScale })
        if (result?.success && result?.html) {
          setPreviewHtml(result.html)
        }
      } catch (e) {
        console.warn('Preview failed:', e)
      } finally {
        setPreviewLoading(false)
      }
    }, 200)
    return () => { if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current) }
  }, [formData.textScale, formData.logoScale, viewMode, bridge])

  // Fetch initial preview on form open
  useEffect(() => {
    if (viewMode === 'add' || viewMode === 'edit') {
      (async () => {
        try {
          const bridgeAny = bridge as any
          const result: any = await bridgeAny.receipt?.samplePreview?.({ textScale: formData.textScale, logoScale: formData.logoScale })
          if (result?.success && result?.html) setPreviewHtml(result.html)
        } catch (_e) { /* preview is best-effort */ }
      })()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])

  // Discover printers (network, USB, system)
  const handleDiscover = async (types?: PrinterType[]) => {
    setScanning(true)
    try {
      const result = await api?.printerDiscover?.(types)
      if (result?.success) {
        const rawPrinters = Array.isArray(result.printers) ? result.printers : []
        const normalizedPrinters = rawPrinters
          .map((entry: unknown) => normalizeDiscoveredPrinterEntry(entry))
          .filter((printer: DiscoveredPrinter | null): printer is DiscoveredPrinter => Boolean(printer))
        if (normalizedPrinters.length !== rawPrinters.length) {
          console.warn('[PrinterSettings] Filtered malformed discovery entries', {
            received: rawPrinters.length,
            accepted: normalizedPrinters.length,
          })
        }
        setDiscoveredPrinters(normalizedPrinters)
        setViewMode('discover')
      } else {
        toast.error(result?.error || t('settings.printer.discoveryFailed'))
      }
    } catch (e) {
      console.error('Discovery failed:', e)
      toast.error(t('settings.printer.discoveryFailed'))
    } finally {
      setScanning(false)
    }
  }

  // Add printer from discovered
  const handleAddFromDiscovered = (discovered: DiscoveredPrinter) => {
    const connectionDetails: ConnectionDetails = { type: discovered.type }
    let usbVendorId = 0
    let usbProductId = 0
    
    if (discovered.type === 'network' || discovered.type === 'wifi') {
      connectionDetails.ip = discovered.address
      connectionDetails.port = discovered.port || 9100
    } else if (discovered.type === 'bluetooth') {
      connectionDetails.address = discovered.address
      connectionDetails.channel = 1
    } else if (discovered.type === 'usb') {
      connectionDetails.path = discovered.address
      // Parse USB address format "vendorId:productId" (e.g., "1046:20497")
      const usbParts = discovered.address.split(':')
      if (usbParts.length === 2) {
        usbVendorId = parseInt(usbParts[0], 10) || 0
        usbProductId = parseInt(usbParts[1], 10) || 0
      }
    }

    setFormData({
      name: discovered.name || `${discovered.type} Printer`,
      type: discovered.type,
      ip: connectionDetails.ip || '',
      port: connectionDetails.port || 9100,
      bluetoothAddress: connectionDetails.address || '',
      bluetoothChannel: connectionDetails.channel || 1,
      usbVendorId,
      usbProductId,
      usbSystemName: '',
      usbPath: connectionDetails.path || '',
      systemPrinterName:
        discovered.type === 'system'
          ? (discovered.name || discovered.address || '')
          : '',
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
      isDefault: printers.length === 0,
      fallbackPrinterId: '',
      enabled: true,
      textScale: 1.25,
      logoScale: 1.0,
    })
    setViewMode('add')
  }

  // Build connection details from form
  const buildConnectionDetails = (): ConnectionDetails => {
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
  }

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
      const config = {
        name: formData.name,
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
      }

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
            },
          })
        } catch (scaleErr) {
          console.warn('Failed to save scale settings:', scaleErr)
        }
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
      const result: any = await api?.printerTestGreekDirect?.(printerId)
      if (result?.success) {
        const latencyInfo = result.latencyMs ? ` (${result.latencyMs}ms)` : ''
        const cpInfo = result.escposCodePage != null ? ` [CP=${result.escposCodePage}]` : ' [CP=Auto]'
        const dispatched = normalizeResolvedTransport(result?.resolvedTransport) === 'raw_tcp' || normalizeResolvedTransport(result?.resolvedTransport) === 'serial'
        const successText = dispatched
          ? t('settings.printer.greekTestPrintDispatched', 'Greek test print dispatched')
          : t('settings.printer.greekTestPrintSuccess', 'Greek test print sent')
        toast.success(`${printerName}: ${successText}${cpInfo}${latencyInfo}`)
      } else {
        const errorMsg = result?.error || t('settings.printer.testPrintFailed')
        toast.error(`${printerName}: ${errorMsg}`, { duration: 6000 })
      }
    } catch (e) {
      console.error('Greek test print failed:', e)
      const errorMessage = e instanceof Error ? e.message : String(t('settings.printer.testPrintFailed'))
      toast.error(`${printerName}: ${errorMessage}`, { duration: 6000 })
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
    setSelectedPrinter(null)
    setAutoConfig(null)
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

  const buildCapabilitiesForSave = (printer?: PrinterConfig | null): PrinterCapabilities => {
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
  }

  // Get printers by role
  const getPrintersByRole = (role: PrinterRole): PrinterConfig[] => {
    return printers.filter(p => p.role === role && p.enabled)
  }

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
                    ? 'bg-green-500/10 border-green-500/30'
                    : 'bg-yellow-500/10 border-yellow-500/30'
                  : 'bg-white/5 border-white/10'
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

  // Render printer list view
  const renderListView = () => (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg bg-white/5 border border-white/10 p-1">
        <button
          onClick={() => setSetupMode('quick')}
          className={`px-3 py-1.5 text-xs rounded-md transition ${
            setupMode === 'quick' ? 'bg-blue-500/20 text-blue-200' : 'liquid-glass-modal-text-muted'
          }`}
          type="button"
        >
          {t('settings.printer.quickSetup', 'Quick Setup')}
        </button>
        <button
          onClick={() => setSetupMode('expert')}
          className={`px-3 py-1.5 text-xs rounded-md transition ${
            setupMode === 'expert' ? 'bg-blue-500/20 text-blue-200' : 'liquid-glass-modal-text-muted'
          }`}
          type="button"
        >
          {t('settings.printer.expertSettings', 'Expert Settings')}
        </button>
      </div>

      <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-100">
        {t(
          'settings.printer.verificationFirstHint',
          'Use Quick Setup first. It verifies a working transport and encoding path before you rely on a printer in live service.',
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => {
            resetForm()
            setViewMode(setupMode === 'quick' ? 'wizard' : 'add')
          }}
          className={liquidGlassModalButton('primary', 'sm')}
        >
          {setupMode === 'quick'
            ? t('settings.printer.startQuickSetup', 'Start Verification Wizard')
            : t('settings.printer.addPrinter')}
        </button>
        <button
          onClick={() => handleDiscover()}
          disabled={scanning}
          className={liquidGlassModalButton('secondary', 'sm')}
        >
          {scanning ? t('settings.printer.scanning') : t('settings.printer.discoverPrinters')}
        </button>
      </div>

      {/* Role assignments summary */}
      {printers.length > 0 && renderRolesSummary()}

      {/* Printer list */}
      {printers.length === 0 ? (
        <div className="text-center py-8 liquid-glass-modal-text-muted">
          {t('settings.printer.noPrintersConfigured')}
        </div>
      ) : (
        <div className="space-y-2">
          {printers.map(printer => {
            const status = statuses[printer.id]
            const verificationStatus = getVerificationStatus(printer, status)
            const resolvedTransport = getResolvedTransport(printer, status)
            const resolvedAddress = getResolvedAddress(printer, status)
            const transportReachable = getTransportReachable(printer, status)
            return (
              <div
                key={printer.id}
                className="p-3 rounded-lg bg-white/5 border border-white/10 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <StatusIndicator state={status?.state || 'offline'} />
                  <div>
                    <div className="font-medium liquid-glass-modal-text">
                      {printer.name}
                      {printer.isDefault && (
                        <span className="ml-2 text-xs bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded">
                          {t('settings.printer.default')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs liquid-glass-modal-text-muted">
                      {formatPrinterTypeLabel(printer.type)} • {getRoleLabel(printer.role)}
                      {status?.state && ` • ${getStateLabel(status.state)}`}
                      {status?.queueLength > 0 && ` • ${status.queueLength} ${t('settings.printer.jobsInQueue')}`}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                      <span className={`px-2 py-0.5 rounded border ${verificationTone(verificationStatus)}`}>
                        {verificationLabel(verificationStatus, t)}
                      </span>
                      <span className="px-2 py-0.5 rounded border border-white/10 liquid-glass-modal-text-muted">
                        {transportLabel(resolvedTransport, t)}
                      </span>
                      {transportReachable === false && verificationStatus !== 'verified' && (
                        <span className="px-2 py-0.5 rounded border border-amber-500/30 text-amber-200">
                          {t('settings.printer.transportUnreachable', 'Transport unreachable')}
                        </span>
                      )}
                    </div>
                    {(resolvedAddress || verificationStatus === 'unverified') && (
                      <div className="mt-1 text-[11px] liquid-glass-modal-text-muted">
                        {resolvedAddress
                          ? `${t('settings.printer.resolvedAddress', 'Resolved address')}: ${resolvedAddress}`
                          : t('settings.printer.discoveredNotPrintable', 'Discovered, not yet printable. Run the wizard to verify a working path.')}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleGetDiagnostics(printer.id)}
                    disabled={loading}
                    className={liquidGlassModalButton('secondary', 'sm')}
                    title={t('settings.printer.diagnostics')}
                  >
                    <Activity className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleEdit(printer)}
                    className={liquidGlassModalButton('secondary', 'sm')}
                    title={t('common.actions.edit')}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDeleteRequest(printer.id)}
                    disabled={loading}
                    className={liquidGlassModalButton('danger', 'sm')}
                    title={t('common.actions.delete')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  // Render discovery view
  const renderDiscoverView = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium liquid-glass-modal-text">{t('settings.printer.discoveredPrinters')}</h3>
        <button
          onClick={() => handleDiscover()}
          disabled={scanning}
          className={liquidGlassModalButton('secondary', 'sm')}
        >
          {scanning ? t('settings.printer.scanning') : t('settings.printer.refresh')}
        </button>
      </div>

      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
        {t(
          'settings.printer.discoveredOnlyHint',
          'Discovery does not mean printable yet. Complete the verification wizard before using a discovered printer in service.',
        )}
      </div>

      {discoveredPrinters.length === 0 ? (
        <div className="text-center py-8 liquid-glass-modal-text-muted">
          {scanning ? t('settings.printer.scanning') : t('settings.printer.noDevicesFound')}
        </div>
      ) : (
        <div className="space-y-2">
          {discoveredPrinters.map((printer, idx) => (
            <div
              key={idx}
              className="p-3 rounded-lg bg-white/5 border border-white/10 flex items-center justify-between"
            >
              <div>
                <div className="font-medium liquid-glass-modal-text">{printer.name}</div>
                <div className="text-xs liquid-glass-modal-text-muted">
                  {formatPrinterTypeLabel(printer.type)} • {printer.address}
                  {printer.port && `:${printer.port}`}
                  {printer.model && ` • ${printer.model}`}
                </div>
                <div className="text-[11px] liquid-glass-modal-text-muted mt-1">
                  {t('settings.printer.discoveredNotPrintable', 'Discovered, not yet printable. Run the wizard to verify a working path.')}
                </div>
              </div>
              <button
                onClick={() => handleAddFromDiscovered(printer)}
                disabled={printer.isConfigured}
                className={liquidGlassModalButton(printer.isConfigured ? 'secondary' : 'primary', 'sm')}
              >
                {printer.isConfigured ? t('settings.printer.alreadyConfigured') : t('settings.printer.add')}
              </button>
            </div>
          ))}
        </div>
      )}

      <button onClick={() => setViewMode('list')} className={liquidGlassModalButton('secondary', 'md')}>
        {t('common.actions.back')}
      </button>
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

    // Section header helper
    const renderSectionHeader = (key: string, labelKey: string, labelDefault: string) => (
      <button
        type="button"
        onClick={() => toggleSection(key)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 hover:bg-white/8 transition-colors"
      >
        <span className="text-xs font-semibold text-white/90 uppercase tracking-wider">
          {t(labelKey, labelDefault)}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-white/50 transition-transform ${openSections[key as keyof typeof openSections] ? 'rotate-180' : ''}`} />
      </button>
    )

    return (
      <div className="space-y-4">
        <h3 className="font-medium liquid-glass-modal-text">
          {viewMode === 'edit' ? t('settings.printer.editPrinter') : t('settings.printer.addPrinter')}
        </h3>

        <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-100">
          <div className="font-medium mb-1">
            {t('settings.printer.quickSetupFirstTitle', 'Quick setup first')}
          </div>
          <div>
            {t(
              'settings.printer.quickSetupFirstBody',
              'Use the verification wizard for the normal path. This form is for manual connection entry and expert overrides.',
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setSetupMode('quick')
              setViewMode('wizard')
            }}
            className={`${liquidGlassModalButton('secondary', 'sm')} mt-3`}
          >
            {t('settings.printer.startQuickSetup', 'Start Verification Wizard')}
          </button>
        </div>

        <div className={`rounded-lg border p-3 ${verificationTone(selectedVerification)}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium">
                {verificationLabel(selectedVerification, t)}
              </div>
              <div className="text-xs mt-1">
                {selectedPrinter
                  ? t('settings.printer.verificationSummaryExisting', 'Saved printer verification state from the last successful setup.')
                  : t('settings.printer.verificationSummaryNew', 'New manual profiles start unverified until the wizard confirms a working path.')}
              </div>
            </div>
            <div className="text-right text-xs">
              <div>{transportLabel(selectedTransport, t)}</div>
              {selectedAddress ? <div className="mt-1">{selectedAddress}</div> : null}
            </div>
          </div>
          {selectedVerification === 'unverified' && !selectedTransport && (
            <div className="mt-2 text-xs">
              {t('settings.printer.discoveredNotPrintable', 'Discovered, not yet printable. Run the wizard to verify a working path.')}
            </div>
          )}
        </div>

        {resetsVerification && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
            {t(
              'settings.printer.verificationResetWarning',
              'These manual changes affect transport or protocol settings, so this profile will return to an unverified state after save.',
            )}
          </div>
        )}

        {/* Split-pane layout: Form + Live Preview */}
        <div className="flex gap-4" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {/* Left: Form sections */}
          <div className="flex-1 min-w-0 overflow-y-auto pr-2 space-y-3">

            {/* Section 1: Connection */}
            {renderSectionHeader('connection', 'settings.printer.sectionConnection', 'Connection')}
            {openSections.connection && (
              <div className="space-y-3 pl-1">
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
                    <p className="text-xs text-gray-400 mt-1">
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
                {/* Paper Size */}
                <div>
                  <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                    {t('settings.printer.paperSize')}
                  </label>
                  <select
                    value={formData.paperSize}
                    onChange={e => setFormData(prev => ({ ...prev, paperSize: e.target.value as PaperSize }))}
                    className="liquid-glass-modal-input"
                  >
                    <option value="58mm">58mm</option>
                    <option value="80mm">80mm</option>
                    <option value="112mm">112mm</option>
                  </select>
                </div>

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
                    <p className="text-xs text-gray-400 mt-1">
                      {t('settings.printer.receiptTemplateHint', 'Classic: compact speed-first text layout. Modern: larger and bolder hierarchy with detailed ingredient lines.')}
                    </p>
                  </div>
                )}

                {/* Classic Render Mode */}
                {formData.role === 'receipt' && formData.receiptTemplate === 'classic' && (
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.classicRenderMode', 'Classic Customer Render Mode')}
                    </label>
                    <select
                      value={formData.classicRenderMode}
                      onChange={e => setFormData(prev => ({ ...prev, classicRenderMode: e.target.value as ClassicRenderMode }))}
                      className="liquid-glass-modal-input"
                    >
                      <option value="text">{t('settings.printer.classicRenderModeText', 'Text (ESC/POS font)')}</option>
                      <option value="raster_exact">{t('settings.printer.classicRenderModeRasterExact', 'Raster Exact (screenshot-like)')}</option>
                    </select>
                  </div>
                )}

                {/* Emulation Mode */}
                {formData.role === 'receipt' && formData.receiptTemplate === 'classic' && (
                  <div>
                    <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                      {t('settings.printer.classicEmulationMode', 'Raster Emulation')}
                    </label>
                    <select
                      value={formData.emulationMode}
                      onChange={e => setFormData(prev => ({ ...prev, emulationMode: e.target.value as EmulationMode }))}
                      className="liquid-glass-modal-input"
                    >
                      <option value="auto">{t('settings.printer.classicEmulationAuto', 'Auto (brand detect)')}</option>
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
                        {t('settings.printer.fontType', 'Font Type')}
                      </label>
                      <select
                        value={formData.fontType}
                        onChange={e => setFormData(prev => ({ ...prev, fontType: e.target.value as FontType }))}
                        className="liquid-glass-modal-input"
                      >
                        <option value="a">{t('settings.printer.fontTypeA', 'A (Larger)')}</option>
                        <option value="b">{t('settings.printer.fontTypeB', 'B (Compact)')}</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                        {t('settings.printer.layoutDensity', 'Layout Density')}
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

                    <p className="text-xs text-gray-400">
                      {t('settings.printer.safeTypographyHint', 'Star-safe mode avoids risky size commands. Use Font A/B and density/emphasis presets for reliable readability.')}
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
                  onChange={(v) => setFormData(prev => ({ ...prev, textScale: v }))}
                  hint={t('settings.printer.textScaleHint', 'Adjust the overall text size on printed receipts.')}
                  resetLabel={t('settings.printer.resetToDefault', 'Reset')}
                />
              </div>
            )}

            {/* Section 4: Logo */}
            {renderSectionHeader('logo', 'settings.printer.sectionLogo', 'Logo')}
            {openSections.logo && (
              <div className="space-y-3 pl-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium liquid-glass-modal-text">
                      {t('settings.printer.receiptLogoTitle', 'Receipt Logo')}
                    </div>
                    <div className="text-[10px] liquid-glass-modal-text-muted">
                      {t('settings.printer.receiptLogoHint', 'Optional per-organization logo for printed receipts (PNG/JPG supported).')}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={logoEnabled}
                      onChange={e => setLogoEnabled(e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-xs liquid-glass-modal-text">
                      {t('settings.printer.enableLogo', 'Enable logo')}
                    </span>
                  </label>
                </div>

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
                    {t('settings.printer.useOrgLogo', 'Use org logo fallback')}
                  </button>
                  <button
                    onClick={handleSaveLogoSettings}
                    className={liquidGlassModalButton('primary', 'sm')}
                    disabled={logoSaving}
                    type="button"
                  >
                    {logoSaving
                      ? t('common.actions.saving', 'Saving...')
                      : t('common.actions.save', 'Save')}
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
                      ? t('settings.printer.logoSourceCustomActive', 'Custom receipt logo source is active.')
                      : t('settings.printer.logoSourceFallbackActive', 'Using organization logo fallback from terminal settings.')}
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
                {logoLoaded && (logoSourceOverride.trim() || orgLogoSource.trim()) && (
                  <div className="rounded-md bg-black/20 border border-white/10 p-2">
                    <div className="text-xs liquid-glass-modal-text-muted mb-2">
                      {t('settings.printer.logoPreview', 'Preview')}
                    </div>
                    <img
                      src={logoSourceOverride.trim() || orgLogoSource.trim()}
                      alt="Receipt logo preview"
                      className="max-h-20 object-contain bg-white rounded p-1"
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
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <Info className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
                    <div className="text-xs">
                      <div className="font-medium text-blue-300 mb-1">
                        {t('settings.printer.autoDetected', 'Auto-Detected Configuration')}
                      </div>
                      <div className="liquid-glass-modal-text-muted space-y-0.5">
                        <div>{t('settings.printer.detectedBrand', 'Brand')}: <span className="text-blue-300">{autoConfig.detectedBrand}</span></div>
                        <div>{t('settings.printer.autoCharacterSet', 'Character Set')}: <span className="text-blue-300">{autoConfig.autoCharacterSet}</span></div>
                        <div>{t('settings.printer.autoCodePage', 'Code Page')}: <span className="text-blue-300">{autoConfig.autoCodePage ?? 'N/A'}</span></div>
                      </div>
                      <p className="mt-1 text-gray-400">
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
                  <p className="text-xs text-gray-400 mt-1">
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
                    <p className="text-xs text-gray-400 mt-1">
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
                  <p className="text-xs text-gray-400 mt-1">
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

                <p className="text-xs text-gray-400">
                  {t(
                    'settings.printer.classicRenderModeHint',
                    'Use Raster Exact for screenshot-like classic receipts. 80mm defaults to full width (576 dots). MCP31 first-pass: emulation=star_line, optional left margin=0-8, threshold=145-165. Auto defaults are applied when fields are empty.'
                  )}
                </p>
              </div>
            )}

            {/* Section 7: Role & Defaults */}
            {renderSectionHeader('roleDefaults', 'settings.printer.sectionRoleDefaults', 'Role & Defaults')}
            {openSections.roleDefaults && (
              <div className="space-y-3 pl-1">
                {/* Role */}
                <div>
                  <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                    {t('settings.printer.role')}
                  </label>
                  <select
                    value={formData.role}
                    onChange={e => setFormData(prev => ({ ...prev, role: e.target.value as PrinterRole }))}
                    className="liquid-glass-modal-input"
                  >
                    <option value="receipt">{t('settings.printer.roleReceipt')}</option>
                    <option value="kitchen">{t('settings.printer.roleKitchen')}</option>
                    <option value="bar">{t('settings.printer.roleBar')}</option>
                    <option value="label">{t('settings.printer.roleLabel')}</option>
                  </select>
                </div>

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

                {/* Options */}
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.isDefault}
                      onChange={e => setFormData(prev => ({ ...prev, isDefault: e.target.checked }))}
                      className="rounded"
                    />
                    <span className="text-sm liquid-glass-modal-text">{t('settings.printer.setAsDefault')}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.enabled}
                      onChange={e => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
                      className="rounded"
                    />
                    <span className="text-sm liquid-glass-modal-text">{t('settings.printer.enabled')}</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Right: Live Preview */}
          <div className="w-[340px] flex-shrink-0 flex flex-col">
            <div className="text-xs font-semibold text-white/70 uppercase tracking-wider mb-2">
              {t('settings.printer.livePreview', 'Live Preview')}
            </div>
            <div className="flex-1 bg-white/5 rounded-lg border border-white/10 overflow-hidden relative">
              {previewLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-10">
                  <span className="text-xs text-white/50">{t('settings.printer.previewLoading', 'Loading preview...')}</span>
                </div>
              )}
              {previewHtml ? (
                <iframe
                  srcDoc={previewHtml}
                  className="w-full h-full border-0"
                  sandbox="allow-same-origin"
                  style={{ minHeight: '500px' }}
                />
              ) : (
                <div className="flex items-center justify-center h-full min-h-[500px] text-xs text-white/30">
                  {t('settings.printer.previewLoading', 'Loading preview...')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={() => { setViewMode('list'); resetForm() }}
            className={liquidGlassModalButton('secondary', 'md')}
          >
            {t('common.actions.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={loading || !formData.name}
            className={liquidGlassModalButton('primary', 'md')}
          >
            {loading ? t('common.actions.saving') : t('common.actions.save')}
          </button>
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

        {diagnostics ? (
          <div className="space-y-3">
            {/* Current Status */}
            {status && (
              <div className={`p-3 rounded-lg border ${
                status.state === 'online' ? 'bg-green-500/10 border-green-500/30' :
                status.state === 'error' ? 'bg-red-500/10 border-red-500/30' :
                status.state === 'busy' ? 'bg-yellow-500/10 border-yellow-500/30' :
                status.state === 'degraded' ? 'bg-amber-500/10 border-amber-500/30' :
                status.state === 'unverified' || status.state === 'unresolved' ? 'bg-blue-500/10 border-blue-500/30' :
                'bg-gray-500/10 border-gray-500/30'
              }`}>
                <div className="flex items-center gap-2">
                  <StatusIndicator state={status.state} />
                  <span className="font-medium liquid-glass-modal-text">
                    {getStateLabel(status.state)}
                  </span>
                </div>
                {status.errorCode && (
                  <div className="mt-1 text-sm text-red-400">
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
                  <span className={`px-2 py-0.5 rounded border ${verificationTone(status.verificationStatus)}`}>
                    {verificationLabel(status.verificationStatus, t)}
                  </span>
                  <span className="px-2 py-0.5 rounded border border-white/10 liquid-glass-modal-text-muted">
                    {transportLabel(status.resolvedTransport, t)}
                  </span>
                  {status.resolvedAddress ? (
                    <span className="px-2 py-0.5 rounded border border-white/10 liquid-glass-modal-text-muted">
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
                    diagnostics.connectionLatencyMs > 500 ? 'text-yellow-400' :
                    diagnostics.connectionLatencyMs > 1000 ? 'text-red-400' : ''
                  }`}>
                    {diagnostics.connectionLatencyMs}ms
                    {diagnostics.connectionLatencyMs > 500 && (
                      <AlertTriangle className="w-3 h-3 inline-block ml-1 align-text-top text-yellow-400" />
                    )}
                  </div>
                </>
              )}

              {diagnostics.signalStrength !== undefined && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.signalStrength')}:</div>
                  <div className={`liquid-glass-modal-text ${
                    diagnostics.signalStrength < 30 ? 'text-red-400' :
                    diagnostics.signalStrength < 60 ? 'text-yellow-400' : ''
                  }`}>
                    {diagnostics.signalStrength}%
                    {diagnostics.signalStrength < 30 && (
                      <span className="inline-flex items-center gap-1 ml-1 text-red-400">
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
            <div className="border-t border-white/10 pt-3">
              <div className="text-sm font-medium liquid-glass-modal-text mb-2">
                {t('settings.printer.recentJobs')}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-2 rounded bg-white/5">
                  <div className="text-lg font-bold liquid-glass-modal-text">{diagnostics.recentJobs.total}</div>
                  <div className="text-xs liquid-glass-modal-text-muted">{t('settings.printer.total')}</div>
                </div>
                <div className="p-2 rounded bg-green-500/10">
                  <div className="text-lg font-bold text-green-400">{diagnostics.recentJobs.successful}</div>
                  <div className="text-xs liquid-glass-modal-text-muted">{t('settings.printer.successful')}</div>
                </div>
                <div className="p-2 rounded bg-red-500/10">
                  <div className="text-lg font-bold text-red-400">{diagnostics.recentJobs.failed}</div>
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

  // Render content based on view mode
  const renderContent = () => {
    switch (viewMode) {
      case 'list':
        return renderListView()
      case 'discover':
        return renderDiscoverView()
      case 'add':
      case 'edit':
        return renderFormView()
      case 'diagnostics':
        return renderDiagnosticsView()
      case 'wizard':
        return renderWizardView()
      default:
        return renderListView()
    }
  }

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('settings.printer.title')}
      size="lg"
      className={viewMode === 'add' || viewMode === 'edit' ? '!max-w-5xl' : '!max-w-2xl'}
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <div className="p-6">
        {renderContent()}
      </div>

      {/* Delete confirmation overlay */}
      {deleteConfirmId && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm rounded-2xl">
          <div className="bg-gray-900/95 border border-white/15 rounded-xl p-6 mx-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <Trash2 className="w-5 h-5 text-red-400 flex-shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-white">Delete Printer</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {printers.find(p => p.id === deleteConfirmId)?.name || 'Printer'}
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-300 mb-5">
              {t('settings.printer.confirmDelete')}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className={liquidGlassModalButton('secondary', 'sm')}
              >
                {t('common.actions.cancel') || 'Cancel'}
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                {t('common.actions.delete') || 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </LiquidGlassModal>
  )
}

export default PrinterSettingsModal
