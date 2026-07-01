export function formatMoneyInputWithCents(value: string): string {
  const cleaned = value.replace(/[^\d.,]/g, '');
  if (!cleaned) {
    return '';
  }

  const lastSeparatorIndex = Math.max(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'));
  if (lastSeparatorIndex >= 0) {
    const integerDigits = cleaned.slice(0, lastSeparatorIndex).replace(/\D/g, '');
    const fractionDigits = cleaned.slice(lastSeparatorIndex + 1).replace(/\D/g, '');

    if (fractionDigits.length <= 2) {
      if (cleaned.endsWith(',') || cleaned.endsWith('.')) {
        return `${integerDigits || '0'},`;
      }
      return `${integerDigits || '0'},${fractionDigits}`;
    }
  }

  const digitsOnly = cleaned.replace(/\D/g, '');
  if (!digitsOnly) {
    return '';
  }

  if (digitsOnly.length === 1) {
    return `0,0${digitsOnly}`;
  }

  if (digitsOnly.length === 2) {
    return `0,${digitsOnly}`;
  }

  const integerPart = digitsOnly.slice(0, -2).replace(/^0+(?=\d)/, '');
  const fractionPart = digitsOnly.slice(-2);
  return `${integerPart || '0'},${fractionPart}`;
}

/**
 * Formats a numeric amount into the comma-decimal money-input format
 * (`12,50`) that formatMoneyInputWithCents produces for typed input. Use
 * this for programmatic prefill (e.g. quick-cash buttons) — passing
 * `String(amount)` through formatMoneyInputWithCents would treat bare
 * integers as cents ("5" -> "0,05").
 */
export function formatMoneyInputFromNumber(amount: number): string {
  if (!Number.isFinite(amount)) {
    return '';
  }
  const cents = Math.max(0, Math.round(amount * 100));
  return `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

export function parseMoneyInputValue(value: string): number {
  const normalized = value.replace(',', '.').trim();
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, parsed);
}
