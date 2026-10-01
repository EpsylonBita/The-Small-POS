import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GiftFundingDrawerView,
  ShiftFinancialClosingRecoveryView,
  ShiftFinancialOpeningView,
} from '../../../lib/ipc-contracts';

// Gift-bound cashier close for the Windows staff-shift modal. Native captures
// one retained original per shift; this module shows the approved terms,
// forwards the hosted drawer fingerprint verbatim and reads the original back.
// It never rebuilds a close, its count or its request body.

export interface GiftClosingDrawerFingerprint {
  version: number;
  acknowledgementId: string | null;
  giftCashCents: number;
  ordinaryExpectedCents: number;
  expectedCents: number;
}

export interface GiftClosingRequest {
  countedCents: number;
  drawer: GiftClosingDrawerFingerprint;
  approvedOrdinaryExpectedCents: number;
}

export interface GiftClosePreview {
  /** Changes on every refreshed preview so an older approval never applies. */
  epoch: number;
  shiftId: string;
  openingKey: string;
  /** Original cashier from the persisted opening. */
  staffId: string;
  currency: string;
  /** From the current local shift summary; sent back as the approved amount. */
  ordinaryExpectedCents: number;
  /** From the hosted drawer projection. */
  giftCashCents: number;
  expectedCents: number;
  drawer: GiftClosingDrawerFingerprint;
}

export interface GiftCloseApproval {
  epoch: number;
  countedCents: number;
}

export type GiftCheckoutState =
  | { kind: 'idle' }
  | { kind: 'loading'; shiftId: string }
  | { kind: 'ordinary'; shiftId: string }
  | { kind: 'unknown'; shiftId: string }
  | { kind: 'preparing'; shiftId: string; opening: ShiftFinancialOpeningView }
  | { kind: 'blocked'; shiftId: string; opening: ShiftFinancialOpeningView; code: string; count?: number }
  | { kind: 'ready'; shiftId: string; opening: ShiftFinancialOpeningView; preview: GiftClosePreview }
  | { kind: 'retained'; shiftId: string; opening: ShiftFinancialOpeningView };

export interface GiftCloseTerms {
  ordinaryExpectedCents: number;
  giftCashCents: number;
  expectedCents: number;
  varianceCents: number;
  countedCents?: number | null;
}

export interface GiftCloseRecoveryTarget {
  /** Modal open/terminal epoch that selected this original. */
  epoch: number;
  origin: 'checkout' | 'checkin';
  staffId: string;
  closingKey: string;
  shiftId: string | null;
  roleType: string;
  currency: string | null;
  retainedCountedCents: number | null;
  initial: ShiftFinancialClosingRecoveryView | null;
  /** Terms approved on this terminal when the close started here. */
  approved: GiftCloseTerms | null;
}

export type GiftClosePendingState =
  | { staffId: string; kind: 'loading' }
  | { staffId: string; kind: 'failed'; code: string }
  | { staffId: string; kind: 'ready'; closings: ShiftFinancialClosingRecoveryView[]; truncated: boolean };

export interface GiftCloseRecoveryBridge {
  shiftFinancialClosing: {
    status(payload: { closingKey: string; staffId: string }): Promise<unknown>;
    retry(payload: { closingKey: string; staffId: string }): Promise<unknown>;
    authorize(payload: { closingKey: string; pin: string }): Promise<unknown>;
  };
}

export interface GiftCloseText {
  key: string;
  defaultValue: string;
  values?: Record<string, unknown>;
}

export const giftCloseText = (key: string, defaultValue: string, values?: Record<string, unknown>): GiftCloseText => ({
  key: `modals.staffShift.giftClose.${key}`,
  defaultValue,
  values,
});

export function useGiftCloseText() {
  const { t } = useTranslation();
  return (entry: GiftCloseText): string =>
    String(t(entry.key, { defaultValue: entry.defaultValue, ...(entry.values ?? {}) }));
}

