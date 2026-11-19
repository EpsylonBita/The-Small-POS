import type {
  PrivilegedActionErrorPayload,
  PrivilegedActionScope,
} from '../../lib/ipc-contracts'

export interface ApprovalErrorPayload extends PrivilegedActionErrorPayload {
  permission?: string
  minutes?: number
}

const KNOWN_PRIVILEGED_ERROR_CODES = new Set([
  'UNAUTHORIZED', 'REAUTH_REQUIRED', 'NO_APPROVER_IN_STORE', 'APPROVALS_PAUSED',
  'AUTH_LOCKED_OUT', 'MANAGER_PIN_REFUSED',
  'AUTH_SESSION_REQUIRED', 'AUTH_SESSION_EXPIRED', 'AUTH_SHIFT_REQUIRED',
  'AUTH_PIN_WRONG', 'AUTH_CONFIRMATION_CANCELLED', 'AUTH_GRANT_EXPIRED', 'AUTH_PERMISSION_REQUIRED',
])

const normalizeCode = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toUpperCase()
  return KNOWN_PRIVILEGED_ERROR_CODES.has(normalized) ? normalized : null
}

const normalizePayload = (
  value: Record<string, unknown>,
  fallbackScope?: PrivilegedActionScope
): ApprovalErrorPayload | null => {
  const code = normalizeCode(value.code)
  if (!code) {
    return null
  }

  const scope =
    typeof value.scope === 'string' && value.scope.trim()
      ? value.scope.trim()
      : fallbackScope

  const reason =
    typeof value.reason === 'string' && value.reason.trim()
      ? value.reason.trim()
      : typeof value.message === 'string' && value.message.trim()
        ? value.message.trim()
        : undefined

  const ttlSeconds =
    typeof value.ttlSeconds === 'number'
      ? value.ttlSeconds
      : typeof value.ttl_seconds === 'number'
        ? value.ttl_seconds
        : null

  // A manager's own PIN can give this approval (nobody on shift here).
  const approval =
    value.approval === 'void_payments' || value.approval === 'void_orders'
      ? value.approval
      : null

  return {
    code,
    scope,
    reason,
    ttlSeconds,
    ...(approval ? { approval } : {}),
    ...(typeof value.permission === 'string' ? { permission: value.permission } : {}),
    ...(typeof value.minutes === 'number' && Number.isFinite(value.minutes) && value.minutes > 0
      ? { minutes: Math.ceil(value.minutes) } : {}),
  }
}

const parseFromText = (
  text: string,
  fallbackScope?: PrivilegedActionScope
): ApprovalErrorPayload | null => {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  if (/^fresh pin confirmation required$/i.test(trimmed)) {
    return {
      code: 'REAUTH_REQUIRED',
      scope: fallbackScope,
      reason: 'Fresh PIN confirmation required',
      ttlSeconds: null,
    }
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizePayload(parsed as Record<string, unknown>, fallbackScope)
    }
  } catch {
    // Ignore invalid JSON and fall back to pattern parsing.
  }

  const match = trimmed.match(/^([A-Z_]+)\b[:\s-]*(.*)$/i)
  const code = normalizeCode(match?.[1])
  if (!match || !code) {
    return null
  }

  return {
    code,
    scope: fallbackScope,
    reason: match[2]?.trim() || undefined,
    ttlSeconds: null,
  }
}

export const extractPrivilegedActionError = (
  error: unknown,
  fallbackScope?: PrivilegedActionScope
): ApprovalErrorPayload | null => {
  if (!error) {
    return null
  }

  if (typeof error === 'string') {
    return parseFromText(error, fallbackScope)
  }

  if (error instanceof Error) {
    const direct = parseFromText(error.message, fallbackScope)
    if (direct) {
      return direct
    }

    const nested = error as Error & {
      cause?: unknown
      error?: unknown
      data?: unknown
      payload?: unknown
      details?: unknown
    }

    return (
      extractPrivilegedActionError(nested.cause, fallbackScope) ||
      extractPrivilegedActionError(nested.error, fallbackScope) ||
      extractPrivilegedActionError(nested.data, fallbackScope) ||
      extractPrivilegedActionError(nested.payload, fallbackScope) ||
      extractPrivilegedActionError(nested.details, fallbackScope)
    )
  }

  if (typeof error === 'object' && !Array.isArray(error)) {
    const normalized = normalizePayload(error as Record<string, unknown>, fallbackScope)
    if (normalized) {
      return normalized
    }

    const nested = error as Record<string, unknown>
    return (
      extractPrivilegedActionError(nested.error, fallbackScope) ||
      extractPrivilegedActionError(nested.cause, fallbackScope) ||
      extractPrivilegedActionError(nested.data, fallbackScope) ||
      extractPrivilegedActionError(nested.payload, fallbackScope) ||
      extractPrivilegedActionError(nested.details, fallbackScope) ||
      (typeof nested.message === 'string'
        ? parseFromText(nested.message, fallbackScope)
        : null)
    )
  }

  return null
}

export function isPrivilegedShiftRequired(error: unknown): boolean {
  const payload = extractPrivilegedActionError(error)
  return payload?.code === 'AUTH_SHIFT_REQUIRED' ||
    (payload?.code === 'UNAUTHORIZED' && /shift/i.test(payload.reason ?? '')) ||
    /cashier or manager shift required/i.test(error instanceof Error ? error.message : String(error))
}

export function isPrivilegedConfirmationCancelled(error: unknown): boolean {
  return extractPrivilegedActionError(error)?.code === 'AUTH_CONFIRMATION_CANCELLED' ||
    (error instanceof Error && error.message === 'Privileged action confirmation cancelled')
}

type Translate = (key: string, options?: Record<string, unknown>) => unknown

export function privilegedActionFeedbackKey(error: unknown): string | undefined {
  const payload = extractPrivilegedActionError(error)
  if (isPrivilegedShiftRequired(error)) return 'orderSyncNotice.shiftRequired'
  switch (payload?.code) {
    case 'UNAUTHORIZED':
      if (payload.reason === 'Active session required') return 'orderSyncNotice.signInAgain'
      break
    case 'AUTH_SESSION_REQUIRED': return 'orderSyncNotice.signInAgain'
    case 'AUTH_SESSION_EXPIRED': return 'orderSyncNotice.sessionExpired'
    case 'AUTH_PIN_WRONG': return 'login.errors.invalidPin'
    case 'AUTH_LOCKED_OUT': return 'orderSyncNotice.pinLocked'
  }
}

export function privilegedActionFeedback(error: unknown, t: Translate): string | undefined {
  const key = privilegedActionFeedbackKey(error)
  return key ? String(t(key)) : undefined
}

export const getErrorMessage = (error: unknown, fallback: string, t?: Translate): string => {
  const feedback = t && privilegedActionFeedback(error, t)
  if (feedback) return feedback

  const privilegedError = extractPrivilegedActionError(error)
  if (privilegedError?.reason) {
    return privilegedError.reason
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }

  return fallback
}
