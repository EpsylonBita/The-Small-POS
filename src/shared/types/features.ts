/**
 * Features Types (POS-local stub)
 */

// Map feature IDs to required plan
export const FEATURE_PLAN_MAP: Record<string, string> = {
  orders: 'Starter',
  menu: 'Starter',
  customers: 'Starter',
  delivery: 'Professional',
  tables: 'Professional',
  reports: 'Professional',
  inventory: 'Enterprise',
  analytics: 'Enterprise',
};

// Features available on Starter plan
export const STARTER_FEATURES: string[] = ['orders', 'menu', 'customers', 'dashboard', 'settings'];
