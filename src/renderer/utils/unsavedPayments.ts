import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';

import { getBridge } from '../../lib';
import { formatCurrency } from './format';
import type { UnsavedChargedPaymentSummary } from '../../lib/ipc-adapter';
import {
  formatPaymentNotSavedMessage,
  formatSetAsidePaymentMessage,
} from '../../lib/payment-integrity';

/**
 * A card the terminal approved whose payment this till could not save yet
 * (`PAYMENT_NOT_SAVED`), or a tender refused because one is not saved
 * (`PAYMENT_NOT_SAVED_PENDING`). The money moved or is held: never treat it
 * as a failure to retry with a new charge (fix review 30/09/2026, Android
 * 1.0.13 parity).
 */
export class PaymentNotSavedError extends Error {
  readonly paymentNotSaved = true;

  constructor(
    message: string,
    readonly unsaved: UnsavedChargedPaymentSummary[],
  ) {
    super(message);
    this.name = 'PaymentNotSavedError';
  }
}

const summariesOf = (result: any): UnsavedChargedPaymentSummary[] => {
  if (Array.isArray(result?.unsavedPayments)) return result.unsavedPayments;
  if (result?.unsavedPayment && typeof result.unsavedPayment === 'object') {
    return [result.unsavedPayment];
  }
  return [];
};

/** Throw the operator's localized sentence when `result` says not saved. */
export function throwIfPaymentNotSaved(
  result: unknown,
  t: TFunction,
  formatMoney: (amount: number) => string,
): void {
  const message = formatPaymentNotSavedMessage(result, t, formatMoney);
  if (message) {
    throw new PaymentNotSavedError(message, summariesOf(result));
  }
}

export function isPaymentNotSavedError(error: unknown): error is PaymentNotSavedError {
  return (
    error instanceof PaymentNotSavedError
    || (typeof error === 'object'
      && error !== null
      && (error as { paymentNotSaved?: unknown }).paymentNotSaved === true)
  );
}

/** How long the cashier sees the "do not charge again" sentence. */
export const PAYMENT_NOT_SAVED_TOAST_MS = 15000;

export interface UnsavedChargedPayments {
  /** The order's records, or the last ones read when a read fails. */
  payments: UnsavedChargedPaymentSummary[];
  /** Read them again; resolves with what was read (the last known on failure). */
  refresh: () => Promise<UnsavedChargedPaymentSummary[]>;
  /** "Save payment again": the same writes and keys, no new charge. */
  saveAgain: () => Promise<void>;
  isSaving: boolean;
}

/**
 * The card payments of one order that were charged on this till and are not
 * saved yet, for the payment surfaces' banner and their check before any new
 * charge. A failed read keeps the last records read instead of reading as
 * "nothing to save".
 */
