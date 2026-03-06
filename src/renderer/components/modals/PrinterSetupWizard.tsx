import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { CheckCircle2, ChevronRight, Info, Printer, SlidersHorizontal, Wand2 } from 'lucide-react'
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

export type ReadabilitySize = 'small' | 'normal' | 'large'

interface ConnectionDetails {
  type: string
  ip?: string
  port?: number
  address?: string
  channel?: number
  path?: string
  systemName?: string
  render_mode?: ClassicRenderMode
  emulation?: EmulationMode
  printable_width_dots?: number
  left_margin_dots?: number
  threshold?: number
}

interface ExistingPrinterProfile {
  id: string
  name: string
  type: PrinterType
  role: PrinterRole
  isDefault?: boolean
  connectionDetails?: ConnectionDetails
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
}

interface Props {
  existingPrinters: ExistingPrinterProfile[]
  onCancel: () => void
  onSaved: () => Promise<void> | void
  onOpenExpert: () => void
}

const QUICK_READABILITY_KEY = 'printer.quick_readability_default'
const QUICK_ONBOARDING_KEY = 'printer.onboarding_completed'

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

const normalizeDiscoveredCandidate = (raw: unknown): Omit<PrinterCandidate, 'recommended' | 'confidence' | 'reasons' | 'detectedBrand'> | null => {
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

const fallbackRecommendationFor = (candidate: Omit<PrinterCandidate, 'recommended' | 'confidence' | 'reasons' | 'detectedBrand'>): RecommendedPrinterConfig => ({
  printerType: candidate.type,
  paperSize: '80mm',
  characterSet: 'PC437_USA',
  escposCodePage: null,
  receiptTemplate: 'modern',
  fontType: 'a',
  layoutDensity: 'compact',
  headerEmphasis: 'strong',
  connectionDetails: {
    type: candidate.type,
    render_mode: 'text',
    emulation: 'auto',
  },
})

const readabilityPreset: Record<ReadabilitySize, { fontType: FontType; layoutDensity: LayoutDensity; headerEmphasis: HeaderEmphasis }> = {
  small: { fontType: 'b', layoutDensity: 'compact', headerEmphasis: 'normal' },
  normal: { fontType: 'a', layoutDensity: 'compact', headerEmphasis: 'strong' },
  large: { fontType: 'a', layoutDensity: 'balanced', headerEmphasis: 'strong' },
}

const guessReadabilityFromRecommended = (recommended: RecommendedPrinterConfig): ReadabilitySize => {
  if (recommended.fontType === 'b' && recommended.layoutDensity === 'compact' && recommended.headerEmphasis === 'normal') {
    return 'small'
  }
  if (recommended.fontType === 'a' && recommended.layoutDensity === 'balanced') {
    return 'large'
  }
  return 'normal'
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

const steps = ['detect', 'confirm', 'style', 'save'] as const

const PrinterSetupWizard: React.FC<Props> = ({ existingPrinters, onCancel, onSaved, onOpenExpert }) => {
  const { t } = useTranslation()
  const bridge = getBridge()
  const [currentStep, setCurrentStep] = useState<(typeof steps)[number]>('detect')
  const [discovering, setDiscovering] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [candidates, setCandidates] = useState<PrinterCandidate[]>([])
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>('')
  const [paperSize, setPaperSize] = useState<PaperSize>('80mm')
  const [template, setTemplate] = useState<ReceiptTemplate>('modern')
  const [readability, setReadability] = useState<ReadabilitySize>(() => {
    const stored = localStorage.getItem(QUICK_READABILITY_KEY)
    return stored === 'small' || stored === 'large' ? stored : 'normal'
  })
  const [setDefaultReceipt, setSetDefaultReceipt] = useState(() => existingPrinters.filter(p => p.role === 'receipt' && p.isDefault).length === 0)
  const [assignKitchen, setAssignKitchen] = useState(false)
  const [assignBar, setAssignBar] = useState(false)
  const [assignLabel, setAssignLabel] = useState(false)

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

  const discoverCandidates = useCallback(async () => {
    setDiscovering(true)
    try {
      const [systemLikeResult, bluetoothResult] = await Promise.all([
        bridge.printer.discover(['system', 'network', 'wifi', 'usb']).catch(() => []),
        bridge.printer.discover(['bluetooth']).catch(() => []),
      ])
      const merged = [...parseDiscoverResult(systemLikeResult), ...parseDiscoverResult(bluetoothResult)]
      const deduped = new Map<string, Omit<PrinterCandidate, 'recommended' | 'confidence' | 'reasons' | 'detectedBrand'>>()
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
              receiptTemplate:
                recommended?.receiptTemplate === 'classic'
                  ? 'classic'
                  : 'modern',
              fontType: recommended?.fontType === 'b' ? 'b' : 'a',
              layoutDensity:
                recommended?.layoutDensity === 'balanced' || recommended?.layoutDensity === 'spacious'
                  ? recommended.layoutDensity
                  : 'compact',
              headerEmphasis: recommended?.headerEmphasis === 'normal' ? 'normal' : 'strong',
              connectionDetails: {
                ...connectionDetails,
                type: normalizePrinterType(connectionDetails.type || candidate.type),
                render_mode: connectionDetails.render_mode === 'raster_exact' ? 'raster_exact' : 'text',
                emulation:
                  connectionDetails.emulation === 'escpos' || connectionDetails.emulation === 'star_line'
                    ? connectionDetails.emulation
                    : 'auto',
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
        setTemplate(selected.recommended.receiptTemplate)
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

  const buildConnectionDetails = (candidate: PrinterCandidate): ConnectionDetails => {
    const base = candidate.recommended.connectionDetails || { type: candidate.type }
    const details: ConnectionDetails = {
      ...base,
      type: normalizePrinterType(base.type || candidate.type),
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

    if (details.render_mode !== 'raster_exact') {
      details.render_mode = 'text'
    }
    if (details.emulation !== 'escpos' && details.emulation !== 'star_line') {
      details.emulation = 'auto'
    }
    return details
  }

  const buildProfilePayload = (candidate: PrinterCandidate, role: PrinterRole, setAsDefault: boolean) => {
    const readabilityConfig = readabilityPreset[readability]
    return {
      name: role === 'receipt' ? candidate.name : `${candidate.name} (${role})`,
      type: candidate.type,
      connectionDetails: buildConnectionDetails(candidate),
      paperSize,
      characterSet: candidate.recommended.characterSet,
      greekRenderMode: 'text',
      escposCodePage: candidate.recommended.escposCodePage ?? null,
      receiptTemplate: template,
      fontType: readabilityConfig.fontType,
      layoutDensity: readabilityConfig.layoutDensity,
      headerEmphasis: readabilityConfig.headerEmphasis,
      role,
      isDefault: setAsDefault,
      enabled: true,
    }
  }

  const findExistingProfile = (role: PrinterRole, candidate: PrinterCandidate): ExistingPrinterProfile | null => {
    const targetIdentity = connectionIdentityFromCandidate(candidate)
    return existingPrinters.find(profile => {
      if (profile.role !== role) return false
      return connectionIdentityFromProfile(profile) === targetIdentity
    }) || null
  }

  const handleTestPrint = useCallback(async () => {
    if (!selectedCandidate) return
    setTesting(true)
    let tempPrinterId: string | null = null
    try {
      const tempPayload = {
        ...buildProfilePayload(selectedCandidate, 'receipt', false),
        name: `${selectedCandidate.name} (Quick Setup Test)`,
      }
      const added: any = await bridge.printer.add(tempPayload)
      tempPrinterId =
        (added?.printer && typeof added.printer.id === 'string' && added.printer.id) ||
        (typeof added?.printerId === 'string' && added.printerId) ||
        null
      if (!tempPrinterId) {
        toast.error(t('settings.printer.testPrintFailed', 'Test print failed'))
        return
      }
      const testResult: any = await bridge.printer.test(tempPrinterId)
      if (testResult?.success) {
        toast.success(t('settings.printer.testPrintSuccess', 'Test print sent'))
      } else {
        toast.error(testResult?.error || t('settings.printer.testPrintFailed', 'Test print failed'))
      }
    } catch (error) {
      console.error('[PrinterSetupWizard] test print failed', error)
      toast.error(t('settings.printer.testPrintFailed', 'Test print failed'))
    } finally {
      if (tempPrinterId) {
        try {
          await bridge.printer.remove(tempPrinterId)
        } catch (cleanupError) {
          console.warn('[PrinterSetupWizard] failed to remove temporary test printer', cleanupError)
        }
      }
      setTesting(false)
    }
  }, [bridge.printer, selectedCandidate, paperSize, template, readability, t])

  const handleSave = useCallback(async () => {
    if (!selectedCandidate) return
    setSaving(true)
    try {
      const receiptPayload = buildProfilePayload(selectedCandidate, 'receipt', setDefaultReceipt)
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
      toast.success(t('settings.printer.saved', 'Saved'))
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
    onSaved,
    readability,
    selectedCandidate,
    setDefaultReceipt,
    t,
    paperSize,
    template,
  ])

  const canContinue = Boolean(selectedCandidate)
  const stepIndex = steps.indexOf(currentStep)

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
            {t('settings.printer.quickWizardDetectHint', 'We auto-detect installed and nearby printers and suggest the best match.')}
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
                  setTemplate(candidate.recommended.receiptTemplate)
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

  const renderConfirmStep = () => (
    <div className="space-y-4">
      <h3 className="font-medium liquid-glass-modal-text">
        {t('settings.printer.quickWizardConfirmTitle', 'Step 2: Confirm Connection')}
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

          <button
            onClick={() => void handleTestPrint()}
            className={liquidGlassModalButton('secondary', 'sm')}
            disabled={testing}
          >
            {testing
              ? t('settings.printer.testing', 'Testing...')
              : t('settings.printer.quickWizardTestPrint', 'Test Print')}
          </button>

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
        {t('settings.printer.quickWizardStyleTitle', 'Step 3: Look & Readability')}
      </h3>

      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.printer.receiptTemplate', 'Receipt Template')}
        </label>
        <select
          value={template}
          onChange={e => setTemplate((e.target.value === 'classic' ? 'classic' : 'modern'))}
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
          '80mm uses full width by default (576 dots). Choose Large for higher readability; fine tuning stays available in Expert Settings.'
        )}
      </p>
    </div>
  )

  const renderSaveStep = () => (
    <div className="space-y-4">
      <h3 className="font-medium liquid-glass-modal-text">
        {t('settings.printer.quickWizardSaveTitle', 'Step 4: Save & Assign')}
      </h3>

      <label className="flex items-center gap-2 text-sm liquid-glass-modal-text cursor-pointer">
        <input
          type="checkbox"
          checked={setDefaultReceipt}
          onChange={e => setSetDefaultReceipt(e.target.checked)}
          className="rounded"
        />
        {t('settings.printer.setAsDefault', 'Set as default')}
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

      <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-100 flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{t('settings.printer.quickWizardReadyToSave', 'Ready to save printer configuration.')}</span>
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
      {currentStep === 'confirm' && renderConfirmStep()}
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
