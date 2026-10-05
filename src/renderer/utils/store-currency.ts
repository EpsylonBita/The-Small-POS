/** Operating currency is supplied by the authenticated store-country snapshot.
 * Historical documents must always pass their own persisted currency explicitly.
 */
let currentStoreCurrency: string | null = null;

function read(settings: Record<string, unknown>, category: string, key: string): unknown {
  const nested = settings[category];
  return settings[`${category}.${key}`] ??
    (nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[key] : undefined);
}

export function configuredStoreCurrency(settings: Record<string, unknown>): string | null {
  const grouped = settings.settings && typeof settings.settings === 'object'
    ? settings.settings as Record<string, unknown> : settings;
  const remoteVerdict = Object.prototype.hasOwnProperty.call(settings, 'store_currency_available');
  const available = remoteVerdict ? settings.store_currency_available : read(grouped, 'restaurant', 'store_currency_available');
  const branch = read(grouped, 'terminal', 'branch_id') ?? settings.branch_id;
  const currencyBranch = remoteVerdict ? settings.store_currency_branch_id : read(grouped, 'restaurant', 'store_currency_branch_id');
  const source = remoteVerdict ? settings.store_currency_source : read(grouped, 'restaurant', 'store_currency_source');
  if ((available !== true && available !== 'true') || source !== 'branch_country' ||
      typeof branch !== 'string' || !branch.trim() || branch.trim() !== currencyBranch) return null;
  const raw = remoteVerdict ? settings.store_currency : read(grouped, 'restaurant', 'currency');
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export function setStoreCurrencyFromSettings(settings: Record<string, unknown>): void {
  currentStoreCurrency = configuredStoreCurrency(settings);
}

export function getStoreCurrency(): string | null {
  return currentStoreCurrency;
}