const CLOSING_STATES = new Set(['pending', 'confirmed', 'blocked']);
export const GIFT_CLOSE_AUTH_CODES = new Set(['HOSTED_REAUTH_REQUIRED', 'HOSTED_SESSION_EXPIRED']);
export const GIFT_CLOSE_TERMS_CODES = new Set(['GIFT_CLOSING_TERMS_CHANGED', 'GIFT_CLOSING_DRAWER_CHANGED']);
export const GIFT_CLOSE_ORIGINAL_CODES = new Set([
  'GIFT_CLOSING_ORIGINAL_EXISTS',
  'GIFT_CLOSING_ORIGINAL_CONFLICT',
  'ORIGINAL_DRAWER_CLOSED',
]);
export const GIFT_CLOSE_REDISCOVER_CODES = new Set([
  'GIFT_CLOSING_PREPARATION_REQUIRED',
  'INVALID_GIFT_CLOSING_PREPARATION',
  'GIFT_CLOSING_SCOPE_MISMATCH',
  'GIFT_CLOSING_NOT_APPLICABLE',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeCents = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

/** Money to integer cents, ties to even, or null when not a finite amount. */
export function toSafeCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const cents = Math.abs(scaled - floor - 0.5) < 1e-7
    ? (floor % 2 === 0 ? floor : floor + 1)
    : Math.round(scaled);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function formatGiftCloseCents(
  cents: number | null | undefined,
  currency: string | null | undefined,
  signed = false,
): string {
  if (!isSafeCents(cents)) return '—';
  const sign = cents < 0 ? '-' : signed && cents > 0 ? '+' : '';
  const absolute = Math.abs(cents);
  const amount = `${sign}${Math.floor(absolute / 100)},${String(absolute % 100).padStart(2, '0')}`;
  return currency ? `${amount} ${currency}` : amount;
}

export function formatGiftCloseTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function readRefusalCode(value: unknown, fallback = 'UNKNOWN'): string {
  if (!isRecord(value)) return fallback;
  const data = isRecord(value.data) ? value.data : null;
  for (const candidate of [value.code, value.errorCode, data?.code]) {
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]*$/.test(candidate)) return candidate;
  }
  if (typeof value.error === 'string') {
    const match = /^([A-Z][A-Z0-9_]{2,})\b/.exec(value.error.trim());
    if (match) return match[1];
  }
  return fallback;
}

export function readOpeningList(reply: unknown): ShiftFinancialOpeningView[] | null {
  if (!isRecord(reply) || reply.success !== true || !Array.isArray(reply.openings)) return null;
  return reply.openings.filter(isRecord) as unknown as ShiftFinancialOpeningView[];
}

export function readPendingList(reply: unknown):
  | { ok: true; closings: ShiftFinancialClosingRecoveryView[]; truncated: boolean }
  | { ok: false; code: string } {
  if (!isRecord(reply) || reply.success !== true || !Array.isArray(reply.closings)) {
    return { ok: false, code: readRefusalCode(reply, 'LOCAL_READ_FAILED') };
  }
  const closings = reply.closings.filter(
    (entry: unknown) => isRecord(entry) && CLOSING_STATES.has(String(entry.state)),
  ) as unknown as ShiftFinancialClosingRecoveryView[];
  return { ok: true, closings, truncated: reply.truncated === true };
}

export function readClosingReply(reply: unknown):
  | { ok: true; closing: ShiftFinancialClosingRecoveryView }
  | { ok: false; code: string } {
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.closing) ||
      !CLOSING_STATES.has(String(reply.closing.state))) {
    return { ok: false, code: readRefusalCode(reply, 'LOCAL_READ_FAILED') };
  }
  return { ok: true, closing: reply.closing as unknown as ShiftFinancialClosingRecoveryView };
}

/** Retry and authorize only acknowledge the same key; neither is confirmation. */
export function readAcceptedClosingKey(reply: unknown): { ok: true; closingKey: string } | { ok: false; code: string } {
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.closing) ||
      typeof reply.closing.closingKey !== 'string') {
    return { ok: false, code: readRefusalCode(reply, 'LOCAL_STORE_FAILED') };
  }
  return { ok: true, closingKey: reply.closing.closingKey };
}

export function readCloseBlocker(reply: unknown):
  | { ok: true; blocked: boolean; unresolved: number }
  | { ok: false; code: string } {
  if (!isRecord(reply) || reply.success !== true || typeof reply.blocked !== 'boolean' ||
      !Array.isArray(reply.unresolved)) {
    return { ok: false, code: readRefusalCode(reply, 'FUNDING_BLOCKER_UNAVAILABLE') };
  }
  return { ok: true, blocked: reply.blocked, unresolved: reply.unresolved.length };
}

