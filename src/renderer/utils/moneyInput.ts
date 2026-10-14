import { formatCurrencyInput, parseCurrencyDigits } from '../../shared/utils/currencyInput';

/**
 * Money fields on the till use digit entry in cents (founder rule 13/10/2026):
 * typing 3350 shows 33,50 and typing 100000 shows 1.000,00. The decimal comma
 * appears by itself; a typed ',' or '.' never switches to decimal entry.
 *
 * A field keeps its value as a plain decimal string ("1000.00", or "" when
 * nothing is entered) so every existing parser and payload stays unchanged;
 * only the text shown in the field is grouped.
 */

/** The grouped text a money field shows for a stored value ("" stays empty). */
export function centsEntryDisplay(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? formatCurrencyInput(value) : '';
  return value.trim() === '' ? '' : formatCurrencyInput(parseMoneyInputValue(value));
}

export interface CentsEntry {
  /** Plain decimal string for state and payloads: "1000.00", or "" when cleared. */
  value: string;
  /** The amount in currency units (0 when cleared). */
  amount: number;
}

/**
 * Applies one edit of a digit-entry money field. `raw` is the field's new
 * text; `deleting` is true when the edit removed text (Backspace, Delete,
 * cut). Returns null to refuse the edit (letters, signs, exponents, more
 * than 12 digits), so the field keeps what it showed.
 */
export function nextCentsEntry(raw: string, deleting = false): CentsEntry | null {
  const amount = parseCurrencyDigits(raw);
  if (amount === null) return null;
  // Removing the last significant digit empties the field instead of leaving
  // "0,00", so "nothing entered yet" stays distinct from a typed 0.
  if (!/\d/.test(raw) || (deleting && amount === 0)) return { value: '', amount: 0 };
  return { value: amount.toFixed(2), amount };
}

/**
 * Reads pasted money text as a decimal amount, not as typed cents: "12.5" and
 * "12,5" are 12,50, "1.234,50" and "1,234.50" are 1.234,50, and "1.234" (a
 * single separator before exactly three digits) is a thousands group, 1.234,00.
 * Spaces, apostrophes (Swiss "1'234.50") and a currency sign or code around the
 * number are ignored. Returns null for anything else (letters, signs, more
 * than 12 digits), so the paste is refused.
 */
export function parsePastedMoney(text: string): number | null {
  const compact = text
    .trim()
    .replace(/^[A-Za-z€$£]{0,3}\s*/, '')
    .replace(/\s*[A-Za-z€$£]{0,3}$/, '')
    .replace(/[\s'’]/g, '');
  if (!/^\d[\d.,]*$/.test(compact)) return null;
  const lastDot = compact.lastIndexOf('.');
  const lastComma = compact.lastIndexOf(',');
  let integerPart = compact;
  let fractionPart = '';
  if (lastDot >= 0 && lastComma >= 0) {
    // Both separators: the last one is the decimal point.
    const decimalIndex = Math.max(lastDot, lastComma);
    integerPart = compact.slice(0, decimalIndex);
    fractionPart = compact.slice(decimalIndex + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastDot >= 0 ? '.' : ',';
    const parts = compact.split(separator);
    const tail = parts[parts.length - 1];
    if (parts.length === 2 && tail.length <= 2) {
      integerPart = parts[0];
      fractionPart = tail;
    }
  }
  // Thousands groups must be well formed: one separator kind, three digits
  // after each one ("1.234.567"), so "12.3.4" is refused rather than guessed.
  const groupSeparators = integerPart.match(/[.,]/g) ?? [];
  const groupSeparator = groupSeparators[0];
  if (groupSeparator !== undefined) {
    const groups = integerPart.split(groupSeparator);
    if (
      groupSeparators.some((separator) => separator !== groupSeparator)
      || !/^\d{1,3}$/.test(groups[0] ?? '')
      || groups.slice(1).some((group) => !/^\d{3}$/.test(group))
    ) {
      return null;
    }
  }
  const integerDigits = integerPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(integerDigits) || /[.,]/.test(fractionPart) || fractionPart.length > 2) {
    return null;
  }
  if (integerDigits.replace(/^0+/, '').length + 2 > 12) return null;
  const cents = Number(integerDigits) * 100 + Number(fractionPart.padEnd(2, '0') || '0');
  return cents / 100;
}

/** The value a money field takes from pasted text, or null to refuse it. */
export function pastedCentsEntry(text: string): CentsEntry | null {
  const amount = parsePastedMoney(text);
  if (amount === null) return null;
  return { value: amount.toFixed(2), amount };
}

/**
 * Reads a money-field value: the plain decimal string a digit-entry field
 * stores ("1000.00"), legacy comma text ("12,50") or the grouped display
 * ("1.000,00"). Returns 0 for empty or unreadable text, never a negative.
 */
export function parseMoneyInputValue(value: string): number {
  const compact = value.replace(/[\s€]/g, '');
  const normalized = compact.includes(',')
    ? compact.replace(/\./g, '').replace(',', '.')
    : compact;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, parsed);
}
