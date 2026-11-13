import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { refundFinishesCompletedOrder } from '../../services/OrderRefundCancellation';
import React, {
  useState,
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import {
  X,
  RotateCcw,
  XCircle,
  CreditCard,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Gift,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShift } from "../../contexts/shift-context";
import { LiquidGlassModal } from "../ui/pos-glass-components";
import {
  RefundAttributionFields,
  refundFormDefaults,
  refundRouteForTender,
  type RefundTender,
} from "./RefundAttributionFields";
import toast from "react-hot-toast";
import { formatCurrency } from "../../utils/format";
import { resolveAdjustmentAttribution } from "../../utils/staffAttribution";
import { refundVoidErrorMessage } from "../../utils/refundVoidErrors";
import { CentsMoneyInput } from "../ui/CentsMoneyInput";
import { getBridge } from "../../../lib";
import type {
  GiftReturnAction,
  GiftReturnAuthorizeResponse,
  GiftReturnBeginRequest,
  GiftReturnResponse,
  GiftReturnStatusResponse,
  GiftReturnView,
} from "../../../lib/ipc-contracts";
import {
  GIFT_RETURN_PENDING_EXISTS,
  GIFT_RETURN_PRIOR_UNRECONCILED,
  completedGiftReturn,
  isBoundGiftReturn,
  isGiftCardPayment,
  isStillUsable,
  parseAmountToCents,
  sameStaffId,
  usableGiftOriginal,
  useGiftReturnTerminalIdentity,
  type UsableGiftOriginal,
} from "../../lib/gift-card-returns";
import { CashHandIcon } from '../icons/PaymentMethodIcons';

export interface RefundCompleteDetail {
  /** Set only for a confirmed native original-card gift return. */
  giftReturn?: {
    orderId: string;
    localPaymentId: string;
    returnKey: string;
  };
}

interface RefundVoidModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  orderTotal: number;
  orderStatus?: string;
  /** false only when the original requires the existing provider return path. */
  onRequestCancellation?: (orderId: string) => Promise<boolean>;
  /**
   * For a confirmed gift return the panel awaits this: `false` (or a rejection)
   * means the host could not reread the order, so fresh gift returns stay blocked.
   */
  onRefundComplete?: (
    detail?: RefundCompleteDetail,
  ) => void | boolean | Promise<void | boolean>;
  /**
   * Opened only to reach original-card gift returns (the header is no longer
   * paid): ordinary payment rows are shown read-only.
   */
  giftReturnOnly?: boolean;
}

interface PaymentRecord {
  id: string;
  order_id: string;
  method: string;
  amount: number;
  status: string;
  created_at: string;
  createdAt?: string;
  transaction_ref?: string;
  /**
   * The delivery platform's settlement row (shared rule R1): never voided or
   * refunded at the till; the server decides what becomes of it.
   */
  platformSettlement?: boolean;
}

interface PaymentBalance {
  verified?: boolean;
  originalAmount: number;
  totalRefunds: number;
  remaining: number;
  /**
   * The tender a refund of this payment names (shared rule R5): its own,
   * cash, card or other; an `other` tender is never guessed as cash.
   */
  defaultRefundMethod?: RefundTender | null;
  /**
   * Who hands a cash refund back by the rule (shared rule R2): the courier
   * while their earning on the order is still unsettled, else the drawer.
   * Shown, never chosen.
   */
  cashHandlerByRule?: "cashier_drawer" | "driver_shift";
}

const readRouteOrNull = (value: unknown): RefundTender | null | undefined =>
  value === "cash" || value === "card" || value === "other"
    ? value
    : value === null
      ? null
      : undefined;

const receiptTimestamp = (value: string): string => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
};

const readHandlerByRule = (
  value: unknown,
): "cashier_drawer" | "driver_shift" | undefined =>
  value === "cashier_drawer" || value === "driver_shift" ? value : undefined;

interface Adjustment {
  id: string;
  payment_id: string;
  adjustment_type: "refund" | "void";
  amount: number;
  reason: string;
  staff_id?: string;
  refundMethod?: RefundTender | null;
  cashHandler?: "cashier_drawer" | "driver_shift" | null;
  created_at: string;
}

const pickRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    const { data, adjustments } = result as {
      data?: unknown;
      adjustments?: unknown;
    };
    if (Array.isArray(data)) return data;
    if (Array.isArray(adjustments)) return adjustments;
  }
  return [];
};

const readRefundMethod = (value: unknown): Adjustment["refundMethod"] =>
  value === "cash" || value === "card" || value === "other"
    ? value
    : value === null
      ? null
      : undefined;

const readCashHandler = (value: unknown): Adjustment["cashHandler"] =>
  value === "cashier_drawer" || value === "driver_shift"
    ? value
    : value === null
      ? null
      : undefined;

