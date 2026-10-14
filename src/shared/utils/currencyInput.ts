/** Digit entry for POS money fields: 3350 means 33,50 (the last two digits are cents). */
export function parseCurrencyDigits(input: string): number | null {
  if (!/^[\d\s.,€]*$/.test(input)) return null;
  const digits = input.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length > 12) return null;
  return Number(digits || '0') / 100;
}

/**
 * Display form of a money field: thousands grouped with '.', the decimal
 * comma fixed and always two cents digits (1000 -> "1.000,00",
 * 1234567.8 -> "1.234.567,80"). Negative or non-finite amounts show "0,00".
 */
export function formatCurrencyInput(amount: number): string {
  const safe = Math.max(0, Number.isFinite(amount) ? amount : 0);
  const [whole, cents] = safe.toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
}
