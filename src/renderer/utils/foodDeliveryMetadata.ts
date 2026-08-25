/**
 * ghost_metadata.food_delivery helpers — the platform extras the aggregator
 * ingest persists on delivery-platform orders (PR #155): the rider-facing
 * short_code, delivery_provider, payment_method and prepaid.
 *
 * The metadata may arrive as a JSON string (local SQLite) or as an object
 * (fresh realtime payloads), under either ghost_metadata or ghostMetadata.
 */
function parseMetadataCandidate(value: unknown): Record<string, any> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, any>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

export function resolveFoodDeliveryMetadata(order: any): Record<string, any> | null {
  const metadata = parseMetadataCandidate(order?.ghost_metadata ?? order?.ghostMetadata);
  const foodDelivery = metadata?.food_delivery;
  return foodDelivery && typeof foodDelivery === 'object' && !Array.isArray(foodDelivery)
    ? (foodDelivery as Record<string, any>)
    : null;
}

/**
 * The 4-digit code riders and staff match orders by (e.g. «#4545» on efood's
 * own slip). This — never the long external order id — is what every
 * order-number surface should headline for platform orders.
 */
export function resolveFoodDeliveryShortCode(order: any): string | null {
  const value = resolveFoodDeliveryMetadata(order)?.short_code;
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}
