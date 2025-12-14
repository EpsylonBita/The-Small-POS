// Shared feature mapping between main (FeatureService) and renderer (useFeatures)
// Server uses snake_case; local uses camelCase keys.

export type FeatureMapping<T extends Record<string, boolean | undefined>> = Record<string, keyof T>;

export const FEATURE_KEY_MAPPING = {
  cash_drawer: 'cashDrawer',
  z_report_execution: 'zReportExecution',
  cash_payments: 'cashPayments',
  card_payments: 'cardPayments',
  order_creation: 'orderCreation',
  order_modification: 'orderModification',
  discounts: 'discounts',
  refunds: 'refunds',
  expenses: 'expenses',
  staff_payments: 'staffPayments',
  reports: 'reports',
  settings: 'settings',
  // Already camelCase keys (tolerate either form)
  cashDrawer: 'cashDrawer',
  zReportExecution: 'zReportExecution',
  cashPayments: 'cashPayments',
  cardPayments: 'cardPayments',
  orderCreation: 'orderCreation',
  orderModification: 'orderModification',
  staffPayments: 'staffPayments',
  // Variations from DB / admin UI
  payment_processing: 'cardPayments',
  receipt_printing: 'cashDrawer',
  table_management: 'orderCreation',
  inventory_view: 'reports',
  reports_view: 'reports',
  staff_management: 'staffPayments',
  settings_access: 'settings',
} as const;

export function mapServerFeaturesToLocal<T extends Record<string, boolean | undefined>>(
  serverFeatures: Record<string, boolean>,
  mapping: FeatureMapping<T>
): Partial<T> {
  const result: Partial<T> = {};
  for (const [serverKey, value] of Object.entries(serverFeatures || {})) {
    const localKey = mapping[serverKey as keyof typeof mapping];
    if (localKey && typeof value === 'boolean') {
      (result as any)[localKey] = value;
    }
  }
  return result;
}