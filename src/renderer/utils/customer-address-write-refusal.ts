import type { useTranslation } from 'react-i18next';
import {
  normalizeCustomerWriteResult,
  type CustomerWriteResult,
} from '../services/customer-write-result';

type TranslateFn = ReturnType<typeof useTranslation>['t'];

/**
 * The native address commands (customer_add_address, customer_update_address,
 * customer_delete_address) answer a refusal with `{success:false, code,
 * status, conflict?}` and save or queue nothing: INVALID_COORDINATES,
 * NOT_FOUND, VERSION_MISMATCH (conflict), HTTP_4xx from the office (with its
 * HTTP status), or this register's own CUSTOMER_NOT_SYNCED /
 * CUSTOMER_SYNC_IN_PROGRESS (status null). `error` is that same machine code,
 * never display text, so a caller must not show it.
 *
 * A write the office could not be reached for is saved on this register and
 * queued: `success:true`, `queued:true` and `warning:
 * CUSTOMER_ADDRESS_SAVED_OFFLINE`.
 *
 * The wording is AddCustomerModal's (`modals.addCustomer.*`), so every
 * address surface names a refusal the same way.
 */
export const CUSTOMER_ADDRESS_SAVED_OFFLINE = 'CUSTOMER_ADDRESS_SAVED_OFFLINE';

/**
 * Which address write was refused. The office answers 404 on an ADD only when
 * the customer is gone (the address does not exist yet); on an update or a
 * delete the address (or its customer) is gone.
 */
export type CustomerAddressWriteKind = 'add' | 'update' | 'delete';

/**
 * Normalise a native address-write answer. A queued write (office
 * unreachable) is a success saved on this register only.
 */
export function readCustomerAddressWrite<T = unknown>(raw: unknown): CustomerWriteResult<T> {
  const result = normalizeCustomerWriteResult<T>(raw);
  if (!result.success) {
    return result;
  }
  const warning = raw && typeof raw === 'object' ? (raw as { warning?: unknown }).warning : undefined;
  return warning === CUSTOMER_ADDRESS_SAVED_OFFLINE
    ? { ...result, queued: true, offline: true }
    : result;
}

/**
 * The operator's text for a refused address write. Never the raw code alone:
 * a code with no dedicated message is named inside a sentence that says who
 * refused it (the office when an HTTP status came back, else this register).
 */
export function describeCustomerAddressWriteRefusal(
  t: TranslateFn,
  refusal: Pick<CustomerWriteResult<unknown>, 'code' | 'status' | 'conflict'>,
  kind: CustomerAddressWriteKind,
  fallbackKey: string,
): string {
  const code = typeof refusal.code === 'string' && refusal.code ? refusal.code : null;
  if (refusal.conflict || code === 'VERSION_MISMATCH') {
    return t('modals.addCustomer.conflictError');
  }
  switch (code) {
    case 'INVALID_COORDINATES':
      return t('modals.addCustomer.addressLocationRejected');
    case 'NOT_FOUND':
      return t(kind === 'add' ? 'modals.addCustomer.customerNotFound' : 'modals.addCustomer.addressNotFound');
    case 'VERSION_REQUIRED':
      return t('modals.addCustomer.versionRequired');
    case 'CUSTOMER_SYNC_IN_PROGRESS':
      return t('modals.addCustomer.customerSyncInProgress');
    case 'CUSTOMER_NOT_SYNCED':
      return t('modals.addCustomer.customerNotSynced');
    default:
      break;
  }
  if (!code) {
    return t(fallbackKey);
  }
  return typeof refusal.status === 'number'
    ? t('modals.addCustomer.saveRejected', { code })
    : t('modals.addCustomer.saveRefusedLocally', { code });
}

/**
 * A refused address write, carrying the operator's text as its message. The
 * callers throw it from their save path so one catch shows either this text
 * or their own generic message (never a native error's raw text).
 */
export class CustomerAddressWriteRefusedError extends Error {
  constructor(
    readonly refusal: CustomerWriteResult<unknown>,
    message: string,
  ) {
    super(message);
    this.name = 'CustomerAddressWriteRefusedError';
  }
}

/**
 * Read a native address-write answer: return it when saved (at the office or
 * queued here), throw CustomerAddressWriteRefusedError with the operator's
 * text when refused.
 */
export function expectCustomerAddressWrite<T = unknown>(
  t: TranslateFn,
  raw: unknown,
  kind: CustomerAddressWriteKind,
  fallbackKey: string,
): CustomerWriteResult<T> {
  const result = readCustomerAddressWrite<T>(raw);
  if (!result.success) {
    throw new CustomerAddressWriteRefusedError(
      result,
      describeCustomerAddressWriteRefusal(t, result, kind, fallbackKey),
    );
  }
  return result;
}

/** The text to show for an error thrown by an address save: a refusal's own, else the generic one. */
export function customerAddressWriteErrorText(
  t: TranslateFn,
  error: unknown,
  fallbackKey: string,
): string {
  return error instanceof CustomerAddressWriteRefusedError ? error.message : t(fallbackKey);
}
