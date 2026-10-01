import { AlertTriangle, Banknote, CreditCard, RotateCcw, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { UnsettledPaymentBlocker } from "../../../lib/ipc-contracts";
import {
  getLocalizedPaymentBlockerFix,
  getLocalizedPaymentBlockerReason,
  getLocalizedPaymentMethod,
  getLocalizedPaymentStatus,
  isPaymentsNeedReviewBlocker,
  isPaymentsNotSavedBlocker,
  paymentBlockerKey,
} from "../../../lib/payment-integrity";
import { formatCurrency, formatDateTime } from "../../utils/format";
import { setAsideResolvingKey } from "../../utils/paymentSetAside";
import { unsavedResolvingKey, unsavedSavingKey } from "../../utils/unsavedPayments";

interface UnsettledPaymentBlockersPanelProps {
  blockers: UnsettledPaymentBlocker[];
  title?: string;
  helperText?: string;
  className?: string;
  onResolveBlocker?: (
    blocker: UnsettledPaymentBlocker,
    method: "cash" | "card",
  ) => void;
  /**
   * "Money given back to the customer" for a payment set aside as a possible
   * duplicate (`payments_need_review`). The caller confirms and authorizes.
   */
  onResolveSetAsidePayment?: (blocker: UnsettledPaymentBlocker) => void;
  /**
   * "Save payment again" for a card charged on this till whose payment is
   * not saved yet (`payments_not_saved`): the same write, no new charge.
   */
  onSaveUnsavedPayment?: (blocker: UnsettledPaymentBlocker) => void;
  /**
   * "Money given back to the customer" for a card charged and never saved.
   * The caller confirms and authorizes.
   */
  onResolveUnsavedPayment?: (blocker: UnsettledPaymentBlocker) => void;
  resolvingKey?: string | null;
}

function getMethodBadgeClasses(method: string): string {
  switch (method) {
    case "cash":
      return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200";
    case "card":
      return "border-zinc-300/25 bg-white/[0.06] text-zinc-100";
    case "split":
      return "border-amber-400/30 bg-amber-500/10 text-amber-200";
    default:
      return "border-amber-400/30 bg-amber-500/10 text-amber-200";
  }
}

function getMethodIcon(method: string) {
  if (method === "cash") {
    return <Banknote className="h-3.5 w-3.5" />;
  }
  if (method === "card") {
    return <CreditCard className="h-3.5 w-3.5" />;
  }
  return <AlertTriangle className="h-3.5 w-3.5" />;
}

/**
 * `payments_not_saved` for a card charged at new-order checkout whose order
 * this till has not written yet (`new_order`, `new_order_cannot_save`).
 */
export function isNewOrderCheckoutBlocker(blocker: UnsettledPaymentBlocker): boolean {
  return (
    blocker.reasonCode === "payments_not_saved" &&
    typeof blocker.reasonVariant === "string" &&
    blocker.reasonVariant.startsWith("new_order")
  );
}

export function UnsettledPaymentBlockersPanel({
  blockers,
  title,
  helperText,
  className = "",
  onResolveBlocker,
  onResolveSetAsidePayment,
  onSaveUnsavedPayment,
  onResolveUnsavedPayment,
  resolvingKey = null,
}: UnsettledPaymentBlockersPanelProps) {
  const { t } = useTranslation();

  if (!Array.isArray(blockers) || blockers.length === 0) {
    return null;
  }

  return (
    <div
      className={`rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 shadow-[0_12px_28px_rgba(245,158,11,0.12)] ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-full border border-amber-400/35 bg-amber-500/15 p-2 text-amber-200">
          <AlertTriangle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-extrabold uppercase tracking-[0.18em] text-amber-100">
            {title ||
              t("paymentIntegrity.blockersTitle", {
                defaultValue: "Payment Integrity Blockers",
              })}
          </div>
          <p className="mt-1 text-sm font-medium text-amber-50/90">
            {helperText ||
              t("paymentIntegrity.blockersHelper", {
                defaultValue:
                  "These orders must be repaired before this action can continue.",
              })}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {blockers.map((blocker) => {
          const outstanding = Math.max(
            Number(blocker.totalAmount || 0) - Number(blocker.settledAmount || 0),
            0,
          );
          // Reason codes the operator must NOT "resolve here" by recording a
          // cash/card payment.
          //
          // `platform_settlement_missing` looks like a plain outstanding
          // balance — order total, nothing settled — but the money is sitting
          // with efood/Wolt, not in the till. Offering the cash/card buttons
          // would invite exactly the guess the 16/09/2026 reconciliation work
          // exists to prevent: platform-held money booked as drawer cash,
          // which then never reconciles at close. The same applies to a
          // settlement recorded in the wrong tender — that one needs a void,
          // not more money.
          // A set-aside payment is money to give BACK, never money to take;
          // a card charged but not saved is money already taken: never again.
          const NON_TENDER_REASON_CODES = [
            "unsupported_payment_method",
            "platform_settlement_missing",
            "platform_settlement_mismatch",
            "overpaid_order",
            "duplicate_payment",
            "payments_need_review",
            "payments_not_saved",
            // A cancelled order still labelled paid (item D7, a warning): its
            // record is restored from the server or the owner decides; money
            // is never recorded on a cancelled order from here.
            "cancelled_order_claims_payment",
          ];
          const reviewPayment = isPaymentsNeedReviewBlocker(blocker)
            ? blocker.reviewPayment
            : undefined;
          const unsavedPayment = isPaymentsNotSavedBlocker(blocker)
            ? blocker.unsavedPayment
            : undefined;
          // Shared rule R4 (round 3, 01/10/2026): an order whose money the
          // delivery platform holds is never offered "Record the payment":
          // the money is restored from the server (Sync Now), never taken at
          // the till (the server refuses it, and the loop starts again).
          const canResolveHere =
            typeof onResolveBlocker === "function" &&
            outstanding > 0.009 &&
            blocker.platformHeld !== true &&
            !NON_TENDER_REASON_CODES.includes(blocker.reasonCode);
          const preferredMethod =
            blocker.reasonCode === "missing_cash_payment" ||
            blocker.reasonCode === "partial_cash_payment" ||
            blocker.paymentMethod === "cash"
              ? "cash"
              : blocker.reasonCode === "missing_card_payment" ||
                  blocker.reasonCode === "partial_card_payment" ||
                  blocker.paymentMethod === "card"
                ? "card"
                : null;
          const resolveMethods = preferredMethod
            ? ([preferredMethod] as const)
            : (["cash", "card"] as const);
          return (
            <div
              key={paymentBlockerKey(blocker)}
              data-testid={
                reviewPayment
                  ? `set-aside-payment-${reviewPayment.paymentId}`
                  : unsavedPayment
                    ? `unsaved-payment-${unsavedPayment.idempotencyKey}`
                    : undefined
              }
              className="rounded-2xl border border-white/10 bg-slate-950/40 p-4"
            >
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <div className="text-lg font-black text-white">
                    {/* A card charged at new-order checkout whose order is not
                        written yet (item E): no order number exists. */}
                    {isNewOrderCheckoutBlocker(blocker)
                      ? t("payment.notSaved.newOrder", {
                          defaultValue: "New order, not saved yet",
                        })
                      : blocker.orderNumber}
                  </div>
                  <div className="mt-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {t("paymentIntegrity.reasonLabel", {
                      defaultValue: "Reason",
                    })}
                  </div>
                  <div className="mt-1 text-sm font-medium text-slate-100">
                    {getLocalizedPaymentBlockerReason(blocker, t, formatCurrency)}
                  </div>
                </div>

                {reviewPayment ? (
                <div className="grid gap-2 sm:grid-cols-3 xl:min-w-[330px]">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.setAsidePaymentLabel", {
                        defaultValue: "Set-aside payment",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-amber-200">
                      {formatCurrency(reviewPayment.amount || 0)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.takenAtLabel", {
                        defaultValue: "Taken at",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-white">
                      {reviewPayment.takenAt
                        ? formatDateTime(reviewPayment.takenAt, {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "-"}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.totalLabel", {
                        defaultValue: "Total",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-white">
                      {formatCurrency(blocker.totalAmount || 0)}
                    </div>
                  </div>
                </div>
                ) : unsavedPayment ? (
                <div className="grid gap-2 sm:grid-cols-3 xl:min-w-[330px]">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.unsavedPaymentLabel", {
                        defaultValue: "Charged, not saved",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-red-200">
                      {formatCurrency(unsavedPayment.amount || 0)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.chargedAtLabel", {
                        defaultValue: "Charged at",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-white">
                      {unsavedPayment.capturedAt
                        ? formatDateTime(unsavedPayment.capturedAt, {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "-"}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.totalLabel", {
                        defaultValue: "Total",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-white">
                      {formatCurrency(blocker.totalAmount || 0)}
                    </div>
                  </div>
                </div>
                ) : (
                <div className="grid gap-2 sm:grid-cols-3 xl:min-w-[330px]">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.totalLabel", {
                        defaultValue: "Total",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-white">
                      {formatCurrency(blocker.totalAmount || 0)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.settledLabel", {
                        defaultValue: "Settled",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-emerald-300">
                      {formatCurrency(blocker.settledAmount || 0)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.outstandingLabel", {
                        defaultValue: "Outstanding",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-amber-200">
                      {formatCurrency(outstanding)}
                    </div>
                  </div>
                </div>
                )}
              </div>

              <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${getMethodBadgeClasses(
                      blocker.paymentMethod || "",
                    )}`}
                  >
                    {getMethodIcon(blocker.paymentMethod || "")}
                    {getLocalizedPaymentMethod(blocker.paymentMethod || "pending", t)}
                  </span>
                  <span className="inline-flex rounded-full border border-slate-400/20 bg-slate-500/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-200">
                    {reviewPayment
                      ? getLocalizedPaymentStatus("duplicate_review", t)
                      : unsavedPayment
                        ? getLocalizedPaymentStatus("not_saved", t)
                        : getLocalizedPaymentStatus(blocker.paymentStatus || "pending", t)}
                  </span>
                </div>

                <div className="rounded-2xl border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-50 xl:max-w-[60%]">
                  <span className="mr-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-200/80">
                    {t("paymentIntegrity.fixLabel", {
                      defaultValue: "Fix",
                    })}
                  </span>
                  {getLocalizedPaymentBlockerFix(blocker, t, formatCurrency)}
                </div>
              </div>

              {reviewPayment && typeof onResolveSetAsidePayment === "function" && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={Boolean(resolvingKey)}
                    onClick={() => onResolveSetAsidePayment(blocker)}
                    className={`inline-flex min-h-[44px] items-center gap-2 rounded-2xl border border-transparent bg-amber-400 px-3 py-2 text-sm font-semibold text-slate-950 transition-transform active:scale-[0.98] active:bg-amber-300 ${
                      resolvingKey ? "cursor-not-allowed opacity-60" : ""
                    }`}
                    aria-busy={resolvingKey === setAsideResolvingKey(reviewPayment.paymentId)}
                  >
                    <Undo2 className="h-4 w-4" />
                    {resolvingKey === setAsideResolvingKey(reviewPayment.paymentId)
                      ? t("paymentIntegrity.setAsideResolving", {
                          defaultValue: "Recording...",
                        })
                      : t("paymentIntegrity.setAsideReturnedAction", {
                          defaultValue: "Money given back to the customer",
                        })}
                  </button>
                </div>
              )}

              {unsavedPayment && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {unsavedPayment.canSaveAgain && typeof onSaveUnsavedPayment === "function" && (
                    <button
                      type="button"
                      disabled={Boolean(resolvingKey)}
                      onClick={() => onSaveUnsavedPayment(blocker)}
                      className={`inline-flex min-h-[44px] items-center gap-2 rounded-2xl border border-transparent bg-emerald-400 px-3 py-2 text-sm font-semibold text-slate-950 transition-transform active:scale-[0.98] active:bg-emerald-300 ${
                        resolvingKey ? "cursor-not-allowed opacity-60" : ""
                      }`}
                      aria-busy={resolvingKey === unsavedSavingKey(unsavedPayment.idempotencyKey)}
                    >
                      <RotateCcw className="h-4 w-4" />
                      {resolvingKey === unsavedSavingKey(unsavedPayment.idempotencyKey)
                        ? t("paymentIntegrity.unsavedSaving", {
                            defaultValue: "Saving...",
                          })
                        : t("paymentIntegrity.unsavedSaveAgainAction", {
                            defaultValue: "Save payment again",
                          })}
                    </button>
                  )}
                  {typeof onResolveUnsavedPayment === "function" && (
                    <button
                      type="button"
                      disabled={Boolean(resolvingKey)}
                      onClick={() => onResolveUnsavedPayment(blocker)}
                      className={`inline-flex min-h-[44px] items-center gap-2 rounded-2xl border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-sm font-semibold text-amber-100 transition-transform active:scale-[0.98] active:bg-amber-500/25 ${
                        resolvingKey ? "cursor-not-allowed opacity-60" : ""
                      }`}
                      aria-busy={resolvingKey === unsavedResolvingKey(unsavedPayment.idempotencyKey)}
                    >
                      <Undo2 className="h-4 w-4" />
                      {resolvingKey === unsavedResolvingKey(unsavedPayment.idempotencyKey)
                        ? t("paymentIntegrity.unsavedResolving", {
                            defaultValue: "Recording...",
                          })
                        : t("paymentIntegrity.unsavedReturnedAction", {
                            defaultValue: "Money given back to the customer",
                          })}
                    </button>
                  )}
                </div>
              )}

              {canResolveHere && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {resolveMethods.map((method) => {
                    const buttonKey = `${blocker.orderId}:${method}`;
                    const isResolving = resolvingKey === buttonKey;
                    const isBusy = Boolean(resolvingKey) && resolvingKey !== buttonKey;
                    const isPreferred = preferredMethod === method;
                    const baseClasses = isPreferred
                      ? method === "cash"
                        ? "border-transparent bg-emerald-500 text-slate-950 active:bg-emerald-400"
                        : "border-transparent bg-amber-400 text-slate-950 active:bg-amber-300"
                      : "border-white/10 bg-white/[0.04] text-white active:bg-white/[0.08]";
                    const icon =
                      method === "cash" ? (
                        <Banknote className="h-4 w-4" />
                      ) : (
                        <CreditCard className="h-4 w-4" />
                      );

                    return (
                      <button
                        key={buttonKey}
                        type="button"
                        disabled={Boolean(resolvingKey)}
                        onClick={() => onResolveBlocker?.(blocker, method)}
                        className={`inline-flex min-h-[44px] items-center gap-2 rounded-2xl border px-3 py-2 text-sm font-semibold transition-transform active:scale-[0.98] ${baseClasses} ${
                          Boolean(resolvingKey)
                            ? "cursor-not-allowed opacity-60"
                            : ""
                        }`}
                        aria-busy={isResolving}
                      >
                        {icon}
                        {isResolving
                          ? t("modals.zReport.resolvingPayment")
                          : t(
                              method === "cash"
                                ? "modals.zReport.resolveBlockerCash"
                                : "modals.zReport.resolveBlockerCard",
                              {
                                amount: formatCurrency(outstanding),
                              },
                            )}
                        {isBusy ? null : (
                          <span className="text-xs opacity-80">
                            {formatCurrency(outstanding)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default UnsettledPaymentBlockersPanel;
