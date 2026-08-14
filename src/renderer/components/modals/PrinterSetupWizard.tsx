import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { AlertTriangle, CheckCircle2, ChevronRight, Info, Printer, SlidersHorizontal, Wand2 } from 'lucide-react'
import { liquidGlassModalButton, liquidGlassModalTone } from '../../styles/designSystem'
import { getBridge } from '../../../lib'
import { usePrintQueue } from '../../hooks/usePrintQueue'
import {
  canSaveVerifiedPrinter,
  canStartWizardSample,
  createVerificationState,
  parseWizardEnqueueResponse,
  verificationReducer,
  type VerificationSample,
} from './printer-setup-verification'

type PrinterType = 'network' | 'bluetooth' | 'usb' | 'wifi' | 'system'
type PaperSize = '58mm' | '80mm' | '112mm'
type ReceiptTemplate = 'classic' | 'modern'
type FontType = 'a' | 'b'
type LayoutDensity = 'compact' | 'balanced' | 'spacious'
type HeaderEmphasis = 'normal' | 'strong'
type ClassicRenderMode = 'text' | 'raster_exact'
type EmulationMode = 'auto' | 'escpos' | 'star_line'
type PrinterRole = 'receipt' | 'kitchen' | 'bar' | 'label'
type VerificationStatus = 'unverified' | 'verified' | 'degraded' | 'candidate'
type ResolvedTransport = 'windows_queue' | 'raw_tcp' | 'serial'
type DraftSampleKind = 'transport_text' | 'encoding' | 'branding'

export type ReadabilitySize = 'small' | 'normal' | 'large'

interface PrinterCapabilities {
  status?: VerificationStatus | string
  resolvedTransport?: ResolvedTransport | string
  resolvedAddress?: string
  emulation?: EmulationMode | string
  renderMode?: ClassicRenderMode | string
  baudRate?: number | null
  supportsCut?: boolean
  supportsLogo?: boolean
  lastVerifiedAt?: string | null
}

interface ConnectionDetails {
  type: string
  ip?: string
  hostname?: string
  port?: number
  address?: string
  channel?: number
  path?: string
  systemName?: string
  vendorId?: number
  productId?: number
  render_mode?: ClassicRenderMode
  emulation?: EmulationMode
  printable_width_dots?: number
  left_margin_dots?: number
  threshold?: number
  capabilities?: PrinterCapabilities
}

interface ExistingPrinterProfile {
  id: string
  name: string
  type: PrinterType
  role: PrinterRole
  isDefault?: boolean
  connectionDetails?: ConnectionDetails
}

interface ProbeHints {
  preferredEmulationOrder?: string[]
  preferredRenderOrder?: string[]
  preferredBaudRates?: number[]
}

export interface RecommendedPrinterConfig {
  printerType: PrinterType
  paperSize: PaperSize
  characterSet: string
  escposCodePage?: number | null
  receiptTemplate: ReceiptTemplate
  fontType: FontType
  layoutDensity: LayoutDensity
  headerEmphasis: HeaderEmphasis
  connectionDetails: ConnectionDetails
}

export interface PrinterCandidate {
  id: string
  name: string
  type: PrinterType
  address: string
  port?: number
  source: string
  isConfigured: boolean
  detectedBrand: string
  confidence: number
  reasons: string[]
  recommended: RecommendedPrinterConfig
  probeHints?: ProbeHints
}

interface Props {
  existingPrinters: ExistingPrinterProfile[]
  onCancel: () => void
  onSaved: () => Promise<void> | void
  onOpenExpert: () => void
  logoSettingsLoaded: boolean
  logoConfigured: boolean
  onOpenLogoSettings: () => void
  onBusyChange?: (busy: boolean) => void
}

const QUICK_READABILITY_KEY = 'printer.quick_readability_default'
const QUICK_ONBOARDING_KEY = 'printer.onboarding_completed'
const steps = ['detect', 'verify', 'style', 'save'] as const

const STAGE_BY_SAMPLE_KIND: Record<DraftSampleKind, VerificationSample> = {
  transport_text: 'transport',
  encoding: 'encoding',
  branding: 'branding',
}

const createWizardSessionId = (): string => {
  const generated = globalThis.crypto?.randomUUID?.()
  if (generated) return `printer-wizard-${generated}`
  return `printer-wizard-${Date.now().toString(36)}`
}

const readabilityPreset: Record<ReadabilitySize, { fontType: FontType; layoutDensity: LayoutDensity; headerEmphasis: HeaderEmphasis }> = {
  small: { fontType: 'b', layoutDensity: 'compact', headerEmphasis: 'normal' },
  normal: { fontType: 'a', layoutDensity: 'compact', headerEmphasis: 'strong' },
  large: { fontType: 'a', layoutDensity: 'balanced', headerEmphasis: 'strong' },
}

const normalizePrinterType = (value: unknown): PrinterType => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'bluetooth' || raw === 'usb' || raw === 'wifi' || raw === 'network' || raw === 'system') {
    return raw
  }
  if (raw === 'lan') return 'network'
  return 'system'
}

const normalizePaperSize = (value: unknown): PaperSize => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw.includes('58')) return '58mm'
  if (raw.includes('112')) return '112mm'
  return '80mm'
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
  resolvedTransport: undefined,
  resolvedAddress: '',
  emulation: 'auto',
  renderMode: 'text',
  baudRate: null,
  supportsCut: false,
  supportsLogo: false,
  lastVerifiedAt: null,
})

const fallbackRecommendationFor = (candidate: Omit<PrinterCandidate, 'recommended' | 'confidence' | 'reasons' | 'detectedBrand' | 'probeHints'>): RecommendedPrinterConfig => ({
  printerType: candidate.type,
  paperSize: '80mm',
  characterSet: 'PC437_USA',
  escposCodePage: null,
  receiptTemplate: 'classic',
  fontType: 'a',
  layoutDensity: 'compact',
  headerEmphasis: 'strong',
  connectionDetails: {
    type: candidate.type,
    render_mode: 'text',
    emulation: 'auto',
    capabilities: defaultCapabilities(),
  },
})

const guessReadabilityFromRecommended = (recommended: RecommendedPrinterConfig): ReadabilitySize => {
  if (recommended.fontType === 'b' && recommended.layoutDensity === 'compact' && recommended.headerEmphasis === 'normal') {
    return 'small'
  }
  if (recommended.fontType === 'a' && recommended.layoutDensity === 'balanced') {
    return 'large'
  }
  return 'normal'
}

const normalizeDiscoveredCandidate = (raw: unknown): Omit<PrinterCandidate, 'recommended' | 'confidence' | 'reasons' | 'detectedBrand' | 'probeHints'> | null => {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const type = normalizePrinterType(entry.type)
  const name =
    (typeof entry.name === 'string' && entry.name.trim()) ||
    (typeof entry.printerName === 'string' && entry.printerName.trim()) ||
    ''
  const address =
    (typeof entry.address === 'string' && entry.address.trim()) ||
    (typeof entry.ip === 'string' && entry.ip.trim()) ||
    name
  if (!name && !address) return null
  const port = Number(entry.port)
  const source = typeof entry.source === 'string' ? entry.source : type === 'system' ? 'windows' : type
  return {
    id: `${type}:${address.toLowerCase()}:${name.toLowerCase()}`,
    name: name || address,
    type,
    address,
    port: Number.isFinite(port) && port > 0 ? port : undefined,
    source,
    isConfigured: Boolean(entry.isConfigured),
  }
}

