/**
 * The platform money rule, on the Windows POS.
 *
 * Mirror of `shared/types/pricing.ts` (the admin and server copy). The renderer cannot
 * import the repository's `shared/` folder, so the rule is restated here and both copies are
 * measured against the same specification: `shared/types/money-fixtures.json`, every euro
 * amount with the exact integer cents the platform must produce. `__tests__/money.test.ts`
 * reads that file; a cent of drift between this POS, the Android POS, the Rust core and the
 * server fails there rather than on a customer's receipt.
 *
 * Module audit, final high-risk closure (2026-09-16). Before it, five copies of `roundMoney`
 * lived in this tree — three did `Math.round(value * 100) / 100` and one did
 * `Number(value.toFixed(2))`, both of which send 1.005 to 1.00 because 1.005 * 100 is
 * 100.49999999999999 in binary. They all now come from here.
 */

/**
 * Move the decimal point without going through binary multiplication, so 1.005 becomes
 * 100.5 and not 100.49999999999999.
 */
function shiftDecimal(value: number, places: number): number {
  const [mantissa, exponent = '0'] = String(value).split('e');
  return Number(`${mantissa}e${Number(exponent) + places}`);
}

/** Integer cents of a money amount, rounded HALF AWAY FROM ZERO; non-finite input is 0. */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) {
    return 0;
  }
  const shifted = shiftDecimal(amount, 2);
  if (!Number.isFinite(shifted)) {
    return 0;
  }
  // `+ 0` normalises -0 (a negative amount below half a cent) to 0.
  return Math.sign(shifted) * Math.round(Math.abs(shifted)) + 0;
}

/** Money amount of integer cents (2 dp); non-finite input is 0. */
export function fromCents(cents: number): number {
  if (!Number.isFinite(cents)) {
    return 0;
  }
  return shiftDecimal(Math.round(cents), -2);
}

/**
 * Round a money amount to whole cents, half away from zero (1.005 → 1.01, -1.005 → -1.01,
 * 0.1 + 0.2 → 0.3). The single rounding entry point for this renderer.
 */
export function roundMoney(value: number): number {
  return fromCents(toCents(value));
}

/**
 * Integer cents a discount of `value` takes off `subtotalCents`.
 *
 * `percentage`: a share of the subtotal, the value clamped to 100, rounded half away from
 * zero. Anything else: a fixed money amount. Never more than the subtotal, never negative.
 */
export function discountCents(
  type: string | null | undefined,
  value: number,
  subtotalCents: number
): number {
  const subtotal = Math.max(0, Math.round(Number(subtotalCents) || 0));
  if (subtotal <= 0) {
    return 0;
  }
  const amount = Math.max(0, Number(value) || 0);
  if (type === 'percentage') {
    return Math.min(subtotal, Math.round((subtotal * Math.min(amount, 100)) / 100));
  }
  return Math.min(toCents(amount), subtotal);
}

/** The same discount rule expressed as a money amount. */
export function discountAmount(
  type: string | null | undefined,
  value: number,
  subtotal: number
): number {
  return fromCents(discountCents(type, value, toCents(subtotal)));
}
