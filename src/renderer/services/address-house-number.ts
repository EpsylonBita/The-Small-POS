export interface HouseNumberParts {
  raw: string;
  digits: string;
  suffix?: string;
}

const HOUSE_NUMBER_REGEX = /(^|[^\p{L}\p{N}])(\d+)([A-Za-zΑ-Ωα-ω]?)(?=$|[^\p{L}\p{N}])/u;

export function canonicalizeHouseNumberSuffix(
  value: string | null | undefined
): string | undefined {
  const normalized = String(value || '').trim().normalize('NFKC');
  if (!normalized) {
    return undefined;
  }

  const suffix = normalized[0]?.toLowerCase();
  if (!suffix) {
    return undefined;
  }

  switch (suffix) {
    case 'a':
    case 'α':
      return 'a';
    default:
      return suffix;
  }
}

export function parseHouseNumberParts(
  value: string | null | undefined
): HouseNumberParts | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(HOUSE_NUMBER_REGEX);
  if (!match) {
    return null;
  }

  const digits = match[2] || '';
  const rawSuffix = match[3] || '';
  const suffix = canonicalizeHouseNumberSuffix(rawSuffix);

  return {
    raw: `${digits}${rawSuffix}`,
    digits,
    ...(suffix ? { suffix } : {}),
  };
}

export function extractStreetNumber(
  address: string | null | undefined
): string | undefined {
  return parseHouseNumberParts(address)?.raw;
}

export function normalizeHouseNumber(
  value: string | null | undefined
): string | undefined {
  const parts = parseHouseNumberParts(value);
  if (!parts) {
    return undefined;
  }

  return `${parts.digits}${parts.suffix || ''}`;
}

export function houseNumbersMatch(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const leftParts = parseHouseNumberParts(left);
  const rightParts = parseHouseNumberParts(right);
  if (!leftParts || !rightParts) {
    return false;
  }

  return (
    leftParts.digits === rightParts.digits
    && (leftParts.suffix || '') === (rightParts.suffix || '')
  );
}

// Preserve a richer suffix from suggestion text when the provider only returns bare digits.
export function selectResolvedStreetNumber(
  providerStreetNumber: string | null | undefined,
  ...candidates: Array<string | null | undefined>
): string | undefined {
  const provider = parseHouseNumberParts(providerStreetNumber);
  const parsedCandidates = candidates
    .map((candidate) => parseHouseNumberParts(candidate))
    .filter((candidate): candidate is HouseNumberParts => candidate !== null);

  if (provider) {
    const richerCandidate = parsedCandidates.find((candidate) => {
      if (candidate.digits !== provider.digits || !candidate.suffix) {
        return false;
      }

      return !provider.suffix || provider.suffix === candidate.suffix;
    });

    return richerCandidate?.raw || provider.raw;
  }

  return parsedCandidates[0]?.raw;
}
