import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canSaveVerifiedPrinter,
  canStartWizardSample,
  createVerificationState,
  parseWizardEnqueueResponse,
  verificationReducer,
  type ConnectionDetails,
} from '../printer-setup-verification'

const componentMocks = vi.hoisted(() => ({
  scanNetwork: vi.fn(),
  scanBluetooth: vi.fn(),
  discover: vi.fn(),
  recommendProfile: vi.fn(),
  testDraft: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  updateLocal: vi.fn(),
  invoke: vi.fn(),
  usePrintQueue: vi.fn(),
  cancelJob: vi.fn(),
  retryJob: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  queue: {} as Record<string, unknown>,
}))

vi.mock('../../../../lib', () => {
  const bridge = {
    invoke: componentMocks.invoke,
    printer: {
      scanNetwork: componentMocks.scanNetwork,
      scanBluetooth: componentMocks.scanBluetooth,
      discover: componentMocks.discover,
      recommendProfile: componentMocks.recommendProfile,
      testDraft: componentMocks.testDraft,
      add: componentMocks.add,
      update: componentMocks.update,
    },
    settings: { updateLocal: componentMocks.updateLocal },
  }
  return { getBridge: () => bridge }
})

vi.mock('../../../hooks/usePrintQueue', () => ({
  usePrintQueue: componentMocks.usePrintQueue,
}))

vi.mock('react-hot-toast', () => ({
  toast: Object.assign(vi.fn(), {
    success: componentMocks.toastSuccess,
    error: componentMocks.toastError,
  }),
}))

vi.mock('react-i18next', () => {
  const t = (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions
      const fallback = fallbackOrOptions?.defaultValue
      if (typeof fallback !== 'string') return key
      return Object.entries(fallbackOrOptions ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        fallback,
      )
    }
  return { useTranslation: () => ({ t }) }
})

import PrinterSetupWizard from '../PrinterSetupWizard'

const exactConnection: ConnectionDetails = {
  type: 'network',
  ip: '192.0.2.44',
  port: 9100,
  emulation: 'star_line',
  render_mode: 'text',
  escposCodePage: 15,
  cutPaper: false,
}

const encodingConnection: ConnectionDetails = {
  ...exactConnection,
  escposCodePage: 14,
  encoding: 'PC737_GREEK',
}

const brandingConnection: ConnectionDetails = {
  ...encodingConnection,
  escposCodePage: 15,
  rasterThreshold: 132,
}

const unsafeNestedLogoConnection: ConnectionDetails = {
  ...exactConnection,
  capabilities: {
    supportsCut: false,
    supportsLogo: true,
  },
}

const candidate = {
  name: 'MCP31 Front Counter',
  type: 'system',
  address: 'MCP31 Front Counter',
  source: 'windows',
  isConfigured: false,
}

const enqueueResponse = (
  sampleKind: 'transport_text' | 'encoding' | 'branding',
  jobId: string,
  options: {
    logoConfigured?: boolean
    logoIncluded?: boolean
    connectionDetails?: ConnectionDetails
  } = {},
) => ({
  success: true,
  queued: true,
  duplicate: false,
  jobId,
  queueState: 'pending',
  sampleKind,
  candidateConnectionDetails: options.connectionDetails ?? exactConnection,
  candidateCapabilities: {
    status: 'verified',
    resolvedTransport: 'windows_queue',
    resolvedAddress: 'MCP31 Front Counter',
    emulation: 'star_line',
    renderMode: 'text',
    supportsCut: false,
    supportsLogo: options.logoIncluded ?? false,
  },
  logoConfigured: options.logoConfigured ?? false,
  logoIncluded: options.logoIncluded ?? false,
})

const makeQueueJob = (
  id: string,
  status: 'pending' | 'printing' | 'printed' | 'dispatched' | 'failed' | 'cancelled',
  transportState: string | null,
  options: { cancellable?: boolean; retryable?: boolean; lastError?: string } = {},
) => ({
  id,
  source: 'pos' as const,
  entityType: 'test_print',
  entityId: 'private-wizard-entity',
  printerProfileId: null,
  printerDisplayName: 'MCP31 Front Counter',
  resolvedTransport: 'windows' as const,
  resolvedTarget: 'MCP31 Front Counter',
  status,
  transportState,
  spoolJobId: 44,
  snapshotAvailable: true,
  reprintOfJobId: null,
  cancellable: options.cancellable ?? false,
  retryable: options.retryable ?? false,
  reprintable: false,
  lastError: options.lastError ?? null,
  warningCode: null,
  warningMessage: null,
  lastSeenAt: '2026-08-13T08:01:00Z',
  createdAt: '2026-08-13T08:00:00Z',
  updatedAt: '2026-08-13T08:01:00Z',
})

const queueState = (
  jobs: ReturnType<typeof makeQueueJob>[] = [],
  overrides: Partial<{
    loading: boolean
    stale: boolean
    error: string | null
  }> = {},
) => ({
  jobs,
  queuePaused: false,
  pausedPrinterProfileIds: [] as string[],
  counts: { active: jobs.length, failed: 0, stale: 0, history: 0 },
  pagination: { offset: 0, limit: 100, total: jobs.length, hasMore: false },
  loading: false,
  stale: false,
  error: null,
  refresh: vi.fn(),
  cancelJob: componentMocks.cancelJob,
  cancelAllJobs: vi.fn(),
  pauseQueue: vi.fn(),
  resumeQueue: vi.fn(),
  retryJob: componentMocks.retryJob,
  reprintJob: vi.fn(),
  ...overrides,
})

const wizardProps = (overrides: Record<string, unknown> = {}) => ({
  existingPrinters: [],
  onCancel: vi.fn(),
  onSaved: vi.fn(),
  onOpenExpert: vi.fn(),
  logoSettingsLoaded: true,
  logoConfigured: false,
  onOpenLogoSettings: vi.fn(),
  ...overrides,
})

const enterVerificationStep = async () => {
  await screen.findByText('MCP31 Front Counter')
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('heading', { name: 'Step 2: Verify Compatibility' })
}

const confirmTrackedPaper = async (
  view: ReturnType<typeof render>,
  props: ReturnType<typeof wizardProps>,
  jobId: string,
) => {
  componentMocks.queue = queueState([makeQueueJob(jobId, 'printed', null)])
  view.rerender(<PrinterSetupWizard {...props} />)
  fireEvent.click(within(await screen.findByRole('group', {
    name: 'Did the paper output print correctly?',
  })).getByRole('button', { name: 'Yes' }))
}

const completeCoreVerification = async (
  view: ReturnType<typeof render>,
  props: ReturnType<typeof wizardProps>,
  transportJobId: string,
  encodingJobId: string,
) => {
  fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
  await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))
  await confirmTrackedPaper(view, props, transportJobId)
  fireEvent.click(await screen.findByRole('button', { name: 'Send encoding sample' }))
  await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(2))
  await confirmTrackedPaper(view, props, encodingJobId)
}