const positiveIntegerOr = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const connectionIdentityFromDetails = (
  details: {
    type: string
    ip?: unknown
    hostname?: unknown
    port?: unknown
    address?: unknown
    channel?: unknown
    deviceName?: unknown
    vendorId?: unknown
    productId?: unknown
    path?: unknown
    systemName?: unknown
    serialPort?: unknown
  },
  fallbackType?: PrinterType,
  fallbackName = '',
): string | null => {
  const rawType = typeof details.type === 'string' ? details.type.trim().toLowerCase() : ''
  const type = normalizePrinterType(rawType || fallbackType)
  const lower = (value: unknown): string => typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''

  if (type === 'network' || type === 'wifi') {
    const host = lower(details.ip) || lower(details.hostname) || lower(details.address)
    return host ? `network:${host}:${positiveIntegerOr(details.port, 9100)}` : null
  }
  if (type === 'bluetooth') {
    const address = lower(details.address) || lower(details.deviceName)
    return address ? `bluetooth:${address}:${positiveIntegerOr(details.channel, 1)}` : null
  }
  if (type === 'usb') {
    const path = lower(details.path) || lower(details.systemName) || lower(details.address)
    if (path) return `usb:${path}`
    const vendorId = positiveIntegerOr(details.vendorId, 0)
    const productId = positiveIntegerOr(details.productId, 0)
    return vendorId && productId ? `usb:${vendorId}:${productId}` : null
  }
  if (rawType === 'serial') {
    const serialPort = lower(details.serialPort) || lower(details.path) || lower(details.address)
    return serialPort ? `serial:${serialPort}` : null
  }
  const systemName = lower(details.systemName) || lower(details.path) || lower(details.address) || lower(fallbackName)
  return systemName ? `system:${systemName}` : null
}

const connectionIdentityFromProfile = (profile: ExistingPrinterProfile): string | null => {
  const details: ConnectionDetails = profile.connectionDetails || { type: profile.type }
  return connectionIdentityFromDetails(details, profile.type, profile.name)
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
  if (status === 'degraded' || status === 'candidate') return liquidGlassModalTone('warning')
  return liquidGlassModalTone('neutral')
}

const mergeCapabilities = (...values: Array<PrinterCapabilities | undefined | null>): PrinterCapabilities => {
  const merged = values.reduce<PrinterCapabilities>((acc, value) => {
    if (!value) return acc
    return {
      ...acc,
      ...value,
      supportsCut: typeof value.supportsCut === 'boolean' ? value.supportsCut : acc.supportsCut,
      supportsLogo: typeof value.supportsLogo === 'boolean' ? value.supportsLogo : acc.supportsLogo,
      baudRate: value.baudRate ?? acc.baudRate,
      lastVerifiedAt: value.lastVerifiedAt ?? acc.lastVerifiedAt,
    }
  }, defaultCapabilities())
  merged.status = normalizeVerificationStatus(merged.status)
  return merged
}

const sampleKinds: Array<{
  kind: DraftSampleKind
  titleKey: string
  defaultTitle: string
  bodyKey: string
  defaultBody: string
  optional?: boolean
}> = [
  {
    kind: 'transport_text',
    titleKey: 'settings.printer.quickWizardVerifyTransportTitle',
    defaultTitle: '1. Transport + cut sample',
    bodyKey: 'settings.printer.quickWizardVerifyTransportHint',
    defaultBody: 'Checks whether this printer can be reached through a working queue, raw TCP, or serial connection.',
  },
  {
    kind: 'encoding',
    titleKey: 'settings.printer.quickWizardVerifyEncodingTitle',
    defaultTitle: '2. Language / encoding sample',
    bodyKey: 'settings.printer.quickWizardVerifyEncodingHint',
    defaultBody: 'Confirms that the active language and character set print correctly on this device.',
  },
  {
    kind: 'branding',
    titleKey: 'settings.printer.quickWizardVerifyBrandingTitle',
    defaultTitle: '3. Optional logo / raster sample',
    bodyKey: 'settings.printer.quickWizardVerifyBrandingHint',
    defaultBody: 'Optional upgrade for branded output after plain-text printing is already confirmed.',
    optional: true,
  },
]