export function readDrawer(reply: unknown): { ok: true; drawer: GiftFundingDrawerView } | { ok: false; code: string } {
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.drawer)) {
    return { ok: false, code: readRefusalCode(reply, 'GIFT_CLOSING_DRAWER_UNAVAILABLE') };
  }
  return { ok: true, drawer: reply.drawer as unknown as GiftFundingDrawerView };
}

/** Null unless the hosted drawer belongs to the persisted opening and every amount is exact. */
export function buildGiftClosePreview(input: {
  epoch: number;
  opening: ShiftFinancialOpeningView;
  drawer: GiftFundingDrawerView;
  ordinaryExpectedCents: number;
}): GiftClosePreview | null {
  const { opening, drawer } = input;
  if (drawer.openingKey !== opening.openingKey || drawer.shiftId !== opening.shiftId ||
      drawer.currency !== opening.currency) {
    return null;
  }
  if (!isSafeCents(drawer.version) || !isSafeCents(drawer.giftCashCents) || drawer.giftCashCents < 0 ||
      !isSafeCents(drawer.ordinaryExpectedCents) || !isSafeCents(drawer.expectedCents) ||
      !(drawer.acknowledgementId === null || typeof drawer.acknowledgementId === 'string') ||
      !isSafeCents(input.ordinaryExpectedCents)) {
    return null;
  }
  const expectedCents = input.ordinaryExpectedCents + drawer.giftCashCents;
  if (!Number.isSafeInteger(expectedCents)) return null;
  return {
    epoch: input.epoch,
    shiftId: opening.shiftId,
    openingKey: opening.openingKey,
    staffId: opening.staffId,
    currency: opening.currency,
    ordinaryExpectedCents: input.ordinaryExpectedCents,
    giftCashCents: drawer.giftCashCents,
    expectedCents,
    drawer: {
      version: drawer.version,
      acknowledgementId: drawer.acknowledgementId,
      giftCashCents: drawer.giftCashCents,
      ordinaryExpectedCents: drawer.ordinaryExpectedCents,
      expectedCents: drawer.expectedCents,
    },
  };
}

export function buildGiftClosingRequest(preview: GiftClosePreview, countedCents: number): GiftClosingRequest {
  return {
    countedCents,
    drawer: { ...preview.drawer },
    approvedOrdinaryExpectedCents: preview.ordinaryExpectedCents,
  };
}

export type GiftCloseResult =
  | {
    kind: 'retained';
    state: 'pending_financial_confirmation' | 'confirmed';
    closingKey: string;
    countedCents: number | null;
  }
  | { kind: 'refused'; code: string }
  | { kind: 'malformed' };

/** Reads only the non-secret retained identity; the captured request body is never surfaced. */
export function readGiftCloseResult(result: unknown): GiftCloseResult {
  if (!isRecord(result)) return { kind: 'malformed' };
  if (result.success !== true) return { kind: 'refused', code: readRefusalCode(result) };
  const gift = result.giftFinancialClosing;
  if (!isRecord(gift)) return { kind: 'malformed' };
  const state = gift.state === 'confirmed' || gift.state === 'pending_financial_confirmation' ? gift.state : null;
  if (!state || typeof gift.closingKey !== 'string' || !gift.closingKey) return { kind: 'malformed' };
  return {
    kind: 'retained',
    state,
    closingKey: gift.closingKey,
    countedCents: isSafeCents(gift.countedCents) ? gift.countedCents : null,
  };
}

export const isGiftBoundCheckoutState = (state: GiftCheckoutState, shiftId: unknown): boolean =>
  (state.kind === 'preparing' || state.kind === 'blocked' || state.kind === 'ready' || state.kind === 'retained') &&
  state.shiftId === String(shiftId ?? '');