export function useUnsavedChargedPayments(
  orderId: string | null | undefined,
  enabled: boolean,
  t: TFunction,
  formatMoney: (amount: number) => string,
  onSaved?: () => void | Promise<void>,
): UnsavedChargedPayments {
  const [payments, setPayments] = useState<UnsavedChargedPaymentSummary[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const lastKnownRef = useRef<UnsavedChargedPaymentSummary[]>([]);

  const refresh = useCallback(async (): Promise<UnsavedChargedPaymentSummary[]> => {
    if (!orderId) {
      lastKnownRef.current = [];
      setPayments([]);
      return [];
    }
    try {
      const result: any = await getBridge().payments.listUnsavedPayments(orderId);
      const next: UnsavedChargedPaymentSummary[] = Array.isArray(result?.payments)
        ? result.payments
        : [];
      lastKnownRef.current = next;
      setPayments(next);
      return next;
    } catch (error) {
      console.warn('[unsavedPayments] Reading the charged payments not saved failed:', error);
      return lastKnownRef.current;
    }
  }, [orderId]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const saveAgain = useCallback(async () => {
    if (!orderId || isSaving) return;
    setIsSaving(true);
    try {
      const result: any = await getBridge().payments.saveUnsavedPayments({ orderId });
      if (announceSaveAgainResult(result, t, formatMoney)) {
        await onSaved?.();
      }
    } catch (error) {
      console.error('[unsavedPayments] Save payment again failed:', error);
      announceStillNotSaved(lastKnownRef.current, t, formatMoney);
    } finally {
      await refresh();
      setIsSaving(false);
    }
  }, [formatMoney, isSaving, onSaved, orderId, refresh, t]);

  return { payments, refresh, saveAgain, isSaving };
}

const sumAmounts = (entries: UnsavedChargedPaymentSummary[]): number =>
  entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);

function announceStillNotSaved(
  entries: UnsavedChargedPaymentSummary[],
  t: TFunction,
  formatMoney: (amount: number) => string,
): void {
  const manual = entries.filter(isManualTwintRecord);
  if (manual.length) toast.error(t(manual.every(entry=>entry.canSaveAgain===false) ? 'twintPayment.receiptReconcile' : 'twintPayment.receiptRecovery'),{duration:PAYMENT_NOT_SAVED_TOAST_MS});
  const ordinary = entries.filter(entry=>!isManualTwintRecord(entry));
  if (!ordinary.length) return;
  toast.error(
    t('payment.notSaved.stillNotSaved', {
      amount: formatMoney(sumAmounts(ordinary)),
      defaultValue:
        'The {{amount}} charged is still not saved on this till. Do NOT charge again. Try Save payment again; if it cannot be saved, give the money back and a manager confirms it on the Z-report.',
    }),
    { duration: PAYMENT_NOT_SAVED_TOAST_MS },
  );
}

/**
 * Tell the cashier what "Save payment again" did: saved, set aside, or still
 * not saved (never a generic failure). Returns whether anything was written.
 */
export function announceSaveAgainResult(
  result: any,
  t: TFunction,
  formatMoney: (amount: number) => string,
): boolean {
  const setAside = Array.isArray(result?.setAside) ? result.setAside : [];
  for (const answer of setAside) {
    const message = formatSetAsidePaymentMessage(answer, t, formatMoney);
    if (message) toast.error(message, { duration: PAYMENT_NOT_SAVED_TOAST_MS });
  }
  const retained: UnsavedChargedPaymentSummary[] = Array.isArray(result?.unsaved)
    ? result.unsaved
    : [];
  const manual=retained.filter(isManualTwintRecord);
  if (manual.length) announceStillNotSaved(manual,t,formatMoney);
  const unsaved=retained.filter(entry=>!isManualTwintRecord(entry));
  if (unsaved.length > 0) {
    if (unsaved.every((entry) => entry.canSaveAgain === false)) {
      toast.error(
        t('payment.notSaved.cannotSave', {
          amount: formatMoney(sumAmounts(unsaved)),
          defaultValue:
            'The {{amount}} charged cannot be saved on this till. Do NOT charge again. Give the money back to the customer, then a manager confirms it on the Z-report.',
        }),
        { duration: PAYMENT_NOT_SAVED_TOAST_MS },
      );
    } else {
      announceStillNotSaved(unsaved, t, formatMoney);
    }
  } else if (manual.length===0 && Number(result?.saved || 0) > 0) {
    toast.success(t('payment.notSaved.saved', { defaultValue: 'Payment saved' }));
  }
  return Number(result?.saved || 0) > 0 || setAside.length > 0;
}

/** The record kind of a card charged at new-order checkout (item E). */
export const NEW_ORDER_CHECKOUT_KIND = 'new_order_checkout';

export function isManualTwintRecord(entry: {method?: string;kind?: string|null}): boolean {
  return entry.method==='twint' && (entry.kind==='manual_twint_checkout' || entry.kind==='manual_twint_payment');
}

export function retainedManualTwintAmount(entry: UnsavedChargedPaymentSummary): number {
  return Number.isSafeInteger(entry.amountCents) ? entry.amountCents / 100 : Number(entry.amount || 0);
}

/**
 * A card charged at new-order checkout whose order this till could not save
 * yet: the record holds the order and its payment until they are saved.
 */
export function isNewOrderCheckoutRecord(
  entry: { kind?: string | null } | null | undefined,
): boolean {
  return entry?.kind === NEW_ORDER_CHECKOUT_KIND || entry?.kind === 'manual_twint_checkout';
}

/** Fired when a checkout ends with a card charged and not saved. */
export const UNSAVED_CHECKOUT_CHANGED_EVENT = 'pos:unsaved-checkout-changed';

export function announceUnsavedCheckoutChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(UNSAVED_CHECKOUT_CHANGED_EVENT));
  } catch (error) {
    console.debug('[unsavedPayments] Could not announce a not-saved checkout:', error);
  }
}

/**
 * The cards charged at new-order checkout on this till whose order and
 * payment are not saved yet (item E, fix review 30/09/2026). Read from their
 * durable records, so the banner is back after a restart. "Save payment
 * again" replays each order and its payment with the same keys: no new
 * charge. A failed read keeps the last records read.
 */
