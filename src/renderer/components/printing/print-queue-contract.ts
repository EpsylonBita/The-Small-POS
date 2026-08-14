export const PRINT_TRANSPORT_STATES = [
  'created',
  'submitting',
  'windows_queued',
  'windows_printing',
  'paused',
  'sent',
  'spool_completed',
  'cancel_requested',
  'cancelled',
  'transport_error',
  'spool_error',
  'cancel_failed',
  'unknown',
] as const

export type PrintTransportState = (typeof PRINT_TRANSPORT_STATES)[number]

export const PRINT_QUEUE_JOB_STATUSES = [
  'pending',
  'printing',
  'printed',
  'dispatched',
  'failed',
  'cancelled',
] as const

export type PrintQueueJobStatus = (typeof PRINT_QUEUE_JOB_STATUSES)[number]
export type PrintQueueCancellableStatus = Extract<
  PrintQueueJobStatus,
  'pending' | 'printing' | 'dispatched'
>
export type PrintResolvedTransport = 'windows' | 'raw_tcp' | 'serial'

export interface PrintQueueJob {
  id: string
  source: 'pos'
  entityType: string
  entityId: string
  printerProfileId: string | null
  printerDisplayName: string
  resolvedTransport: PrintResolvedTransport | null
  resolvedTarget: string | null
  status: PrintQueueJobStatus
  transportState: PrintTransportState | null
  spoolJobId: number | null
  snapshotAvailable: boolean
  reprintOfJobId: string | null
  cancellable: boolean
  retryable: boolean
  reprintable: boolean
  lastError: string | null
  warningCode: string | null
  warningMessage: string | null
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

/** Counts cover the whole POS queue and intentionally may overlap. */
export interface PrintQueueCounts {
  active: number
  failed: number
  stale: number
  history: number
}

/** Pagination describes the server-filtered query before any client jobIds filter. */
export interface PrintQueuePagination {
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export interface PrintQueueSnapshot {
  success: true
  jobs: PrintQueueJob[]
  queuePaused: boolean
  pausedPrinterProfileIds: string[]
  counts: PrintQueueCounts
  pagination: PrintQueuePagination
}

export interface PrintQueueListOptions {
  status?: PrintQueueJobStatus
  printerProfileId?: string
  limit?: number
  offset?: number
}

export interface PrintQueueControlOptions {
  printerProfileId?: string
}

export interface PrintQueueCancelAllOptions extends PrintQueueControlOptions {
  statuses?: PrintQueueCancellableStatus[]
}

interface PrintQueueNativeControlEvidence {
  activeStopsRequested: number
  nativeControlsRequested: number
  nativeControlsConfirmed: number
  nativeControlsFailed: number
  ownershipRefused: number
}

export interface PrintQueueCancelJobResult extends PrintQueueNativeControlEvidence {
  success: boolean
  affected: number
  unchanged: number
  localCancelled: number
  error?: string
}

export interface PrintQueueCancelAllResult extends PrintQueueNativeControlEvidence {
  success: boolean
  affected: number
  unchanged: number
  localCancelled: number
  printerProfileId: string | null
  error?: string
}

export interface PrintQueuePauseResult extends PrintQueueNativeControlEvidence {
  success: boolean
  queuePaused: boolean
  pausedPrinterProfileIds: string[]
  printerProfileId: string | null
  error?: string
}

export interface PrintQueueResumeResult extends PrintQueueNativeControlEvidence {
  success: boolean
  queuePaused: boolean
  pausedPrinterProfileIds: string[]
  printerProfileId: string | null
  error?: string
}

export interface PrintQueueRetryResult {
  success: true
  jobId: string
  newJobId: null
  affected: number
  unchanged: boolean
  duplicate: boolean
}

export interface PrintQueueReprintResult {
  success: true
  jobId: string
  newJobId: string | null
  affected: number
  unchanged: boolean
  duplicate: boolean
}

export interface PrintQueueReprintRequest {
  jobId: string
}

type UnknownRecord = Record<string, unknown>

const TRANSPORT_STATE_SET = new Set<string>(PRINT_TRANSPORT_STATES)
const JOB_STATUS_SET = new Set<string>(PRINT_QUEUE_JOB_STATUSES)
const RESOLVED_TRANSPORT_SET = new Set<string>(['windows', 'raw_tcp', 'serial'])

function malformed(path: string, expectation: string): never {
  throw new Error(`Invalid print queue snapshot at ${path}: ${expectation}`)
}

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return malformed(path, 'expected an object')
  }
  return value as UnknownRecord
}

function boundedString(
  value: unknown,
  path: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Array.from(value).length > maxLength
  ) {
    return malformed(path, `expected a non-empty string of at most ${maxLength} characters`)
  }
  return value
}

function nullableBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  if (value === null) return null
  return boundedString(value, path, maxLength)
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return malformed(path, 'expected a boolean')
  return value
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return malformed(path, 'expected a non-negative safe integer')
  }
  return value as number
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = nonNegativeInteger(value, path)
  if (parsed === 0) return malformed(path, 'expected a positive safe integer')
  return parsed
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    return malformed(path, 'contains an unsupported value')
  }
  return value as T
}

function nullableEnumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): T | null {
  if (value === null) return null
  return enumValue<T>(value, allowed, path)
}

