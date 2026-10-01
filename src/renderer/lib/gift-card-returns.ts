/**
 * Renderer helpers for the original-card gift return (native `giftReturns`,
 * atomic_return_v1). Pure checks over the typed DTOs plus the terminal
 * lifecycle fence. Nothing here computes a payout, writes money or replaces
 * native permission: native captures, sends and adopts every return.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';
import type {
  GiftReturnOriginalAdvisory,
  GiftReturnResponse,
  GiftReturnView,
} from '../../lib/ipc-contracts';

/** The exact local tender method of a gift card payment row. */
export const GIFT_CARD_PAYMENT_METHOD = 'gift_card';

/** Exact match only: ordinary cash/card/EFT rows never take the gift path. */
export const isGiftCardPayment = (method: unknown): boolean => method === GIFT_CARD_PAYMENT_METHOD;

/** Another operator's (or an unauthorized caller's) pending return blocks the payment. */
export const GIFT_RETURN_PENDING_EXISTS = 'GIFT_RETURN_PENDING_EXISTS';

/** An earlier canonical return is not reconciled locally; replays keep this code. */
export const GIFT_RETURN_PRIOR_UNRECONCILED = 'GIFT_RETURN_PRIOR_UNRECONCILED';

/** After these events nothing held from the previous terminal configuration may be shown. */
export const GIFT_RETURN_LIFECYCLE_EVENTS = [
  'terminal-config-updated',
  'terminal-credentials-updated',
  'terminal-auth-paused',
  'app:reset',
] as const;

const isCents = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Exact decimal money text to integer minor units: digits with at most two
 * fraction digits, greater than zero. No float parsing, rounding or tolerance.
 */
export function parseAmountToCents(input: string): number | null {
  const match = /^(\d{1,13})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export const sameStaffId = (left: string | null | undefined, right: string | null | undefined): boolean =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  left.trim() !== '' &&
  left.trim().toLowerCase() === right.trim().toLowerCase();

/** Advisory expiry only: native and the server still decide at send time. */
export function isStillUsable(usableUntil: string | null | undefined, now: number = Date.now()): boolean {
  if (typeof usableUntil !== 'string') return false;
  const until = Date.parse(usableUntil);
  return Number.isFinite(until) && until > now;
}

export interface UsableGiftOriginal {
  localPaymentId: string;
  currency: string;
  grossCents: number;
  returnedCents: number;
  remainingCents: number;
}

/**
 * The native original's money, only when every amount is a proven integer.
 * Unknown values are never treated as zero or as the full gross.
 */
export function usableGiftOriginal(
  original: GiftReturnOriginalAdvisory | null | undefined,
  localPaymentId: string,
): UsableGiftOriginal | null {
  if (!original || original.localPaymentId !== localPaymentId || !original.eligible) return null;
  const { currency, grossCents, returnedCents, remainingCents } = original;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  if (!isCents(grossCents) || !isCents(returnedCents) || !isCents(remainingCents)) return null;
  if (remainingCents > grossCents || returnedCents > grossCents) return null;
  return { localPaymentId, currency, grossCents, returnedCents, remainingCents };
}

export interface GiftReturnBinding {
  localPaymentId: string;
  localOrderId: string;
  /** The authorized original operator. */
  staffId: string;
  /** Required for recovery: the reply must carry the same key. */
  returnKey?: string;
}

/** An attempt view bound to this exact payment, order, operator (and key). */
export function isBoundGiftReturn(
  view: GiftReturnView | null | undefined,
  binding: GiftReturnBinding,
): view is GiftReturnView {
  if (!view) return false;
  return (
    view.localPaymentId === binding.localPaymentId &&
    view.localOrderId === binding.localOrderId &&
    sameStaffId(view.staffId, binding.staffId) &&
    (binding.returnKey === undefined || view.returnKey === binding.returnKey)
  );
}

/** The typed, current completed proof for this binding, or null. Nothing else is success. */
export function completedGiftReturn(
  response: GiftReturnResponse | null | undefined,
  binding: GiftReturnBinding,
): GiftReturnView | null {
  if (!response || response.success !== true) return null;
  if (response.contract !== 'atomic_return_v1' || response.outcome !== 'completed') return null;
  const view = response.return;
  if (!isBoundGiftReturn(view, binding) || view.state !== 'completed' || !view.proof) return null;
  if (!isCents(view.proof.returnedCents) || !isCents(view.proof.remainingCents)) return null;
  return view;
}

export interface GiftReturnTerminalIdentity {
  ready: boolean;
  organizationId: string | null;
  branchId: string | null;
  terminalId: string | null;
  /** Bumped by every configuration, credential, auth-pause or reset event. */
  epoch: number;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The trusted terminal identity, re-read after every lifecycle event. `onInvalidate`
 * runs synchronously inside the event, before any held reply can resolve. It is a
 * UI fence only; native enforces the return's org/branch/terminal scope.
 */
export function useGiftReturnTerminalIdentity(onInvalidate: () => void): GiftReturnTerminalIdentity {
  const [identity, setIdentity] = useState<GiftReturnTerminalIdentity>({
    ready: false,
    organizationId: null,
    branchId: null,
    terminalId: null,
    epoch: 0,
  });
  const invalidateRef = useRef(onInvalidate);
  useLayoutEffect(() => {
    invalidateRef.current = onInvalidate;
  });

  useEffect(() => {
    let active = true;
    let request = 0;
    const read = () => {
      const current = ++request;
      const terminalConfig = getBridge().terminalConfig;
      void Promise.all([
        Promise.resolve().then(() => terminalConfig.getOrganizationId()).catch(() => null),
        Promise.resolve().then(() => terminalConfig.getBranchId()).catch(() => null),
        Promise.resolve().then(() => terminalConfig.getTerminalId()).catch(() => null),
      ]).then(([organizationId, branchId, terminalId]) => {
        if (!active || current !== request) return;
        setIdentity((previous) => ({
          ready: true,
          organizationId: text(organizationId),
          branchId: text(branchId),
          terminalId: text(terminalId),
          epoch: previous.epoch,
        }));
      });
    };
    const handleLifecycle = () => {
      invalidateRef.current();
      setIdentity((previous) => ({
        ready: false,
        organizationId: null,
        branchId: null,
        terminalId: null,
        epoch: previous.epoch + 1,
      }));
      read();
    };
    read();
    GIFT_RETURN_LIFECYCLE_EVENTS.forEach((event) => onEvent<unknown>(event, handleLifecycle));
    return () => {
      active = false;
      GIFT_RETURN_LIFECYCLE_EVENTS.forEach((event) => offEvent<unknown>(event, handleLifecycle));
    };
  }, []);

  return identity;
}
