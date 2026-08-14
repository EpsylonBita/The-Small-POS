export type SamplePhase =
  | 'idle'
  | 'queued'
  | 'printing'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'rejected'
  | 'failed'
  | 'cancelled'

export type VerificationSample = 'transport' | 'encoding' | 'branding'
export type WizardSampleKind = 'transport_text' | 'encoding' | 'branding'

export interface ConnectionDetails {
  type: string
  ip?: string
  hostname?: string
  port?: number
  address?: string
  channel?: number
  path?: string
  systemName?: string
  serialPort?: string
  baudRate?: number
  render_mode?: string
  renderMode?: string
  emulation?: string
  printable_width_dots?: number
  left_margin_dots?: number
  threshold?: number
  escposCodePage?: number
  cutPaper?: boolean
  [key: string]: unknown
}

export interface CandidateCapabilities {
  status?: string
  supportsCut?: boolean
  supportsLogo?: boolean
  [key: string]: unknown
}

export interface SampleState {
  phase: SamplePhase
  jobId: string | null
  attemptCount: number
  duplicate: boolean
  candidateConnectionDetails: ConnectionDetails | null
  candidateCapabilities: CandidateCapabilities | null
  logoConfigured: boolean
  logoIncluded: boolean
}

export interface VerificationState {
  transport: SampleState
  encoding: SampleState
  branding: SampleState
  activeJobId: string | null
  confirmedConnectionDetails: ConnectionDetails | null
  continueWithoutLogo: boolean
}

export type ObservedJobStatus =
  | 'pending'
  | 'printing'
  | 'printed'
  | 'dispatched'
  | 'failed'
  | 'cancelled'

export type VerificationAction =
  | {
      type: 'sample_queued'
      sample: VerificationSample
      jobId: string
      duplicate: boolean
      candidateConnectionDetails: ConnectionDetails
      candidateCapabilities: CandidateCapabilities
      logoConfigured: boolean
      logoIncluded: boolean
    }
  | {
      type: 'job_observed'
      jobId: string
      status: ObservedJobStatus
      transportState?: string | null
    }
  | {
      type: 'paper_confirmed'
      sample: VerificationSample
      worked: boolean
    }
  | {
      type: 'continue_without_logo'
      value: boolean
    }
  | { type: 'reset' }

export interface WizardEnqueueEvidence {
  jobId: string
  duplicate: boolean
  sampleKind: WizardSampleKind
  candidateConnectionDetails: ConnectionDetails
  candidateCapabilities: CandidateCapabilities
  logoConfigured: boolean
  logoIncluded: boolean
}

export type WizardEnqueueParseResult =
  | { ok: true; value: WizardEnqueueEvidence }
  | {
      ok: false
      errorCode:
        | 'enqueue_rejected'
        | 'invalid_enqueue_response'
        | 'sample_kind_mismatch'
    }

const SAMPLE_KIND_BY_STAGE: Record<VerificationSample, WizardSampleKind> = {
  transport: 'transport_text',
  encoding: 'encoding',
  branding: 'branding',
}

const KNOWN_QUEUE_STATES = new Set<ObservedJobStatus>([
  'pending',
  'printing',
  'printed',
  'dispatched',
  'failed',
  'cancelled',
])

const emptySample = (): SampleState => ({
  phase: 'idle',
  jobId: null,
  attemptCount: 0,
  duplicate: false,
  candidateConnectionDetails: null,
  candidateCapabilities: null,
  logoConfigured: false,
  logoIncluded: false,
})

export const createVerificationState = (): VerificationState => ({
  transport: emptySample(),
  encoding: emptySample(),
  branding: emptySample(),
  activeJobId: null,
  confirmedConnectionDetails: null,
  continueWithoutLogo: false,
})

export const canStartWizardSample = (
  state: VerificationState,
  sample: VerificationSample,
  logoConfigured: boolean,
): boolean => {
  if (state.activeJobId) return false
  if (sample === 'transport') return true
  if (state.transport.phase !== 'confirmed') return false
  if (sample === 'encoding') return true
  return state.encoding.phase === 'confirmed' && logoConfigured
}

export const canSaveVerifiedPrinter = (
  state: VerificationState,
  logoConfigured: boolean,
): boolean => !state.activeJobId
  && state.transport.phase === 'confirmed'
  && state.encoding.phase === 'confirmed'
  && (
    !logoConfigured
    || state.branding.phase === 'confirmed'
    || state.continueWithoutLogo
  )

const sampleForJob = (
  state: VerificationState,
  jobId: string,
): VerificationSample | null => {
  if (state.transport.jobId === jobId) return 'transport'
  if (state.encoding.jobId === jobId) return 'encoding'
  if (state.branding.jobId === jobId) return 'branding'
  return null
}

const phaseForObservedJob = (
  status: ObservedJobStatus,
  transportState: string | null | undefined,
): SamplePhase => {
  if (status === 'pending') return 'queued'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'printed') return 'awaiting_confirmation'
  if (
    status === 'dispatched'
    && (transportState === 'sent' || transportState === 'spool_completed')
  ) {
    return 'awaiting_confirmation'
  }
  return 'printing'
}

const sanitizeLogoCapabilityEvidence = (
  details: ConnectionDetails,
  logoIncluded: boolean,
): ConnectionDetails => {
  const nestedCapabilities = details.capabilities
  if (
    logoIncluded
    || !nestedCapabilities
    || typeof nestedCapabilities !== 'object'
    || Array.isArray(nestedCapabilities)
  ) {
    return details
  }
  return {
    ...details,
    capabilities: {
      ...(nestedCapabilities as Record<string, unknown>),
      supportsLogo: false,
    },
  }
}

