import { useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getBridge } from "../../../lib";

import {
  resolvePlatformHeldNotice,
  type CoverageOrderInput,
  type PlatformHeldNoticeKind,
} from "../../../../../shared/platforms/payment-coverage";

/**
 * Tells the operator, in words, why there is nothing to collect here.
 *
 * Founder request (16/09/2026). The write paths already REFUSE a cash/card row
 * on platform-held money (`payments::record_payment_in_connection`,
 * `persistCanonicalOrderPayment`, `PaymentService.assertOrderIsStoreCollectable`),
 * but a refusal the operator meets as a generic error at the counter, with a
 * customer waiting, is a bad way to learn it. This is the same answer said out
 * loud, before they try.
 *
 * PRESENTATION ONLY. It decides nothing: `resolvePlatformHeldNotice` reads the
 * platform's own disposition through the existing collectability logic, so the
 * banner and the refusal cannot disagree.
 *
 * It is deliberately NOT a function of `payment_status`. That field answers
 * what the ledger has proved, and a failed settlement honestly lowers it to
 * `pending` — exactly the moment the operator most needs to be told not to
 * collect.
 */

/** The order fields the notice needs. A superset is fine. */
export type PlatformHeldNoticeOrder = Pick<
  CoverageOrderInput,
  "id" | "platform" | "externalPlatformOrderId" | "ghostMetadata"
>;

export function usePlatformHeldNotice(
  order: PlatformHeldNoticeOrder | null | undefined,
): PlatformHeldNoticeKind | null {
  if (!order) {
    return null;
  }
  return resolvePlatformHeldNotice(order as CoverageOrderInput);
}

/**
 * Same answer, resolved from the order id alone.
 *
 * The collect surfaces receive only an `orderId`, and the operator can reach
 * them several ways (order details, the dashboard, a table check, an auto-open
 * on mount). Threading the disposition through every call site would leave the
 * one path nobody remembered showing a generic refusal at the counter, so the
 * banner fetches it itself.
 *
 * Fails OPEN on a read error: this is presentation, and the write paths still
 * refuse the collection. Never guesses a notice it could not read.
 */
export function usePlatformHeldNoticeForOrderId(
  orderId: string | null | undefined,
  enabled = true,
): PlatformHeldNoticeKind | null {
  const [notice, setNotice] = useState<PlatformHeldNoticeKind | null>(null);

  useEffect(() => {
    if (!enabled || !orderId) {
      setNotice(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const raw: any = await getBridge().orders.getById(orderId);
        const order = raw?.data ?? raw?.order ?? raw;
        if (cancelled || !order || typeof order !== "object") {
          return;
        }
        setNotice(
          resolvePlatformHeldNotice({
            id: orderId,
            platform: order.plugin ?? order.platform ?? null,
            externalPlatformOrderId:
              order.external_plugin_order_id ?? order.externalPluginOrderId ?? null,
            ghostMetadata: order.ghost_metadata ?? order.ghostMetadata ?? null,
          }),
        );
      } catch {
        // Presentation only; the refusal still holds in the write paths.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, orderId]);

  return notice;
}

interface PlatformHeldPaymentNoticeProps {
  /** The order, when the surface already has it. */
  order?: PlatformHeldNoticeOrder | null;
  /** Or the already-resolved notice, from `usePlatformHeldNoticeForOrderId`. */
  notice?: PlatformHeldNoticeKind | null;
  /** Adds the "collection is disabled" line, for collect/payment surfaces. */
  showBlockedAction?: boolean;
  className?: string;
}

export function PlatformHeldPaymentNotice({
  order,
  notice: providedNotice,
  showBlockedAction = false,
  className = "",
}: PlatformHeldPaymentNoticeProps) {
  const { t } = useTranslation();
  const derived = usePlatformHeldNotice(order);
  const notice = providedNotice ?? derived;

  if (!notice) {
    return null;
  }

  // Two shapes, one meaning: do not take money from this customer. The
  // unsynced one adds why the day will also refuse to close.
  const unsynced = notice === "platform_settlement_unsynced";
  const title = unsynced
    ? t("payment.platformHeld.unsyncedTitle", {
        defaultValue: "Platform payment not yet reconciled",
      })
    : t("payment.platformHeld.title", {
        defaultValue: "Payment already collected by the platform",
      });
  const body = unsynced
    ? t("payment.platformHeld.unsyncedBody", {
        defaultValue:
          "The platform has collected the payment, but the record of that collection has not synced yet. Do not collect from the customer again. The day cannot be closed until the reconciliation completes.",
      })
    : t("payment.platformHeld.body", {
        defaultValue:
          "The payment has been collected by the platform. Do not take cash or card from the customer.",
      });

  const tone = unsynced
    ? "border-amber-400/40 bg-amber-500/10 text-amber-100"
    : "border-emerald-400/35 bg-emerald-500/10 text-emerald-100";

  return (
    <div
      data-platform-held-notice={notice}
      role="status"
      className={`rounded-2xl border p-3.5 ${tone} ${className}`}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">
          {unsynced ? (
            <AlertTriangle className="h-4 w-4" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-black">{title}</div>
          <p className="mt-1 text-xs font-semibold leading-relaxed opacity-90">
            {body}
          </p>
          {showBlockedAction && (
            <p className="mt-1.5 text-xs font-bold opacity-80">
              {t("payment.platformHeld.blockedAction", {
                defaultValue: "Collection is disabled for this order.",
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