const PrinterSetupWizard: React.FC<Props> = ({
  existingPrinters,
  onCancel,
  onSaved,
  onOpenExpert,
  logoSettingsLoaded,
  logoConfigured,
  onOpenLogoSettings,
  onBusyChange,
}) => {
  const { t } = useTranslation()
  const bridge = getBridge()
  const [currentStep, setCurrentStep] = useState<(typeof steps)[number]>('detect')
  const [discovering, setDiscovering] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submittingKind, setSubmittingKind] = useState<DraftSampleKind | null>(null)
  const [sampleErrorCode, setSampleErrorCode] = useState<string | null>(null)
  const [sampleActionBusy, setSampleActionBusy] = useState(false)
  const [queueObservationEpoch, setQueueObservationEpoch] = useState(0)
  const [candidates, setCandidates] = useState<PrinterCandidate[]>([])
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>('')
  const [paperSize, setPaperSize] = useState<PaperSize>('80mm')
  const [template, setTemplate] = useState<ReceiptTemplate>('classic')
  const [readability, setReadability] = useState<ReadabilitySize>(() => {
    const stored = localStorage.getItem(QUICK_READABILITY_KEY)
    return stored === 'small' || stored === 'large' ? stored : 'normal'
  })
  const [setDefaultReceipt, setSetDefaultReceipt] = useState(() => existingPrinters.filter(p => p.role === 'receipt' && p.isDefault).length === 0)
  const [assignKitchen, setAssignKitchen] = useState(false)
  const [assignBar, setAssignBar] = useState(false)
  const [assignLabel, setAssignLabel] = useState(false)
  const [verification, dispatchVerification] = useReducer(
    verificationReducer,
    undefined,
    createVerificationState,
  )
  const wizardSessionIdRef = useRef(createWizardSessionId())
  const requestGenerationRef = useRef(0)
  const requestTokenRef = useRef<symbol | null>(null)
  const saveTokenRef = useRef<symbol | null>(null)
  const mountedRef = useRef(true)
  const readabilityButtonRefs = useRef<Record<ReadabilitySize, HTMLButtonElement | null>>({
    small: null,
    normal: null,
    large: null,
  })
  const trackedJobId = useMemo(() => {
    if (verification.activeJobId) return verification.activeJobId
    for (const sample of ['branding', 'encoding', 'transport'] as const) {
      const state = verification[sample]
      if (state.jobId && (state.phase === 'failed' || state.phase === 'cancelled')) {
        return state.jobId
      }
    }
    return null
  }, [verification])
  const trackedQueue = usePrintQueue({ jobIds: trackedJobId ? [trackedJobId] : [] })
  const effectiveLogoConfigured = logoConfigured
    || verification.transport.logoConfigured
    || verification.encoding.logoConfigured
    || verification.branding.logoConfigured

  const selectedCandidate = useMemo(
    () => candidates.find(candidate => candidate.id === selectedCandidateId) || null,
    [candidates, selectedCandidateId],
  )
  const sampleInteractionLocked = Boolean(
    saving || submittingKind || verification.activeJobId || sampleActionBusy,
  )
  const candidateSelectionLocked = discovering || sampleInteractionLocked

  const parseDiscoverResult = (result: unknown): unknown[] => {
    if (Array.isArray(result)) return result
    if (result && typeof result === 'object') {
      const payload = result as Record<string, unknown>
      if (Array.isArray(payload.printers)) return payload.printers
      if (Array.isArray(payload.data)) return payload.data
    }
    return []
  }

  const resetVerification = useCallback(() => {
    requestGenerationRef.current += 1
    requestTokenRef.current = null
    dispatchVerification({ type: 'reset' })
    setSubmittingKind(null)
    setSampleErrorCode(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
      requestTokenRef.current = null
      saveTokenRef.current = null
    }
  }, [])

  useEffect(() => () => onBusyChange?.(false), [onBusyChange])

  const discoverCandidates = useCallback(async () => {
    setDiscovering(true)
    try {
      const [systemLikeResult, bluetoothResult] = await Promise.all([
        bridge.printer.scanNetwork().catch(() => bridge.printer.discover(['system', 'network', 'wifi', 'usb']).catch(() => [])),
        bridge.printer.scanBluetooth().catch(() => bridge.printer.discover(['bluetooth']).catch(() => [])),
      ])
      const merged = [...parseDiscoverResult(systemLikeResult), ...parseDiscoverResult(bluetoothResult)]
      const deduped = new Map<string, Omit<PrinterCandidate, 'recommended' | 'confidence' | 'reasons' | 'detectedBrand' | 'probeHints'>>()
      merged.forEach((entry) => {
        const normalized = normalizeDiscoveredCandidate(entry)
        if (!normalized) return
        if (!deduped.has(normalized.id)) deduped.set(normalized.id, normalized)
      })
      const baseCandidates = Array.from(deduped.values())
      const enrichedCandidates = await Promise.all(
        baseCandidates.map(async (candidate): Promise<PrinterCandidate> => {
          try {
            const recommendationResult: any = await bridge.printer.recommendProfile({
              name: candidate.name,
              type: candidate.type,
              address: candidate.address,
            })
            const recommended = recommendationResult?.recommended
            const connectionDetails = (recommended?.connectionDetails || {}) as ConnectionDetails
            const normalizedRecommended: RecommendedPrinterConfig = {
              printerType: normalizePrinterType(recommended?.printerType ?? candidate.type),
              paperSize: normalizePaperSize(recommended?.paperSize),
              characterSet:
                typeof recommended?.characterSet === 'string' && recommended.characterSet.trim()
                  ? recommended.characterSet
                  : 'PC437_USA',
              escposCodePage:
                typeof recommended?.escposCodePage === 'number'
                  ? recommended.escposCodePage
                  : null,
              receiptTemplate: 'classic',
              fontType: recommended?.fontType === 'b' ? 'b' : 'a',
              layoutDensity:
                recommended?.layoutDensity === 'balanced' || recommended?.layoutDensity === 'spacious'
                  ? recommended.layoutDensity
                  : 'compact',
              headerEmphasis: recommended?.headerEmphasis === 'normal' ? 'normal' : 'strong',
              connectionDetails: {
                ...connectionDetails,
                type: normalizePrinterType(connectionDetails.type || candidate.type),
                render_mode: 'text',
                emulation: 'auto',
                capabilities: defaultCapabilities(),
              },
            }
            return {
              ...candidate,
              detectedBrand:
                typeof recommendationResult?.detectedBrand === 'string'
                  ? recommendationResult.detectedBrand
                  : 'Unknown',
              confidence:
                typeof recommendationResult?.confidence === 'number'
                  ? recommendationResult.confidence
                  : 30,
              reasons: Array.isArray(recommendationResult?.reasons)
                ? recommendationResult.reasons.filter((reason: unknown): reason is string => typeof reason === 'string')
                : [],
              recommended: normalizedRecommended,
              probeHints: recommendationResult?.probeHints,
            }
          } catch {
            return {
              ...candidate,
              detectedBrand: 'Unknown',
              confidence: 25,
              reasons: [t('settings.printer.quickWizardFallbackReason', 'Using safe defaults for this printer.')],
              recommended: fallbackRecommendationFor(candidate),
            }
          }
        }),
      )
      enrichedCandidates.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
      setCandidates(enrichedCandidates)
      const selected = enrichedCandidates[0] || null
      if (selected) {
        setSelectedCandidateId(selected.id)
        setPaperSize(selected.recommended.paperSize)
        setTemplate('classic')
        setReadability(guessReadabilityFromRecommended(selected.recommended))
      }
      if (!selected) {
        toast(t('settings.printer.noDevicesFound', 'No printers found'), { icon: <Info className="w-4 h-4 text-amber-400" /> })
      }
    } catch (error) {
      console.error('[PrinterSetupWizard] discovery failed', error)
      toast.error(t('settings.printer.discoveryFailed', 'Printer discovery failed'))
    } finally {
      setDiscovering(false)
    }
  }, [bridge.printer, t])

  useEffect(() => {
    void discoverCandidates()
  }, [discoverCandidates])

  useEffect(() => {
    resetVerification()
    // Only reset when the physical printer changes — cosmetic settings
    // (template, readability, paperSize) don't invalidate transport verification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCandidateId, resetVerification])

  const trackedJob = trackedJobId
    ? trackedQueue.jobs.find((job) => job.id === trackedJobId) ?? null
    : null
  const trackedQueueObservationMissing = Boolean(
    trackedJobId && !trackedQueue.loading && !trackedJob,
  )
  const trackedQueueObservationStale = Boolean(
    trackedJobId
      && !trackedQueueObservationMissing
      && (trackedQueue.stale || trackedQueue.error),
  )

  useEffect(() => {
    if (!trackedJob) return
    dispatchVerification({
      type: 'job_observed',
      jobId: trackedJob.id,
      status: trackedJob.status,
      transportState: trackedJob.transportState,
    })
  }, [
    queueObservationEpoch,
    trackedJob?.id,
    trackedJob?.lastSeenAt,
    trackedJob?.status,
    trackedJob?.transportState,
    trackedJob?.updatedAt,
  ])

  const buildConnectionDetails = useCallback((candidate: PrinterCandidate): ConnectionDetails => {
    const base = candidate.recommended.connectionDetails || { type: candidate.type }
    const details: ConnectionDetails = {
      ...base,
      type: normalizePrinterType(base.type || candidate.type),
      render_mode: 'text',
      emulation: 'auto',
      capabilities: defaultCapabilities(),
    }

    switch (candidate.type) {
      case 'network':
      case 'wifi':
        details.ip = candidate.address
        details.port = candidate.port || details.port || 9100
        break
      case 'bluetooth':
        details.address = candidate.address
        details.channel = details.channel || 1
        break
      case 'usb':
        details.path = candidate.address
        break
      case 'system':
      default:
        details.systemName = candidate.name || candidate.address
        break
    }

    return details
  }, [])

  const derivedCapabilities = useMemo(() => {
    const transport = verification.transport
    if (transport.phase !== 'confirmed' || !transport.candidateCapabilities) {
      return defaultCapabilities()
    }

    let capabilities = mergeCapabilities(
      transport.candidateCapabilities,
      {
        status: 'verified',
      },
    )

    if (verification.encoding.phase === 'confirmed') {
      capabilities = mergeCapabilities(capabilities, verification.encoding.candidateCapabilities, {
        status: 'verified',
      })
    }

    if (verification.branding.phase === 'confirmed' && verification.branding.logoIncluded) {
      capabilities = mergeCapabilities(capabilities, verification.branding.candidateCapabilities, {
        status: 'verified',
        supportsLogo: true,
      })
    }

    return capabilities
  }, [verification])

  const buildProfilePayload = useCallback((candidate: PrinterCandidate, role: PrinterRole, setAsDefault: boolean) => {
    const readabilityConfig = readabilityPreset[readability]
    const connectionDetails = buildConnectionDetails(candidate)
    const capabilities = verification.transport.phase === 'confirmed'
      ? mergeCapabilities(derivedCapabilities, {
          status: 'verified',
          supportsLogo:
            verification.branding.phase === 'confirmed' && verification.branding.logoIncluded
              ? true
              : false,
        })
      : defaultCapabilities()

    return {
      name: role === 'receipt' ? candidate.name : `${candidate.name} (${role})`,
      type: candidate.type,
      connectionDetails: {
        ...connectionDetails,
        capabilities,
      },
      confirmedCandidateConnectionDetails: verification.confirmedConnectionDetails,
      paperSize,
      characterSet:
        candidate.recommended.characterSet,
      greekRenderMode: 'text',
      escposCodePage:
        verification.encoding.phase === 'confirmed'
          && typeof verification.encoding.candidateCapabilities?.escposCodePage === 'number'
          ? verification.encoding.candidateCapabilities.escposCodePage
          : candidate.recommended.escposCodePage ?? null,
      receiptTemplate: template,
      fontType: readabilityConfig.fontType,
      layoutDensity: readabilityConfig.layoutDensity,
      headerEmphasis: readabilityConfig.headerEmphasis,
      role,
      isDefault: setAsDefault,
      enabled: true,
    }
  }, [buildConnectionDetails, derivedCapabilities, paperSize, readability, template, verification])

  const buildDraftPayload = useCallback((candidate: PrinterCandidate) => {
    return buildProfilePayload(candidate, 'receipt', false)
  }, [buildProfilePayload])

  const findExistingProfile = useCallback((role: PrinterRole): ExistingPrinterProfile | null => {
    if (!verification.confirmedConnectionDetails) return null
    const targetIdentity = connectionIdentityFromDetails(verification.confirmedConnectionDetails)
    if (!targetIdentity) return null
    return existingPrinters.find(profile => {
      if (profile.role !== role) return false
      return connectionIdentityFromProfile(profile) === targetIdentity
    }) || null
  }, [existingPrinters, verification.confirmedConnectionDetails])

  const handleRunVerification = useCallback(async (sampleKind: DraftSampleKind) => {
    if (
      saving
      || discovering
      || sampleActionBusy
      || !selectedCandidate
      || requestTokenRef.current
      || saveTokenRef.current
    ) return
    const sample = STAGE_BY_SAMPLE_KIND[sampleKind]
    if (!canStartWizardSample(
      verification,
      sample,
      logoSettingsLoaded && effectiveLogoConfigured,
    )) return
    const token = Symbol(sampleKind)
    const generation = requestGenerationRef.current
    const candidateId = selectedCandidate.id
    requestTokenRef.current = token
    setSubmittingKind(sampleKind)
    setSampleErrorCode(null)
    try {
      const draftPayload = buildDraftPayload(selectedCandidate)
      const result = await bridge.printer.testDraft({
        profileDraft: draftPayload,
        sampleKind,
        probeAttempt: verification[sample].attemptCount,
        wizardSessionId: wizardSessionIdRef.current,
        ...(verification.confirmedConnectionDetails
          ? { confirmedCandidateConnectionDetails: verification.confirmedConnectionDetails }
          : {}),
      })
      if (
        !mountedRef.current
        || requestGenerationRef.current !== generation
        || selectedCandidateId !== candidateId
      ) return
      const parsed = parseWizardEnqueueResponse(sample, result)
      if (!parsed.ok) {
        setSampleErrorCode(parsed.errorCode)
        return
      }
      dispatchVerification({
        type: 'sample_queued',
        sample,
        jobId: parsed.value.jobId,
        duplicate: parsed.value.duplicate,
        candidateConnectionDetails: parsed.value.candidateConnectionDetails,
        candidateCapabilities: parsed.value.candidateCapabilities,
        logoConfigured: parsed.value.logoConfigured,
        logoIncluded: parsed.value.logoIncluded,
      })
    } catch {
      if (mountedRef.current && requestGenerationRef.current === generation) {
        setSampleErrorCode('enqueue_rejected')
      }
    } finally {
      if (requestTokenRef.current === token) {
        requestTokenRef.current = null
        if (mountedRef.current) setSubmittingKind(null)
      }
    }
  }, [
    bridge.printer,
    buildDraftPayload,
    discovering,
    effectiveLogoConfigured,
    saving,
    logoSettingsLoaded,
    sampleActionBusy,
    selectedCandidate,
    selectedCandidateId,
    verification,
  ])

  const handleConfirmStage = useCallback((sampleKind: DraftSampleKind, worked: boolean) => {
    if (saveTokenRef.current) return
    dispatchVerification({
      type: 'paper_confirmed',
      sample: STAGE_BY_SAMPLE_KIND[sampleKind],
      worked,
    })
  }, [])

  const handleTrackedCancel = useCallback(async (sampleKind: DraftSampleKind) => {
    const sample = STAGE_BY_SAMPLE_KIND[sampleKind]
    const jobId = verification[sample].jobId
    if (
      !jobId
      || requestTokenRef.current
      || saveTokenRef.current
      || sampleActionBusy
      || !trackedJob?.cancellable
    ) return
    const token = Symbol('cancel-sample')
    requestTokenRef.current = token
    setSampleActionBusy(true)
    setSampleErrorCode(null)
    try {
      const result = await trackedQueue.cancelJob(jobId)
      if (mountedRef.current && (!result.success || result.affected < 1)) {
        setSampleErrorCode('cancel_failed')
      }
    } catch {
      if (mountedRef.current) setSampleErrorCode('cancel_failed')
    } finally {
      if (requestTokenRef.current === token) {
        requestTokenRef.current = null
        if (mountedRef.current) setSampleActionBusy(false)
      }
    }
  }, [sampleActionBusy, trackedJob?.cancellable, trackedQueue, verification])

  const handleTrackedRetry = useCallback(async (sampleKind: DraftSampleKind) => {
    const sample = STAGE_BY_SAMPLE_KIND[sampleKind]
    const jobId = verification[sample].jobId
    if (
      !jobId
      || requestTokenRef.current
      || saveTokenRef.current
      || sampleActionBusy
      || !trackedJob?.retryable
    ) return
    const token = Symbol('retry-sample')
    requestTokenRef.current = token
    setSampleActionBusy(true)
    setSampleErrorCode(null)
    try {
      const result = await trackedQueue.retryJob(jobId)
      if (mountedRef.current && (!result.success || result.affected < 1)) {
        setSampleErrorCode('retry_failed')
      } else if (mountedRef.current) {
        dispatchVerification({
          type: 'job_observed',
          jobId,
          status: 'pending',
          transportState: 'created',
        })
        setQueueObservationEpoch(epoch => epoch + 1)
      }
    } catch {
      if (mountedRef.current) setSampleErrorCode('retry_failed')
    } finally {
      if (requestTokenRef.current === token) {
        requestTokenRef.current = null
        if (mountedRef.current) setSampleActionBusy(false)
      }
    }
  }, [sampleActionBusy, trackedJob?.retryable, trackedQueue, verification])

  const handleSave = useCallback(async () => {
    const verifiedForSave = logoSettingsLoaded
      && !discovering
      && !submittingKind
      && !sampleActionBusy
      && canSaveVerifiedPrinter(verification, effectiveLogoConfigured)
    if (!selectedCandidate || !verifiedForSave || requestTokenRef.current || saveTokenRef.current) return
    const saveToken = Symbol('save')
    saveTokenRef.current = saveToken
    onBusyChange?.(true)
    setSaving(true)
    let receiptSaved = false
    try {
      const receiptPayload = buildProfilePayload(selectedCandidate, 'receipt', setDefaultReceipt)
      const existingReceipt = findExistingProfile('receipt')
      let receiptResult: any
      if (existingReceipt) {
        receiptResult = await bridge.printer.update(existingReceipt.id, receiptPayload)
      } else {
        receiptResult = await bridge.printer.add(receiptPayload)
      }
      if (receiptResult?.success !== true) {
        toast.error(t(
          'settings.printer.quickWizardSaveFailedSafe',
          'The printer could not be saved. Refresh the printer list and try again.',
        ))
        return
      }
      receiptSaved = true

      const optionalRoles: PrinterRole[] = []
      if (assignKitchen) optionalRoles.push('kitchen')
      if (assignBar) optionalRoles.push('bar')
      if (assignLabel) optionalRoles.push('label')

      for (const role of optionalRoles) {
        const payload = buildProfilePayload(selectedCandidate, role, false)
        const existing = findExistingProfile(role)
        let roleResult: any
        if (existing) {
          roleResult = await bridge.printer.update(existing.id, payload)
        } else {
          roleResult = await bridge.printer.add(payload)
        }
        if (roleResult?.success !== true) {
          toast.error(t(
            'settings.printer.quickWizardPartialSaveFailedSafe',
            'Some printer assignments could not be saved. The printer list was refreshed so you can retry safely.',
          ))
          await onSaved()
          return
        }
      }

      localStorage.setItem(QUICK_ONBOARDING_KEY, 'true')
      localStorage.setItem(QUICK_READABILITY_KEY, readability)
      try {
        await bridge.settings.updateLocal({
          settingType: 'printer',
          settings: {
            onboarding_completed: true,
            quick_readability_default: readability,
          },
        })
      } catch (settingsError) {
        console.warn('[PrinterSetupWizard] failed to persist onboarding flags in settings store', settingsError)
      }

      toast.success(t('settings.printer.saved', 'Saved'))
      await onSaved()
    } catch (error) {
      console.error('[PrinterSetupWizard] save failed', error)
      if (receiptSaved) {
        toast.error(t(
          'settings.printer.quickWizardPartialSaveFailedSafe',
          'Some printer assignments could not be saved. The printer list was refreshed so you can retry safely.',
        ))
        await onSaved()
      } else {
        toast.error(t(
          'settings.printer.quickWizardSaveFailedSafe',
          'The printer could not be saved. Refresh the printer list and try again.',
        ))
      }
    } finally {
      if (saveTokenRef.current === saveToken) {
        saveTokenRef.current = null
        onBusyChange?.(false)
      }
      if (mountedRef.current) setSaving(false)
    }
  }, [
    assignBar,
    assignKitchen,
    assignLabel,
    bridge.printer,
    bridge.settings,
    buildProfilePayload,
    findExistingProfile,
    onSaved,
    onBusyChange,
    readability,
    selectedCandidate,
    setDefaultReceipt,
    t,
    logoSettingsLoaded,
    discovering,
    submittingKind,
    sampleActionBusy,
    effectiveLogoConfigured,
    verification,
  ])

  const saveAllowed = logoSettingsLoaded
    && !discovering
    && !submittingKind
    && !sampleActionBusy
    && !saving
    && !requestTokenRef.current
    && canSaveVerifiedPrinter(verification, effectiveLogoConfigured)
  const canContinue = Boolean(selectedCandidate)
    && (currentStep !== 'verify' || saveAllowed)
  const stepIndex = steps.indexOf(currentStep)
  const verificationStatus = saveAllowed ? 'verified' : 'unverified'
  const resolvedTransport = derivedCapabilities.resolvedTransport
  const resolvedAddress = derivedCapabilities.resolvedAddress
  const defaultReceiptAllowed = saveAllowed

  const handleReadabilityKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: ReadabilitySize,
  ) => {
    const sizes: ReadabilitySize[] = ['small', 'normal', 'large']
    const currentIndex = sizes.indexOf(current)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % sizes.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + sizes.length) % sizes.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = sizes.length - 1
    }
    if (nextIndex === null) return
    event.preventDefault()
    const next = sizes[nextIndex]
    setReadability(next)
    readabilityButtonRefs.current[next]?.focus()
  }

  const gotoNext = () => {
    if (saveTokenRef.current || stepIndex >= steps.length - 1) return
    setCurrentStep(steps[stepIndex + 1])
  }

  const gotoPrevious = () => {
    if (saveTokenRef.current || stepIndex <= 0) return
    setCurrentStep(steps[stepIndex - 1])
  }

  const renderDetectStep = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium liquid-glass-modal-text">
            {t('settings.printer.quickWizardDetectTitle', 'Step 1: Detect Printers')}
          </h3>
          <p className="text-xs liquid-glass-modal-text-muted">
            {t('settings.printer.quickWizardDetectHint', 'We detect nearby and installed printers first, but nothing is treated as printable until verification succeeds.')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (requestTokenRef.current || saveTokenRef.current || sampleInteractionLocked) return
            void discoverCandidates()
          }}
          className={liquidGlassModalButton('secondary', 'sm')}
          disabled={discovering || sampleInteractionLocked}
        >
          {discovering ? t('settings.printer.scanning', 'Scanning...') : t('settings.printer.refresh', 'Refresh')}
        </button>
      </div>

      <div className={`p-3 rounded-2xl border text-xs ${liquidGlassModalTone('warning')}`}>
        {t(
          'settings.printer.quickWizardDraftOnlyHint',
          'Compatibility-first setup: the wizard tests transport and encoding using an unsaved draft profile. No temporary printer profiles are created.',
        )}
      </div>

      {candidates.length === 0 ? (
        <div className={`p-4 rounded-2xl border text-sm ${liquidGlassModalTone('neutral')}`}>
          {discovering ? t('settings.printer.scanning', 'Scanning...') : t('settings.printer.noDevicesFound', 'No printers found')}
        </div>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {candidates.map(candidate => {
            const selected = candidate.id === selectedCandidateId
            return (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={selected}
                disabled={candidateSelectionLocked}
                onClick={() => {
                  if (candidateSelectionLocked || requestTokenRef.current || saveTokenRef.current) return
                  setSelectedCandidateId(candidate.id)
                  setPaperSize(candidate.recommended.paperSize)
                  setTemplate('classic')
                  setReadability(guessReadabilityFromRecommended(candidate.recommended))
                }}
                className={`min-h-[44px] w-full text-left p-3 rounded-lg border transition-all active:scale-[0.99] ${
                  selected
                    ? 'bg-amber-50 border-amber-400 text-amber-950 dark:bg-amber-500/15 dark:border-amber-400/50 dark:text-amber-100'
                    : 'bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900/60 dark:border-white/10 dark:text-slate-100'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium liquid-glass-modal-text">{candidate.name}</div>
                    <div className="text-xs liquid-glass-modal-text-muted">
                      {candidate.type.toUpperCase()} • {candidate.address}
                      {candidate.port ? `:${candidate.port}` : ''}
                    </div>
                    <div className="mt-1 text-[11px] liquid-glass-modal-text-muted">
                      {t('settings.printer.quickWizardCandidateState', 'Discovered only. Verify before using.')}{' '}
                      {candidate.isConfigured
                        ? t('settings.printer.quickWizardAlreadyConfigured', 'Existing profile found.')
                        : t('settings.printer.quickWizardNotConfiguredYet', 'No saved profile yet.')}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-xs px-2 py-0.5 rounded ${
                      candidate.confidence >= 80
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-100'
                        : 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100'
                    }`}>
                      {candidate.confidence >= 80
                        ? t('settings.printer.quickWizardHighConfidence', 'High confidence')
                        : t('settings.printer.quickWizardNeedsReview', 'Needs review')}
                    </div>
                    <div className="text-[11px] liquid-glass-modal-text-muted mt-1">
                      {candidate.detectedBrand === 'Unknown'
                        ? t('settings.printer.unknown', 'Unknown')
                        : candidate.detectedBrand}
                    </div>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )

  const renderVerificationCard = (
    stage: {
      kind: DraftSampleKind
      titleKey: string
      defaultTitle: string
      bodyKey: string
      defaultBody: string
      optional?: boolean
    },
    disabled: boolean,
  ) => {
    const sample = STAGE_BY_SAMPLE_KIND[stage.kind]
    const state = verification[sample]
    const isTrackedRow = Boolean(state.jobId && trackedJob?.id === state.jobId)
    const canStart = canStartWizardSample(
      verification,
      sample,
      logoSettingsLoaded && effectiveLogoConfigured,
    )
    const awaitingConfirmation = state.phase === 'awaiting_confirmation'
    const sampleLabel = sample === 'transport'
      ? t('settings.printer.quickWizardSampleLabel.transport', 'transport')
      : sample === 'encoding'
        ? t('settings.printer.quickWizardSampleLabel.encoding', 'encoding')
        : t('settings.printer.quickWizardSampleLabel.branding', 'branding')
    const sendLabel = sample === 'transport'
      ? t('settings.printer.quickWizardSendTransportSample', 'Send transport sample')
      : sample === 'encoding'
        ? t('settings.printer.quickWizardSendEncodingSample', 'Send encoding sample')
        : t('settings.printer.quickWizardSendBrandingSample', 'Send branding sample')

    return (
      <div key={stage.kind} className={`rounded-2xl border p-3 space-y-3 ${liquidGlassModalTone('neutral')}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-medium liquid-glass-modal-text">
              {t(stage.titleKey, stage.defaultTitle)}
              {stage.optional && (
                <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700 dark:bg-white/10 dark:text-slate-200">
                  {t('settings.printer.optional', 'Optional')}
                </span>
              )}
            </div>
            <p className="text-xs liquid-glass-modal-text-muted mt-1">
              {t(stage.bodyKey, stage.defaultBody)}
            </p>
          </div>
          <button
            type="button"
            aria-label={sendLabel}
            disabled={disabled || !canStart || saving || discovering || Boolean(submittingKind) || sampleActionBusy}
            onClick={() => void handleRunVerification(stage.kind)}
            className={`${liquidGlassModalButton('secondary', 'sm')} min-h-[44px] min-w-[44px]`}
          >
            {submittingKind === stage.kind
              ? t('settings.printer.testing', 'Testing...')
              : t('settings.printer.quickWizardSendSample', 'Send sample')}
          </button>
        </div>

        {disabled && (
          <div className="text-xs liquid-glass-modal-text-muted">
            {t('settings.printer.quickWizardVerifyLockedHint', 'Confirm the basic transport sample first.')}
          </div>
        )}

        {(state.phase === 'queued' || state.phase === 'printing' || state.phase === 'cancelled') && (
          <div
            role="status"
            aria-live="polite"
            className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone(
              state.phase === 'cancelled' ? 'warning' : 'neutral',
            )}`}
          >
            {state.phase === 'queued'
              ? t('settings.printer.quickWizardQueueQueued', 'Sample queued')
              : state.phase === 'printing'
                ? t('settings.printer.quickWizardQueuePrinting', 'Printing in progress')
                : t('settings.printer.quickWizardQueueCancelled', 'Sample cancelled')}
          </div>
        )}

        {state.phase === 'failed' && (
          <div role="alert" className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('danger')}`}>
            {t('settings.printer.quickWizardQueueFailed', 'The tracked sample failed. Check the printer and try again.')}
          </div>
        )}

        {isTrackedRow && (trackedJob?.cancellable || trackedJob?.retryable) && (
          <div className="flex flex-wrap gap-2">
            {trackedJob.cancellable && (
              <button
                type="button"
                aria-label={t(
                  'settings.printer.quickWizardCancelSampleAria',
                  `Cancel ${sampleLabel} sample`,
                  { sample: sampleLabel },
                )}
                disabled={sampleActionBusy}
                onClick={() => void handleTrackedCancel(stage.kind)}
                className={`${liquidGlassModalButton('secondary', 'sm')} min-h-[44px] min-w-[44px]`}
              >
                {t('settings.printer.quickWizardCancelSample', 'Cancel sample')}
              </button>
            )}
            {trackedJob.retryable && (
              <button
                type="button"
                aria-label={t(
                  'settings.printer.quickWizardRetrySampleAria',
                  `Retry ${sampleLabel} sample`,
                  { sample: sampleLabel },
                )}
                disabled={sampleActionBusy}
                onClick={() => void handleTrackedRetry(stage.kind)}
                className={`${liquidGlassModalButton('secondary', 'sm')} min-h-[44px] min-w-[44px]`}
              >
                {t('settings.printer.quickWizardRetrySample', 'Retry sample')}
              </button>
            )}
          </div>
        )}

        {awaitingConfirmation && (
          <fieldset className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('warning')}`}>
            <legend className="px-1 font-medium">
              {t('settings.printer.quickWizardConfirmPaperResult', 'Did the paper output print correctly?')}
            </legend>
            <div role="status" aria-live="polite" className="mb-2">
              {t('settings.printer.quickWizardAwaitingPaper', 'Paper output is ready for confirmation.')}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleConfirmStage(stage.kind, true)}
                className={`${liquidGlassModalButton('primary', 'sm')} min-h-[44px] min-w-[44px]`}
              >
                {t('common.actions.yes', 'Yes')}
              </button>
              <button
                type="button"
                onClick={() => handleConfirmStage(stage.kind, false)}
                className={`${liquidGlassModalButton('secondary', 'sm')} min-h-[44px] min-w-[44px]`}
              >
                {t('common.actions.no', 'No')}
              </button>
            </div>
          </fieldset>
        )}

        {state.phase === 'confirmed' && (
          <div role="status" className={`flex items-center gap-2 rounded-xl border p-2 text-xs ${liquidGlassModalTone('success')}`}>
            <CheckCircle2 className="w-4 h-4" />
            <span>{t('settings.printer.quickWizardStageVerified', 'Confirmed working')}</span>
          </div>
        )}

        {state.phase === 'rejected' && (
          <div role="alert" className={`flex items-center gap-2 rounded-xl border p-2 text-xs ${liquidGlassModalTone('warning')}`}>
            <AlertTriangle className="w-4 h-4" />
            <span>{sample === 'branding' && !state.logoIncluded
              ? t('settings.printer.quickWizardLogoNotIncluded', 'The sample did not include logo raster data, so logo support was not confirmed.')
              : t('settings.printer.quickWizardStageRejected', 'This stage is not trusted yet. Adjust settings and retry.')}</span>
          </div>
        )}

        {stage.kind === 'branding' && logoSettingsLoaded && !effectiveLogoConfigured && (
          <div className={`rounded-xl border p-3 text-xs ${liquidGlassModalTone('warning')}`}>
            <div className="font-medium">
              {t('settings.printer.quickWizardLogoUnavailableTitle', 'Logo sample unavailable')}
            </div>
            <p className="mt-1">
              {t('settings.printer.quickWizardLogoUnavailableBody', 'Enable and save a receipt logo before testing Branding.')}
            </p>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                if (!saveTokenRef.current) onOpenLogoSettings()
              }}
              className={`${liquidGlassModalButton('secondary', 'sm')} mt-2 min-h-[44px] min-w-[44px]`}
            >
              {t('settings.printer.quickWizardOpenLogoSettings', 'Open logo settings')}
            </button>
          </div>
        )}
      </div>
    )
  }

  const renderLogoSettingsRecovery = () => !logoSettingsLoaded && (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('warning')}`}
    >
      <div>
        {t(
          'settings.printer.quickWizardLogoSettingsUnavailable',
          'Logo settings are unavailable. Open logo settings to reload them before saving.',
        )}
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          if (!saveTokenRef.current) onOpenLogoSettings()
        }}
        className={`${liquidGlassModalButton('secondary', 'sm')} mt-2 min-h-[44px] min-w-[44px]`}
      >
        {t('settings.printer.quickWizardOpenLogoSettings', 'Open logo settings')}
      </button>
    </div>
  )

  const renderVerifyStep = () => (
    <div className="space-y-4">
      <h3 className="font-medium liquid-glass-modal-text">
        {t('settings.printer.quickWizardVerifyTitle', 'Step 2: Verify Compatibility')}
      </h3>
      {selectedCandidate ? (
        <div className="space-y-3">
          <div className={`p-3 rounded-2xl border ${liquidGlassModalTone('neutral')}`}>
            <div className="flex items-center gap-2 text-sm liquid-glass-modal-text">
              <Printer className="w-4 h-4" />
              <span className="font-medium">{selectedCandidate.name}</span>
            </div>
            <div className="text-xs liquid-glass-modal-text-muted mt-1">
              {selectedCandidate.type.toUpperCase()} • {selectedCandidate.address}
            </div>
            <div className="text-xs liquid-glass-modal-text-muted mt-2">
              {t('settings.printer.quickWizardVerifyDraftHint', 'Each stage uses a draft profile only. The printer is not saved until the last step.')}
            </div>
          </div>

          <div>
            <label htmlFor="quick-wizard-paper-size" className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.printer.paperSize', 'Paper Size')}
            </label>
            <select
              id="quick-wizard-paper-size"
              value={paperSize}
              onChange={e => setPaperSize(normalizePaperSize(e.target.value))}
              className="liquid-glass-modal-input"
            >
              <option value="58mm">58mm</option>
              <option value="80mm">80mm</option>
              <option value="112mm">112mm</option>
            </select>
          </div>

          {sampleErrorCode && (
            <div role="alert" className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('danger')}`}>
              {sampleErrorCode === 'sample_kind_mismatch'
                ? t(
                    'settings.printer.quickWizardSampleMismatch',
                    'The queued sample did not match this verification step.',
                  )
                : sampleErrorCode === 'cancel_failed'
                  ? t('settings.printer.quickWizardCancelFailed', 'The tracked sample could not be cancelled.')
                  : sampleErrorCode === 'retry_failed'
                    ? t('settings.printer.quickWizardRetryFailed', 'The tracked sample could not be retried.')
                    : sampleErrorCode === 'invalid_enqueue_response'
                      ? t('settings.printer.quickWizardInvalidResponse', 'The printer returned an invalid sample response. Try again.')
                      : t('settings.printer.quickWizardEnqueueFailed', 'The sample could not be queued. Check the printer and try again.')}
            </div>
          )}

          {trackedQueueObservationMissing && (
            <div
              role="alert"
              className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('danger')}`}
            >
              {t(
                'settings.printer.quickWizardTrackedJobUnavailable',
                'The tracked sample status is unavailable. Refresh the queue or retry the sample.',
              )}
            </div>
          )}

          {trackedQueueObservationStale && (
            <div
              role="status"
              aria-live="polite"
              className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('warning')}`}
            >
              {t(
                'settings.printer.quickWizardQueueStale',
                'Print status may be out of date. The last known sample state remains visible.',
              )}
            </div>
          )}

          {sampleKinds.map(stage => {
            const disabled = stage.kind === 'encoding'
              ? verification.transport.phase !== 'confirmed'
              : stage.kind === 'branding'
                ? verification.encoding.phase !== 'confirmed'
                  || !logoSettingsLoaded
                  || !effectiveLogoConfigured
                : false
            return renderVerificationCard(stage, disabled)
          })}

          {renderLogoSettingsRecovery()}

          {logoSettingsLoaded
            && effectiveLogoConfigured
            && verification.encoding.phase === 'confirmed'
            && verification.branding.phase !== 'confirmed' && (
              <label className={`flex min-h-[44px] items-center gap-2 rounded-2xl border p-3 text-sm ${liquidGlassModalTone('warning')}`}>
                <input
                  type="checkbox"
                  checked={verification.continueWithoutLogo}
                  onChange={(event) => dispatchVerification({
                    type: 'continue_without_logo',
                    value: event.target.checked,
                  })}
                  className="h-5 w-5 rounded"
                />
                {t('settings.printer.quickWizardContinueWithoutLogo', 'Continue without verified logo output')}
              </label>
            )}

          <div className={`rounded-2xl border p-3 ${verificationTone(verificationStatus)}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium">
                  {t('settings.printer.quickWizardVerificationSummary', 'Verification summary')}
                </div>
                <div className="text-sm mt-1">
                  {verificationLabel(verificationStatus, t)}
                </div>
              </div>
              <div className="text-right text-xs">
                <div>{transportLabel(resolvedTransport, t)}</div>
                {resolvedAddress ? <div className="mt-1">{resolvedAddress}</div> : null}
              </div>
            </div>
          </div>

          {selectedCandidate.reasons.length > 0 && (
            <div className={`p-3 rounded-2xl border ${liquidGlassModalTone('warning')}`}>
              <div className="mb-1 text-xs font-medium">
                {t('settings.printer.quickWizardWhyTitle', 'Why this recommendation')}
              </div>
              <ul className="space-y-1 text-xs">
                {selectedCandidate.reasons.slice(0, 3).map(reason => (
                  <li key={reason}>• {reason}</li>
                ))}
              </ul>
              {selectedCandidate.probeHints?.preferredEmulationOrder?.length ? (
                <div className="mt-2 text-[11px] opacity-80">
                  {t('settings.printer.quickWizardProbeOrder', 'Probe order')}:{' '}
                  {selectedCandidate.probeHints.preferredEmulationOrder.join(' → ')}
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm liquid-glass-modal-text-muted">
          {t('settings.printer.quickWizardSelectPrinterFirst', 'Select a printer first.')}
        </div>
      )}
    </div>
  )

  const renderStyleStep = () => (
    <div className="space-y-4">
      <h3 className="font-medium liquid-glass-modal-text">
        {t('settings.printer.quickWizardStyleTitle', 'Step 3: Defaults & Readability')}
      </h3>

      <div className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('neutral')}`}>
        {t(
          'settings.printer.quickWizardCompatibilityDefaults',
          'Safe defaults for new profiles: Classic template, text render mode, and automatic protocol selection. Optional logo / raster support is only trusted after confirmation.',
        )}
      </div>

      <div>
        <label htmlFor="quick-wizard-receipt-template" className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.printer.receiptTemplate', 'Receipt Template')}
        </label>
        <select
          id="quick-wizard-receipt-template"
          value={template}
          onChange={e => setTemplate((e.target.value === 'modern' ? 'modern' : 'classic'))}
          className="liquid-glass-modal-input"
        >
          <option value="classic">{t('settings.printer.receiptTemplateClassic', 'Classic')}</option>
          <option value="modern">{t('settings.printer.receiptTemplateModern', 'Modern')}</option>
        </select>
      </div>

      <div>
        <div id="quick-wizard-readability-label" className="block text-xs font-medium mb-2 liquid-glass-modal-text-muted">
          {t('settings.printer.quickWizardReadability.label', 'Readability')}
        </div>
        <div role="radiogroup" aria-labelledby="quick-wizard-readability-label" className="grid grid-cols-3 gap-2">
          {(['small', 'normal', 'large'] as ReadabilitySize[]).map(size => (
            <button
              key={size}
              ref={(element) => {
                readabilityButtonRefs.current[size] = element
              }}
              type="button"
              role="radio"
              aria-checked={readability === size}
              tabIndex={readability === size ? 0 : -1}
              onClick={() => setReadability(size)}
              onKeyDown={event => handleReadabilityKeyDown(event, size)}
              className={`min-h-[44px] min-w-[44px] rounded-lg border px-3 py-2 text-sm ${
                readability === size
                  ? liquidGlassModalTone('warning')
                  : liquidGlassModalTone('neutral')
              }`}
            >
              {t(`settings.printer.quickWizardReadability.${size}`, size.charAt(0).toUpperCase() + size.slice(1))}
            </button>
          ))}
        </div>
      </div>

      <div className={`rounded-2xl border p-3 ${liquidGlassModalTone('neutral')}`}>
        <div className="text-xs liquid-glass-modal-text-muted mb-2">
          {t('settings.printer.quickWizardLivePreview', 'Live style preview')}
        </div>
        <div
          className="bg-white text-black rounded px-3 py-2"
          style={{
            fontSize: readability === 'small' ? 12 : readability === 'large' ? 16 : 14,
            lineHeight: readability === 'small' ? '1.2' : readability === 'large' ? '1.45' : '1.3',
          }}
        >
          <div style={{ fontWeight: 700 }}>ΠΑΡΑΓΓΕΛΙΑ #0019</div>
          <div>1 x Βάφλα .......... 9,20</div>
          <div style={{ fontWeight: 700 }}>ΣΥΝΟΛΟ ........ 17,70 €</div>
        </div>
      </div>

      <p className="text-xs liquid-glass-modal-text-muted">
        {t(
          'settings.printer.quickWizardReadabilityHint',
          'Fine-tuning stays available in Expert Settings. Changing protocol, render mode, or connection details later will reset verification.',
        )}
      </p>
    </div>
  )

  const renderSaveStep = () => (
    <div className="space-y-4">
      <h3 className="font-medium liquid-glass-modal-text">
        {t('settings.printer.quickWizardSaveTitle', 'Step 4: Save & Assign')}
      </h3>

      {renderLogoSettingsRecovery()}

      <div className={`rounded-2xl border p-3 ${verificationTone(verificationStatus)}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-medium">
              {saveAllowed
                ? t('settings.printer.quickWizardReadyVerifiedTitle', 'Ready to save as verified')
                : t('settings.printer.quickWizardVerificationRequired', 'Verification is incomplete')}
            </div>
            <div className="text-xs mt-1">
              {saveAllowed
                ? t('settings.printer.quickWizardReadyVerifiedBody', 'Transport and encoding are confirmed for this printer.')
                : t('settings.printer.quickWizardEncodingRequired', 'Confirm both Transport and Encoding before saving this printer.')}
            </div>
          </div>
          <div className="text-right text-xs">
            <div>{verificationLabel(verificationStatus, t)}</div>
            <div className="mt-1">{transportLabel(resolvedTransport, t)}</div>
          </div>
        </div>
      </div>

      <label className={`flex min-h-[44px] items-center gap-2 text-sm cursor-pointer ${defaultReceiptAllowed ? 'liquid-glass-modal-text' : 'liquid-glass-modal-text-muted'}`}>
        <input
          type="checkbox"
          checked={defaultReceiptAllowed ? setDefaultReceipt : false}
          onChange={e => setSetDefaultReceipt(e.target.checked)}
          disabled={!defaultReceiptAllowed}
          className="rounded"
        />
        {defaultReceiptAllowed
          ? t('settings.printer.setAsDefault', 'Set as default')
          : t('settings.printer.quickWizardDefaultLocked', 'Default remains disabled until transport verification succeeds')}
      </label>

      <div className="space-y-2">
        <div className="text-xs liquid-glass-modal-text-muted">
          {t('settings.printer.quickWizardAssignOtherRoles', 'Assign this printer to other roles (optional)')}
        </div>
        <label className="flex min-h-[44px] items-center gap-2 text-sm liquid-glass-modal-text cursor-pointer">
          <input type="checkbox" checked={assignKitchen} onChange={e => setAssignKitchen(e.target.checked)} className="rounded" />
          {t('settings.printer.roleKitchen', 'Kitchen')}
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-sm liquid-glass-modal-text cursor-pointer">
          <input type="checkbox" checked={assignBar} onChange={e => setAssignBar(e.target.checked)} className="rounded" />
          {t('settings.printer.roleBar', 'Bar')}
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-sm liquid-glass-modal-text cursor-pointer">
          <input type="checkbox" checked={assignLabel} onChange={e => setAssignLabel(e.target.checked)} className="rounded" />
          {t('settings.printer.roleLabel', 'Label')}
        </label>
      </div>

      <div className={`rounded-2xl border p-3 text-xs ${liquidGlassModalTone('neutral')}`}>
        <div>{t('settings.printer.quickWizardSavedTemplate', 'Template')}: {template}</div>
        <div>{t('settings.printer.quickWizardSavedRenderMode', 'Render mode')}: {derivedCapabilities.renderMode || 'text'}</div>
        <div>{t('settings.printer.quickWizardSavedEmulation', 'Emulation')}: {derivedCapabilities.emulation || 'auto'}</div>
        {resolvedAddress ? <div>{t('settings.printer.quickWizardSavedAddress', 'Resolved address')}: {resolvedAddress}</div> : null}
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ol className={`inline-flex rounded-lg border p-1 ${liquidGlassModalTone('neutral')}`}>
          {steps.map(step => {
            const active = step === currentStep
            const passed = steps.indexOf(step) < stepIndex
            return (
              <li key={step}>
                <button
                  type="button"
                  aria-current={active ? 'step' : undefined}
                  disabled={saving}
                  onClick={() => {
                    if (!saving && !saveTokenRef.current) setCurrentStep(step)
                  }}
                  className={`min-h-[44px] min-w-[44px] px-2.5 py-1.5 text-xs rounded-md transition active:scale-95 ${
                    active
                      ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100'
                      : passed
                        ? 'text-emerald-700 dark:text-emerald-200'
                        : 'liquid-glass-modal-text-muted'
                  }`}
                >
                  {t(`settings.printer.quickWizardStep.${step}`, step)}
                </button>
              </li>
            )
          })}
        </ol>
        <button disabled={saving} onClick={() => {
          if (!saveTokenRef.current) onOpenExpert()
        }} className={`${liquidGlassModalButton('secondary', 'sm')} min-h-[44px] min-w-[44px]`} type="button">
          <span className="inline-flex items-center justify-center gap-1">
            <SlidersHorizontal className="w-4 h-4 shrink-0" />
            {t('settings.printer.quickWizardAdvanced', 'Expert Settings')}
          </span>
        </button>
      </div>

      {currentStep === 'detect' && renderDetectStep()}
      {currentStep === 'verify' && renderVerifyStep()}
      {currentStep === 'style' && renderStyleStep()}
      {currentStep === 'save' && renderSaveStep()}

      <div className="flex items-center justify-between border-t border-slate-200 pt-2 dark:border-white/10">
        <button disabled={saving} onClick={() => {
          if (!saveTokenRef.current) onCancel()
        }} className={`${liquidGlassModalButton('secondary', 'md')} min-h-[44px] min-w-[44px]`} type="button">
          {t('common.actions.cancel', 'Cancel')}
        </button>
        <div className="flex items-center gap-2">
          {stepIndex > 0 && (
            <button disabled={saving} onClick={gotoPrevious} className={`${liquidGlassModalButton('secondary', 'md')} min-h-[44px] min-w-[44px]`} type="button">
              {t('common.actions.back', 'Back')}
            </button>
          )}
          {stepIndex < steps.length - 1 ? (
            <button
              onClick={gotoNext}
              disabled={saving || !canContinue}
              className={`${liquidGlassModalButton('primary', 'md')} min-h-[44px] min-w-[44px]`}
              type="button"
            >
              <span className="inline-flex items-center justify-center gap-1">
                <Wand2 className="w-4 h-4 shrink-0" />
                {t('common.actions.next', 'Next')}
                <ChevronRight className="w-4 h-4 shrink-0" />
              </span>
            </button>
          ) : (
            <button
              onClick={() => void handleSave()}
              disabled={saving || !saveAllowed}
              className={`${liquidGlassModalButton('primary', 'md')} min-h-[44px] min-w-[44px]`}
              type="button"
            >
              {saving ? t('common.actions.saving', 'Saving...') : t('common.actions.save', 'Save')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default PrinterSetupWizard