export function useUnsavedCheckoutPayments(
  enabled: boolean,
  t: TFunction,
  formatMoney: (amount: number) => string = formatCurrency,
  onSaved?: () => void | Promise<void>,
): UnsavedChargedPayments {
  const [payments, setPayments] = useState<UnsavedChargedPaymentSummary[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const lastKnownRef = useRef<UnsavedChargedPaymentSummary[]>([]);

  const refresh = useCallback(async (): Promise<UnsavedChargedPaymentSummary[]> => {
    try {
      const result: any = await getBridge().payments.listUnsavedPayments();
      const next: UnsavedChargedPaymentSummary[] = (
        Array.isArray(result?.payments) ? result.payments : []
      ).filter(isNewOrderCheckoutRecord);
      lastKnownRef.current = next;
      setPayments(next);
      return next;
    } catch (error) {
      console.warn('[unsavedPayments] Reading the checkouts not saved failed:', error);
      return lastKnownRef.current;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    if (typeof window === 'undefined') return undefined;
    const onChanged = () => {
      void refresh();
    };
    window.addEventListener(UNSAVED_CHECKOUT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(UNSAVED_CHECKOUT_CHANGED_EVENT, onChanged);
  }, [enabled, refresh]);

  const saveAgain = useCallback(async () => {
    if (isSaving) return;
    const pending = lastKnownRef.current.filter((entry) => entry.canSaveAgain !== false);
    if (pending.length === 0) return;
    setIsSaving(true);
    const combined: {
      saved: number;
      setAside: unknown[];
      unsaved: UnsavedChargedPaymentSummary[];
    } = { saved: 0, setAside: [], unsaved: [] };
    let failed = false;
    try {
      for (const entry of pending) {
        const result: any = await getBridge().payments.saveUnsavedPayments({
          idempotencyKey: entry.idempotencyKey,
        });
        combined.saved += Number(result?.saved || 0);
        if (Array.isArray(result?.setAside)) combined.setAside.push(...result.setAside);
        if (Array.isArray(result?.unsaved)) combined.unsaved.push(...result.unsaved);
      }
    } catch (error) {
      console.error('[unsavedPayments] Save payment again (checkout) failed:', error);
      failed = true;
    }
    try {
      if (failed && combined.saved === 0 && combined.setAside.length === 0) {
        announceStillNotSaved(pending, t, formatMoney);
      } else if (announceSaveAgainResult(combined, t, formatMoney)) {
        await onSaved?.();
      }
    } finally {
      await refresh();
      setIsSaving(false);
    }
  }, [formatMoney, isSaving, onSaved, refresh, t]);

  return { payments, refresh, saveAgain, isSaving };
}

/** The refusal sentence for a new tender while `pending` are not saved. */
export function pendingNotSavedMessage(
  pending: UnsavedChargedPaymentSummary[],
  t: TFunction,
  formatMoney: (amount: number, currency?: string | null) => string,
): string {
  const amountCents = pending.reduce(
    (sum, entry) => sum + Number(entry.amountCents ?? Math.round(Number(entry.amount || 0) * 100)),
    0,
  );
  const currencies = new Set(pending.map(entry => entry.currency));
  const currency = currencies.size === 1 ? pending[0]?.currency ?? null : null;
  return (
    formatPaymentNotSavedMessage(
      { errorCode: 'PAYMENT_NOT_SAVED_PENDING', amountCents, currency, manualReceiptConfirmed:pending.some(isManualTwintRecord) },
      t,
      formatMoney,
    ) ?? ''
  );
}

/**
 * Tell the cashier, in the store's language, that a card was charged but its
 * payment is not saved (or that a tender was refused because one is not):
 * never the generic "Failed to collect payment". Returns whether it did.
 */
export function notifyPaymentNotSaved(
  result: unknown,
  t: TFunction,
  formatMoney: (amount: number) => string = formatCurrency,
): boolean {
  const message = formatPaymentNotSavedMessage(result, t, formatMoney);
  if (!message) return false;
  toast.error(message, { duration: PAYMENT_NOT_SAVED_TOAST_MS });
  return true;
}

/** The Z panel's busy key while one record is being saved again. */
export function unsavedSavingKey(idempotencyKey: string): string {
  return `unsaved-save:${idempotencyKey}`;
}

/** The Z panel's busy key while one record is being resolved. */
export function unsavedResolvingKey(idempotencyKey: string): string {
  return `unsaved-resolve:${idempotencyKey}`;
}