const openSaveStep = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('heading', { name: 'Step 3: Defaults & Readability' })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('heading', { name: 'Step 4: Save & Assign' })
}

const queueSample = (
  state: ReturnType<typeof createVerificationState>,
  sample: 'transport' | 'encoding' | 'branding',
  jobId: string,
  options: {
    logoConfigured?: boolean
    logoIncluded?: boolean
    connectionDetails?: ConnectionDetails
  } = {},
) => verificationReducer(state, {
  type: 'sample_queued',
  sample,
  jobId,
  duplicate: false,
  candidateConnectionDetails: options.connectionDetails ?? exactConnection,
  candidateCapabilities: { status: 'verified', supportsLogo: options.logoIncluded ?? false },
  logoConfigured: options.logoConfigured ?? false,
  logoIncluded: options.logoIncluded ?? false,
})

const dispatchSample = (
  state: ReturnType<typeof createVerificationState>,
  jobId: string,
) => verificationReducer(state, {
  type: 'job_observed',
  jobId,
  status: 'dispatched',
  transportState: 'spool_completed',
})

const confirmPaper = (
  state: ReturnType<typeof createVerificationState>,
  sample: 'transport' | 'encoding' | 'branding',
  worked: boolean,
) => verificationReducer(state, { type: 'paper_confirmed', sample, worked })

const confirmedTransport = () => confirmPaper(
  dispatchSample(queueSample(createVerificationState(), 'transport', 'transport-job'), 'transport-job'),
  'transport',
  true,
)

const confirmedEncoding = () => confirmPaper(
  dispatchSample(queueSample(confirmedTransport(), 'encoding', 'encoding-job'), 'encoding-job'),
  'encoding',
  true,
)

