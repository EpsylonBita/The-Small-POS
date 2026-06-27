/**
 * Order summary (totals) display helpers. Pure + framework-agnostic so the
 * strikethrough/discount display rules are unit-testable independently of the
 * OrderDetailsModal component.
 */

/**
 * The pre-discount subtotal to strike through in an order summary, or null when
 * there is none to show.
 *
 * A strikethrough is only meaningful when the order carries a REAL, distinct
 * pre-discount subtotal that is greater than the displayed subtotal. It must NOT
 * be fabricated as `subtotal + discount`: the displayed `subtotal` is already the
 * pre-(order-)discount item subtotal, so adding the discount back double-counts it
 * (e.g. 18.50 + 1.85 = a bogus 20.35).
 */
export function resolveStrikethroughSubtotal(input: {
  subtotal?: number | null;
  originalSubtotal?: number | null;
}): number | null {
  const subtotal = Number(input.subtotal) || 0;
  const original = Number(input.originalSubtotal) || 0;
  return original > subtotal + 0.005 ? Number(original.toFixed(2)) : null;
}
