const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeUuid(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || !UUID_RE.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

interface AdjustmentAttributionOptions {
  databaseStaffId?: unknown;
  shiftStaffOwnerId?: unknown;
  staffShiftId?: unknown;
  candidateStaffIds?: unknown[];
}

export function resolveAdjustmentAttribution({
  databaseStaffId,
  shiftStaffOwnerId,
  staffShiftId,
  candidateStaffIds = [],
}: AdjustmentAttributionOptions): {
  staffId?: string;
  staffShiftId?: string;
} {
  return {
    staffId:
      normalizeUuid(databaseStaffId) ??
      normalizeUuid(shiftStaffOwnerId) ??
      candidateStaffIds
        .map((candidate) => normalizeUuid(candidate))
        .find((candidate): candidate is string => Boolean(candidate)),
    staffShiftId: normalizeUuid(staffShiftId),
  };
}