export const verificationReducer = (
  state: VerificationState,
  action: VerificationAction,
): VerificationState => {
  if (action.type === 'reset') return createVerificationState()
  if (action.type === 'continue_without_logo') {
    return { ...state, continueWithoutLogo: action.value }
  }
  if (action.type === 'sample_queued') {
    if (state.activeJobId && state.activeJobId !== action.jobId) return state
    const invalidatedState: VerificationState = action.sample === 'transport'
      ? {
          ...state,
          encoding: emptySample(),
          branding: emptySample(),
          confirmedConnectionDetails: null,
          continueWithoutLogo: false,
        }
      : action.sample === 'encoding'
        ? {
            ...state,
            branding: emptySample(),
            confirmedConnectionDetails: state.transport.phase === 'confirmed'
              ? state.transport.candidateConnectionDetails
              : null,
            continueWithoutLogo: false,
          }
        : {
            ...state,
            confirmedConnectionDetails: state.encoding.phase === 'confirmed'
              ? state.encoding.candidateConnectionDetails
              : state.transport.phase === 'confirmed'
                ? state.transport.candidateConnectionDetails
                : null,
            continueWithoutLogo: false,
          }
    const candidateConnectionDetails = sanitizeLogoCapabilityEvidence(
      action.candidateConnectionDetails,
      action.logoIncluded,
    )
    return {
      ...invalidatedState,
      [action.sample]: {
        phase: 'queued',
        jobId: action.jobId,
        attemptCount: state[action.sample].attemptCount + 1,
        duplicate: action.duplicate,
        candidateConnectionDetails,
        candidateCapabilities: {
          ...action.candidateCapabilities,
          supportsLogo: action.logoIncluded === true
            ? action.candidateCapabilities.supportsLogo
            : false,
        },
        logoConfigured: action.logoConfigured,
        logoIncluded: action.logoIncluded,
      },
      activeJobId: action.jobId,
    }
  }
  if (action.type === 'job_observed') {
    const sample = sampleForJob(state, action.jobId)
    if (!sample) return state
    if (state[sample].phase === 'confirmed' || state[sample].phase === 'rejected') {
      return state
    }
    const phase = phaseForObservedJob(action.status, action.transportState)
    return {
      ...state,
      [sample]: { ...state[sample], phase },
      activeJobId: phase === 'failed' || phase === 'cancelled'
        ? null
        : action.jobId,
    }
  }

  const current = state[action.sample]
  if (current.phase !== 'awaiting_confirmation') return state
  const honestPositiveBranding = action.sample !== 'branding' || current.logoIncluded
  const confirmed = action.worked && honestPositiveBranding
  let next: VerificationState = {
    ...state,
    [action.sample]: {
      ...current,
      phase: confirmed ? 'confirmed' : 'rejected',
      candidateCapabilities: action.sample === 'branding' && !honestPositiveBranding
        ? { ...current.candidateCapabilities, supportsLogo: false }
        : current.candidateCapabilities,
    },
    activeJobId: current.jobId === state.activeJobId ? null : state.activeJobId,
    confirmedConnectionDetails: confirmed
      ? current.candidateConnectionDetails
      : state.confirmedConnectionDetails,
  }

  if (action.sample === 'transport') {
    next = {
      ...next,
      confirmedConnectionDetails: confirmed
        ? current.candidateConnectionDetails
        : null,
      ...(confirmed ? {} : { encoding: emptySample(), branding: emptySample() }),
      continueWithoutLogo: confirmed ? next.continueWithoutLogo : false,
    }
  } else if (action.sample === 'encoding' && !confirmed) {
    next = {
      ...next,
      branding: emptySample(),
      continueWithoutLogo: false,
    }
  }
  return next
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const parseWizardEnqueueResponse = (
  sample: VerificationSample,
  response: unknown,
): WizardEnqueueParseResult => {
  if (!isRecord(response) || response.success !== true || response.queued !== true) {
    return { ok: false, errorCode: 'enqueue_rejected' }
  }
  if (response.sampleKind !== SAMPLE_KIND_BY_STAGE[sample]) {
    return { ok: false, errorCode: 'sample_kind_mismatch' }
  }
  if (
    typeof response.jobId !== 'string'
    || !response.jobId.trim()
    || response.jobId.length > 256
    || typeof response.queueState !== 'string'
    || !KNOWN_QUEUE_STATES.has(response.queueState as ObservedJobStatus)
    || typeof response.duplicate !== 'boolean'
    || !isRecord(response.candidateConnectionDetails)
    || typeof response.candidateConnectionDetails.type !== 'string'
    || !response.candidateConnectionDetails.type.trim()
    || !isRecord(response.candidateCapabilities)
    || typeof response.logoConfigured !== 'boolean'
    || typeof response.logoIncluded !== 'boolean'
  ) {
    return { ok: false, errorCode: 'invalid_enqueue_response' }
  }
  return {
    ok: true,
    value: {
      jobId: response.jobId,
      duplicate: response.duplicate,
      sampleKind: response.sampleKind as WizardSampleKind,
      candidateConnectionDetails: response.candidateConnectionDetails as ConnectionDetails,
      candidateCapabilities: response.candidateCapabilities,
      logoConfigured: response.logoConfigured,
      logoIncluded: response.logoIncluded,
    },
  }
}