export function giftCloseCodeText(code: string, count?: number): GiftCloseText {
  switch (code) {
    case 'GIFT_FUNDING_UNRESOLVED':
      return giftCloseText('blockedUnresolved',
        'Unresolved gift card cash attempts ({{count}}) must be resolved before closing.', { count: count ?? 0 });
    case 'FUNDING_BLOCKER_UNAVAILABLE':
      return giftCloseText('blockedAttemptsUnknown', 'Gift card cash attempts could not be checked. The close stays blocked.');
    case 'ORDINARY_SUMMARY_UNAVAILABLE':
      return giftCloseText('blockedSummary', 'The ordinary shift summary could not be read. The close stays blocked.');
    case 'GIFT_CLOSING_DRAWER_UNAVAILABLE':
    case 'GIFT_CLOSING_DRAWER_MISMATCH':
      return giftCloseText('drawerUnavailable', 'The gift card cash terms could not be read. Nothing is assumed to be zero.');
    case 'GIFT_CLOSING_TERMS_CHANGED':
    case 'GIFT_CLOSING_DRAWER_CHANGED':
      return giftCloseText('termsChanged', 'The close terms changed. Review the refreshed terms, count again and approve again.');
    case 'GIFT_CLOSING_ORIGINAL_EXISTS':
    case 'GIFT_CLOSING_ORIGINAL_CONFLICT':
    case 'ORIGINAL_DRAWER_CLOSED':
      return giftCloseText('originalExists', 'A retained close already exists for this shift. Open it instead of closing again.');
    case 'GIFT_CLOSING_ORIGINAL_MISSING':
      return giftCloseText('originalMissing', 'The retained close original is missing. It cannot be retried from this terminal.');
    case 'GIFT_CLOSING_PROOF_UNAVAILABLE':
      return giftCloseText('proofUnavailable', 'The close proof is unavailable. Check the status again later.');
    case 'FINANCIAL_OPENING_PENDING':
    case 'FINANCIAL_OPENING_REQUIRED':
    case 'OPENING_UNUSABLE':
    case 'OPENING_PROOF_INCOMPLETE':
      return giftCloseText('openingNotReady', 'The gift card shift opening is not confirmed yet, so the close stays blocked.');
    case 'HOSTED_REAUTH_REQUIRED':
    case 'HOSTED_SESSION_EXPIRED':
      return giftCloseText('authRequired', 'The original cashier must enter their PIN to renew the close authorization.');
    case 'LOCAL_READ_FAILED':
    case 'LOCAL_STORE_FAILED':
    case 'TERMINAL_SCOPE_UNAVAILABLE':
      return giftCloseText('localUnavailable', 'This terminal could not read the retained close. Try again.');
    default:
      return giftCloseText('refused', 'The gift card close was refused ({{code}}).', { code });
  }
}

const shortId = (value: string | null | undefined) =>
  typeof value === 'string' && value.length > 8 ? value.slice(-8) : value || '—';

const actionClass =
  'inline-flex items-center justify-center rounded-xl border border-slate-200/80 bg-white/80 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-all disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/10 dark:text-slate-200';
const primaryActionClass =
  'inline-flex items-center justify-center rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-black shadow-[0_12px_28px_rgba(250,204,21,0.28)] transition-all disabled:cursor-not-allowed disabled:opacity-60';

export function GiftCloseAmount({ testId, label, cents, currency, signed = false, strong = false }: {
  testId: string;
  label: React.ReactNode;
  cents: number | null | undefined;
  currency: string | null | undefined;
  signed?: boolean;
  strong?: boolean;
}) {
  return (
    <div
      data-testid={testId}
      data-cents={isSafeCents(cents) ? String(cents) : undefined}
      className="flex items-baseline justify-between gap-4"
    >
      <dt className="text-sm text-slate-600 dark:text-slate-300/80">{label}</dt>
      <dd className={strong
        ? 'text-2xl font-black text-slate-900 dark:text-white'
        : 'text-base font-semibold text-slate-900 dark:text-white'}
      >
        {formatGiftCloseCents(cents, currency, signed)}
      </dd>
    </div>
  );
}

interface GiftCloseRecoveryPanelProps {
  bridge: GiftCloseRecoveryBridge;
  target: GiftCloseRecoveryTarget;
  /** Parent fence: the modal open/terminal epoch that selected this original. */
  isCurrent: () => boolean;
  print: (shiftId: string, roleType: string, isCurrent: () => boolean) => Promise<unknown>;
  onDone: () => void;
}

/**
 * One retained original, keyed by cashier and closing key. Reads status,
 * renews only the original cashier's close authorization and retries the exact
 * original. Completion and printing follow canonical confirmation only.
 */