describe('printer setup verification reducer', () => {
  it('enforces Transport then Encoding then optional Branding with one global in-flight sample', () => {
    const initial = createVerificationState()
    expect(canStartWizardSample(initial, 'transport', false)).toBe(true)
    expect(canStartWizardSample(initial, 'encoding', false)).toBe(false)
    expect(canStartWizardSample(initial, 'branding', true)).toBe(false)

    const transportQueued = queueSample(initial, 'transport', 'transport-job')
    expect(transportQueued.transport.phase).toBe('queued')
    expect(transportQueued.activeJobId).toBe('transport-job')
    expect(canStartWizardSample(transportQueued, 'transport', false)).toBe(false)
    expect(canStartWizardSample(transportQueued, 'encoding', false)).toBe(false)

    const transportConfirmed = confirmPaper(
      dispatchSample(transportQueued, 'transport-job'),
      'transport',
      true,
    )
    expect(transportConfirmed.activeJobId).toBeNull()
    expect(canStartWizardSample(transportConfirmed, 'encoding', false)).toBe(true)
    expect(canStartWizardSample(transportConfirmed, 'branding', true)).toBe(false)

    const encodingConfirmed = confirmPaper(
      dispatchSample(queueSample(transportConfirmed, 'encoding', 'encoding-job'), 'encoding-job'),
      'encoding',
      true,
    )
    expect(canStartWizardSample(encodingConfirmed, 'branding', true)).toBe(true)
    expect(canStartWizardSample(encodingConfirmed, 'branding', false)).toBe(false)
  })

  it('maps tracked queue cancellation and failure without exposing an enqueue as paper success', () => {
    const queued = queueSample(createVerificationState(), 'transport', 'private-job-id')
    expect(queued.transport.phase).toBe('queued')

    const printing = verificationReducer(queued, {
      type: 'job_observed',
      jobId: 'private-job-id',
      status: 'printing',
      transportState: 'windows_printing',
    })
    expect(printing.transport.phase).toBe('printing')

    const cancelled = verificationReducer(printing, {
      type: 'job_observed',
      jobId: 'private-job-id',
      status: 'cancelled',
      transportState: 'cancelled',
    })
    expect(cancelled.transport.phase).toBe('cancelled')
    expect(cancelled.activeJobId).toBeNull()

    const failed = verificationReducer(
      queueSample(createVerificationState(), 'transport', 'failed-job'),
      { type: 'job_observed', jobId: 'failed-job', status: 'failed', transportState: 'spool_error' },
    )
    expect(failed.transport.phase).toBe('failed')
    expect(failed.activeJobId).toBeNull()
  })

  it('fails closed while a dispatched Windows job is only queued and accepts strongest completed transport evidence', () => {
    const queued = queueSample(createVerificationState(), 'transport', 'windows-job')
    const onlyAcceptedByWindows = verificationReducer(queued, {
      type: 'job_observed',
      jobId: 'windows-job',
      status: 'dispatched',
      transportState: 'windows_queued',
    })
    expect(onlyAcceptedByWindows.transport.phase).toBe('printing')
    expect(onlyAcceptedByWindows.activeJobId).toBe('windows-job')

    const spoolCompleted = verificationReducer(onlyAcceptedByWindows, {
      type: 'job_observed',
      jobId: 'windows-job',
      status: 'dispatched',
      transportState: 'spool_completed',
    })
    expect(spoolCompleted.transport.phase).toBe('awaiting_confirmation')

    const rawSent = verificationReducer(
      queueSample(createVerificationState(), 'transport', 'raw-job'),
      {
        type: 'job_observed',
        jobId: 'raw-job',
        status: 'dispatched',
        transportState: 'sent',
      },
    )
    expect(rawSent.transport.phase).toBe('awaiting_confirmation')

    const printed = verificationReducer(
      queueSample(createVerificationState(), 'transport', 'printed-job'),
      {
        type: 'job_observed',
        jobId: 'printed-job',
        status: 'printed',
        transportState: null,
      },
    )
    expect(printed.transport.phase).toBe('awaiting_confirmation')
  })

  it('rejects a duplicate enqueue response whose persisted sample belongs to another stage', () => {
    const parsed = parseWizardEnqueueResponse('encoding', {
      success: true,
      queued: true,
      duplicate: true,
      jobId: 'persisted-transport-job',
      queueState: 'pending',
      sampleKind: 'transport_text',
      candidateConnectionDetails: exactConnection,
      candidateCapabilities: { status: 'verified' },
      logoConfigured: false,
      logoIncluded: false,
    })

    expect(parsed).toEqual({ ok: false, errorCode: 'sample_kind_mismatch' })
  })

  it('accepts a same-stage duplicate at a known persisted queue state so it can be watched', () => {
    const parsed = parseWizardEnqueueResponse('transport', {
      ...enqueueResponse('transport_text', 'persisted-transport-job'),
      duplicate: true,
      queueState: 'dispatched',
    })

    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.jobId).toBe('persisted-transport-job')
  })

  it('ignores paper confirmation until the tracked job reaches its confirmation phase', () => {
    const queued = queueSample(createVerificationState(), 'transport', 'early-job')
    expect(confirmPaper(queued, 'transport', true)).toBe(queued)

    const failed = verificationReducer(queued, {
      type: 'job_observed',
      jobId: 'early-job',
      status: 'failed',
      transportState: 'spool_error',
    })
    expect(confirmPaper(failed, 'transport', true)).toBe(failed)
  })

  it('resets later evidence after Transport rejection and Branding after Encoding rejection', () => {
    const allConfirmed = confirmPaper(
      dispatchSample(
        queueSample(confirmedEncoding(), 'branding', 'branding-job', {
          logoConfigured: true,
          logoIncluded: true,
        }),
        'branding-job',
      ),
      'branding',
      true,
    )
    expect(allConfirmed.branding.phase).toBe('confirmed')

    const transportRejected = confirmPaper(
      dispatchSample(queueSample(allConfirmed, 'transport', 'transport-retest-job'), 'transport-retest-job'),
      'transport',
      false,
    )
    expect(transportRejected.transport.phase).toBe('rejected')
    expect(transportRejected.encoding.phase).toBe('idle')
    expect(transportRejected.branding.phase).toBe('idle')
    expect(transportRejected.confirmedConnectionDetails).toBeNull()

    const encodingRejected = confirmPaper(
      dispatchSample(queueSample(allConfirmed, 'encoding', 'encoding-retest-job'), 'encoding-retest-job'),
      'encoding',
      false,
    )
    expect(encodingRejected.transport.phase).toBe('confirmed')
    expect(encodingRejected.encoding.phase).toBe('rejected')
    expect(encodingRejected.branding.phase).toBe('idle')
  })

  it('requires Encoding and an honest logo decision before Save or Set Default', () => {
    const transport = confirmedTransport()
    expect(canSaveVerifiedPrinter(transport, false)).toBe(false)

    const encoding = confirmedEncoding()
    expect(canSaveVerifiedPrinter(encoding, false)).toBe(true)
    expect(canSaveVerifiedPrinter(encoding, true)).toBe(false)

    const explicitContinue = verificationReducer(encoding, {
      type: 'continue_without_logo',
      value: true,
    })
    expect(canSaveVerifiedPrinter(explicitContinue, true)).toBe(true)

    const branding = confirmPaper(
      dispatchSample(
        queueSample(encoding, 'branding', 'branding-job', {
          logoConfigured: true,
          logoIncluded: true,
        }),
        'branding-job',
      ),
      'branding',
      true,
    )
    expect(canSaveVerifiedPrinter(branding, true)).toBe(true)
  })

  it('persists the exact Transport candidate and refuses positive Branding evidence without raster bytes', () => {
    const transport = confirmedTransport()
    expect(transport.confirmedConnectionDetails).toEqual(exactConnection)
    expect(transport.confirmedConnectionDetails).toBe(transport.transport.candidateConnectionDetails)

    const brandingAwaiting = dispatchSample(
      queueSample(confirmedEncoding(), 'branding', 'branding-job', {
        logoConfigured: true,
        logoIncluded: false,
      }),
      'branding-job',
    )
    const falselyConfirmed = confirmPaper(brandingAwaiting, 'branding', true)
    expect(falselyConfirmed.branding.phase).toBe('rejected')
    expect(falselyConfirmed.branding.candidateCapabilities?.supportsLogo).not.toBe(true)
    expect(canSaveVerifiedPrinter(falselyConfirmed, true)).toBe(false)

    const transportWithDishonestNestedCapability = confirmPaper(
      dispatchSample(
        queueSample(createVerificationState(), 'transport', 'nested-logo-evidence-job', {
          logoIncluded: false,
          connectionDetails: unsafeNestedLogoConnection,
        }),
        'nested-logo-evidence-job',
      ),
      'transport',
      true,
    )
    const nestedCapabilities = transportWithDishonestNestedCapability
      .confirmedConnectionDetails?.capabilities as Record<string, unknown>
    expect(nestedCapabilities.supportsLogo).toBe(false)
  })

  it('promotes the exact latest paper-confirmed candidate through Transport, Encoding, and honest Branding', () => {
    const transportAwaiting = dispatchSample(
      queueSample(createVerificationState(), 'transport', 'transport-evidence-job', {
        connectionDetails: exactConnection,
      }),
      'transport-evidence-job',
    )
    const transportConfirmed = confirmPaper(transportAwaiting, 'transport', true)
    expect(transportConfirmed.confirmedConnectionDetails).toBe(exactConnection)

    const encodingAwaiting = dispatchSample(
      queueSample(transportConfirmed, 'encoding', 'encoding-evidence-job', {
        connectionDetails: encodingConnection,
      }),
      'encoding-evidence-job',
    )
    const encodingConfirmed = confirmPaper(encodingAwaiting, 'encoding', true)
    expect(encodingConfirmed.confirmedConnectionDetails).toBe(encodingConnection)
    expect(encodingConfirmed.confirmedConnectionDetails?.escposCodePage).toBe(14)

    const brandingWithoutRaster = confirmPaper(
      dispatchSample(
        queueSample(encodingConfirmed, 'branding', 'branding-without-raster-job', {
          logoConfigured: true,
          logoIncluded: false,
          connectionDetails: brandingConnection,
        }),
        'branding-without-raster-job',
      ),
      'branding',
      true,
    )
    expect(brandingWithoutRaster.branding.phase).toBe('rejected')
    expect(brandingWithoutRaster.confirmedConnectionDetails).toBe(encodingConnection)

    const brandingAwaiting = dispatchSample(
      queueSample(encodingConfirmed, 'branding', 'branding-evidence-job', {
        logoConfigured: true,
        logoIncluded: true,
        connectionDetails: brandingConnection,
      }),
      'branding-evidence-job',
    )
    const brandingConfirmed = confirmPaper(brandingAwaiting, 'branding', true)
    expect(brandingConfirmed.confirmedConnectionDetails).toBe(brandingConnection)
    expect(brandingConfirmed.confirmedConnectionDetails?.escposCodePage).toBe(15)
  })

  it('invalidates stale downstream evidence immediately when any confirmed stage is re-run', () => {
    const transportConfirmed = confirmPaper(
      dispatchSample(
        queueSample(createVerificationState(), 'transport', 'transport-old', {
          connectionDetails: exactConnection,
        }),
        'transport-old',
      ),
      'transport',
      true,
    )
    const encodingConfirmed = confirmPaper(
      dispatchSample(
        queueSample(transportConfirmed, 'encoding', 'encoding-old', {
          connectionDetails: encodingConnection,
        }),
        'encoding-old',
      ),
      'encoding',
      true,
    )
    const brandingConfirmed = confirmPaper(
      dispatchSample(
        queueSample(encodingConfirmed, 'branding', 'branding-old', {
          logoConfigured: true,
          logoIncluded: true,
          connectionDetails: brandingConnection,
        }),
        'branding-old',
      ),
      'branding',
      true,
    )
    const withExplicitContinue = verificationReducer(brandingConfirmed, {
      type: 'continue_without_logo',
      value: true,
    })
    const transportRerun = queueSample(withExplicitContinue, 'transport', 'transport-new', {
      connectionDetails: { ...exactConnection, port: 9101 },
    })
    expect(transportRerun.encoding.phase).toBe('idle')
    expect(transportRerun.branding.phase).toBe('idle')
    expect(transportRerun.confirmedConnectionDetails).toBeNull()
    expect(transportRerun.continueWithoutLogo).toBe(false)
    expect(canSaveVerifiedPrinter(transportRerun, true)).toBe(false)

    const encodingRerun = queueSample(withExplicitContinue, 'encoding', 'encoding-new', {
      connectionDetails: { ...encodingConnection, escposCodePage: 16 },
    })
    expect(encodingRerun.transport.phase).toBe('confirmed')
    expect(encodingRerun.branding.phase).toBe('idle')
    expect(encodingRerun.confirmedConnectionDetails).toBe(exactConnection)
    expect(encodingRerun.continueWithoutLogo).toBe(false)
    expect(canSaveVerifiedPrinter(encodingRerun, true)).toBe(false)

    const brandingRerun = queueSample(withExplicitContinue, 'branding', 'branding-new', {
      logoConfigured: true,
      logoIncluded: true,
      connectionDetails: { ...brandingConnection, rasterThreshold: 140 },
    })
    expect(brandingRerun.confirmedConnectionDetails).toBe(encodingConnection)
    expect(brandingRerun.continueWithoutLogo).toBe(false)
    expect(canSaveVerifiedPrinter(brandingRerun, true)).toBe(false)
  })

  it('fails Save closed whenever a sample job is still active', () => {
    const verified = verificationReducer(confirmedEncoding(), {
      type: 'continue_without_logo',
      value: true,
    })

    expect(
      canSaveVerifiedPrinter({ ...verified, activeJobId: 'still-observing-sample' }, true),
    ).toBe(false)
  })

  it('keeps paper-confirmed and rejected decisions terminal when a late queue observation arrives', () => {
    const awaitingYes = dispatchSample(
      queueSample(createVerificationState(), 'transport', 'late-confirmed-job'),
      'late-confirmed-job',
    )
    const confirmed = confirmPaper(awaitingYes, 'transport', true)
    const afterLatePending = verificationReducer(confirmed, {
      type: 'job_observed',
      jobId: 'late-confirmed-job',
      status: 'pending',
      transportState: 'created',
    })
    expect(afterLatePending.transport.phase).toBe('confirmed')

    const awaitingNo = dispatchSample(
      queueSample(createVerificationState(), 'transport', 'late-rejected-job'),
      'late-rejected-job',
    )
    const rejected = confirmPaper(awaitingNo, 'transport', false)
    const afterLateDispatch = verificationReducer(rejected, {
      type: 'job_observed',
      jobId: 'late-rejected-job',
      status: 'dispatched',
      transportState: 'spool_completed',
    })
    expect(afterLateDispatch.transport.phase).toBe('rejected')
  })
})