/** Local adjustment rows arrive bare or wrapped, snake_case or camelCase. */
function normalizeAdjustments(result: unknown): Adjustment[] {
  return pickRows(result)
    .filter(
      (row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === "object",
    )
    .map((row) => {
      const staffId = row.staff_id ?? row.staffId;
      return {
        id: String(row.id ?? ""),
        payment_id: String(row.payment_id ?? row.paymentId ?? ""),
        adjustment_type: (row.adjustment_type ??
          row.adjustmentType) as Adjustment["adjustment_type"],
        amount: Number(row.amount ?? 0),
        reason: typeof row.reason === "string" ? row.reason : "",
        staff_id: typeof staffId === "string" ? staffId : undefined,
        refundMethod: readRefundMethod(
          row.refundMethod !== undefined ? row.refundMethod : row.refund_method,
        ),
        cashHandler: readCashHandler(
          row.cashHandler !== undefined ? row.cashHandler : row.cash_handler,
        ),
        created_at: String(row.created_at ?? row.createdAt ?? ""),
      };
    });
}

// -- Original-card gift return ------------------------------------------------

interface FrozenGiftRequest {
  action: GiftReturnAction;
  /** Integer cents for `refund`; null for `void`, which sends no amount. */
  amountCents: number | null;
  reason: string;
  currency: string;
  grossCents: number | null;
}

type GiftPhase =
  | { kind: "authorize" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; original: UsableGiftOriginal }
  | { kind: "blocked"; code: string | null; otherPending: boolean }
  | { kind: "review"; original: UsableGiftOriginal; request: FrozenGiftRequest }
  | { kind: "sending"; request: FrozenGiftRequest }
  | { kind: "retained"; view: GiftReturnView }
  | {
      kind: "unknown";
      request: FrozenGiftRequest | null;
      returnKey: string | null;
    }
  | { kind: "completed"; view: GiftReturnView; reread: "running" | "failed" };

interface GiftNotice {
  tone: "error" | "info" | "success";
  text: string;
}

/** The captured original of a lost reply, until status rediscovers or rules it out. */
interface LostGiftRequest {
  knownKeys: ReadonlySet<string>;
  request: FrozenGiftRequest | null;
}

const frozenFromView = (view: GiftReturnView): FrozenGiftRequest => ({
  action: view.action,
  amountCents: view.action === "void" ? null : view.requestedCents,
  reason: view.reason,
  currency: view.currency,
  grossCents: view.grossCents,
});

const matchesRequest = (
  view: GiftReturnView,
  request: FrozenGiftRequest,
): boolean =>
  view.action === request.action &&
  (request.action === "void" || view.requestedCents === request.amountCents) &&
  view.reason === request.reason;

/** Display only: native amounts are integer cents. */
const formatCents = (cents: number, currency: string) =>
  formatCurrency(cents / 100, currency);

/** A retained or unresolved original stays on screen until recovered. */
const keepRetained = (previous: GiftPhase, next: GiftPhase): GiftPhase =>
  previous.kind === "retained" || previous.kind === "unknown"
    ? previous
    : next;

/** One open instance of the dialog; a close intent or `isOpen=false` ends it. */
interface GiftSession {
  open: boolean;
}

interface GiftOriginalReturnPanelProps {
  orderId: string;
  payment: PaymentRecord;
  staffId: string | null;
  staffName: string | null;
  /** Held replies publish only while the dialog instance they started in is open. */
  sessionRef: { readonly current: GiftSession };
  onClose: () => void;
  /** Resolves once the host reread the order; false blocks fresh returns. */
  onCompleted: (view: GiftReturnView) => Promise<boolean>;
  /** Rereads the local rows and settlement; false blocks fresh returns. */
  rereadLocal: () => Promise<boolean>;
}

/**
 * Returns a gift card payment to the card that paid it through the native
 * `giftReturns` commands. Keyed by order, payment and selected staff, so any of
 * those changing remounts it and ends every held reply. No payout, attribution
 * or adjustment is written here.
 */
const GiftOriginalReturnPanel: React.FC<GiftOriginalReturnPanelProps> = ({
  orderId,
  payment,
  staffId,
  staffName,
  sessionRef,
  onClose,
  onCompleted,
  rereadLocal,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  const pinId = useId();
  const amountId = useId();
  const reasonId = useId();
  // The PIN field is uncontrolled: a PIN never enters React state and is cleared before any await.
  const pinRef = useRef<HTMLInputElement>(null);
  // Instance, terminal-lifecycle and authority fences: a held reply publishes only while all match.
  const aliveRef = useRef(false);
  const generationRef = useRef(0);
  const authorityRef = useRef(0);
  const busyRef = useRef(false);
  const busyTokenRef = useRef(0);
  const handledEpochRef = useRef(0);
  const lostRef = useRef<LostGiftRequest | null>(null);

  const [auth, setAuth] = useState<{
    staffId: string;
    usableUntil: string;
  } | null>(null);
  const [phase, setPhase] = useState<GiftPhase>({ kind: "authorize" });
  const [attempts, setAttempts] = useState<GiftReturnView[]>([]);
  const [notice, setNotice] = useState<GiftNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<GiftReturnAction>("refund");
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");

  const identity = useGiftReturnTerminalIdentity(() => {
    // Synchronous, before any held reply resolves: nothing from the old configuration publishes.
    generationRef.current += 1;
    authorityRef.current += 1;
  });

  useLayoutEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (identity.epoch === handledEpochRef.current) return;
    handledEpochRef.current = identity.epoch;
    // Clear every visible detail; the native original stays retained for its operator.
    lostRef.current = null;
    busyTokenRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setAuth(null);
    setAttempts([]);
    setPhase({ kind: "authorize" });
    setAmountText("");
    setReason("");
    setNotice({ tone: "info", text: t("modals.refund.gift.contextChanged") });
  }, [identity.epoch, t]);

  const staffLabel = staffName || staffId || "";

  const capture = () => {
    const generation = generationRef.current;
    const authority = authorityRef.current;
    const session = sessionRef.current;
    return () =>
      aliveRef.current &&
      session.open &&
      sessionRef.current === session &&
      generationRef.current === generation &&
      authorityRef.current === authority;
  };

  const clearAuthority = () => {
    authorityRef.current += 1;
    setAuth(null);
  };

  const closePanel = () => {
    // A held reply of this panel ends now, not at unmount.
    generationRef.current += 1;
    onClose();
  };

  const runExclusive = async (work: () => Promise<void>) => {
    // Nothing new starts once the dialog's close was requested.
    if (busyRef.current || !sessionRef.current.open) return;
    const token = ++busyTokenRef.current;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      if (aliveRef.current && busyTokenRef.current === token) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  /** Original-staff-bound status; only ever read after this operator's authorization. */
  const readStatus = async (
    actor: string,
    lost: LostGiftRequest | null = null,
  ) => {
    const current = capture();
    setPhase((previous) => keepRetained(previous, { kind: "loading" }));
    let response: GiftReturnStatusResponse | null = null;
    try {
      response = await bridge.giftReturns.status({ localPaymentId: payment.id });
    } catch {
      response = null;
    }
    if (!current()) return;
    if (
      !response ||
      response.success !== true ||
      response.contract !== "atomic_return_v1"
    ) {
      // Unavailable is not "nothing pending": fresh returns stay blocked, recovery stays.
      setPhase((previous) => keepRetained(previous, { kind: "unavailable" }));
      setNotice({ tone: "error", text: t("modals.refund.gift.unavailable") });
      return;
    }
    const { authorization, original, returns } = response;
    if (!authorization.active || !sameStaffId(authorization.staffId, actor)) {
      clearAuthority();
      setAttempts([]);
      setPhase((previous) => keepRetained(previous, { kind: "authorize" }));
      setNotice({ tone: "info", text: t("modals.refund.gift.authExpired") });
      return;
    }
    const binding = {
      localPaymentId: payment.id,
      localOrderId: orderId,
      staffId: actor,
    };
    const own = (Array.isArray(returns) ? returns : []).filter((view) =>
      isBoundGiftReturn(view, binding),
    );
    setAttempts(own);
    if (!original || original.localPaymentId !== payment.id) {
      setPhase((previous) => keepRetained(previous, { kind: "unavailable" }));
      setNotice({ tone: "error", text: t("modals.refund.gift.unavailable") });
      return;
    }
    const pendingKey = original.pendingReturnKey;
    if (pendingKey) {
      lostRef.current = null;
      const view = own.find(
        (attempt) =>
          attempt.returnKey === pendingKey && attempt.state === "pending",
      );
      setPhase(
        view
          ? { kind: "retained", view }
          : { kind: "unknown", request: lost?.request ?? null, returnKey: pendingKey },
      );
      return;
    }
    if (lost) {
      lostRef.current = null;
      // After a lost reply: an own attempt this panel had not seen is the original to recover.
      const discovered = own.find(
        (attempt) => !lost.knownKeys.has(attempt.returnKey),
      );
      if (discovered) {
        setPhase({ kind: "retained", view: discovered });
        return;
      }
      setNotice({ tone: "info", text: t("modals.refund.gift.noCapture") });
    }
    if (!original.eligible) {
      setPhase({
        kind: "blocked",
        code: original.code,
        otherPending: original.code === GIFT_RETURN_PENDING_EXISTS,
      });
      return;
    }
    const usable = usableGiftOriginal(original, payment.id);
    if (!usable) {
      setPhase({ kind: "unavailable" });
      setNotice({ tone: "error", text: t("modals.refund.gift.moneyUnavailable") });
      return;
    }
    setPhase(
      usable.remainingCents > 0
        ? { kind: "ready", original: usable }
        : { kind: "blocked", code: null, otherPending: false },
    );
  };

  /**
   * Rereads the local rows, then awaits the host's order reread. Null when the
   * panel was fenced meanwhile; false keeps fresh returns blocked behind a retry.
   */
  const rereadAfterCompletion = async (
    view: GiftReturnView,
    current: () => boolean,
  ): Promise<boolean | null> => {
    let reread = false;
    try {
      reread = await rereadLocal();
    } catch {
      reread = false;
    }
    if (!current()) return null;
    let refreshed = false;
    try {
      refreshed = await onCompleted(view);
    } catch {
      refreshed = false;
    }
    if (!current()) return null;
    return reread && refreshed;
  };

  const finishCompletion = async (view: GiftReturnView, proofCheck = false) => {
    lostRef.current = null;
    setPhase({ kind: "completed", view, reread: "running" });
    // A checked proof is an earlier return: its stored remainder may be out of date.
    setNotice({
      tone: "success",
      text: proofCheck
        ? t("modals.refund.gift.proofConfirmed", {
            amount: formatCents(view.proof?.returnedCents ?? 0, view.currency),
          })
        : t("modals.refund.gift.completed", {
            amount: formatCents(view.proof?.returnedCents ?? 0, view.currency),
            remaining: formatCents(view.proof?.remainingCents ?? 0, view.currency),
          }),
    });
    setAmountText("");
    setReason("");
    const reread = await rereadAfterCompletion(view, capture());
    if (reread === null) return;
    if (!reread) {
      setPhase({ kind: "completed", view, reread: "failed" });
      return;
    }
    // A second return is offered only from the refreshed native original.
    await readStatus(view.staffId);
  };

  const settle = async (
    response: GiftReturnResponse | null,
    context: {
      request: FrozenGiftRequest | null;
      actor: string;
      knownKeys: ReadonlySet<string>;
      returnKey?: string;
      proofCheck?: boolean;
    },
  ) => {
    const binding = {
      localPaymentId: payment.id,
      localOrderId: orderId,
      staffId: context.actor,
      returnKey: context.returnKey,
    };
    const completed = completedGiftReturn(response, binding);
    if (completed && (!context.request || matchesRequest(completed, context.request))) {
      await finishCompletion(completed, context.proofCheck === true);
      return;
    }
    const lost: LostGiftRequest = {
      knownKeys: context.knownKeys,
      request: context.request,
    };
    const markUnknown = () => {
      lostRef.current = lost;
      setPhase({
        kind: "unknown",
        request: context.request,
        returnKey: context.returnKey ?? null,
      });
    };
    if (
      response &&
      response.success === false &&
      (response.outcome === "refused" || response.outcome === "rejected")
    ) {
      lostRef.current = null;
      setNotice({
        tone: "error",
        text:
          response.outcome === "refused"
            ? t("modals.refund.gift.refused", { code: response.code, error: response.error })
            : t("modals.refund.gift.rejected", { code: response.code, error: response.error }),
      });
      // Not completion: reload native state before any fresh, deliberate attempt.
      setPhase({ kind: "loading" });
      await readStatus(context.actor);
      return;
    }
    if (
      response &&
      response.success === false &&
      (response.outcome === "pending" || response.outcome === "auth_required")
    ) {
      const view = isBoundGiftReturn(response.return, binding)
        ? response.return
        : null;
      if (view) {
        lostRef.current = null;
        setPhase({ kind: "retained", view });
      } else {
        markUnknown();
      }
      if (response.outcome === "auth_required") {
        clearAuthority();
        setNotice({
          tone: "info",
          text: t("modals.refund.gift.authRequired", { name: staffLabel }),
        });
      } else if (!view) {
        await readStatus(context.actor, lost);
      }
      return;
    }
    // A lost, thrown or unproven reply is neither success nor failure: rediscover the exact original.
    markUnknown();
    await readStatus(context.actor, lost);
  };

  const authorize = () => {
    const input = pinRef.current;
    const pin = input?.value ?? "";
    if (input) input.value = "";
    if (busyRef.current || !staffId || !identity.ready) return;
    if (!pin.trim()) {
      setNotice({ tone: "error", text: t("modals.refund.gift.pinRequired") });
      return;
    }
    const requested = staffId;
    void runExclusive(async () => {
      setNotice(null);
      const current = capture();
      let response: GiftReturnAuthorizeResponse | null = null;
      try {
        response = await bridge.giftReturns.authorize({ staffId: requested, pin });
      } catch {
        response = null;
      }
      if (!current()) return;
      if (
        !response ||
        response.success !== true ||
        response.contract !== "atomic_return_v1" ||
        !sameStaffId(response.staffId, requested) ||
        !isStillUsable(response.usableUntil)
      ) {
        setNotice({
          tone: "error",
          text: t("modals.refund.gift.authRefused", {
            error:
              response && response.success === false
                ? response.error
                : t("modals.refund.gift.authUnavailable"),
          }),
        });
        return;
      }
      authorityRef.current += 1;
      setAuth({ staffId: response.staffId, usableUntil: response.usableUntil });
      await readStatus(response.staffId, lostRef.current);
    });
  };

  const startReview = () => {
    if (busyRef.current || phase.kind !== "ready") return;
    const { original } = phase;
    const trimmedReason = reason.trim();
    let amountCents: number | null = null;
    if (action === "refund") {
      amountCents = parseAmountToCents(amountText);
      if (amountCents === null) {
        setNotice({ tone: "error", text: t("modals.refund.gift.invalidAmount") });
        return;
      }
      if (amountCents > original.remainingCents) {
        setNotice({
          tone: "error",
          text: t("modals.refund.gift.exceedsRemaining", {
            amount: formatCents(original.remainingCents, original.currency),
          }),
        });
        return;
      }
    }
    if (!trimmedReason) {
      setNotice({ tone: "error", text: t("modals.refund.gift.reasonRequired") });
      return;
    }
    setNotice(null);
    setPhase({
      kind: "review",
      original,
      request: {
        action,
        amountCents,
        reason: trimmedReason,
        currency: original.currency,
        grossCents: original.grossCents,
      },
    });
  };

  const submit = () => {
    if (busyRef.current || phase.kind !== "review") return;
    const { request } = phase;
    if (!auth || !isStillUsable(auth.usableUntil)) {
      clearAuthority();
      setPhase({ kind: "authorize" });
      setNotice({ tone: "info", text: t("modals.refund.gift.authExpired") });
      return;
    }
    let payload: GiftReturnBeginRequest;
    if (request.action === "void") {
      // A void never carries a client amount.
      payload = { localPaymentId: payment.id, action: "void", reason: request.reason };
    } else if (request.amountCents !== null) {
      payload = {
        localPaymentId: payment.id,
        action: "refund",
        amountCents: request.amountCents,
        reason: request.reason,
      };
    } else {
      return;
    }
    const actor = auth.staffId;
    const knownKeys = new Set(attempts.map((attempt) => attempt.returnKey));
    void runExclusive(async () => {
      setNotice(null);
      setPhase({ kind: "sending", request });
      const current = capture();
      let response: GiftReturnResponse | null = null;
      try {
        response = await bridge.giftReturns.begin(payload);
      } catch {
        response = null;
      }
      // A held reply after an order, staff or terminal change publishes nothing.
      if (!current()) return;
      await settle(response, { request, actor, knownKeys });
    });
  };

  const recoverTarget = (target: {
    returnKey: string;
    request: FrozenGiftRequest | null;
    owner: string | null;
    proofCheck?: boolean;
  }) => {
    if (busyRef.current) return;
    if (!auth || !isStillUsable(auth.usableUntil)) {
      clearAuthority();
      setNotice({
        tone: "info",
        text: t("modals.refund.gift.authRequired", { name: staffLabel }),
      });
      return;
    }
    // A retained original belongs to its recorded operator; nobody else recovers it.
    if (target.owner !== null && !sameStaffId(target.owner, auth.staffId)) return;
    const actor = auth.staffId;
    const knownKeys = new Set(
      attempts
        .map((attempt) => attempt.returnKey)
        .filter((key) => key !== target.returnKey),
    );
    void runExclusive(async () => {
      setNotice(null);
      const current = capture();
      let response: GiftReturnResponse | null = null;
      try {
        response = await bridge.giftReturns.recover({ returnKey: target.returnKey });
      } catch {
        response = null;
      }
      if (!current()) return;
      await settle(response, {
        request: target.request,
        actor,
        knownKeys,
        returnKey: target.returnKey,
        proofCheck: target.proofCheck,
      });
    });
  };

  const recover = () => {
    const target =
      phase.kind === "retained"
        ? {
            returnKey: phase.view.returnKey,
            request: frozenFromView(phase.view),
            owner: phase.view.staffId as string | null,
          }
        : phase.kind === "unknown" && phase.returnKey
          ? { returnKey: phase.returnKey, request: phase.request, owner: null }
          : null;
    if (target) recoverTarget(target);
  };

  /**
   * A completed own attempt whose reply may have been lost before a remount: native
   * recover of its retained key returns the stored proof without another send.
   * Fresh returns stay available.
   */
  const checkProof = (attempt: GiftReturnView) => {
    if (attempt.state !== "completed") return;
    recoverTarget({
      returnKey: attempt.returnKey,
      request: frozenFromView(attempt),
      owner: attempt.staffId,
      proofCheck: true,
    });
  };

  const checkStatus = () => {
    if (!auth) return;
    const actor = auth.staffId;
    void runExclusive(async () => {
      await readStatus(actor, lostRef.current);
    });
  };

  const retryReread = () => {
    if (phase.kind !== "completed" || phase.reread !== "failed") return;
    const { view } = phase;
    void runExclusive(async () => {
      setPhase({ kind: "completed", view, reread: "running" });
      const reread = await rereadAfterCompletion(view, capture());
      if (reread === null) return;
      if (!reread) {
        setPhase({ kind: "completed", view, reread: "failed" });
        return;
      }
      await readStatus(view.staffId);
    });
  };

  const actionLabel = (value: GiftReturnAction) =>
    value === "void"
      ? t("modals.refund.gift.actionVoid")
      : t("modals.refund.gift.actionRefund");

  const stateLabel = (state: GiftReturnView["state"]) =>
    state === "completed"
      ? t("modals.refund.gift.stateCompleted")
      : state === "refused"
        ? t("modals.refund.gift.stateRefused")
        : t("modals.refund.gift.statePending");

  const renderFrozen = (request: FrozenGiftRequest) => (
    <dl
      data-testid="gift-return-frozen"
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm"
    >
      <dt className="liquid-glass-modal-text-muted">
        {t("modals.refund.gift.reviewPayment")}
      </dt>
      <dd className="liquid-glass-modal-text break-all">
        {payment.id}
        {request.grossCents !== null
          ? ` · ${formatCents(request.grossCents, request.currency)}`
          : ""}
      </dd>
      <dt className="liquid-glass-modal-text-muted">
        {t("modals.refund.gift.reviewDestination")}
      </dt>
      <dd className="liquid-glass-modal-text">
        {t("modals.refund.gift.destinationValue")}
      </dd>
      <dt className="liquid-glass-modal-text-muted">
        {t("modals.refund.gift.reviewAction")}
      </dt>
      <dd className="liquid-glass-modal-text">{actionLabel(request.action)}</dd>
      <dt className="liquid-glass-modal-text-muted">
        {t("modals.refund.gift.reviewAmount")}
      </dt>
      <dd data-testid="gift-return-frozen-amount" className="liquid-glass-modal-text">
        {request.action === "void" || request.amountCents === null
          ? t("modals.refund.gift.voidNoAmount")
          : formatCents(request.amountCents, request.currency)}
      </dd>
      <dt className="liquid-glass-modal-text-muted">
        {t("modals.refund.gift.reviewCurrency")}
      </dt>
      <dd className="liquid-glass-modal-text">{request.currency}</dd>
      <dt className="liquid-glass-modal-text-muted">
        {t("modals.refund.gift.reviewReason")}
      </dt>
      <dd className="liquid-glass-modal-text wrap-break-word">{request.reason}</dd>
    </dl>
  );

  const renderOriginal = (original: UsableGiftOriginal) => (
    <dl
      data-testid="gift-return-original"
      className="grid grid-cols-3 gap-2 text-xs"
    >
      <div>
        <dt className="liquid-glass-modal-text-muted">{t("modals.refund.gift.gross")}</dt>
        <dd className="font-semibold liquid-glass-modal-text">
          {formatCents(original.grossCents, original.currency)}
        </dd>
      </div>
      <div>
        <dt className="liquid-glass-modal-text-muted">{t("modals.refund.gift.returned")}</dt>
        <dd className="font-semibold liquid-glass-modal-text">
          {formatCents(original.returnedCents, original.currency)}
        </dd>
      </div>
      <div>
        <dt className="liquid-glass-modal-text-muted">{t("modals.refund.gift.remaining")}</dt>
        <dd className="font-semibold liquid-glass-modal-text">
          {formatCents(original.remainingCents, original.currency)}
        </dd>
      </div>
    </dl>
  );

  const renderForm = (original: UsableGiftOriginal) => (
    <div data-testid="gift-return-form" className="space-y-3">
      {renderOriginal(original)}
      <div
        role="group"
        aria-label={t("modals.refund.gift.actionLabel")}
        className="flex gap-2"
      >
        {(["refund", "void"] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`gift-return-action-${value}`}
            aria-pressed={action === value}
            onClick={() => setAction(value)}
            disabled={busy}
            className={`flex-1 min-h-touch rounded-xl px-3 text-sm py-2 disabled:opacity-50 ${
              action === value
                ? "bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg) shadow-(--pos-s-depth-card) active:shadow-(--pos-s-depth-press)"
                : "pos-glass-field"
            }`}
          >
            {actionLabel(value)}
          </button>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {action === "refund" ? (
          <motion.div key="action-refund" {...revealMotion}>
            <label
              htmlFor={amountId}
              className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text-muted"
            >
              {t("modals.refund.gift.amountLabel", { currency: original.currency })}
            </label>
            <CentsMoneyInput
              id={amountId}
              data-testid="gift-return-amount"
              value={amountText}
              onValueChange={setAmountText}
              disabled={busy}
              placeholder="0,00"
              className="w-full p-3 rounded-lg liquid-glass-modal-input pos-glass-field min-h-touch focus:ring-2 focus:ring-purple-500 transition-all text-sm liquid-glass-modal-text"
            />
            <p className="text-xs liquid-glass-modal-text-muted mt-1">
              {t("modals.refund.gift.amountHint", {
                amount: formatCents(original.remainingCents, original.currency),
              })}
            </p>
          </motion.div>
        ) : (
          <motion.p key="action-refund-alternative" {...revealMotion}
            data-testid="gift-return-void-note"
            className="text-xs liquid-glass-modal-text-muted"
          >
            {t("modals.refund.gift.voidNote")}
          </motion.p>
        )}
      </AnimatePresence>
      <div>
        <label
          htmlFor={reasonId}
          className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text-muted"
        >
          {t("modals.refund.gift.reasonLabel")} *
        </label>
        <textarea
          id={reasonId}
          data-testid="gift-return-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("modals.refund.gift.reasonPlaceholder")}
          rows={2}
          disabled={busy}
          className="w-full p-3 rounded-lg liquid-glass-modal-input pos-glass-field min-h-touch focus:ring-2 focus:ring-purple-500 transition-all text-sm liquid-glass-modal-text resize-none"
        />
      </div>
      <button
        type="button"
        data-testid="gift-return-review"
        onClick={startReview}
        disabled={busy}
        className="w-full liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-purple-800 dark:text-purple-200 border-(--pos-s-border) gap-2 disabled:opacity-50"
      >
        {t("modals.refund.gift.review")}
      </button>
    </div>
  );

  const renderReview = (original: UsableGiftOriginal, request: FrozenGiftRequest) => (
    <div
      data-testid="gift-return-review-panel"
      className="pos-glass-form-card space-y-3 p-3!"
    >
      <div className="text-sm font-semibold liquid-glass-modal-text">
        {t("modals.refund.gift.reviewTitle")}
      </div>
      {renderFrozen(request)}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="gift-return-confirm"
          onClick={submit}
          disabled={busy}
          className="flex-1 liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-purple-800 dark:text-purple-200 border-(--pos-s-border) gap-2 disabled:opacity-50"
        >
          <Gift className="w-4 h-4" />
          {t("modals.refund.gift.confirm")}
        </button>
        <button
          type="button"
          data-testid="gift-return-back"
          onClick={() => setPhase({ kind: "ready", original })}
          disabled={busy}
          className="liquid-glass-modal-button"
        >
          {t("modals.refund.gift.back")}
        </button>
      </div>
    </div>
  );

  const renderRetained = (view: GiftReturnView) => {
    const priorUnreconciled = view.lastCode === GIFT_RETURN_PRIOR_UNRECONCILED;
    return (
      <div
        data-testid="gift-return-retained"
        className="pos-glass-form-card space-y-2 p-3!"
      >
        <div className="text-sm font-semibold text-amber-700 dark:text-amber-400">
          {view.state === "pending"
            ? t("modals.refund.gift.pendingTitle")
            : t("modals.refund.gift.foundTitle")}
          {" · "}
          {stateLabel(view.state)}
        </div>
        <p className="text-xs liquid-glass-modal-text-muted">
          {priorUnreconciled
            ? t("modals.refund.gift.priorUnreconciled")
            : t("modals.refund.gift.pendingBody")}
        </p>
        {renderFrozen(frozenFromView(view))}
        {auth && !priorUnreconciled && (
          <button
            type="button"
            data-testid="gift-return-recover"
            onClick={recover}
            disabled={busy}
            className="w-full liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-amber-800 dark:text-amber-200 border-(--pos-s-border) gap-2 disabled:opacity-50"
          >
            {t("modals.refund.gift.recover")}
          </button>
        )}
      </div>
    );
  };

  const renderUnknown = (request: FrozenGiftRequest | null, returnKey: string | null) => (
    <div
      data-testid="gift-return-unknown"
      className="pos-glass-form-card space-y-2 p-3!"
    >
      <div className="text-sm font-semibold text-amber-700 dark:text-amber-400">
        {t("modals.refund.gift.unknownTitle")}
      </div>
      <p className="text-xs liquid-glass-modal-text-muted">
        {t("modals.refund.gift.unknownBody")}
      </p>
      {request && renderFrozen(request)}
      <AnimatePresence initial={false}>
        {auth && (
          <motion.div key="auth" {...revealMotion} className="flex gap-2">
            {returnKey && (
              <button
                type="button"
                data-testid="gift-return-recover"
                onClick={recover}
                disabled={busy}
                className="flex-1 liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-amber-800 dark:text-amber-200 border-(--pos-s-border) gap-2 disabled:opacity-50"
              >
                {t("modals.refund.gift.recover")}
              </button>
            )}
            <button
              type="button"
              data-testid="gift-return-check-status"
              onClick={checkStatus}
              disabled={busy}
              className="flex-1 liquid-glass-modal-button disabled:opacity-50"
            >
              {t("modals.refund.gift.checkStatus")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  const noticeClass =
    notice?.tone === "error"
      ? "text-red-800 dark:text-red-300"
      : notice?.tone === "success"
        ? "text-green-800 dark:text-green-300"
        : "liquid-glass-modal-text";

  return (
    <section
      data-testid="gift-return-panel"
      aria-label={t("modals.refund.gift.title")}
      className="pos-glass-form-card space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gift className="w-5 h-5 text-purple-400" />
          <div>
            <div className="font-semibold liquid-glass-modal-text">
              {t("modals.refund.gift.title")}
            </div>
            <div className="text-xs liquid-glass-modal-text-muted">
              {t("modals.refund.gift.destination")}
            </div>
          </div>
        </div>
        <button
          type="button"
          data-testid="gift-return-close"
          onClick={closePanel}
          className="liquid-glass-modal-close shrink-0"
          aria-label={t("modals.refund.gift.close")}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <AnimatePresence initial={false}>

        {notice && (
          <motion.div key="notice" {...revealMotion}
            data-testid="gift-return-notice"
            role={notice.tone === "error" ? "alert" : "status"}
            className={`pos-glass-form-card px-3! py-2! text-sm ${noticeClass}`}
          >
            {notice.text}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>

        {!staffId ? (
          <motion.p key="staffid" {...revealMotion} data-testid="gift-return-no-staff" className="text-sm liquid-glass-modal-text-muted">
            {t("modals.refund.gift.noStaff")}
          </motion.p>
        ) : !auth ? (
          <motion.div key="gift-return-authorize-form" {...revealMotion} data-testid="gift-return-authorize-form" className="space-y-2">
            <label
              htmlFor={pinId}
              className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text-muted"
            >
              {t("modals.refund.gift.authorizeTitle", { name: staffLabel })}
            </label>
            <div className="flex gap-2">
              <input
                id={pinId}
                ref={pinRef}
                data-testid="gift-return-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                placeholder={t("modals.refund.gift.pinLabel")}
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") authorize();
                }}
                className="flex-1 p-3 rounded-lg liquid-glass-modal-input pos-glass-field min-h-touch focus:ring-2 focus:ring-purple-500 transition-all text-sm liquid-glass-modal-text"
              />
              <button
                type="button"
                data-testid="gift-return-authorize"
                onClick={authorize}
                disabled={busy || !identity.ready}
                className="liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-purple-800 dark:text-purple-200 border-(--pos-s-border) disabled:opacity-50"
              >
                {busy
                  ? t("modals.refund.gift.authorizing")
                  : t("modals.refund.gift.authorize")}
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>

        {phase.kind === "loading" && (
          <motion.p key="phase-kind-loading" {...revealMotion} data-testid="gift-return-loading" className="text-sm liquid-glass-modal-text-muted">
            {t("modals.refund.gift.loading")}
          </motion.p>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {phase.kind === "unavailable" && (
          <motion.div key="phase-kind-unavailable" {...revealMotion} data-testid="gift-return-unavailable" className="space-y-2">
            {auth && (
              <button
                type="button"
                data-testid="gift-return-check-status"
                onClick={checkStatus}
                disabled={busy}
                className="w-full liquid-glass-modal-button disabled:opacity-50"
              >
                {t("modals.refund.gift.retry")}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {phase.kind === "blocked" && (
          <motion.p key="phase-kind-blocked" {...revealMotion} data-testid="gift-return-blocked" className="text-sm liquid-glass-modal-text-muted">
            {phase.otherPending
              ? t("modals.refund.gift.otherPending")
              : phase.code
                ? t("modals.refund.gift.notEligible", { code: phase.code })
                : t("modals.refund.gift.nothingRemaining")}
          </motion.p>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {phase.kind === "ready" && auth && <motion.div key="phase-kind-ready-auth" {...revealMotion}>{renderForm(phase.original)}</motion.div>}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {phase.kind === "review" && auth && <motion.div key="phase-kind-review-auth" {...revealMotion}>{renderReview(phase.original, phase.request)}</motion.div>}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {phase.kind === "sending" && (
          <motion.div key="phase-kind-sending" {...revealMotion} data-testid="gift-return-sending" className="space-y-2">
            {renderFrozen(phase.request)}
            <p className="text-sm liquid-glass-modal-text-muted">
              {t("modals.refund.gift.sending")}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {phase.kind === "retained" && <motion.div key="phase-kind-retained" {...revealMotion}>{renderRetained(phase.view)}</motion.div>}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {phase.kind === "unknown" && <motion.div key="phase-kind-unknown" {...revealMotion}>{renderUnknown(phase.request, phase.returnKey)}</motion.div>}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {phase.kind === "completed" && (
          <motion.div key="phase-kind-completed" {...revealMotion} data-testid="gift-return-completed" className="space-y-2">
            <AnimatePresence initial={false}>
              {phase.reread === "running" ? (
                <motion.p key="phase-reread-running" {...revealMotion} className="text-sm liquid-glass-modal-text-muted">
                  {t("modals.refund.gift.rereading")}
                </motion.p>
              ) : (
                <>
                  <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                    {t("modals.refund.gift.rereadFailed")}
                  </p>
                  <button
                    type="button"
                    data-testid="gift-return-reread-retry"
                    onClick={retryReread}
                    disabled={busy}
                    className="w-full liquid-glass-modal-button disabled:opacity-50"
                  >
                    {t("modals.refund.gift.retry")}
                  </button>
                </>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>

        {auth && attempts.length > 0 && (
          <motion.div key="auth-attempts-length-0" {...revealMotion} data-testid="gift-return-attempts" className="space-y-1">
            <div className="text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
              {t("modals.refund.gift.attemptsTitle")}
            </div>
            {attempts.map((attempt) => (
              <div
                key={attempt.returnKey}
                className="flex justify-between gap-2 text-xs liquid-glass-modal-text-muted"
              >
                <span>
                  {stateLabel(attempt.state)} · {actionLabel(attempt.action)}
                </span>
                <span className="flex items-center gap-2">
                  <span>
                    {attempt.proof
                      ? formatCents(attempt.proof.returnedCents, attempt.currency)
                      : attempt.requestedCents !== null
                        ? formatCents(attempt.requestedCents, attempt.currency)
                        : "—"}
                  </span>
                  {attempt.state === "completed" && (
                    <button
                      type="button"
                      data-testid={`gift-return-proof-check-${attempt.returnKey}`}
                      onClick={() => checkProof(attempt)}
                      disabled={busy}
                      className="liquid-glass-modal-button px-2 py-1 text-xs disabled:opacity-50"
                    >
                      {t("modals.refund.gift.checkProof")}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};

const RefundVoidModal: React.FC<RefundVoidModalProps> = ({
  isOpen,
  onClose,
  orderId,
  orderTotal,
  orderStatus,
  onRequestCancellation,
  onRefundComplete,
  giftReturnOnly = false,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  const { staff, activeShift } = useShift();

  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [balances, setBalances] = useState<Record<string, PaymentBalance>>({});
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  // True when the order is paid but the payment was settled through a table
  // session/check, so there are no order-linked payment rows to adjust here.
  const [tableSettledPaid, setTableSettledPaid] = useState(false);

  // Refund form state (per-payment)
  const [activeRefundId, setActiveRefundId] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  // Shared rule R5: the refund names its tender; none until the form opens
  // on a payment (its own tender), and no refund is recorded without one.
  const [refundMethod, setRefundMethod] = useState<RefundTender | null>(null);

  // Void confirm state
  const [activeVoidId, setActiveVoidId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  // Original-card gift return: the exact gift row the operator selected.
  const [activeGift, setActiveGift] = useState<{
    orderId: string;
    payment: PaymentRecord;
  } | null>(null);

  // Adjustment history visibility
  const [showHistory, setShowHistory] = useState(false);

  const orderIdRef = useRef(orderId);
  useLayoutEffect(() => {
    orderIdRef.current = orderId;
  }, [orderId]);

  // One open instance. A close intent (buttons, backdrop, Escape) or isOpen=false
  // ends it synchronously, so a held gift reply cannot publish during the exit animation.
  const giftSessionRef = useRef<GiftSession>({ open: isOpen });
  useLayoutEffect(() => {
    giftSessionRef.current = { open: isOpen };
  }, [isOpen]);
  const fenceGiftSession = useCallback(() => {
    giftSessionRef.current.open = false;
  }, []);
  const requestClose = () => {
    fenceGiftSession();
    onClose();
  };

  const loadData = useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      if (!orderId) return false;
      const requestedOrderId = orderId;
      // A reply for an order this modal no longer shows is dropped.
      const isCurrent = () => orderIdRef.current === requestedOrderId;
      if (!options?.silent) setLoading(true);
      setTableSettledPaid(false);
      try {
        // Load payments for this order
        const orderPayments =
          await bridge.payments.getOrderPayments(requestedOrderId);
        if (!isCurrent()) return false;
        const rowsRead = Array.isArray(orderPayments);
        const paymentList: PaymentRecord[] = rowsRead
          ? orderPayments.map((payment: PaymentRecord) => ({
              ...payment,
              created_at: payment.created_at ?? payment.createdAt ?? '',
            }))
          : [];
        setPayments(paymentList);
        try {
          const order = await bridge.orders.getById(requestedOrderId);
          if (!isCurrent()) return false;

          // A dine-in/table order can be fully paid even though no payment row is
          // linked to the order id (the payment lives on the table session). Detect
          // that case so the UI can explain it instead of showing "No payments".
          const paymentStatus = String(
            (order as any)?.paymentStatus || (order as any)?.payment_status || "",
          ).toLowerCase();
          const paidAmount = Number(
            (order as any)?.paidAmount ?? (order as any)?.paid_amount ?? 0,
          );
          const looksPaid =
            [
              "paid",
              "completed",
              "partially_paid",
              "partially_refunded",
              "refunded",
            ].includes(paymentStatus) || paidAmount > 0;
          const tableLinked = Boolean(
            (order as any)?.tableSessionId ||
              (order as any)?.table_session_id ||
              (order as any)?.tableId ||
              (order as any)?.table_id ||
              String(
                (order as any)?.orderType || (order as any)?.order_type || "",
              ).toLowerCase() === "dine-in",
          );
          setTableSettledPaid(
            paymentList.length === 0 && looksPaid && tableLinked,
          );
        } catch {
          // The order's own fields only explain a table-settled payment.
        }

        // Load balance for each completed ordinary payment. Gift card rows are
        // excluded: their money and caps come only from the native original.
        const balanceMap: Record<string, PaymentBalance> = {};
        for (const p of paymentList) {
          if (p.status === "completed" && !isGiftCardPayment(p.method)) {
            try {
              const bal = await bridge.refunds.getPaymentBalance(p.id);
              if (bal) {
                balanceMap[p.id] = {
                  verified: true,
                  originalAmount: bal.originalAmount ?? p.amount,
                  totalRefunds: bal.totalRefunds ?? 0,
                  remaining: bal.remaining ?? p.amount - (bal.totalRefunds ?? 0),
                  defaultRefundMethod: readRouteOrNull(
                    (bal as { defaultRefundMethod?: unknown }).defaultRefundMethod,
                  ),
                  cashHandlerByRule: readHandlerByRule(
                    (bal as { cashHandlerByRule?: unknown }).cashHandlerByRule,
                  ),
                };
              }
            } catch {
              balanceMap[p.id] = {
                originalAmount: p.amount,
                totalRefunds: 0,
                remaining: 0,
              };
              toast.error(t("modals.refund.canonicalRefreshRequired"));
            }
          }
        }
        if (!isCurrent()) return false;
        setBalances(balanceMap);

        // Load adjustment history
        try {
          const adj = await bridge.refunds.listOrderAdjustments(requestedOrderId);
          if (isCurrent()) setAdjustments(normalizeAdjustments(adj));
        } catch {
          if (isCurrent()) setAdjustments([]);
        }
        return rowsRead && isCurrent();
      } catch (err) {
        console.error("Failed to load refund data:", err);
        toast.error(
          t("modals.refund.loadFailed", {
            defaultValue: "Failed to load payment data",
          }),
        );
        return false;
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [bridge, orderId, t],
  );

  /**
   * After a confirmed gift return: reread the local rows and the order's
   * settlement (one native SQLite read). Any failure blocks fresh returns.
   */
  const rereadAfterGiftReturn = useCallback(async (): Promise<boolean> => {
    const requestedOrderId = orderId;
    const [rowsRead, settlementRead] = await Promise.all([
      loadData({ silent: true }),
      Promise.resolve()
        .then(() => bridge.payments.getSettlementSnapshot(requestedOrderId))
        .then(
          (snapshot) =>
            snapshot?.success === true && snapshot.orderId === requestedOrderId,
        )
        .catch(() => false),
    ]);
    return rowsRead && settlementRead && orderIdRef.current === requestedOrderId;
  }, [bridge, loadData, orderId]);

  // The refund, void or gift return has committed: a cancellation offer that fails (a snapshot
  // read, a table preflight offline) must never report the confirmed return as failed. The
  // order's own Cancel stays available. Android parity: PaymentsBridge.refund.
  const offerCancellationAfterReturn = async () => {
    if (!onRequestCancellation || !['completed', 'delivered'].includes(String(orderStatus).toLowerCase())) return;
    const requestedOrderId = orderId;
    try {
      const snapshot = await bridge.payments.getSettlementSnapshot(requestedOrderId);
      if (orderIdRef.current === requestedOrderId && giftSessionRef.current.open &&
          snapshot?.success === true && snapshot.orderId === requestedOrderId && snapshot.netPaid === 0) {
        await onRequestCancellation(requestedOrderId);
      }
    } catch (error) {
      console.warn('Returned order cancellation offer unavailable', error);
    }
  };

  const handleGiftReturnCompleted = useCallback(
    async (view: GiftReturnView): Promise<boolean> => {
      // Only for the order this modal still shows; the panel fenced the reply already.
      if (view.localOrderId !== orderIdRef.current) return false;
      // Awaited: a host that could not reread the order answers false.
      const refreshed = await onRefundComplete?.({
        giftReturn: {
          orderId: view.localOrderId,
          localPaymentId: view.localPaymentId,
          returnKey: view.returnKey,
        },
      });
      if (refreshed !== false) await offerCancellationAfterReturn();
      return refreshed !== false;
    },
    [onRefundComplete, onRequestCancellation, orderId, orderStatus],
  );

  useEffect(() => {
    if (isOpen) {
      loadData();
      // Reset form state on open
      setActiveRefundId(null);
      setActiveVoidId(null);
      setActiveGift(null);
      setRefundAmount("");
      setRefundReason("");
      setRefundMethod(null);
      setVoidReason("");
      setShowHistory(false);
    }
  }, [isOpen, loadData]);

  const isGiftPaymentId = (paymentId: string) =>
    isGiftCardPayment(payments.find((p) => p.id === paymentId)?.method);

  const handleRefund = async (paymentId: string) => {
    // Gift card rows return only to the original card, never through ordinary refunds.
    if (isGiftPaymentId(paymentId)) return;
    const amount = parseFloat(refundAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error(
        t("modals.refund.invalidAmount", {
          defaultValue: "Enter a valid refund amount",
        }),
      );
      return;
    }
    if (!refundReason.trim()) {
      toast.error(
        t("modals.refund.reasonRequired", {
          defaultValue: "A reason is required",
        }),
      );
      return;
    }
    // Shared rule R5: a refund always names its tender.
    if (!refundMethod) {
      toast.error(
        t("modals.refund.tenderRequired", {
          defaultValue: "Choose how the refund was paid back",
        }),
      );
      return;
    }

    const balance = balances[paymentId];
    if (balance && amount > balance.remaining + 0.01) {
      toast.error(
        t("modals.refund.exceedsBalance", {
          defaultValue: "Amount exceeds remaining balance",
        }),
      );
      return;
    }

    setProcessing(true);
    try {
      if (onRequestCancellation && refundFinishesCompletedOrder({
        status: orderStatus, payments, balances, paymentId, amount,
      }) && await onRequestCancellation(orderId)) return;
      const attribution = resolveAdjustmentAttribution({
        databaseStaffId: staff?.databaseStaffId,
        shiftStaffOwnerId: activeShift?.staff_id,
        staffShiftId: activeShift?.id,
        candidateStaffIds: [staff?.staffId],
      });
      const result = await bridge.refunds.refundPayment({
        paymentId,
        amount,
        reason: refundReason.trim(),
        staffId: attribution.staffId,
        staffShiftId: attribution.staffShiftId,
        orderId,
        // R5: a refund names its tender (an `other` tender is never sent as
        // cash unless the cashier chose it). R2: who handed cash back is the
        // till's rule, never sent from here.
        refundMethod,
        adjustmentContext: "manual",
      });

      if (result?.success !== false && !result?.error) {
        toast.success(
          t("modals.refund.refundSuccess", {
            defaultValue: "Refund recorded successfully",
          }),
        );
        setActiveRefundId(null);
        setRefundAmount("");
        setRefundReason("");
        await loadData();
        await onRefundComplete?.();
        await offerCancellationAfterReturn();
      } else {
        toast.error(
          refundVoidErrorMessage(
            result?.error,
            t,
            t("modals.refund.refundFailed", { defaultValue: "Refund failed" }),
          ),
        );
      }
    } catch (err) {
      toast.error(
        refundVoidErrorMessage(
          err,
          t,
          t("modals.refund.refundFailed", { defaultValue: "Refund failed" }),
        ),
      );
    } finally {
      setProcessing(false);
    }
  };

  const handleVoid = async (paymentId: string) => {
    // Gift card rows are voided only through the original-card return.
    if (isGiftPaymentId(paymentId)) return;
    if (!voidReason.trim()) {
      toast.error(
        t("modals.refund.reasonRequired", {
          defaultValue: "A reason is required",
        }),
      );
      return;
    }

    setProcessing(true);
    try {
      const attribution = resolveAdjustmentAttribution({
        databaseStaffId: staff?.databaseStaffId,
        shiftStaffOwnerId: activeShift?.staff_id,
        staffShiftId: activeShift?.id,
        candidateStaffIds: [staff?.staffId],
      });
      const result = await bridge.payments.voidPayment(
        paymentId,
        voidReason.trim(),
        attribution.staffId,
        attribution.staffShiftId,
      );

      if (result?.success !== false && !result?.error) {
        toast.success(
          t("modals.refund.voidSuccess", {
            defaultValue: "Payment voided successfully",
          }),
        );
        setActiveVoidId(null);
        setVoidReason("");
        await loadData();
        await onRefundComplete?.();
        await offerCancellationAfterReturn();
      } else {
        toast.error(
          refundVoidErrorMessage(
            result?.error,
            t,
            t("modals.refund.voidFailed", { defaultValue: "Void failed" }),
          ),
        );
      }
    } catch (err) {
      toast.error(
        refundVoidErrorMessage(
          err,
          t,
          t("modals.refund.voidFailed", { defaultValue: "Void failed" }),
        ),
      );
    } finally {
      setProcessing(false);
    }
  };

  const getMethodIcon = (method: string) => {
    if (isGiftCardPayment(method)) {
      return <Gift className="w-5 h-5 text-purple-400" />;
    }
    switch (method?.toLowerCase()) {
      case "cash":
        return <CashHandIcon className="w-5 h-5 text-green-700 dark:text-green-400" />;
      case "card":
        return <CreditCard className="w-5 h-5 text-blue-600 dark:text-blue-400" />;
      default:
        return <Clock className="w-5 h-5 liquid-glass-modal-text-muted" />;
    }
  };

  const getMethodLabel = (method: string) =>
    isGiftCardPayment(method)
      ? t("modals.refund.gift.methodLabel")
      : method || t("common.unknown", { defaultValue: "Unknown" });

  const getStatusBadge = (status: string) => {
    switch (status?.toLowerCase()) {
      case "completed":
        return (
          <span className="text-xs px-2 py-0.5 rounded-full bg-(--pos-s-surface-2) text-green-800 dark:text-green-300 border border-(--pos-s-border)">
            {t("modals.refund.statusCompleted", { defaultValue: "Completed" })}
          </span>
        );
      case "voided":
        return (
          <span className="text-xs px-2 py-0.5 rounded-full bg-(--pos-s-surface-2) text-red-800 dark:text-red-300 border border-(--pos-s-border)">
            {t("modals.refund.statusVoided", { defaultValue: "Voided" })}
          </span>
        );
      case "refunded":
        return (
          <span className="text-xs px-2 py-0.5 rounded-full bg-(--pos-s-surface-2) text-yellow-800 dark:text-yellow-300 border border-(--pos-s-border)">
            {t("modals.refund.statusRefunded", { defaultValue: "Refunded" })}
          </span>
        );
      // Set aside as a possible duplicate: not money, never voided or
      // refunded from here. The Z-report lists it until a manager confirms
      // it was given back.
      case "duplicate_review":
        return (
          <span className="text-xs px-2 py-0.5 rounded-full bg-(--pos-s-surface-2) text-amber-800 dark:text-amber-200 border border-(--pos-s-border)">
            {t("modals.refund.statusSetAside", { defaultValue: "Set aside for review" })}
          </span>
        );
      default:
        return (
          <span className="text-xs px-2 py-0.5 rounded-full liquid-glass-modal-text-muted">
            {status}
          </span>
        );
    }
  };

  const completedPayments = payments.filter((p) => p.status === "completed");
  const nonCompletedPayments = payments.filter((p) => p.status !== "completed");
  const giftPaymentIds = new Set(
    payments.filter((p) => isGiftCardPayment(p.method)).map((p) => p.id),
  );

  const modalHeader = (
    <div className="shrink-0 px-6 py-4">
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1">
          <h2 className="text-2xl font-bold liquid-glass-modal-text">
            {t("modals.refund.title", { defaultValue: "Void / Refund" })}
          </h2>
          <p className="text-sm liquid-glass-modal-text-muted mt-1">
            {t("modals.refund.subtitle", {
              defaultValue: "Manage payment adjustments",
            })}{" "}
            &middot;{" "}
            {t("modals.refund.orderTotal", { defaultValue: "Order total" })}:{" "}
            {formatCurrency(orderTotal)}
          </p>
        </div>
        <button
          onClick={requestClose}
          className="liquid-glass-modal-close shrink-0"
          aria-label={t("common.actions.close")}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  const modalFooter = (
    <div className="shrink-0 px-6 pb-5 pt-2">
      <button
        data-testid="refund-modal-close"
        onClick={requestClose}
        className="w-full liquid-glass-modal-button liquid-glass-modal-text gap-2"
      >
        {t("common.actions.close", { defaultValue: "Close" })}
      </button>
    </div>
  );

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      onCloseIntent={fenceGiftSession}
      size="lg"
      className="max-w-3xl!"
      contentClassName="p-0 overflow-hidden"
      ariaLabel={t("modals.refund.title", { defaultValue: "Void / Refund" })}
      header={modalHeader}
      footer={modalFooter}
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 min-h-0 scrollbar-hide">
        {activeGift && activeGift.orderId === orderId && (
          <div className="mb-4">
            <GiftOriginalReturnPanel
              key={`${orderId}|${activeGift.payment.id}|${staff?.staffId ?? ""}`}
              orderId={orderId}
              payment={activeGift.payment}
              staffId={staff?.staffId ?? null}
              staffName={staff?.name ?? null}
              sessionRef={giftSessionRef}
              onClose={() => setActiveGift(null)}
              onCompleted={handleGiftReturnCompleted}
              rereadLocal={rereadAfterGiftReturn}
            />
          </div>
        )}
        <AnimatePresence initial={false}>
          {loading ? (
            <motion.div key="loading" {...revealMotion} className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-500" />
            </motion.div>
          ) : payments.length === 0 ? (
            <motion.div key="payment-view-1" {...revealMotion} className="text-center py-12">
              <CreditCard className="w-12 h-12 mx-auto mb-3 liquid-glass-modal-text-muted opacity-50" />
              <AnimatePresence initial={false}>
                {tableSettledPaid ? (
                  <>
                    <p className="text-sm font-semibold liquid-glass-modal-text">
                      {t("modals.refund.tableSettledTitle", {
                        defaultValue: "Paid on the table check",
                      })}
                    </p>
                    <p className="mx-auto mt-2 max-w-md text-sm liquid-glass-modal-text-muted">
                      {t("modals.refund.tableSettledBody", {
                        defaultValue:
                          "This order was settled through its table session, so there is no order-level payment to void or refund here. Reopen the table check to adjust or refund the payment.",
                      })}
                    </p>
                  </>
                ) : (
                  <motion.p key="tablesettledpaid-alternative" {...revealMotion} className="text-sm liquid-glass-modal-text-muted">
                    {t("modals.refund.noPayments", {
                      defaultValue: "No payments found for this order",
                    })}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>
          ) : (
            <motion.div key="payment-view-2" {...revealMotion} className="space-y-4">
              {/* Active (completed) payments */}
              <AnimatePresence initial={false}>
                {completedPayments.length > 0 && (
                  <motion.div key="completedpayments-length-0" {...revealMotion} className="space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                      {t("modals.refund.activePayments", {
                        defaultValue: "Active Payments",
                      })}
                    </h3>
                    {completedPayments.map((payment) => {
                      const balance = balances[payment.id];
                      const isRefunding = activeRefundId === payment.id;
                      const isVoiding = activeVoidId === payment.id;
                      const isGift = isGiftCardPayment(payment.method);

                      return (
                        <div
                          key={payment.id}
                          data-testid={`refund-payment-${payment.id}`}
                          className="pos-glass-form-card space-y-3"
                        >
                          {/* Payment row */}
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              {getMethodIcon(payment.method)}
                              <div>
                                <div className="font-semibold liquid-glass-modal-text capitalize">
                                  {getMethodLabel(payment.method)}
                                </div>
                                <div className="text-xs liquid-glass-modal-text-muted">
                                  {receiptTimestamp(payment.created_at)}
                                </div>
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-bold liquid-glass-modal-text">
                                {formatCurrency(payment.amount)}
                              </div>
                              <AnimatePresence initial={false}>
                                {balance && balance.totalRefunds > 0 && (
                                  <motion.div key="refundbal" {...revealMotion} className="text-xs text-yellow-700 dark:text-yellow-400">
                                    {t("modals.refund.statusRefunded", {
                                      defaultValue: "Refunded",
                                    })}
                                    : {formatCurrency(balance.totalRefunds)} &middot;{" "}
                                    {t("modals.refund.remaining", {
                                      defaultValue: "Remaining",
                                    })}
                                    : {formatCurrency(balance.remaining)}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                              {getStatusBadge(payment.status)}
                            </div>
                          </div>

                          {/* Gift card rows: only the original-card return */}
                          <AnimatePresence initial={false}>
                            {isGift && (
                              <motion.div key="isgift" {...revealMotion} className="flex gap-2 pt-1">
                                <button
                                  type="button"
                                  data-testid={`gift-return-open-${payment.id}`}
                                  onClick={() => setActiveGift({ orderId, payment })}
                                  disabled={
                                    processing ||
                                    (activeGift?.orderId === orderId &&
                                      activeGift.payment.id === payment.id)
                                  }
                                  className="flex-1 liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-purple-800 dark:text-purple-200 border-(--pos-s-border) gap-2 text-sm py-2 disabled:opacity-50"
                                >
                                  <Gift className="w-4 h-4" />
                                  {t("modals.refund.gift.action")}
                                </button>
                              </motion.div>
                            )}
                          </AnimatePresence>

                          {/* R1: the platform's settlement row is never reversed here */}
                          <AnimatePresence initial={false}>
                            {!isGift && !giftReturnOnly && payment.platformSettlement === true && (
                              <motion.div key="isgift-giftreturnonly-payment-platformsettlement-true" {...revealMotion}
                                data-testid={`refund-platform-settlement-${payment.id}`}
                                className="pos-glass-form-card px-3! py-2! text-xs liquid-glass-modal-text-muted"
                              >
                                {t("modals.refund.platformSettlementLocked", {
                                  defaultValue:
                                    "The delivery platform's settlement: it is never voided or refunded at the till. The server decides what becomes of it.",
                                })}
                              </motion.div>
                            )}
                          </AnimatePresence>

                          {/* Action buttons */}
                          <AnimatePresence initial={false}>
                            {!isGift && !giftReturnOnly && payment.platformSettlement !== true && !isRefunding && !isVoiding && (
                              <motion.div key="isgift-giftreturnonly-payment-platformsettlement-true-isrefunding-isvoiding" {...revealMotion} className="flex gap-2 pt-1">
                                <button
                                  onClick={() => {
                                    setActiveVoidId(payment.id);
                                    setActiveRefundId(null);
                                    setVoidReason("");
                                  }}
                                  disabled={processing || !balance || balance.remaining <= 0 || balance.totalRefunds > 0}
                                  className="flex-1 liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-red-800 dark:text-red-300 border-(--pos-s-border) gap-2 text-sm py-2 disabled:opacity-50"
                                >
                                  <XCircle className="w-4 h-4" />
                                  {t("modals.refund.voidButton", {
                                    defaultValue: "Void",
                                  })}
                                </button>
                                <button
                                  onClick={() => {
                                    setActiveRefundId(payment.id);
                                    setActiveVoidId(null);
                                    const bal = balances[payment.id];
                                    // R5: the payment's own tender, never a guessed
                                    // cash drawer refund.
                                    setRefundMethod(
                                      refundFormDefaults(payment, bal).refundMethod,
                                    );
                                    setRefundAmount(
                                      bal
                                        ? bal.remaining.toFixed(2)
                                        : payment.amount.toFixed(2),
                                    );
                                    setRefundReason("");
                                  }}
                                  disabled={
                                    processing || (balance && balance.remaining <= 0)
                                  }
                                  className="flex-1 liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-orange-800 dark:text-orange-300 border-(--pos-s-border) gap-2 text-sm py-2 disabled:opacity-50"
                                >
                                  <RotateCcw className="w-4 h-4" />
                                  {t("modals.refund.refundButton", {
                                    defaultValue: "Refund",
                                  })}
                                </button>
                              </motion.div>
                            )}
                          </AnimatePresence>

                          {/* Void form */}
                          <AnimatePresence initial={false}>
                            {isVoiding && !isGift && (
                              <motion.div key="isvoiding-isgift" {...revealMotion} className="pos-glass-form-card space-y-3 mt-3">
                                <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
                                  <AlertTriangle className="w-4 h-4" />
                                  <span className="font-medium">
                                    {t("modals.refund.voidWarning", {
                                      defaultValue:
                                        "This will fully reverse the payment of",
                                    })}{" "}
                                    {formatCurrency(payment.amount)}
                                  </span>
                                </div>
                                <textarea
                                  value={voidReason}
                                  onChange={(e) => setVoidReason(e.target.value)}
                                  placeholder={t("modals.refund.reasonPlaceholder", {
                                    defaultValue: "Enter reason for void...",
                                  })}
                                  rows={2}
                                  className="w-full p-3 rounded-lg liquid-glass-modal-input pos-glass-field min-h-touch focus:ring-2 focus:ring-red-500 transition-all text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted resize-none"
                                />
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => handleVoid(payment.id)}
                                    disabled={processing || !voidReason.trim()}
                                    className="flex-1 liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-red-800 dark:text-red-300 border-(--pos-s-border) gap-2 disabled:opacity-50"
                                  >
                                    <XCircle className="w-4 h-4" />
                                    {processing
                                      ? t("common.loading", {
                                          defaultValue: "Processing...",
                                        })
                                      : t("modals.refund.confirmVoid", {
                                          defaultValue: "Confirm Void",
                                        })}
                                  </button>
                                  <button
                                    onClick={() => {
                                      setActiveVoidId(null);
                                      setVoidReason("");
                                    }}
                                    disabled={processing}
                                    className="liquid-glass-modal-button"
                                  >
                                    {t("common.actions.cancel", {
                                      defaultValue: "Cancel",
                                    })}
                                  </button>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>

                          {/* Refund form */}
                          <AnimatePresence initial={false}>
                            {isRefunding && !isGift && (
                              <motion.div key="isrefunding-isgift" {...revealMotion} className="pos-glass-form-card space-y-3 mt-3">
                                <div>
                                  <label className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text-muted">
                                    <CashHandIcon className="w-4 h-4 inline mr-1" />
                                    {t("modals.refund.refundAmount", {
                                      defaultValue: "Refund Amount",
                                    })}
                                  </label>
                                  <div className="relative">
                                    <CentsMoneyInput
                                      aria-label={t("modals.refund.refundAmount", {
                                        defaultValue: "Refund Amount",
                                      })}
                                      value={refundAmount}
                                      onValueChange={setRefundAmount}
                                      placeholder="0,00"
                                      className="w-full p-3 pl-10 rounded-lg liquid-glass-modal-input pos-glass-field min-h-touch focus:ring-2 focus:ring-orange-500 transition-all text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted"
                                    />
                                    <CashHandIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 liquid-glass-modal-text-muted" />
                                  </div>
                                  <AnimatePresence initial={false}>
                                    {balance && (
                                      <motion.p key="balance" {...revealMotion} className="text-xs liquid-glass-modal-text-muted mt-1">
                                        {t("modals.refund.maxRefund", {
                                          defaultValue: "Maximum refundable: {{amount}}",
                                          amount: formatCurrency(balance.remaining),
                                        })}
                                      </motion.p>
                                    )}
                                  </AnimatePresence>
                                </div>
                                <div>
                                  <label className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text-muted">
                                    {t("modals.refund.reason", {
                                      defaultValue: "Reason",
                                    })}{" "}
                                    *
                                  </label>
                                  <textarea
                                    value={refundReason}
                                    onChange={(e) => setRefundReason(e.target.value)}
                                    placeholder={t(
                                      "modals.refund.reasonPlaceholder",
                                      { defaultValue: "Enter reason for refund..." },
                                    )}
                                    rows={2}
                                    className="w-full p-3 rounded-lg liquid-glass-modal-input pos-glass-field min-h-touch focus:ring-2 focus:ring-orange-500 transition-all text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted resize-none"
                                  />
                                </div>
                                <RefundAttributionFields
                                  refundMethod={refundMethod}
                                  onRefundMethodChange={setRefundMethod}
                                  allowOtherTender={
                                    refundRouteForTender(payment.method) === "other"
                                  }
                                  cashHandler={
                                    refundFormDefaults(payment, balances[payment.id])
                                      .cashHandler
                                  }
                                  disabled={processing}
                                />
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => handleRefund(payment.id)}
                                    disabled={
                                      processing ||
                                      !refundMethod ||
                                      !refundReason.trim() ||
                                      !refundAmount ||
                                      parseFloat(refundAmount) <= 0
                                    }
                                    className="flex-1 liquid-glass-modal-button bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-orange-800 dark:text-orange-300 border-(--pos-s-border) gap-2 disabled:opacity-50"
                                  >
                                    <RotateCcw className="w-4 h-4" />
                                    {processing
                                      ? t("common.loading", {
                                          defaultValue: "Processing...",
                                        })
                                      : t("modals.refund.confirmRefund", {
                                          defaultValue: "Confirm Refund",
                                        })}
                                  </button>
                                  <button
                                    onClick={() => {
                                      setActiveRefundId(null);
                                      setRefundAmount("");
                                      setRefundReason("");
                                      setRefundMethod(null);
                                    }}
                                    disabled={processing}
                                    className="liquid-glass-modal-button"
                                  >
                                    {t("common.actions.cancel", {
                                      defaultValue: "Cancel",
                                    })}
                                  </button>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Non-active (voided/refunded) payments */}
              <AnimatePresence initial={false}>
                {nonCompletedPayments.length > 0 && (
                  <motion.div key="noncompletedpayments-length-0" {...revealMotion} className="space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                      {t("modals.refund.closedPayments", {
                        defaultValue: "Voided / Refunded",
                      })}
                    </h3>
                    {nonCompletedPayments.map((payment) => (
                      <div
                        key={payment.id}
                        className="pos-glass-form-card opacity-60"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {getMethodIcon(payment.method)}
                            <div>
                              <div className="font-semibold liquid-glass-modal-text capitalize">
                                {isGiftCardPayment(payment.method)
                                  ? t("modals.refund.gift.methodLabel")
                                  : payment.method || "Unknown"}
                              </div>
                              <div className="text-xs liquid-glass-modal-text-muted">
                                {receiptTimestamp(payment.created_at)}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold liquid-glass-modal-text line-through">
                              {formatCurrency(payment.amount)}
                            </div>
                            {getStatusBadge(payment.status)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Adjustment History */}
              <AnimatePresence initial={false}>
                {adjustments.length > 0 && (
                  <motion.div key="adjustments-length-0" {...revealMotion} className="space-y-3">
                    <button
                      onClick={() => setShowHistory(!showHistory)}
                      className="pos-glass-field min-h-touch flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-wider"
                    >
                      {showHistory ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                      {t("modals.refund.adjustmentHistory", {
                        defaultValue: "Adjustment History",
                      })}
                      <span className="text-xs liquid-glass-modal-badge ml-1">
                        {adjustments.length}
                      </span>
                    </button>
                    <AnimatePresence initial={false}>
                      {showHistory && (
                        <motion.div key="showhistory" {...revealMotion} className="space-y-3">
                          {adjustments.map((adj) => (
                            <div
                              key={adj.id}
                              data-testid={`refund-adjustment-${adj.id}`}
                              className="pos-glass-form-card p-3!"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  {adj.adjustment_type === "void" ? (
                                    <XCircle className="w-4 h-4 text-red-700 dark:text-red-400" />
                                  ) : (
                                    <RotateCcw className="w-4 h-4 text-orange-700 dark:text-orange-400" />
                                  )}
                                  <span
                                    className={`text-sm font-medium ${
                                      adj.adjustment_type === "void"
                                        ? "text-red-700 dark:text-red-400"
                                        : "text-orange-700 dark:text-orange-400"
                                    }`}
                                  >
                                    {adj.adjustment_type === "void"
                                      ? t("modals.refund.voidLabel", {
                                          defaultValue: "VOID",
                                        })
                                      : t("modals.refund.refundLabel", {
                                          defaultValue: "REFUND",
                                        })}
                                  </span>
                                </div>
                                <span
                                  className={`font-bold ${
                                    adj.adjustment_type === "void"
                                      ? "text-red-700 dark:text-red-400"
                                      : "text-orange-700 dark:text-orange-400"
                                  }`}
                                >
                                  -{formatCurrency(adj.amount)}
                                </span>
                              </div>
                              <div className="mt-1 text-xs liquid-glass-modal-text-muted">
                                {adj.reason}
                              </div>
                              <AnimatePresence initial={false}>
                                {giftPaymentIds.has(adj.payment_id) && !adj.refundMethod ? (
                                  // A native gift return has no cash/card method: it went back to the original card, never a cash payout.
                                  <motion.div key="giftpaymentids-has-adj-payment_id-adj-refundmethod" {...revealMotion} className="mt-1 text-xs liquid-glass-modal-text-muted opacity-80">
                                    {t("modals.refund.gift.historyLabel")}
                                  </motion.div>
                                ) : (
                                  adj.adjustment_type === "refund" && (
                                    <motion.div key="payment-view-3" {...revealMotion} className="mt-1 text-xs liquid-glass-modal-text-muted opacity-80">
                                      {adj.refundMethod === "card"
                                        ? t("modals.refund.cardRefund", {
                                            defaultValue: "Card Refund",
                                          })
                                        : adj.refundMethod === "other"
                                        ? t("modals.refund.otherRefund", {
                                            defaultValue: "Same tender (other)",
                                          })
                                        : !adj.refundMethod && !adj.cashHandler
                                          ? null
                                          : adj.cashHandler === "driver_shift"
                                          ? t("modals.refund.driverCash", {
                                              defaultValue: "Driver Cash",
                                            })
                                          : t("modals.refund.cashierCash", {
                                              defaultValue: "Cashier Cash",
                                            })}
                                    </motion.div>
                                  )
                                )}
                              </AnimatePresence>
                              <div className="mt-1 text-xs liquid-glass-modal-text-muted opacity-60">
                                {receiptTimestamp(adj.created_at)}
                              </div>
                            </div>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </LiquidGlassModal>
  );
};

export default RefundVoidModal;
