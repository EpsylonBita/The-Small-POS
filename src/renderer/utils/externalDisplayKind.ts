/**
 * Which kind of window this is: the till itself (null), or a customer/kitchen display opened with
 * ?externalDisplay=… in the URL or the hash. Shared by App and the start-up intro (src/main.tsx), which
 * plays only on the till's own window.
 */
export type ExternalDisplayKind = 'customer_display' | 'kitchen_display';

export function resolveExternalDisplayKind(hash: string): ExternalDisplayKind | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const candidates: string[] = [];
  try {
    const searchValue = new URLSearchParams(window.location.search).get('externalDisplay');
    if (searchValue) candidates.push(searchValue);
  } catch {
    // Ignore malformed URLs; fall through to hash parsing.
  }

  const hashValue = hash || window.location.hash || '';
  const hashQuery = hashValue.includes('?') ? hashValue.slice(hashValue.indexOf('?') + 1) : '';
  if (hashQuery) {
    try {
      const hashParam = new URLSearchParams(hashQuery).get('externalDisplay');
      if (hashParam) candidates.push(hashParam);
    } catch {
      // Ignore malformed hashes.
    }
  }

  const normalized = candidates[0]?.trim().toLowerCase();
  if (normalized === 'kitchen_display' || normalized === 'kds' || normalized === 'kitchen') {
    return 'kitchen_display';
  }
  if (normalized === 'customer_display' || normalized === 'customer') {
    return 'customer_display';
  }
  return null;
}