describe('PrinterSetupWizard tracked sample workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    componentMocks.scanNetwork.mockResolvedValue([candidate])
    componentMocks.scanBluetooth.mockResolvedValue([])
    componentMocks.discover.mockResolvedValue([])
    componentMocks.recommendProfile.mockResolvedValue({
      detectedBrand: 'Star',
      confidence: 95,
      reasons: ['Windows queue detected'],
      recommended: {
        printerType: 'system',
        paperSize: '80mm',
        characterSet: 'PC737_GREEK',
        escposCodePage: 15,
        receiptTemplate: 'classic',
        fontType: 'a',
        layoutDensity: 'compact',
        headerEmphasis: 'strong',
        connectionDetails: {
          type: 'system',
          systemName: 'MCP31 Front Counter',
        },
      },
    })
    componentMocks.queue = queueState()
    componentMocks.usePrintQueue.mockImplementation(() => componentMocks.queue)
    componentMocks.add.mockResolvedValue({ success: true })
    componentMocks.update.mockResolvedValue({ success: true })
    componentMocks.updateLocal.mockResolvedValue({ success: true })
    componentMocks.cancelJob.mockResolvedValue({ success: true, affected: 1 })
    componentMocks.retryJob.mockResolvedValue({
      success: true,
      jobId: 'tracked-job',
      newJobId: null,
      affected: 1,
      unchanged: false,
      duplicate: false,
    })
  })

  afterEach(() => cleanup())

  it('uses only typed testDraft, watches the tracked job, and waits for strongest transport evidence before paper confirmation', async () => {
    componentMocks.testDraft.mockResolvedValue(enqueueResponse('transport_text', 'tracked-job'))
    const view = render(<PrinterSetupWizard {...wizardProps()} />)
    await enterVerificationStep()

    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))
    expect(componentMocks.invoke).not.toHaveBeenCalled()
    const request = componentMocks.testDraft.mock.calls[0][0]
    expect(request).toMatchObject({
      sampleKind: 'transport_text',
      probeAttempt: 0,
    })
    expect(request.profileDraft).toBeTruthy()
    expect(typeof request.wizardSessionId).toBe('string')
    expect(new TextEncoder().encode(request.wizardSessionId).byteLength).toBeLessThanOrEqual(128)
    expect(componentMocks.usePrintQueue).toHaveBeenLastCalledWith({ jobIds: ['tracked-job'] })
    expect(screen.getByRole('status')).toHaveTextContent('Sample queued')
    expect(screen.queryByRole('group', { name: 'Did the paper output print correctly?' })).toBeNull()

    componentMocks.queue = queueState([
      makeQueueJob('tracked-job', 'dispatched', 'windows_queued'),
    ])
    view.rerender(<PrinterSetupWizard {...wizardProps()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Printing in progress'))
    expect(screen.queryByRole('group', { name: 'Did the paper output print correctly?' })).toBeNull()

    componentMocks.queue = queueState([
      makeQueueJob('tracked-job', 'dispatched', 'spool_completed'),
    ])
    view.rerender(<PrinterSetupWizard {...wizardProps()} />)
    expect(await screen.findByRole('group', { name: 'Did the paper output print correctly?' })).toBeVisible()
    const awaitingAnnouncement = screen.getByRole('status')
    expect(awaitingAnnouncement).toHaveAttribute('aria-live', 'polite')
    expect(awaitingAnnouncement).toHaveTextContent('Paper output is ready for confirmation')
  })

  it('closes the same-tick double-click race with one global in-flight request', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise((done) => { resolve = done })
    componentMocks.testDraft.mockReturnValue(pending)
    render(<PrinterSetupWizard {...wizardProps()} />)
    await enterVerificationStep()

    const send = screen.getByRole('button', { name: 'Send transport sample' })
    fireEvent.click(send)
    fireEvent.click(send)
    expect(componentMocks.testDraft).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolve(enqueueResponse('transport_text', 'tracked-job'))
      await pending
    })
  })

  it('locks Refresh and physical candidate selection while a tracked sample is active', async () => {
    componentMocks.scanNetwork.mockResolvedValue([
      candidate,
      { ...candidate, name: 'MCP31 Kitchen', address: 'MCP31 Kitchen' },
    ])
    componentMocks.testDraft.mockResolvedValue(enqueueResponse('transport_text', 'candidate-lock-job'))
    render(<PrinterSetupWizard {...wizardProps()} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'detect' }))
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    const otherCandidate = screen.getByRole('button', { name: /MCP31 Kitchen/ })
    expect(refresh).toBeDisabled()
    expect(otherCandidate).toBeDisabled()

    const scanCount = componentMocks.scanNetwork.mock.calls.length
    fireEvent.click(refresh)
    fireEvent.click(otherCandidate)
    expect(componentMocks.scanNetwork).toHaveBeenCalledTimes(scanCount)
    expect(otherCandidate).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /MCP31 Front Counter/ }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('fails Send closed while a deferred Refresh can still replace the physical candidate', async () => {
    render(<PrinterSetupWizard {...wizardProps()} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'detect' }))

    let finishRefresh!: (value: typeof candidate[]) => void
    const pendingRefresh = new Promise<typeof candidate[]>((resolve) => {
      finishRefresh = resolve
    })
    componentMocks.scanNetwork.mockReturnValueOnce(pendingRefresh)
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    fireEvent.click(refresh)
    expect(refresh).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'verify' }))
    const send = screen.getByRole('button', { name: 'Send transport sample' })
    expect(send).toBeDisabled()
    fireEvent.click(send)
    expect(componentMocks.testDraft).not.toHaveBeenCalled()

    await act(async () => {
      finishRefresh([{ ...candidate, name: 'MCP31 Replacement', address: 'MCP31 Replacement' }])
      await pendingRefresh
    })
    expect(componentMocks.testDraft).not.toHaveBeenCalled()
  })

  it('keeps the stage visible and shows safe stale feedback without raw queue errors', async () => {
    componentMocks.testDraft.mockResolvedValue(enqueueResponse('transport_text', 'private-stale-job'))
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))

    componentMocks.queue = queueState(
      [makeQueueJob('private-stale-job', 'pending', 'created')],
      { stale: true, error: 'private native queue stack at C:\\spool\\secret' },
    )
    view.rerender(<PrinterSetupWizard {...props} />)

    expect(await screen.findByText(
      'Print status may be out of date. The last known sample state remains visible.',
    )).toBeVisible()
    expect(screen.getByText('Sample queued')).toBeVisible()
    expect(view.container).not.toHaveTextContent(/private native|C:\\spool|private-stale-job/i)
  })

  it('shows safe unavailable feedback when a completed queue load omits the watched job', async () => {
    componentMocks.testDraft.mockResolvedValue(enqueueResponse('transport_text', 'private-missing-job'))
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))

    componentMocks.queue = queueState([], {
      loading: false,
      stale: false,
      error: 'private missing row diagnostics',
    })
    view.rerender(<PrinterSetupWizard {...props} />)

    expect(await screen.findByText(
      'The tracked sample status is unavailable. Refresh the queue or retry the sample.',
    )).toBeVisible()
    expect(screen.getByText('Sample queued')).toBeVisible()
    expect(view.container).not.toHaveTextContent(/private missing|private-missing-job/i)
  })

  it('offers capability-gated Cancel and Retry without rendering the private job or technical failure', async () => {
    componentMocks.testDraft.mockResolvedValue(enqueueResponse('transport_text', 'private-tracked-job'))
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))

    componentMocks.queue = queueState([
      makeQueueJob('private-tracked-job', 'pending', 'created', { cancellable: true }),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel transport sample' }))
    expect(componentMocks.cancelJob).toHaveBeenCalledWith('private-tracked-job')

    componentMocks.queue = queueState([
      makeQueueJob('private-tracked-job', 'failed', 'spool_error', {
        retryable: true,
        lastError: 'TheSmallPOS/private-tracked-job native spool stack',
      }),
    ])
    componentMocks.retryJob.mockImplementationOnce(async () => {
      componentMocks.queue = queueState([
        makeQueueJob('private-tracked-job', 'pending', 'created', { cancellable: true }),
      ])
      return {
        success: true,
        jobId: 'private-tracked-job',
        newJobId: null,
        affected: 1,
        unchanged: false,
        duplicate: false,
      }
    })
    view.rerender(<PrinterSetupWizard {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry transport sample' }))
    expect(componentMocks.retryJob).toHaveBeenCalledWith('private-tracked-job')
    await waitFor(() => expect(screen.getByText('Sample queued')).toBeVisible())
    const send = screen.getByRole('button', { name: 'Send transport sample' })
    expect(send).toBeDisabled()
    fireEvent.click(send)
    expect(componentMocks.testDraft).toHaveBeenCalledTimes(1)
    expect(view.container.innerHTML).not.toContain('private-tracked-job')
    expect(view.container).not.toHaveTextContent(/native spool stack/i)
  })

  it('lets the authoritative unchanged failed snapshot win after a successful Retry refresh', async () => {
    componentMocks.testDraft.mockResolvedValue(enqueueResponse('transport_text', 'authoritative-retry-job'))
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))

    const unchangedFailure = makeQueueJob(
      'authoritative-retry-job',
      'failed',
      'spool_error',
      { retryable: true },
    )
    componentMocks.queue = queueState([unchangedFailure])
    view.rerender(<PrinterSetupWizard {...props} />)
    const retry = await screen.findByRole('button', { name: 'Retry transport sample' })
    fireEvent.click(retry)
    expect(retry).toBeDisabled()

    await waitFor(() => expect(retry).toBeEnabled())
    await waitFor(() => {
      expect(screen.getByText(
        'The tracked sample failed. Check the printer and try again.',
      )).toBeVisible()
      expect(screen.queryByText('Sample queued')).toBeNull()
    })
  })

  it('serializes same-tick Cancel actions with the enqueue mutex', async () => {
    componentMocks.testDraft.mockResolvedValue(enqueueResponse('transport_text', 'cancel-mutex-job'))
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))

    componentMocks.queue = queueState([
      makeQueueJob('cancel-mutex-job', 'pending', 'created', { cancellable: true }),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    let resolveCancel!: (value: unknown) => void
    const pendingCancel = new Promise((resolve) => { resolveCancel = resolve })
    componentMocks.cancelJob.mockReturnValueOnce(pendingCancel)
    const cancel = await screen.findByRole('button', { name: 'Cancel transport sample' })
    act(() => {
      cancel.click()
      cancel.click()
    })
    expect(componentMocks.cancelJob).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCancel({ success: true, affected: 1 })
      await pendingCancel
    })
  })

  it('serializes same-tick Retry and blocks a competing enqueue with the same mutex', async () => {
    componentMocks.testDraft.mockResolvedValue(enqueueResponse('transport_text', 'retry-mutex-job'))
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))

    componentMocks.queue = queueState([
      makeQueueJob('retry-mutex-job', 'failed', 'spool_error', { retryable: true }),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    let resolveRetry!: (value: unknown) => void
    const pendingRetry = new Promise((resolve) => { resolveRetry = resolve })
    componentMocks.retryJob.mockReturnValueOnce(pendingRetry)
    const retry = await screen.findByRole('button', { name: 'Retry transport sample' })
    const send = screen.getByRole('button', { name: 'Send transport sample' })
    act(() => {
      retry.click()
      retry.click()
      send.click()
    })
    expect(componentMocks.retryJob).toHaveBeenCalledTimes(1)
    expect(componentMocks.testDraft).toHaveBeenCalledTimes(1)

    await act(async () => {
      componentMocks.queue = queueState([
        makeQueueJob('retry-mutex-job', 'pending', 'created', { cancellable: true }),
      ])
      resolveRetry({
        success: true,
        jobId: 'retry-mutex-job',
        newJobId: null,
        affected: 1,
        unchanged: false,
        duplicate: false,
      })
      await pendingRetry
    })
  })

  it('shows fixed safe failures when Cancel is refused or Retry changes no queue row', async () => {
    componentMocks.testDraft.mockResolvedValue(enqueueResponse('transport_text', 'private-action-job'))
    componentMocks.cancelJob.mockResolvedValue({
      success: false,
      affected: 0,
      error: 'private cancel backend detail',
    })
    componentMocks.retryJob.mockResolvedValue({
      success: true,
      jobId: 'private-action-job',
      newJobId: null,
      affected: 0,
      unchanged: true,
      duplicate: false,
      error: 'private retry backend detail',
    })
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))

    componentMocks.queue = queueState([
      makeQueueJob('private-action-job', 'pending', 'created', { cancellable: true }),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel transport sample' }))
    expect(await screen.findByText('The tracked sample could not be cancelled.')).toBeVisible()

    componentMocks.queue = queueState([
      makeQueueJob('private-action-job', 'failed', 'spool_error', { retryable: true }),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry transport sample' }))
    expect(await screen.findByText('The tracked sample could not be retried.')).toBeVisible()
    expect(view.container).not.toHaveTextContent(/private cancel|private retry|private-action-job/i)
  })

  it('disables Branding when logo evidence is unavailable and opens logo settings without receiving a logo source', async () => {
    const onOpenLogoSettings = vi.fn()
    render(<PrinterSetupWizard {...wizardProps({
      logoSettingsLoaded: true,
      logoConfigured: false,
      onOpenLogoSettings,
    })} />)
    await enterVerificationStep()

    expect(screen.getByRole('button', { name: 'Send branding sample' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Open logo settings' }))
    expect(onOpenLogoSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps Save closed for unknown logo settings and offers a safe recovery action', async () => {
    const onOpenLogoSettings = vi.fn()
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'unknown-logo-transport'))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'unknown-logo-encoding'))
    const props = wizardProps({
      logoSettingsLoaded: false,
      logoConfigured: false,
      onOpenLogoSettings,
    })
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    await completeCoreVerification(
      view,
      props,
      'unknown-logo-transport',
      'unknown-logo-encoding',
    )

    const unavailable = screen.getByText(
      'Logo settings are unavailable. Open logo settings to reload them before saving.',
    )
    expect(unavailable.closest('[role="status"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open logo settings' }))
    expect(onOpenLogoSettings).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    expect(screen.getByRole('button', { name: 'Open logo settings' })).toBeVisible()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(componentMocks.add).not.toHaveBeenCalled()
  })

  it('treats accepted backend logo evidence as authoritative when the known parent state is false', async () => {
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'backend-logo-transport', {
        logoConfigured: true,
      }))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'backend-logo-encoding', {
        logoConfigured: true,
      }))
    const props = wizardProps({ logoSettingsLoaded: true, logoConfigured: false })
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    await completeCoreVerification(
      view,
      props,
      'backend-logo-transport',
      'backend-logo-encoding',
    )

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    const explicitContinue = screen.getByRole('checkbox', {
      name: 'Continue without verified logo output',
    })
    fireEvent.click(explicitContinue)
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
  })

  it('rejects cross-stage duplicate evidence without watching or rendering its private job ID', async () => {
    componentMocks.testDraft.mockResolvedValue({
      ...enqueueResponse('transport_text', 'private-other-stage-job'),
      sampleKind: 'encoding',
      duplicate: true,
    })
    const view = render(<PrinterSetupWizard {...wizardProps()} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The queued sample did not match this verification step.')
    expect(componentMocks.usePrintQueue).not.toHaveBeenCalledWith({ jobIds: ['private-other-stage-job'] })
    expect(view.container.innerHTML).not.toContain('private-other-stage-job')
  })

  it('fails closed on a malformed successful enqueue response', async () => {
    componentMocks.testDraft.mockResolvedValue({
      success: true,
      queued: true,
      duplicate: false,
      jobId: 41,
      queueState: 'pending',
      sampleKind: 'transport_text',
      candidateConnectionDetails: exactConnection,
      candidateCapabilities: { status: 'verified' },
      logoConfigured: false,
      logoIncluded: false,
    })
    render(<PrinterSetupWizard {...wizardProps()} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The printer returned an invalid sample response. Try again.',
    )
    expect(componentMocks.usePrintQueue).not.toHaveBeenCalledWith({ jobIds: ['41'] })
  })

  it('locks candidate changes while an enqueue request is still pending', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise((done) => { resolve = done })
    componentMocks.testDraft.mockReturnValue(pending)
    componentMocks.scanNetwork.mockResolvedValue([
      candidate,
      { ...candidate, name: 'MCP31 Kitchen', address: 'MCP31 Kitchen' },
    ])
    const view = render(<PrinterSetupWizard {...wizardProps()} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))

    fireEvent.click(screen.getByRole('button', { name: 'detect' }))
    const kitchen = await screen.findByRole('button', { name: /MCP31 Kitchen/ })
    expect(kitchen).toBeDisabled()
    fireEvent.click(kitchen)
    await act(async () => {
      resolve(enqueueResponse('transport_text', 'stale-private-job'))
      await pending
    })

    expect(componentMocks.usePrintQueue).toHaveBeenCalledWith({ jobIds: ['stale-private-job'] })
    expect(view.container.innerHTML).not.toContain('stale-private-job')
  })

  it('ignores a pending enqueue completion after unmount', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise((done) => { resolve = done })
    componentMocks.testDraft.mockReturnValue(pending)
    const view = render(<PrinterSetupWizard {...wizardProps()} />)
    await enterVerificationStep()
    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    view.unmount()

    await act(async () => {
      resolve(enqueueResponse('transport_text', 'unmounted-private-job'))
      await pending
    })
    expect(componentMocks.usePrintQueue).not.toHaveBeenCalledWith({ jobIds: ['unmounted-private-job'] })
  })

  it('passes the exact confirmed candidate to Encoding and every saved role at the top level', async () => {
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'transport-job'))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'encoding-job'))
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()

    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))
    componentMocks.queue = queueState([
      makeQueueJob('transport-job', 'dispatched', 'spool_completed'),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    fireEvent.click(within(await screen.findByRole('group', {
      name: 'Did the paper output print correctly?',
    })).getByRole('button', { name: 'Yes' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Send encoding sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(2))
    expect(componentMocks.testDraft.mock.calls[1][0].confirmedCandidateConnectionDetails)
      .toBe(exactConnection)
    expect(componentMocks.testDraft.mock.calls[1][0].wizardSessionId)
      .toBe(componentMocks.testDraft.mock.calls[0][0].wizardSessionId)

    componentMocks.queue = queueState([
      makeQueueJob('encoding-job', 'printed', null),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    fireEvent.click(within(await screen.findByRole('group', {
      name: 'Did the paper output print correctly?',
    })).getByRole('button', { name: 'Yes' }))

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('heading', { name: 'Step 3: Defaults & Readability' })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('heading', { name: 'Step 4: Save & Assign' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bar' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Label' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(componentMocks.add).toHaveBeenCalledTimes(4))
    for (const [payload] of componentMocks.add.mock.calls) {
      expect(payload.confirmedCandidateConnectionDetails).toBe(exactConnection)
    }
  })

  it('never persists nested logo support when the accepted sample contained no logo bytes', async () => {
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'nested-logo-transport', {
        connectionDetails: unsafeNestedLogoConnection,
      }))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'nested-logo-encoding', {
        connectionDetails: unsafeNestedLogoConnection,
      }))
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    await completeCoreVerification(view, props, 'nested-logo-transport', 'nested-logo-encoding')
    await openSaveStep()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(componentMocks.add).toHaveBeenCalledTimes(1))
    const persisted = componentMocks.add.mock.calls[0][0]
      .confirmedCandidateConnectionDetails.capabilities
    expect(persisted.supportsLogo).toBe(false)
  })

  it('matches an existing profile by the final confirmed TCP port, not discovery address alone', async () => {
    const networkCandidate = {
      ...candidate,
      type: 'network',
      address: '192.0.2.44',
      port: 9101,
      source: 'network',
    }
    componentMocks.scanNetwork.mockResolvedValue([networkCandidate])
    componentMocks.recommendProfile.mockResolvedValue({
      detectedBrand: 'Star',
      confidence: 95,
      reasons: [],
      recommended: {
        printerType: 'network',
        paperSize: '80mm',
        characterSet: 'PC737_GREEK',
        receiptTemplate: 'classic',
        connectionDetails: { type: 'network', ip: '192.0.2.44', port: 9101 },
      },
    })
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'identity-port-transport', {
        connectionDetails: exactConnection,
      }))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'identity-port-encoding', {
        connectionDetails: exactConnection,
      }))
    const props = wizardProps({
      existingPrinters: [
        {
          id: 'wrong-port-profile',
          name: 'Same host wrong port',
          type: 'network',
          role: 'receipt',
          isDefault: false,
          connectionDetails: { type: 'network', ip: '192.0.2.44', port: 9101 },
        },
        {
          id: 'exact-port-profile',
          name: 'Exact verified target',
          type: 'network',
          role: 'receipt',
          isDefault: true,
          connectionDetails: exactConnection,
        },
      ],
    })
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    await completeCoreVerification(view, props, 'identity-port-transport', 'identity-port-encoding')
    await openSaveStep()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(componentMocks.update).toHaveBeenCalledTimes(1))
    expect(componentMocks.update).toHaveBeenCalledWith('exact-port-profile', expect.any(Object))
    expect(componentMocks.add).not.toHaveBeenCalled()
  })

  it('matches an existing Bluetooth profile by the final confirmed channel', async () => {
    const bluetoothCandidate = {
      ...candidate,
      name: 'Counter Bluetooth',
      type: 'bluetooth',
      address: 'AA:BB:CC:DD:EE:FF',
      source: 'bluetooth',
    }
    const confirmedBluetooth: ConnectionDetails = {
      type: 'bluetooth',
      address: bluetoothCandidate.address,
      channel: 7,
      emulation: 'escpos',
    }
    componentMocks.scanNetwork.mockResolvedValue([])
    componentMocks.scanBluetooth.mockResolvedValue([bluetoothCandidate])
    componentMocks.recommendProfile.mockResolvedValue({
      detectedBrand: 'Generic',
      confidence: 80,
      reasons: [],
      recommended: {
        printerType: 'bluetooth',
        paperSize: '80mm',
        characterSet: 'PC737_GREEK',
        receiptTemplate: 'classic',
        connectionDetails: { type: 'bluetooth', address: bluetoothCandidate.address, channel: 1 },
      },
    })
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'identity-channel-transport', {
        connectionDetails: confirmedBluetooth,
      }))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'identity-channel-encoding', {
        connectionDetails: confirmedBluetooth,
      }))
    const props = wizardProps({
      existingPrinters: [
        {
          id: 'wrong-channel-profile',
          name: 'Same device wrong channel',
          type: 'bluetooth',
          role: 'receipt',
          isDefault: false,
          connectionDetails: { type: 'bluetooth', address: bluetoothCandidate.address, channel: 1 },
        },
        {
          id: 'exact-channel-profile',
          name: 'Exact verified channel',
          type: 'bluetooth',
          role: 'receipt',
          isDefault: true,
          connectionDetails: confirmedBluetooth,
        },
      ],
    })
    const view = render(<PrinterSetupWizard {...props} />)
    await screen.findByText('Counter Bluetooth')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('heading', { name: 'Step 2: Verify Compatibility' })
    await completeCoreVerification(view, props, 'identity-channel-transport', 'identity-channel-encoding')
    await openSaveStep()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(componentMocks.update).toHaveBeenCalledTimes(1))
    expect(componentMocks.update).toHaveBeenCalledWith('exact-channel-profile', expect.any(Object))
    expect(componentMocks.add).not.toHaveBeenCalled()
  })

  it('uses each latest stage candidate in the next request and every final update payload', async () => {
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'transport-update-job', {
        logoConfigured: true,
        connectionDetails: exactConnection,
      }))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'encoding-update-job', {
        logoConfigured: true,
        connectionDetails: encodingConnection,
      }))
      .mockResolvedValueOnce(enqueueResponse('branding', 'branding-update-job', {
        logoConfigured: true,
        logoIncluded: true,
        connectionDetails: brandingConnection,
      }))
    const existingPrinters = (['receipt', 'kitchen', 'bar', 'label'] as const).map((role) => ({
      id: `existing-${role}`,
      name: `MCP31 Front Counter ${role}`,
      type: 'network' as const,
      role,
      isDefault: role === 'receipt',
      connectionDetails: brandingConnection,
    }))
    const props = wizardProps({ existingPrinters, logoConfigured: true })
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()

    fireEvent.click(screen.getByRole('button', { name: 'Send transport sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(1))
    componentMocks.queue = queueState([
      makeQueueJob('transport-update-job', 'dispatched', 'spool_completed'),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    fireEvent.click(within(await screen.findByRole('group', {
      name: 'Did the paper output print correctly?',
    })).getByRole('button', { name: 'Yes' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Send encoding sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(2))
    expect(componentMocks.testDraft.mock.calls[1][0].confirmedCandidateConnectionDetails)
      .toBe(exactConnection)
    componentMocks.queue = queueState([
      makeQueueJob('encoding-update-job', 'printed', null),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    fireEvent.click(within(await screen.findByRole('group', {
      name: 'Did the paper output print correctly?',
    })).getByRole('button', { name: 'Yes' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Send branding sample' }))
    await waitFor(() => expect(componentMocks.testDraft).toHaveBeenCalledTimes(3))
    expect(componentMocks.testDraft.mock.calls[2][0].confirmedCandidateConnectionDetails)
      .toBe(encodingConnection)
    componentMocks.queue = queueState([
      makeQueueJob('branding-update-job', 'dispatched', 'spool_completed'),
    ])
    view.rerender(<PrinterSetupWizard {...props} />)
    fireEvent.click(within(await screen.findByRole('group', {
      name: 'Did the paper output print correctly?',
    })).getByRole('button', { name: 'Yes' }))

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('heading', { name: 'Step 3: Defaults & Readability' })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('heading', { name: 'Step 4: Save & Assign' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bar' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Label' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(componentMocks.update).toHaveBeenCalledTimes(4))
    expect(componentMocks.add).not.toHaveBeenCalled()
    for (const [id, payload] of componentMocks.update.mock.calls) {
      expect(id).toMatch(/^existing-/)
      expect(payload.confirmedCandidateConnectionDetails).toBe(brandingConnection)
    }
  })

  it('fails Save closed while a new sample enqueue request is still unresolved', async () => {
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'save-race-transport'))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'save-race-encoding'))
    const props = wizardProps()
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    await completeCoreVerification(view, props, 'save-race-transport', 'save-race-encoding')

    let resolve!: (value: unknown) => void
    const pending = new Promise((done) => { resolve = done })
    componentMocks.testDraft.mockReturnValueOnce(pending)
    fireEvent.click(screen.getByRole('button', { name: 'Send encoding sample' }))
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(componentMocks.add).not.toHaveBeenCalled()

    await act(async () => {
      resolve(enqueueResponse('encoding', 'save-race-retest'))
      await pending
    })
  })

  it('requires explicit success and never exposes a raw receipt mutation error', async () => {
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'strict-receipt-transport'))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'strict-receipt-encoding'))
    componentMocks.add.mockResolvedValueOnce({
      error: 'private receipt database stack',
    })
    const onSaved = vi.fn()
    const props = wizardProps({ onSaved })
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    await completeCoreVerification(
      view,
      props,
      'strict-receipt-transport',
      'strict-receipt-encoding',
    )
    await openSaveStep()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(componentMocks.toastError).toHaveBeenCalledWith(
      'The printer could not be saved. Refresh the printer list and try again.',
    ))
    expect(componentMocks.toastSuccess).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(view.container).not.toHaveTextContent(/private receipt|database stack/i)
    expect(JSON.stringify(componentMocks.toastError.mock.calls)).not.toMatch(/private receipt|database stack/i)
  })

  it('refreshes after a safe partial assignment failure so retry cannot duplicate the saved receipt', async () => {
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'partial-save-transport'))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'partial-save-encoding'))
    componentMocks.add
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'private optional role error' })
    const onSaved = vi.fn()
    const props = wizardProps({ onSaved })
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    await completeCoreVerification(view, props, 'partial-save-transport', 'partial-save-encoding')
    await openSaveStep()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(componentMocks.add).toHaveBeenCalledTimes(2)
    expect(componentMocks.toastError).toHaveBeenCalledWith(
      'Some printer assignments could not be saved. The printer list was refreshed so you can retry safely.',
    )
    expect(componentMocks.toastSuccess).not.toHaveBeenCalled()
    expect(view.container).not.toHaveTextContent(/private optional role/i)
    expect(JSON.stringify(componentMocks.toastError.mock.calls)).not.toMatch(/private optional role/i)
  })

  it('also refreshes safely when an optional assignment rejects after the receipt is saved', async () => {
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'throwing-save-transport'))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'throwing-save-encoding'))
    componentMocks.add
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('private optional exception stack'))
    const onSaved = vi.fn()
    const props = wizardProps({ onSaved })
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    await completeCoreVerification(view, props, 'throwing-save-transport', 'throwing-save-encoding')
    await openSaveStep()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kitchen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(componentMocks.toastError).toHaveBeenCalledWith(
      'Some printer assignments could not be saved. The printer list was refreshed so you can retry safely.',
    )
    expect(componentMocks.toastSuccess).not.toHaveBeenCalled()
    expect(view.container).not.toHaveTextContent(/private optional exception/i)
    expect(JSON.stringify(componentMocks.toastError.mock.calls)).not.toMatch(/private optional exception/i)
  })

  it('serializes same-tick Save clicks into one mutation sequence', async () => {
    componentMocks.testDraft
      .mockResolvedValueOnce(enqueueResponse('transport_text', 'save-mutex-transport'))
      .mockResolvedValueOnce(enqueueResponse('encoding', 'save-mutex-encoding'))
    const onBusyChange = vi.fn()
    const props = wizardProps({ onBusyChange })
    const view = render(<PrinterSetupWizard {...props} />)
    await enterVerificationStep()
    await completeCoreVerification(view, props, 'save-mutex-transport', 'save-mutex-encoding')
    await openSaveStep()

    let resolve!: (value: unknown) => void
    const pending = new Promise((done) => { resolve = done })
    componentMocks.add.mockReturnValue(pending)
    const save = screen.getByRole('button', { name: 'Save' })
    const detectStep = screen.getByRole('button', { name: 'detect' })
    act(() => {
      save.click()
      detectStep.click()
      save.click()
    })
    expect(componentMocks.add).toHaveBeenCalledTimes(1)
    expect(onBusyChange).toHaveBeenCalledWith(true)
    expect(screen.getByRole('heading', { name: 'Step 4: Save & Assign' })).toBeVisible()
    expect(detectStep).toBeDisabled()

    await act(async () => {
      resolve({ success: true })
      await pending
    })
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })
})
