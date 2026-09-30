import type { Customer } from '../../shared/types/customer';

/**
 * Outcome of a customer create or update, as the native command reports it.
 * The address commands (add/update/delete address) answer with the same
 * envelope, so the form reads their refusals through this normaliser too.
 * Kept in its own module so a component can read a result without the
 * CustomerService singleton (tests mock that module).
 *
 * Incident 2026-09-28 (Tomikro, desktop 1.4.118): the office refused an
 * 11-digit phone with 400 INVALID_PHONE, the terminal saved the customer
 * "offline" anyway and queued a row that could never sync, and the Z report
 * was blocked. The native command now answers a coded application rejection
 * with `{success:false, code, status}` and queues nothing, so the form must
 * see that answer: `success:false` is returned as such, never unwrapped into
 * something that looks like a customer.
 *
 * - `success:true` with `data`: saved at the office, or `queued`/`offline`
 *   when the office could not be reached (saved on this register, synced
 *   later).
 * - `success:false`: nothing was saved or queued. `code` is the office's
 *   bounded machine code (INVALID_PHONE, COUNTRY_CONTEXT_REQUIRED,
 *   INVALID_COORDINATES, DUPLICATE, VERSION_MISMATCH, NOT_FOUND,
 *   MISSING_PHONE_OR_NAME, HTTP_400, ...) with its HTTP `status`, this
 *   register's own refusal (VERSION_REQUIRED, CUSTOMER_SYNC_IN_PROGRESS,
 *   CUSTOMER_NOT_SYNCED) with `status` null, or null when none was given;
 *   `conflict` marks a version conflict. `error` is never display text.
 */
export interface CustomerWriteResult<T = Customer> {
  success: boolean;
  data?: T;
  code: string | null;
  status: number | null;
  conflict: boolean;
  queued: boolean;
  offline: boolean;
  error?: string;
}

const CUSTOMER_WRITE_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;

const readCustomerWriteCode = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const code = value.trim().toUpperCase();
  return CUSTOMER_WRITE_CODE_PATTERN.test(code) ? code : null;
};

/** Normalise the native envelope (current and older shapes) into a CustomerWriteResult. */
export function normalizeCustomerWriteResult<T = Customer>(raw: unknown): CustomerWriteResult<T> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      success: false,
      code: null,
      status: null,
      conflict: false,
      queued: false,
      offline: false,
      error: 'EMPTY_RESPONSE',
    };
  }

  const envelope = raw as Record<string, unknown>;
  const status = typeof envelope.status === 'number' && Number.isFinite(envelope.status)
    ? envelope.status
    : null;
  const conflict = envelope.conflict === true;

  if (envelope.success === false) {
    // A local version conflict from older native code carries no code.
    const code = readCustomerWriteCode(envelope.code)
      ?? readCustomerWriteCode(envelope.errorCode)
      ?? (conflict ? 'VERSION_MISMATCH' : null);
    return {
      success: false,
      code,
      status,
      conflict: conflict || code === 'VERSION_MISMATCH',
      queued: false,
      offline: false,
      error: code ?? 'CUSTOMER_WRITE_REJECTED',
    };
  }

  const data = (envelope.data ?? envelope.customer ?? undefined) as T | undefined;
  return {
    success: true,
    data: data && typeof data === 'object' ? data : undefined,
    code: null,
    status,
    conflict: false,
    queued: envelope.queued === true,
    offline: envelope.offline === true,
  };
}
