import type {
  PaymentSettlementSnapshot,
  RecordPaymentResult,
} from "../ipc-adapter";

// Compile-time contract for the structured native failure variants consumed by
// recovery UI. Keeping this as a normal .ts module makes `npm run type-check`
// validate it even though Vitest test files are excluded from the app tsconfig.
export function assertRecordPaymentFailureContract(
  result: RecordPaymentResult,
): void {
  const paymentApproved: boolean | undefined = result.paymentApproved;
  const paymentPersisted: boolean | undefined = result.paymentPersisted;
  const requiresReconciliation: boolean | undefined =
    result.requiresReconciliation;
  const fiscalCheckout:
    | {
        success: boolean;
        approved: boolean;
        requiresReconciliation?: boolean;
        error?: string;
        transaction?: Record<string, unknown>;
      }
    | undefined = result.fiscalCheckout;
  const settlement:
    | Omit<PaymentSettlementSnapshot, "success" | "orderId">
    | undefined = result.settlement;

  void paymentApproved;
  void paymentPersisted;
  void requiresReconciliation;
  void fiscalCheckout;
  void settlement;
}
