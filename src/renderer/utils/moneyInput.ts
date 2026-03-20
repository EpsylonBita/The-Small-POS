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

  if (digitsOnly.length <= 2) {
    return digitsOnly;
  }

  const integerPart = digitsOnly.slice(0, -2).replace(/^0+(?=\d)/, '');
  const fractionPart = digitsOnly.slice(-2);
  return `${integerPart || '0'},${fractionPart}`;
}

export function parseMoneyInputValue(value: string): number {
  const normalized = value.replace(',', '.').trim();
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, parsed);
}
