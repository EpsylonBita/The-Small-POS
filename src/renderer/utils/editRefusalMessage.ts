/** Fixed native refusal classes; never show SQL/I/O detail to the cashier. */
export function editRefusalMessageKey(code: string): string {
  if (/EDIT_DISCARD_MONEY_DECLARED/.test(code)) return 'editDiscardMoneyGuidance';
  if (/EDIT_DISCARD_PROVIDER_CHECK_REQUIRED/.test(code)) return 'editDiscardProviderCheck';
  if (/EDIT_LOCAL_STORAGE_(?:BUSY|LOCKED)/.test(code)) return 'editStorageBusy';
  if (/EDIT_LOCAL_STORAGE_CONSTRAINT/.test(code)) return 'editStorageConstraint';
  if (/EDIT_LOCAL_STORAGE_IO/.test(code)) return 'editStorageIo';
  if (/EDIT_LOCAL_STORAGE_OTHER/.test(code)) return 'editLocalOperationFailed';
  if (/PAYMENT_ORDER_NOT_FOUND/.test(code)) return 'editOrderNotFound';
  if (/PAYMENT_GHOST_ORDER/.test(code)) return 'editGhostOrder';
  if (/PAYMENT_COLLECTOR_NOT_DRAWER_OWNER/.test(code)) return 'editCollectorNotDrawerOwner';
  if (/(?:PAYMENT|REFUND)_INVALID_REQUEST|EDIT_INVALID_(?:REQUEST|DELIVERY_COORDINATES|ORDER_TYPE)/.test(code)) return 'editInvalidDetails';
  if (/(?:PAYMENT|REFUND)_DRIVER_EARNING_REQUIRED/.test(code)) return 'editDriverSettlementUnavailable';
  if (/REFUND_PAYMENT_NOT_FOUND/.test(code)) return 'editOriginalPaymentUnavailable';
  if (/REFUND_PAYMENT_(?:VOIDED|SET_ASIDE)/.test(code)) return 'editRefundOriginalUnavailable';
  if (/REFUND_IDEMPOTENCY_CONFLICT/.test(code)) return 'editRefundIdentityConflict';
  if (/REFUND_AMOUNT_EXCEEDS_BALANCE/.test(code)) return 'editRefundBalanceChanged';
  if (/MANUAL_CANCEL_UNAVAILABLE/.test(code)) return 'editCancellationUnavailable';
  if (/MANUAL_CANCEL_(?:PROVIDER_CONNECTED|ORIGINAL_PROVIDER_REQUIRED)/.test(code)) return 'editOriginalProviderRequired';
  if (/EDIT_SETTLEMENT_RECONCILIATION_REQUIRED/.test(code)) return 'editReconciliationRequired';
  if (/EDIT_SETTLEMENT_BUSY/.test(code)) return 'editSettlementBusy';
  if (/EDIT_NO_DRAWER_OWNER_ON_SHIFT/.test(code)) return 'editNoDrawerOwnerOnShift';
  if (/OPERATING_CURRENCY_BRANCH_MISMATCH/.test(code)) return 'editScopeChanged';
  if (/(?:CURRENCY_UNAVAILABLE|CURRENCY_SETTLEMENT_REQUIRED)/.test(code)) return 'editCurrencyUnavailable';
  if (/CURRENCY_(?:MISMATCH|MIXED)/.test(code)) return 'editCurrencyMismatch';
  if (/PAYMENT_COLLECTOR_|EDIT_PAYMENT_COLLECTOR_UNAVAILABLE|CASHIER_REQUIRED|UNSUPPORTED_SHIFT_ROLE/.test(code)) return 'editCollectorUnavailable';
  if (/EDIT_(?:COLLECTION|REFUND)_AMOUNT_MISMATCH|PAYMENT_RECOVERY_IDENTITY_MISMATCH/.test(code)) return 'editPaymentMismatch';
  if (/EDIT_LOCAL_OPERATION_FAILED|EDIT_SETTLEMENT_OUTCOME_UNKNOWN/.test(code)) return 'editLocalOperationFailed';
  if (/SCOPE_|TERMINAL_(?:BINDING_UNAVAILABLE|SCOPE_UNAVAILABLE|REBIND_PENDING|TRANSITION_PENDING)/.test(code)) return 'editScopeChanged';
  return 'editFailed';
}
