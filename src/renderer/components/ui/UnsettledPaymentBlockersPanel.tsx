import { AlertTriangle, Banknote, CreditCard } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { UnsettledPaymentBlocker } from "../../../lib/ipc-contracts";
import { formatCurrency } from "../../utils/format";

interface UnsettledPaymentBlockersPanelProps {
  blockers: UnsettledPaymentBlocker[];
  title?: string;
  helperText?: string;
  className?: string;
  onResolveBlocker?: (
    blocker: UnsettledPaymentBlocker,
    method: "cash" | "card",
  ) => void;
  resolvingKey?: string | null;
}

function getMethodBadgeClasses(method: string): string {
  switch (method) {
    case "cash":
      return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200";
    case "card":
      return "border-sky-400/30 bg-sky-500/10 text-sky-200";
    case "split":
      return "border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200";
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

export function UnsettledPaymentBlockersPanel({
  blockers,
  title,
  helperText,
  className = "",
  onResolveBlocker,
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
          const canResolveHere =
            typeof onResolveBlocker === "function" &&
            outstanding > 0.009 &&
            blocker.reasonCode !== "unsupported_payment_method";
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
          return (
            <div
              key={`${blocker.orderId}-${blocker.reasonCode}`}
              className="rounded-2xl border border-white/10 bg-slate-950/40 p-4"
            >
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <div className="text-lg font-black text-white">
                    {blocker.orderNumber}
                  </div>
                  <div className="mt-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {t("paymentIntegrity.reasonLabel", {
                      defaultValue: "Reason",
                    })}
                  </div>
                  <div className="mt-1 text-sm font-medium text-slate-100">
                    {blocker.reasonText}
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-3 xl:min-w-[330px]">
                  <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.totalLabel", {
                        defaultValue: "Total",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-white">
                      {formatCurrency(blocker.totalAmount || 0)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {t("paymentIntegrity.settledLabel", {
                        defaultValue: "Settled",
                      })}
                    </div>
                    <div className="mt-2 text-sm font-bold text-emerald-300">
                      {formatCurrency(blocker.settledAmount || 0)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3">
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
              </div>

              <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${getMethodBadgeClasses(
                      blocker.paymentMethod || "",
                    )}`}
                  >
                    {getMethodIcon(blocker.paymentMethod || "")}
                    {blocker.paymentMethod || "pending"}
                  </span>
                  <span className="inline-flex rounded-full border border-slate-400/20 bg-slate-500/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-200">
                    {blocker.paymentStatus || "pending"}
                  </span>
                </div>

                <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-100 xl:max-w-[60%]">
                  <span className="mr-2 text-xs font-bold uppercase tracking-[0.18em] text-cyan-200/80">
                    {t("paymentIntegrity.fixLabel", {
                      defaultValue: "Fix",
                    })}
                  </span>
                  {blocker.suggestedFix}
                </div>
              </div>

              {canResolveHere && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {(["cash", "card"] as const).map((method) => {
                    const buttonKey = `${blocker.orderId}:${method}`;
                    const isResolving = resolvingKey === buttonKey;
                    const isBusy = Boolean(resolvingKey) && resolvingKey !== buttonKey;
                    const isPreferred = preferredMethod === method;
                    const baseClasses = isPreferred
                      ? method === "cash"
                        ? "border-transparent bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                        : "border-transparent bg-sky-500 text-slate-950 hover:bg-sky-400"
                      : "border-white/10 bg-white/[0.04] text-white hover:bg-white/[0.08]";
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
                        className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${baseClasses} ${
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