export function GiftCloseRecoveryPanel({ bridge, target, isCurrent, print, onDone }: GiftCloseRecoveryPanelProps) {
  const text = useGiftCloseText();
  const label = (key: string, defaultValue: string, values?: Record<string, unknown>) =>
    text(giftCloseText(key, defaultValue, values));
  const [view, setView] = useState<ShiftFinancialClosingRecoveryView | null>(target.initial);
  const [busy, setBusy] = useState<'status' | 'retry' | 'authorize' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; entry: GiftCloseText } | null>(null);
  const [needsAuth, setNeedsAuth] = useState(target.initial?.authorizationRequired === true);
  const [pin, setPin] = useState('');
  const [printState, setPrintState] = useState<'idle' | 'printing' | 'queued' | 'failed'>('idle');
  const mounted = useRef(false);
  const generation = useRef(0);
  const printed = useRef(false);
  const lastPreview = useRef<GiftCloseTerms | null>(target.initial?.localPreview ?? null);
  const currentRef = useRef(isCurrent);
  currentRef.current = isCurrent;

  const begin = () => {
    generation.current += 1;
    const token = generation.current;
    return () => mounted.current && generation.current === token && currentRef.current();
  };

  const printConfirmed = async (closing: ShiftFinancialClosingRecoveryView) => {
    const shiftId = closing.shiftId || target.shiftId;
    const token = generation.current;
    const valid = () => mounted.current && generation.current === token && currentRef.current();
    if (closing.state !== 'confirmed' || !closing.canonical || !shiftId || !valid()) return;
    setPrintState('printing');
    try {
      const result = await print(shiftId, target.roleType, valid);
      if (valid()) setPrintState(isRecord(result) && result.success === true ? 'queued' : 'failed');
    } catch {
      if (valid()) setPrintState('failed');
    }
  };

  const readStatusWith = async (valid: () => boolean) => {
    let reply: unknown;
    try {
      reply = await bridge.shiftFinancialClosing.status({ closingKey: target.closingKey, staffId: target.staffId });
    } catch {
      if (valid()) {
        setBusy(null);
        setNotice({ tone: 'error', entry: giftCloseCodeText('LOCAL_READ_FAILED') });
      }
      return;
    }
    if (!valid()) return;
    setBusy(null);
    const parsed = readClosingReply(reply);
    if (!parsed.ok) {
      if (GIFT_CLOSE_AUTH_CODES.has(parsed.code)) setNeedsAuth(true);
      setNotice({ tone: 'error', entry: giftCloseCodeText(parsed.code) });
      return;
    }
    const closing = parsed.closing;
    if (closing.closingKey !== target.closingKey ||
        (target.shiftId && closing.shiftId && closing.shiftId !== target.shiftId)) {
      setNotice({ tone: 'error', entry: giftCloseCodeText('CLOSING_SCOPE_CHANGED') });
      return;
    }
    if (closing.localPreview) lastPreview.current = closing.localPreview;
    setView(closing);
    setNeedsAuth(closing.state === 'pending' && closing.authorizationRequired === true);
    if (closing.state === 'confirmed') {
      setNotice(null);
      if (closing.canonical && !printed.current) {
        printed.current = true;
        void printConfirmed(closing);
      }
    }
  };

  const retryWith = async (valid: () => boolean) => {
    let reply: unknown;
    try {
      reply = await bridge.shiftFinancialClosing.retry({ closingKey: target.closingKey, staffId: target.staffId });
    } catch {
      if (valid()) {
        setBusy(null);
        setNotice({ tone: 'error', entry: giftCloseCodeText('LOCAL_STORE_FAILED') });
      }
      return;
    }
    if (!valid()) return;
    const accepted = readAcceptedClosingKey(reply);
    if (!accepted.ok || accepted.closingKey !== target.closingKey) {
      const code = accepted.ok ? 'CLOSING_SCOPE_CHANGED' : accepted.code;
      setBusy(null);
      if (GIFT_CLOSE_AUTH_CODES.has(code)) setNeedsAuth(true);
      setNotice({ tone: 'error', entry: giftCloseCodeText(code) });
      return;
    }
    // Queued is never confirmation: read the retained original back.
    setNotice({
      tone: 'info',
      entry: giftCloseText('queued', 'Confirmation retry queued. Check the status again shortly.'),
    });
    await readStatusWith(valid);
  };

  const readStatus = () => {
    const valid = begin();
    setBusy('status');
    setNotice(null);
    void readStatusWith(valid);
  };

  const retry = () => {
    const valid = begin();
    setBusy('retry');
    setNotice(null);
    void retryWith(valid);
  };

  const authorize = async () => {
    // The original cashier's PIN is private and leaves UI state immediately.
    const secret = pin;
    setPin('');
    if (!/^\d{4,12}$/.test(secret)) {
      setNotice({ tone: 'error', entry: giftCloseText('pinInvalid', "Enter the original cashier's PIN.") });
      return;
    }
    const valid = begin();
    setBusy('authorize');
    setNotice(null);
    let reply: unknown;
    try {
      reply = await bridge.shiftFinancialClosing.authorize({ closingKey: target.closingKey, pin: secret });
    } catch {
      if (valid()) {
        setBusy(null);
        setNotice({ tone: 'error', entry: giftCloseCodeText('HOSTED_REAUTH_REQUIRED') });
      }
      return;
    }
    if (!valid()) return;
    const accepted = readAcceptedClosingKey(reply);
    if (!accepted.ok || accepted.closingKey !== target.closingKey) {
      setBusy(null);
      setNotice({ tone: 'error', entry: giftCloseCodeText(accepted.ok ? 'CLOSING_SCOPE_CHANGED' : accepted.code) });
      return;
    }
    setNeedsAuth(false);
    await retryWith(valid);
  };

  useEffect(() => {
    mounted.current = true;
    readStatus();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const state = view?.state ?? null;
  const currency = view?.currency ?? target.currency;
  const retainedCount = view?.countedCents ?? target.retainedCountedCents;
  const canonical = state === 'confirmed' ? view?.canonical ?? null : null;
  const preview = state === 'pending' ? view?.localPreview ?? null : null;
  const reference = target.approved ?? lastPreview.current;
  const differs = Boolean(canonical && reference && (
    canonical.ordinaryExpectedCents !== reference.ordinaryExpectedCents ||
    canonical.giftCashCents !== reference.giftCashCents ||
    canonical.expectedCents !== reference.expectedCents ||
    canonical.varianceCents !== reference.varianceCents ||
    (typeof reference.countedCents === 'number' && canonical.countedCents !== reference.countedCents)
  ));
  const title = state === 'confirmed'
    ? label('confirmedTitle', 'Financial close confirmed')
    : state === 'blocked'
      ? label('blockedStateTitle', 'Close confirmation is blocked')
      : state === 'pending'
        ? label('pendingTitle', 'Awaiting financial confirmation')
        : label('loadingStatus', 'Reading the retained close…');

  return (
    <div
      data-testid="gift-close-recovery"
      data-state={state ?? 'loading'}
      data-closing-key={target.closingKey}
      className="space-y-4 rounded-2xl border border-yellow-300/60 bg-white/80 p-5 shadow-[0_10px_24px_rgba(15,23,42,0.06)] dark:border-yellow-300/20 dark:bg-white/5"
    >
      <div>
        <div className="text-xs uppercase tracking-[0.22em] text-yellow-700 dark:text-yellow-300/90">
          {label('title', 'Gift card cash close')}
        </div>
        <h3 className="mt-2 text-2xl font-black text-slate-900 dark:text-white">{title}</h3>
        {state === 'pending' && (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
            {label('pendingBody', 'The shift is closed on this terminal. Its gift card cash close is waiting for financial confirmation and will not be closed again.')}
          </p>
        )}
        {state === 'blocked' && view && (
          <p data-testid="gift-close-blocked-state" data-code={view.code ?? ''} className="mt-2 text-sm text-red-700 dark:text-red-300">
            {text(giftCloseCodeText(view.code || 'UNKNOWN'))}
          </p>
        )}
      </div>

      {state !== 'confirmed' && (
        <dl className="space-y-2">
          <GiftCloseAmount
            testId="gift-close-retained-count"
            label={label('retainedCount', 'Retained count')}
            cents={retainedCount}
            currency={currency}
          />
        </dl>
      )}

      {preview && (
        <section data-testid="gift-close-local-preview" className="rounded-xl border border-slate-200/80 p-4 dark:border-white/10">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
            {label('localPreview', 'Local preview, not confirmed')}
          </div>
          <dl className="mt-3 space-y-2">
            <GiftCloseAmount testId="gift-close-preview-ordinary" label={label('ordinaryExpected', 'Ordinary cash expected')} cents={preview.ordinaryExpectedCents} currency={currency} />
            <GiftCloseAmount testId="gift-close-preview-gift" label={label('giftCash', 'Gift card cash')} cents={preview.giftCashCents} currency={currency} />
            <GiftCloseAmount testId="gift-close-preview-expected" label={label('expectedTotal', 'Expected in drawer')} cents={preview.expectedCents} currency={currency} strong />
            <GiftCloseAmount testId="gift-close-preview-variance" label={label('variance', 'Variance')} cents={preview.varianceCents} currency={currency} signed />
          </dl>
        </section>
      )}

      {canonical && (
        <section data-testid="gift-close-canonical" className="rounded-xl border border-emerald-300/60 p-4 dark:border-emerald-300/20">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
            {label('canonical', 'Confirmed terms')}
          </div>
          <dl className="mt-3 space-y-2">
            <GiftCloseAmount testId="gift-close-canonical-ordinary" label={label('ordinaryExpected', 'Ordinary cash expected')} cents={canonical.ordinaryExpectedCents} currency={currency} />
            <GiftCloseAmount testId="gift-close-canonical-gift" label={label('giftCash', 'Gift card cash')} cents={canonical.giftCashCents} currency={currency} />
            <GiftCloseAmount testId="gift-close-canonical-expected" label={label('expectedTotal', 'Expected in drawer')} cents={canonical.expectedCents} currency={currency} strong />
            <GiftCloseAmount testId="gift-close-canonical-counted" label={label('counted', 'Counted cash')} cents={canonical.countedCents} currency={currency} />
            <GiftCloseAmount testId="gift-close-canonical-variance" label={label('variance', 'Variance')} cents={canonical.varianceCents} currency={currency} signed />
            <div data-testid="gift-close-canonical-closed-at" className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-slate-600 dark:text-slate-300/80">{label('closedAt', 'Closed at')}</dt>
              <dd className="text-sm font-semibold text-slate-900 dark:text-white">{formatGiftCloseTime(canonical.closedAt)}</dd>
            </div>
            <div data-testid="gift-close-canonical-confirmed-at" className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-slate-600 dark:text-slate-300/80">{label('confirmedAt', 'Confirmed at')}</dt>
              <dd className="text-sm font-semibold text-slate-900 dark:text-white">{formatGiftCloseTime(canonical.confirmedAt)}</dd>
            </div>
          </dl>
          {differs && (
            <p data-testid="gift-close-canonical-differs" className="mt-3 text-sm font-semibold text-amber-700 dark:text-amber-300">
              {label('canonicalDiffers', 'The confirmed terms differ from the preview shown at close.')}
            </p>
          )}
        </section>
      )}

      {state === 'pending' && needsAuth && (
        <div data-testid="gift-close-authorization" className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300/80">
            {label('authRequired', 'The original cashier must enter their PIN to renew the close authorization.')}
          </p>
          <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
            {label('pinLabel', 'Original cashier PIN')}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              data-testid="gift-close-pin"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))}
              className="liquid-glass-modal-input mt-2 w-full text-center text-2xl tracking-[0.4em]"
            />
          </label>
          <button
            type="button"
            data-testid="gift-close-authorize"
            disabled={busy !== null || pin.length < 4}
            onClick={() => { void authorize(); }}
            className={primaryActionClass}
          >
            {label('authorize', 'Renew authorization and retry')}
          </button>
        </div>
      )}

      {notice && (
        <p
          data-testid="gift-close-notice"
          data-tone={notice.tone}
          className={notice.tone === 'error'
            ? 'text-sm font-semibold text-red-700 dark:text-red-300'
            : 'text-sm text-slate-600 dark:text-slate-300/80'}
        >
          {text(notice.entry)}
        </p>
      )}
      {(printState === 'queued' || printState === 'failed') && (
        <p data-testid="gift-close-print-state" data-print={printState} className="text-sm text-slate-600 dark:text-slate-300/80">
          {printState === 'queued'
            ? label('printQueued', 'Checkout print queued.')
            : label('printFailed', 'The checkout print failed. Try printing again.')}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button type="button" data-testid="gift-close-status" disabled={busy !== null} onClick={readStatus} className={actionClass}>
          {label('checkStatus', 'Check status')}
        </button>
        {state === 'pending' && !needsAuth && (
          <button type="button" data-testid="gift-close-retry" disabled={busy !== null} onClick={retry} className={primaryActionClass}>
            {label('retry', 'Retry confirmation')}
          </button>
        )}
        {canonical && view && (
          <button
            type="button"
            data-testid="gift-close-print"
            disabled={printState === 'printing'}
            onClick={() => { void printConfirmed(view); }}
            className={actionClass}
          >
            {label('print', 'Print checkout')}
          </button>
        )}
        <button type="button" data-testid="gift-close-done" onClick={() => {
          generation.current += 1;
          mounted.current = false;
          onDone();
        }} className={actionClass}>
          {label('done', 'Done')}
        </button>
      </div>
    </div>
  );
}

