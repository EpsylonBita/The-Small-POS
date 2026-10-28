/** Fixed native refusal classes; never show SQL/I/O detail to the cashier. */
export function editRefusalMessageKey(code: string): string {
  if (/OPERATING_CURRENCY_BRANCH_MISMATCH/.test(code)) return 'editScopeChanged';
  if (/(?:CURRENCY_UNAVAILABLE|CURRENCY_SETTLEMENT_REQUIRED)/.test(code)) return 'editCurrencyUnavailable';
  if (/CURRENCY_(?:MISMATCH|MIXED)/.test(code)) return 'editCurrencyMismatch';
  if (/PAYMENT_COLLECTOR_|EDIT_PAYMENT_COLLECTOR_UNAVAILABLE|CASHIER_REQUIRED|UNSUPPORTED_SHIFT_ROLE/.test(code)) return 'editCollectorUnavailable';
  if (/EDIT_(?:COLLECTION|REFUND)_AMOUNT_MISMATCH|PAYMENT_RECOVERY_IDENTITY_MISMATCH/.test(code)) return 'editPaymentMismatch';
  if (/EDIT_LOCAL_OPERATION_FAILED|EDIT_SETTLEMENT_OUTCOME_UNKNOWN/.test(code)) return 'editLocalOperationFailed';
  if (/SCOPE_|TERMINAL_(?:BINDING_UNAVAILABLE|SCOPE_UNAVAILABLE|REBIND_PENDING|TRANSITION_PENDING)/.test(code)) return 'editScopeChanged';
  return 'editFailed';
}
