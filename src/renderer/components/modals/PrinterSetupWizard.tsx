import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { AlertTriangle, CheckCircle2, ChevronRight, Info, Printer, SlidersHorizontal, Wand2 } from 'lucide-react'
import { liquidGlassModalButton } from '../../styles/designSystem'
import { getBridge } from '../../../lib'

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

interface DraftVerificationResult {
  success?: boolean
  error?: string
  sampleKind?: DraftSampleKind | string
  latencyMs?: number
  bytesRequested?: number
  bytesWritten?: number
  resolvedTransport?: string
  resolvedAddress?: string
  transportReachable?: boolean
  verificationStatus?: VerificationStatus | string
  emulationMode?: EmulationMode | string
  renderMode?: ClassicRenderMode | string
  characterSet?: string
  escposCodePage?: number | null
  candidateCapabilities?: PrinterCapabilities
  candidateConnectionDetails?: ConnectionDetails
  knownPrinters?: string[]
}

interface VerificationStageState {
  attempted: boolean
  result: DraftVerificationResult | null
  confirmed: boolean | null
  attemptCount: number
}

interface Props {
  existingPrinters: ExistingPrinterProfile[]
  onCancel: () => void
  onSaved: () => Promise<void> | void
  onOpenExpert: () => void
}

const QUICK_READABILITY_KEY = 'printer.quick_readability_default'
const QUICK_ONBOARDING_KEY = 'printer.onboarding_completed'
const steps = ['detect', 'verify', 'style', 'save'] as const

const emptyVerificationState = (): Record<DraftSampleKind, VerificationStageState> => ({
  transport_text: { attempted: false, result: null, confirmed: null, attemptCount: 0 },
  encoding: { attempted: false, result: null, confirmed: null, attemptCount: 0 },
  branding: { attempted: false, result: null, confirmed: null, attemptCount: 0 },
})

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

const connectionIdentityFromCandidate = (candidate: PrinterCandidate): string => {
  return `${candidate.type}:${candidate.address.toLowerCase()}`
}

