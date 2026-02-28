import { posApiGet } from '../utils/api-helpers'

export interface FiscalReceiptStatus {
  status: string
  aade_mark?: string | null
  aade_uid?: string | null
  qr_url?: string | null
  error?: string | null
  error_code?: string | null
  updated_at?: string | null
}

interface PollFiscalOptions {
  timeoutMs?: number
  intervalMs?: number
  maxConsecutiveFailures?: number
}

const TERMINAL_STATUSES = new Set(['AADE_ACCEPTED', 'CANCELLED', 'NEEDS_FIX', 'REJECTED'])

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function pollFiscalReceiptStatus(
  receiptId: string,
  options: PollFiscalOptions = {}
): Promise<FiscalReceiptStatus | null> {
  if (!receiptId) {
    return null
  }

  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 2500
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3

  const deadline = Date.now() + timeoutMs
  let lastKnownStatus: FiscalReceiptStatus | null = null
  let consecutiveFailures = 0

  while (Date.now() < deadline) {
    const result = await posApiGet<FiscalReceiptStatus>(
      `pos/fiscal/receipt/${encodeURIComponent(receiptId)}`
    )

    if (result.success && result.data) {
      lastKnownStatus = result.data
      consecutiveFailures = 0

      if (TERMINAL_STATUSES.has(result.data.status)) {
        return result.data
      }
    } else {
      consecutiveFailures += 1

      if (result.status === 401 || result.status === 403 || result.status === 404) {
        return lastKnownStatus
      }

      if (consecutiveFailures >= maxConsecutiveFailures) {
        return lastKnownStatus
      }
    }

    await delay(intervalMs)
  }

  return lastKnownStatus
}
