/**
 * Repair operation identifiers are replay/idempotency keys, so the UI must
 * fail closed when the platform CSPRNG is unavailable.
 */
export function createSecureRepairId(): string | null {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : null
}

export function canCreateSecureRepairId(): boolean {
  return typeof globalThis.crypto?.randomUUID === 'function'
}