function displayName(
  wire: UnknownRecord,
  resolvedTarget: string | null,
  path: string,
): string {
  const candidates: Array<[unknown, string, number]> = [
    [wire.printerDisplayName, `${path}.printerDisplayName`, 160],
    [wire.printerProfileName, `${path}.printerProfileName`, 160],
    [resolvedTarget, `${path}.resolvedTarget`, 256],
  ]
  for (const [candidate, candidatePath, maxLength] of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue
    return boundedString(candidate, candidatePath, maxLength)
  }
  return 'Printer'
}

function normalizeJob(value: unknown, index: number): PrintQueueJob {
  const path = `jobs[${index}]`
  const wire = record(value, path)
  const capabilities = record(wire.capabilities, `${path}.capabilities`)
  const resolvedTarget = nullableBoundedString(
    wire.resolvedTarget,
    `${path}.resolvedTarget`,
    256,
  )
  const windowsJobId = wire.windowsJobId
  const spoolJobId = windowsJobId === null
    ? null
    : positiveInteger(windowsJobId, `${path}.windowsJobId`)

  return {
    id: boundedString(wire.id, `${path}.id`, 256),
    source: enumValue<'pos'>(wire.source, new Set(['pos']), `${path}.source`),
    entityType: boundedString(wire.entityType, `${path}.entityType`, 128),
    entityId: boundedString(wire.entityId, `${path}.entityId`, 256),
    printerProfileId: nullableBoundedString(
      wire.printerProfileId,
      `${path}.printerProfileId`,
      256,
    ),
    printerDisplayName: displayName(wire, resolvedTarget, path),
    resolvedTransport: nullableEnumValue<PrintResolvedTransport>(
      wire.resolvedTransport,
      RESOLVED_TRANSPORT_SET,
      `${path}.resolvedTransport`,
    ),
    resolvedTarget,
    status: enumValue<PrintQueueJobStatus>(
      wire.status,
      JOB_STATUS_SET,
      `${path}.status`,
    ),
    transportState: nullableEnumValue<PrintTransportState>(
      wire.transportState,
      TRANSPORT_STATE_SET,
      `${path}.transportState`,
    ),
    spoolJobId,
    snapshotAvailable: boolean(
      wire.snapshotAvailable,
      `${path}.snapshotAvailable`,
    ),
    reprintOfJobId: nullableBoundedString(
      wire.reprintOfJobId,
      `${path}.reprintOfJobId`,
      256,
    ),
    cancellable: boolean(capabilities.cancellable, `${path}.capabilities.cancellable`),
    retryable: boolean(capabilities.retryable, `${path}.capabilities.retryable`),
    reprintable: boolean(capabilities.reprintable, `${path}.capabilities.reprintable`),
    lastError: nullableBoundedString(wire.lastError, `${path}.lastError`, 1024),
    warningCode: nullableBoundedString(
      wire.warningCode,
      `${path}.warningCode`,
      128,
    ),
    warningMessage: nullableBoundedString(
      wire.warningMessage,
      `${path}.warningMessage`,
      512,
    ),
    lastSeenAt: nullableBoundedString(
      wire.lastSeenAt,
      `${path}.lastSeenAt`,
      64,
    ),
    createdAt: boundedString(wire.createdAt, `${path}.createdAt`, 64),
    updatedAt: boundedString(wire.updatedAt, `${path}.updatedAt`, 64),
  }
}

/**
 * Treat the native response as untrusted wire data. The returned object is a
 * field-by-field renderer allowlist; attempt ownership and frozen-envelope
 * internals never cross this boundary.
 */
export function normalizePrintQueueSnapshot(value: unknown): PrintQueueSnapshot {
  const wire = record(value, 'root')
  if (wire.success !== true) {
    return malformed('success', 'expected true')
  }
  if (!Array.isArray(wire.jobs)) {
    return malformed('jobs', 'expected an array')
  }
  if (!Array.isArray(wire.pausedPrinterProfileIds)) {
    return malformed('pausedPrinterProfileIds', 'expected an array')
  }
  const pausedPrinterProfileIds = wire.pausedPrinterProfileIds.map((profileId, index) =>
    boundedString(profileId, `pausedPrinterProfileIds[${index}]`, 256),
  )
  const counts = record(wire.counts, 'counts')
  const pagination = record(wire.pagination, 'pagination')
  const limit = positiveInteger(pagination.limit, 'pagination.limit')
  if (limit > 100) return malformed('pagination.limit', 'expected a value no greater than 100')

  return {
    success: true,
    jobs: wire.jobs.map(normalizeJob),
    queuePaused: boolean(wire.queuePaused, 'queuePaused'),
    pausedPrinterProfileIds,
    counts: {
      active: nonNegativeInteger(counts.active, 'counts.active'),
      failed: nonNegativeInteger(counts.failed, 'counts.failed'),
      stale: nonNegativeInteger(counts.stale, 'counts.stale'),
      history: nonNegativeInteger(counts.history, 'counts.history'),
    },
    pagination: {
      offset: nonNegativeInteger(pagination.offset, 'pagination.offset'),
      limit,
      total: nonNegativeInteger(pagination.total, 'pagination.total'),
      hasMore: boolean(pagination.hasMore, 'pagination.hasMore'),
    },
  }
}