/** Explicit selection among one or many retained originals of the selected cashier. */
export function GiftClosePendingList({ state, onSelect, onReload }: {
  state: GiftClosePendingState;
  onSelect: (closing: ShiftFinancialClosingRecoveryView) => void;
  onReload: () => void;
}) {
  const text = useGiftCloseText();
  const label = (key: string, defaultValue: string, values?: Record<string, unknown>) =>
    text(giftCloseText(key, defaultValue, values));

  if (state.kind === 'loading') return null;
  if (state.kind === 'failed') {
    return (
      <div data-testid="gift-close-pending-failed" data-code={state.code} className="flex flex-col gap-3 rounded-2xl border border-amber-300/60 bg-amber-50/70 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-amber-300/20 dark:bg-amber-400/10">
        <p className="text-sm text-slate-700 dark:text-slate-200">
          {label('pendingListFailed', 'Pending gift card closes for this cashier could not be checked.')}
        </p>
        <button type="button" data-testid="gift-close-pending-reload" onClick={onReload} className={actionClass}>
          {label('checkAgain', 'Check again')}
        </button>
      </div>
    );
  }
  if (state.closings.length === 0) return null;

  return (
    <div data-testid="gift-close-pending-list" className="rounded-2xl border border-yellow-300/60 bg-yellow-50/70 p-4 dark:border-yellow-300/20 dark:bg-yellow-400/10">
      <div className="text-sm font-bold text-slate-900 dark:text-white">
        {label('pendingListTitle', 'Pending gift card closes')}
      </div>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300/80">
        {label('pendingListHelper', 'Select a retained close to check or retry it. A new close is never created from here.')}
      </p>
      <ul className="mt-3 space-y-2">
        {state.closings.map((closing, index) => (
          <li
            key={closing.closingKey ?? `missing-${index}`}
            data-testid="gift-close-pending-entry"
            data-state={closing.state}
            className="flex items-center justify-between gap-3 rounded-xl bg-white/80 px-3 py-2 dark:bg-white/5"
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 dark:text-white">
                {label('shiftLabel', 'Shift {{id}}', { id: shortId(closing.shiftId) })}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300/80">
                {closing.state === 'blocked'
                  ? text(giftCloseCodeText(closing.code || 'UNKNOWN'))
                  : label('pendingTitle', 'Awaiting financial confirmation')}
                {' · '}
                {formatGiftCloseCents(closing.countedCents, closing.currency)}
              </div>
            </div>
            <button
              type="button"
              data-testid="gift-close-pending-open"
              data-closing-key={closing.closingKey ?? ''}
              disabled={!closing.closingKey}
              onClick={() => onSelect(closing)}
              className={actionClass}
            >
              {label('open', 'Open')}
            </button>
          </li>
        ))}
      </ul>
      {state.truncated && (
        <p data-testid="gift-close-pending-truncated" className="mt-2 text-xs text-slate-600 dark:text-slate-300/80">
          {label('pendingListTruncated', 'More retained closes exist than are shown here.')}
        </p>
      )}
    </div>
  );
}
