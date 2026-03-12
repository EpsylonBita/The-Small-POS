import type {
  PrivilegedActionErrorPayload,
  PrivilegedActionScope,
} from '../../lib/ipc-contracts'

const KNOWN_PRIVILEGED_ERROR_CODES = new Set(['UNAUTHORIZED', 'REAUTH_REQUIRED'])

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
): PrivilegedActionErrorPayload | null => {
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

  return {
    code,
    scope,
    reason,
    ttlSeconds,
  }
}

const parseFromText = (
  text: string,
  fallbackScope?: PrivilegedActionScope
): PrivilegedActionErrorPayload | null => {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizePayload(parsed as Record<string, unknown>, fallbackScope)
    }
  } catch {
    // Ignore invalid JSON and fall back to pattern parsing.
  }

  const match = trimmed.match(/\b(REAUTH_REQUIRED|UNAUTHORIZED)\b[:\s-]*(.*)$/i)
  if (!match) {
    return null
  }

  return {
    code: match[1].toUpperCase(),
    scope: fallbackScope,
    reason: match[2]?.trim() || undefined,
    ttlSeconds: null,
  }
}

export const extractPrivilegedActionError = (
  error: unknown,
  fallbackScope?: PrivilegedActionScope
): PrivilegedActionErrorPayload | null => {
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

export const getErrorMessage = (error: unknown, fallback: string): string => {
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