const connectionIdentityFromProfile = (profile: ExistingPrinterProfile): string => {
  const details: ConnectionDetails = profile.connectionDetails || { type: profile.type }
  const rawAddress =
    details.systemName ||
    details.ip ||
    details.address ||
    details.path ||
    profile.name ||
    ''
  return `${normalizePrinterType(profile.type)}:${rawAddress.toLowerCase()}`
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
  if (status === 'verified') return 'bg-emerald-500/15 border-emerald-400/30 text-emerald-200'
  if (status === 'degraded') return 'bg-amber-500/15 border-amber-400/30 text-amber-200'
  if (status === 'candidate') return 'bg-blue-500/15 border-blue-400/30 text-blue-200'
  return 'bg-white/5 border-white/10 liquid-glass-modal-text-muted'
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

const PrinterSetupWizard: React.FC<Props> = ({ existingPrinters, onCancel, onSaved, onOpenExpert }) => {
  const { t } = useTranslation()
  const bridge = getBridge()
  const [currentStep, setCurrentStep] = useState<(typeof steps)[number]>('detect')
  const [discovering, setDiscovering] = useState(false)
  const [saving, setSaving] = useState(false)
  const [verifyingKind, setVerifyingKind] = useState<DraftSampleKind | null>(null)
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
  const [verification, setVerification] = useState<Record<DraftSampleKind, VerificationStageState>>(emptyVerificationState)

  const selectedCandidate = useMemo(
    () => candidates.find(candidate => candidate.id === selectedCandidateId) || null,
    [candidates, selectedCandidateId],
  )

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
    setVerification(emptyVerificationState())
    setVerifyingKind(null)
  }, [])

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
        toast(t('settings.printer.noDevicesFound', 'No printers found'), { icon: <Info className="w-4 h-4 text-blue-400" /> })
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
    const transport = verification.transport_text
    if (transport.confirmed !== true || !transport.result?.candidateCapabilities) {
      return defaultCapabilities()
    }

    let capabilities = mergeCapabilities(
      transport.result.candidateCapabilities,
      {
        status: 'verified',
      },
    )

    if (verification.encoding.confirmed === true) {
      capabilities = mergeCapabilities(capabilities, verification.encoding.result?.candidateCapabilities, {
        status: 'verified',
      })
    }

    if (verification.branding.confirmed === true) {
      capabilities = mergeCapabilities(capabilities, verification.branding.result?.candidateCapabilities, {
        status: 'verified',
        supportsLogo: true,
      })
    }

    return capabilities
  }, [verification])

  const buildProfilePayload = useCallback((candidate: PrinterCandidate, role: PrinterRole, setAsDefault: boolean) => {
    const readabilityConfig = readabilityPreset[readability]
    const connectionDetails = buildConnectionDetails(candidate)
    const capabilities = verification.transport_text.confirmed === true
      ? mergeCapabilities(derivedCapabilities, {
          status: 'verified',
          supportsLogo:
            verification.branding.confirmed === true
              ? true
              : Boolean(derivedCapabilities.supportsLogo),
        })
      : defaultCapabilities()

    return {
      name: role === 'receipt' ? candidate.name : `${candidate.name} (${role})`,
      type: candidate.type,
      connectionDetails: {
        ...connectionDetails,
        capabilities,
      },
      paperSize,
      characterSet:
        verification.encoding.confirmed === true && verification.encoding.result?.characterSet
          ? verification.encoding.result.characterSet
          : candidate.recommended.characterSet,
      greekRenderMode: 'text',
      escposCodePage:
        verification.encoding.confirmed === true && typeof verification.encoding.result?.escposCodePage === 'number'
          ? verification.encoding.result.escposCodePage
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

  const findExistingProfile = useCallback((role: PrinterRole, candidate: PrinterCandidate): ExistingPrinterProfile | null => {
    const targetIdentity = connectionIdentityFromCandidate(candidate)
    return existingPrinters.find(profile => {
      if (profile.role !== role) return false
      return connectionIdentityFromProfile(profile) === targetIdentity
    }) || null
  }, [existingPrinters])

  const invokeDraftVerification = useCallback(async (
    draftPayload: Record<string, unknown>,
    sampleKind: DraftSampleKind,
    probeAttempt: number,
  ): Promise<DraftVerificationResult> => {
    const payload = { profileDraft: draftPayload, sampleKind, probeAttempt }
    const commandNames = ['printer:test-draft', 'printer_test_draft']
    let lastError: unknown = null

    for (const commandName of commandNames) {
      try {
        const result = await bridge.invoke(commandName, payload)
        return (result || {}) as DraftVerificationResult
      } catch (error) {
        lastError = error
      }
    }

    throw lastError
  }, [bridge])

  const handleRunVerification = useCallback(async (sampleKind: DraftSampleKind) => {
    if (!selectedCandidate) return
    setVerifyingKind(sampleKind)
    try {
      const draftPayload = buildDraftPayload(selectedCandidate)
      const probeAttempt = verification[sampleKind].attemptCount
      const result = await invokeDraftVerification(
        draftPayload as Record<string, unknown>,
        sampleKind,
        probeAttempt,
      )
      setVerification(prev => ({
        ...prev,
        [sampleKind]: {
          attempted: true,
          result,
          confirmed: result?.success ? null : false,
          attemptCount: prev[sampleKind].attemptCount + 1,
        },
      }))

      if (result?.success) {
        const dispatchText = sampleKind === 'branding'
          ? t('settings.printer.quickWizardBrandingDispatched', 'Branding sample dispatched. Confirm the actual paper result before saving.')
          : t('settings.printer.quickWizardSampleDispatched', 'Sample dispatched. Confirm the actual paper result before saving.')
        toast.success(dispatchText)
      } else {
        toast.error(result?.error || t('settings.printer.testPrintFailed', 'Test print failed'))
      }
    } catch (error) {
      console.error('[PrinterSetupWizard] draft verification failed', error)
      const message = error instanceof Error ? error.message : t('settings.printer.testPrintFailed', 'Test print failed')
      setVerification(prev => ({
        ...prev,
        [sampleKind]: {
          attempted: true,
          result: { success: false, error: message, sampleKind },
          confirmed: false,
          attemptCount: prev[sampleKind].attemptCount + 1,
        },
      }))
      toast.error(message)
    } finally {
      setVerifyingKind(null)
    }
  }, [buildDraftPayload, invokeDraftVerification, selectedCandidate, t, verification])

  const handleConfirmStage = useCallback((sampleKind: DraftSampleKind, worked: boolean) => {
    setVerification(prev => {
      const next = {
        ...prev,
        [sampleKind]: {
          ...prev[sampleKind],
          confirmed: worked,
        },
      }

      if (sampleKind === 'transport_text' && !worked) {
        next.encoding = { attempted: false, result: null, confirmed: null, attemptCount: 0 }
        next.branding = { attempted: false, result: null, confirmed: null, attemptCount: 0 }
      }

      if (sampleKind === 'encoding' && !worked) {
        next.branding = { attempted: false, result: null, confirmed: null, attemptCount: 0 }
      }

      return next
    })
  }, [])

  const handleSave = useCallback(async () => {
    if (!selectedCandidate) return
    setSaving(true)
    try {
      const defaultAllowed = verification.transport_text.confirmed === true
      const receiptPayload = buildProfilePayload(selectedCandidate, 'receipt', defaultAllowed ? setDefaultReceipt : false)
      const existingReceipt = findExistingProfile('receipt', selectedCandidate)
      let receiptResult: any
      if (existingReceipt) {
        receiptResult = await bridge.printer.update(existingReceipt.id, receiptPayload)
      } else {
        receiptResult = await bridge.printer.add(receiptPayload)
      }
      if (receiptResult?.success === false) {
        toast.error(receiptResult?.error || t('errors.operationFailed', 'Operation failed'))
        return
      }

      const optionalRoles: PrinterRole[] = []
      if (assignKitchen) optionalRoles.push('kitchen')
      if (assignBar) optionalRoles.push('bar')
      if (assignLabel) optionalRoles.push('label')

      for (const role of optionalRoles) {
        const payload = buildProfilePayload(selectedCandidate, role, false)
        const existing = findExistingProfile(role, selectedCandidate)
        if (existing) {
          await bridge.printer.update(existing.id, payload)
        } else {
          await bridge.printer.add(payload)
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

      if (!defaultAllowed) {
        toast(t(
          'settings.printer.quickWizardSavedUnverified',
          'Saved as discovered only. Run verification before using it as a default printer.',
        ), {
          icon: <AlertTriangle className="w-4 h-4 text-amber-300" />,
        })
      } else {
        toast.success(t('settings.printer.saved', 'Saved'))
      }
      await onSaved()
    } catch (error) {
      console.error('[PrinterSetupWizard] save failed', error)
      toast.error(t('errors.operationFailed', 'Operation failed'))
    } finally {
      setSaving(false)
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
    readability,
    selectedCandidate,
    setDefaultReceipt,
    t,
    verification.transport_text.confirmed,
  ])

  const canContinue = Boolean(selectedCandidate)
    && (currentStep !== 'verify' || verification.transport_text.confirmed === true)
  const stepIndex = steps.indexOf(currentStep)
  const verificationStatus = verification.transport_text.confirmed === true ? 'verified' : 'unverified'
  const resolvedTransport = derivedCapabilities.resolvedTransport
  const resolvedAddress = derivedCapabilities.resolvedAddress
  const defaultReceiptAllowed = verification.transport_text.confirmed === true
  const transportFailureMessage = verification.transport_text.attempted && verification.transport_text.result?.success === false
    ? verification.transport_text.result?.error
    : ''

  const gotoNext = () => {
    if (stepIndex >= steps.length - 1) return
    setCurrentStep(steps[stepIndex + 1])
  }

  const gotoPrevious = () => {
    if (stepIndex <= 0) return
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
          onClick={() => void discoverCandidates()}
          className={liquidGlassModalButton('secondary', 'sm')}
          disabled={discovering}
        >
          {discovering ? t('settings.printer.scanning', 'Scanning...') : t('settings.printer.refresh', 'Refresh')}
        </button>
      </div>

      <div className="p-3 rounded-lg border border-blue-500/20 bg-blue-500/10 text-xs text-blue-100">
        {t(
          'settings.printer.quickWizardDraftOnlyHint',
          'Compatibility-first setup: the wizard tests transport and encoding using an unsaved draft profile. No temporary printer profiles are created.',
        )}
      </div>

      {candidates.length === 0 ? (
        <div className="p-4 rounded-lg border border-white/10 bg-white/5 text-sm liquid-glass-modal-text-muted">
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
                onClick={() => {
                  setSelectedCandidateId(candidate.id)
                  setPaperSize(candidate.recommended.paperSize)
                  setTemplate('classic')
                  setReadability(guessReadabilityFromRecommended(candidate.recommended))
                }}
                className={`w-full text-left p-3 rounded-lg border transition-all ${
                  selected
                    ? 'bg-blue-500/15 border-blue-400/50'
                    : 'bg-white/5 border-white/10 hover:bg-white/10'
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
                        ? 'bg-green-500/20 text-green-300'
                        : 'bg-yellow-500/20 text-yellow-300'
                    }`}>
                      {candidate.confidence >= 80
                        ? t('settings.printer.quickWizardHighConfidence', 'High confidence')
                        : t('settings.printer.quickWizardNeedsReview', 'Needs review')}
                    </div>
                    <div className="text-[11px] liquid-glass-modal-text-muted mt-1">
                      {candidate.detectedBrand}
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
    const state = verification[stage.kind]
    const result = state.result
    const awaitingConfirmation = Boolean(result?.success) && state.confirmed === null

    return (
      <div key={stage.kind} className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-medium liquid-glass-modal-text">
              {t(stage.titleKey, stage.defaultTitle)}
              {stage.optional && (
                <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-white/10 liquid-glass-modal-text-muted">
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
            disabled={disabled || verifyingKind === stage.kind}
            onClick={() => void handleRunVerification(stage.kind)}
            className={liquidGlassModalButton('secondary', 'sm')}
          >
            {verifyingKind === stage.kind
              ? t('settings.printer.testing', 'Testing...')
              : t('settings.printer.quickWizardSendSample', 'Send sample')}
          </button>
        </div>

        {disabled && (
          <div className="text-xs liquid-glass-modal-text-muted">
            {t('settings.printer.quickWizardVerifyLockedHint', 'Confirm the basic transport sample first.')}
          </div>
        )}

        {result && (
          <div className={`rounded-lg border p-3 text-xs ${
            result.success
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-100'
              : 'bg-amber-500/10 border-amber-500/20 text-amber-100'
          }`}>
            <div className="font-medium">
              {result.success
                ? t('settings.printer.quickWizardSampleSent', 'Sample dispatched')
                : t('settings.printer.quickWizardSampleFailed', 'Sample failed')}
            </div>
            {result.error && (
              <div className="mt-1">{result.error}</div>
            )}
            {(result.resolvedTransport || result.resolvedAddress) && (
              <div className="mt-1">
                {t('settings.printer.quickWizardResolvedPath', 'Resolved path')}:{' '}
                {transportLabel(result.resolvedTransport, t)}
                {result.resolvedAddress ? ` • ${result.resolvedAddress}` : ''}
              </div>
            )}
            {typeof result.transportReachable === 'boolean' && (
              <div className="mt-1">
                {result.transportReachable
                  ? t('settings.printer.quickWizardTransportReachable', 'Transport reachable')
                  : t('settings.printer.quickWizardTransportNotReachable', 'Transport not reachable')}
              </div>
            )}
            {result.knownPrinters && result.knownPrinters.length > 0 && !result.success && (
              <div className="mt-1">
                {t('settings.printer.quickWizardKnownQueues', 'Detected Windows queues')}: {result.knownPrinters.join(', ')}
              </div>
            )}
          </div>
        )}

        {awaitingConfirmation && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-100">
            <div className="font-medium mb-2">
              {t('settings.printer.quickWizardConfirmPaperResult', 'Did the paper output print correctly?')}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleConfirmStage(stage.kind, true)}
                className={liquidGlassModalButton('primary', 'sm')}
              >
                {t('common.actions.yes', 'Yes')}
              </button>
              <button
                type="button"
                onClick={() => handleConfirmStage(stage.kind, false)}
                className={liquidGlassModalButton('secondary', 'sm')}
              >
                {t('common.actions.no', 'No')}
              </button>
            </div>
          </div>
        )}

        {state.confirmed === true && (
          <div className="flex items-center gap-2 text-xs text-emerald-200">
            <CheckCircle2 className="w-4 h-4" />
            <span>{t('settings.printer.quickWizardStageVerified', 'Confirmed working')}</span>
          </div>
        )}

        {state.confirmed === false && state.attempted && (
          <div className="flex items-center gap-2 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4" />
            <span>{t('settings.printer.quickWizardStageRejected', 'This stage is not trusted yet. Adjust settings or keep the profile unverified.')}</span>
          </div>
        )}
      </div>
    )
  }

  const renderVerifyStep = () => (
    <div className="space-y-4">
      <h3 className="font-medium liquid-glass-modal-text">
        {t('settings.printer.quickWizardVerifyTitle', 'Step 2: Verify Compatibility')}
      </h3>
      {selectedCandidate ? (
        <div className="space-y-3">
          <div className="p-3 rounded-lg border border-white/10 bg-white/5">
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
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.printer.paperSize', 'Paper Size')}
            </label>
            <select
              value={paperSize}
              onChange={e => setPaperSize(normalizePaperSize(e.target.value))}
              className="liquid-glass-modal-input"
            >
              <option value="58mm">58mm</option>
              <option value="80mm">80mm</option>
              <option value="112mm">112mm</option>
            </select>
          </div>

          {sampleKinds.map(stage => renderVerificationCard(stage, stage.kind !== 'transport_text' && verification.transport_text.confirmed !== true))}

          <div className={`rounded-lg border p-3 ${verificationTone(verificationStatus)}`}>
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

          {transportFailureMessage && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
              <div className="font-medium">
                {t('settings.printer.quickWizardDiscoveredNotPrintableTitle', 'Discovered, not yet printable')}
              </div>
              <div className="mt-1">
                {transportFailureMessage}
              </div>
              <div className="mt-2">
                {t(
                  'settings.printer.quickWizardDiscoveredNotPrintableBody',
                  'The device was detected, but the app could not confirm a working queue, raw TCP path, or serial/RFCOMM transport yet.',
                )}
              </div>
            </div>
          )}

          {selectedCandidate.reasons.length > 0 && (
            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <div className="text-xs font-medium text-blue-300 mb-1">
                {t('settings.printer.quickWizardWhyTitle', 'Why this recommendation')}
              </div>
              <ul className="text-xs text-blue-100/80 space-y-1">
                {selectedCandidate.reasons.slice(0, 3).map(reason => (
                  <li key={reason}>• {reason}</li>
                ))}
              </ul>
              {selectedCandidate.probeHints?.preferredEmulationOrder?.length ? (
                <div className="mt-2 text-[11px] text-blue-100/70">
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

      <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs liquid-glass-modal-text-muted">
        {t(
          'settings.printer.quickWizardCompatibilityDefaults',
          'Safe defaults for new profiles: Classic template, text render mode, and automatic protocol selection. Optional logo / raster support is only trusted after confirmation.',
        )}
      </div>

      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.printer.receiptTemplate', 'Receipt Template')}
        </label>
        <select
          value={template}
          onChange={e => setTemplate((e.target.value === 'modern' ? 'modern' : 'classic'))}
          className="liquid-glass-modal-input"
        >
          <option value="classic">{t('settings.printer.receiptTemplateClassic', 'Classic')}</option>
          <option value="modern">{t('settings.printer.receiptTemplateModern', 'Modern')}</option>
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium mb-2 liquid-glass-modal-text-muted">
          {t('settings.printer.quickWizardReadability', 'Readability')}
        </label>
        <div className="grid grid-cols-3 gap-2">
          {(['small', 'normal', 'large'] as ReadabilitySize[]).map(size => (
            <button
              key={size}
              type="button"
              onClick={() => setReadability(size)}
              className={`px-3 py-2 rounded-lg border text-sm ${
                readability === size
                  ? 'bg-blue-500/15 border-blue-400/50 text-blue-100'
                  : 'bg-white/5 border-white/10 liquid-glass-modal-text'
              }`}
            >
              {t(`settings.printer.quickWizardReadability.${size}`, size.charAt(0).toUpperCase() + size.slice(1))}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-3">
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

      <div className={`rounded-lg border p-3 ${verificationTone(verificationStatus)}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-medium">
              {verification.transport_text.confirmed === true
                ? t('settings.printer.quickWizardReadyVerifiedTitle', 'Ready to save as verified')
                : t('settings.printer.quickWizardReadyUnverifiedTitle', 'Ready to save as discovered only')}
            </div>
            <div className="text-xs mt-1">
              {verification.transport_text.confirmed === true
                ? t('settings.printer.quickWizardReadyVerifiedBody', 'This printer now has a confirmed transport path and can be used as a working receipt printer.')
                : t('settings.printer.quickWizardReadyUnverifiedBody', 'You can still save the profile, but it will remain unverified and should not be relied on as the default printer yet.')}
            </div>
          </div>
          <div className="text-right text-xs">
            <div>{verificationLabel(verificationStatus, t)}</div>
            <div className="mt-1">{transportLabel(resolvedTransport, t)}</div>
          </div>
        </div>
      </div>

      <label className={`flex items-center gap-2 text-sm cursor-pointer ${defaultReceiptAllowed ? 'liquid-glass-modal-text' : 'liquid-glass-modal-text-muted'}`}>
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
        <label className="flex items-center gap-2 text-sm liquid-glass-modal-text cursor-pointer">
          <input type="checkbox" checked={assignKitchen} onChange={e => setAssignKitchen(e.target.checked)} className="rounded" />
          {t('settings.printer.roleKitchen', 'Kitchen')}
        </label>
        <label className="flex items-center gap-2 text-sm liquid-glass-modal-text cursor-pointer">
          <input type="checkbox" checked={assignBar} onChange={e => setAssignBar(e.target.checked)} className="rounded" />
          {t('settings.printer.roleBar', 'Bar')}
        </label>
        <label className="flex items-center gap-2 text-sm liquid-glass-modal-text cursor-pointer">
          <input type="checkbox" checked={assignLabel} onChange={e => setAssignLabel(e.target.checked)} className="rounded" />
          {t('settings.printer.roleLabel', 'Label')}
        </label>
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs liquid-glass-modal-text-muted">
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
        <div className="inline-flex rounded-lg bg-white/5 border border-white/10 p-1">
          {steps.map(step => {
            const active = step === currentStep
            const passed = steps.indexOf(step) < stepIndex
            return (
              <button
                key={step}
                type="button"
                onClick={() => setCurrentStep(step)}
                className={`px-2.5 py-1.5 text-xs rounded-md transition ${
                  active
                    ? 'bg-blue-500/20 text-blue-200'
                    : passed
                    ? 'text-emerald-200'
                    : 'liquid-glass-modal-text-muted'
                }`}
              >
                {t(`settings.printer.quickWizardStep.${step}`, step)}
              </button>
            )
          })}
        </div>
        <button onClick={onOpenExpert} className={liquidGlassModalButton('secondary', 'sm')} type="button">
          <SlidersHorizontal className="w-4 h-4 mr-1" />
          {t('settings.printer.quickWizardAdvanced', 'Expert Settings')}
        </button>
      </div>

      {currentStep === 'detect' && renderDetectStep()}
      {currentStep === 'verify' && renderVerifyStep()}
      {currentStep === 'style' && renderStyleStep()}
      {currentStep === 'save' && renderSaveStep()}

      <div className="flex items-center justify-between pt-2 border-t border-white/10">
        <button onClick={onCancel} className={liquidGlassModalButton('secondary', 'md')} type="button">
          {t('common.actions.cancel', 'Cancel')}
        </button>
        <div className="flex items-center gap-2">
          {stepIndex > 0 && (
            <button onClick={gotoPrevious} className={liquidGlassModalButton('secondary', 'md')} type="button">
              {t('common.actions.back', 'Back')}
            </button>
          )}
          {stepIndex < steps.length - 1 ? (
            <button
              onClick={gotoNext}
              disabled={!canContinue}
              className={liquidGlassModalButton('primary', 'md')}
              type="button"
            >
              <span className="inline-flex items-center gap-1">
                <Wand2 className="w-4 h-4" />
                {t('common.actions.next', 'Next')}
                <ChevronRight className="w-4 h-4" />
              </span>
            </button>
          ) : (
            <button
              onClick={() => void handleSave()}
              disabled={saving || !canContinue}
              className={liquidGlassModalButton('primary', 'md')}
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
