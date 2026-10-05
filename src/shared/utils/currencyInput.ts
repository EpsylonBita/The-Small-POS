/** Digit entry for POS money fields: 3350 means 33,50 (the last two digits are cents). */
export function parseCurrencyDigits(input: string): number | null {
  if (!/^[\d\s.,€]*$/.test(input)) return null;
  const digits = input.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length > 12) return null;
  return Number(digits || '0') / 100;
}

export function formatCurrencyInput(amount: number): string {
  return Math.max(0, Number.isFinite(amount) ? amount : 0).toFixed(2).replace('.', ',');
}
