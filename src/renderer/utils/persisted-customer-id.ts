const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPersistedCustomerId(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

export function resolvePersistedCustomerId(
  ...candidates: Array<unknown>
): string | null {
  for (const candidate of candidates) {
    if (isPersistedCustomerId(candidate)) {
      return candidate.trim();
    }
  }

  return null;
}
