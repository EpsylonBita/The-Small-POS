// Shared formatting utilities for the POS renderer
// Keep this light and framework-agnostic

export function formatCurrency(amount: number, currency: string = 'EUR', locale?: string): string {
  const resolvedLocale = locale || (typeof navigator !== 'undefined' ? navigator.language : 'en-IE');
  try {
    return new Intl.NumberFormat(resolvedLocale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(amount) ? amount : 0);
  } catch {
    // Fallback in case of unsupported locale/currency
    const safe = Number.isFinite(amount) ? amount : 0;
    return `${currency === 'EUR' ? '€' : ''}${safe.toFixed(2)}`;
  }
}

